// Okena push for the agent dock: one read-only `/v1/stream` WebSocket
// (src/extensions/okena/stream.ts) to the Okena profile the dock observes (the
// active one, as OkenaClaudeSource polls it), over the same local endpoint and
// credentials OkenaClient resolves (unix socket, else loopback TCP + token).
//
//   state_changed      → onChange() (watcher.nudge: debounced, coalesced), plus one
//                        echo STREAM_ECHO_MS later: Okena's `busy` comes from its own
//                        hook, which does not bump state_version, while the lifecycle
//                        OSC that does comes from a separate hook and can land first.
//   everything else    → ignored (system_stats_changed every 2 s, usage_changed, …).
//   open / lost        → onChange() too: a full sweep after (re)connecting, and the
//                        cadence re-arms at the polling rate once the stream is gone.
//
// Lifecycle: sync() after every watcher tick follows the target (profile switch,
// removal, daemon restart: a new pid or endpoint) and closes the old socket cleanly.
// A lost stream reconnects with exponential backoff (STREAM_BACKOFF_MIN_MS doubling
// to STREAM_BACKOFF_MAX_MS; reset after STREAM_STABLE_MS up). An Okena without the
// route (HTTP 404 instead of 101) stays on polling silently and is retried at the
// cap. Logs state transitions only (connected / lost), never each failed attempt.
// resume() (powerMonitor resume / unlock-screen) reconnects at once.
//
// Side effect on Okena: an authenticated stream is an active client (stream.rs
// `active_connections`, `had_client`). A UI-owned daemon (`okena --headless
// --ui-owned`, remote.json `ui_owned`) exits when its desktop app quits only once no
// client is left, and its idle exit (10 s without clients after a GUI crash) cannot
// fire while one is connected; agent-usage polls also run while any client is. So
// Helm holds a UI-owned daemon's stream as a lease of UI_OWNED_LEASE_MS, then closes
// and reconnects right away: after a clean Okena quit the daemon exits at the next
// release (≤ one lease late), and no longer than that does Helm keep it alive. A GUI
// crash still leaves the daemon running while Helm is (the gap is too short for the
// idle exit; the next Okena launch adopts it). Standalone daemons never idle-exit.

import type { OkenaStreamTarget } from '../../../src/extensions/okena/client'
import {
	type OkenaStreamEnd,
	type OkenaStreamHandlers,
	type OkenaStreamSocket,
	openOkenaStream,
} from '../../../src/extensions/okena/stream'
import { type AgentDockPushChannel, type WatcherTimers, realTimers } from './watcher'

export const STREAM_BACKOFF_MIN_MS = 1_000
export const STREAM_BACKOFF_MAX_MS = 30_000
/** A stream up this long resets the backoff (a flapping one keeps backing off). */
export const STREAM_STABLE_MS = 30_000
/** The trailing re-read after a state_changed burst (see the header). */
export const STREAM_ECHO_MS = 1_000
/** How long one connection to a UI-owned daemon is held before a clean close + reconnect. */
export const UI_OWNED_LEASE_MS = 60_000

/** The OkenaClient surface the stream uses (structural, so tests inject a double). */
export interface OkenaStreamClient {
	activeProfileId(): string | null
	forProfile(profileId: string): { streamTarget(): OkenaStreamTarget | null }
}

export type OkenaStreamOpener = (
	target: { endpoint: OkenaStreamTarget['endpoint']; token?: string },
	handlers: OkenaStreamHandlers,
) => OkenaStreamSocket

/** off: no Okena to connect to; connecting; open; backoff: lost, retrying; unsupported: no route (404). */
export type OkenaStreamStatus = 'off' | 'connecting' | 'open' | 'backoff' | 'unsupported'

export interface OkenaStreamSubscriptionOptions {
	client: OkenaStreamClient
	/** A change Okena pushed, or the stream (re)connected or was lost: tick soon (watcher.nudge). */
	onChange(): void
	open?: OkenaStreamOpener
	timers?: WatcherTimers
	now?: () => number
	log?: (message: string) => void
}

interface Resolved {
	profile: string
	/** Profile + endpoint + daemon pid: a change is a different daemon to connect to. */
	key: string
	target: OkenaStreamTarget
}

export class OkenaStreamSubscription implements AgentDockPushChannel {
	private state: OkenaStreamStatus = 'off'
	private current: Resolved | null = null
	private socket: OkenaStreamSocket | null = null
	/** Bumped per connection: callbacks from an older socket are ignored. */
	private generation = 0
	private failures = 0
	private openedAt = 0
	private retryTimer: unknown = null
	private echoTimer: unknown = null
	private leaseTimer: unknown = null
	/** A lease release (or resume) is reconnecting: stay healthy, no log, no backoff. */
	private renewing = false
	/** Last transition logged, so a retry loop logs once. */
	private announced: 'up' | 'down' | null = null
	private started = false
	private stopped = false
	private readonly timers: WatcherTimers
	private readonly now: () => number
	private readonly open: OkenaStreamOpener

	constructor(private readonly options: OkenaStreamSubscriptionOptions) {
		this.timers = options.timers ?? realTimers
		this.now = options.now ?? Date.now
		this.open = options.open ?? ((target, handlers) => openOkenaStream(target, handlers))
	}

	/** Connected and authenticated (or renewing a lease): Okena pushes every state_version bump. */
	healthy(): boolean {
		return this.state === 'open' || (this.renewing && this.state === 'connecting')
	}

	status(): OkenaStreamStatus {
		return this.state
	}

	start(): void {
		if (this.started || this.stopped) return
		this.started = true
		this.sync()
	}

	/** Follow the dock's Okena profile and daemon (after every tick). Cheap: config reads are cached. */
	sync(): void {
		if (!this.started || this.stopped) return
		const next = this.resolve()
		if (next?.key === this.current?.key) {
			if (next && this.state === 'off') this.connect(next)
			return
		}
		// Another profile, a restarted daemon, or none: drop the old stream cleanly.
		this.drop()
		this.failures = 0
		this.current = next
		if (next) this.connect(next)
		else this.markDown()
	}

	/** Wake / unlock: the socket may be half-open. Reconnect now (no backoff) and sweep. */
	resume(): void {
		if (!this.started || this.stopped) return
		this.failures = 0
		const wasHealthy = this.healthy()
		this.drop()
		this.current = this.resolve()
		if (this.current) {
			this.renewing = wasHealthy
			this.connect(this.current)
		} else this.markDown()
		this.options.onChange()
	}

	/** Quit: close cleanly, no reconnect. */
	stop(): void {
		if (this.stopped) return
		this.stopped = true
		this.drop()
		this.clear('echoTimer')
	}

	private resolve(): Resolved | null {
		try {
			const profile = this.options.client.activeProfileId()
			if (!profile) return null
			const target = this.options.client.forProfile(profile).streamTarget()
			if (!target) return null
			const where = target.endpoint.kind === 'unixSocket' ? target.endpoint.socketPath : target.endpoint.baseUrl
			return { profile, key: `${profile}\u0000${where}\u0000${target.pid}`, target }
		} catch {
			return null
		}
	}

	private connect(resolved: Resolved): void {
		this.clear('retryTimer')
		this.state = 'connecting'
		const generation = ++this.generation
		const stale = () => generation !== this.generation || this.stopped
		const { endpoint, token } = resolved.target
		this.socket = this.open(
			{ endpoint, ...(endpoint.kind === 'http' ? { token } : {}) },
			{
				onOpen: () => {
					if (stale()) return
					this.state = 'open'
					this.openedAt = this.now()
					this.renewing = false
					if (this.announced !== 'up') this.options.log?.(`Okena stream connected (profile ${resolved.profile})`)
					this.announced = 'up'
					if (resolved.target.uiOwned) this.leaseTimer = this.timers.setTimeout(() => this.release(), UI_OWNED_LEASE_MS)
					// Sweep: whatever changed while the stream was down (or between lease connections).
					this.options.onChange()
				},
				onFrame: frame => {
					if (stale() || frame.type !== 'state_changed') return
					this.changed()
				},
				onClose: end => {
					if (stale()) return
					this.socket = null
					this.closed(end)
				},
			},
		)
	}

	private changed(): void {
		this.options.onChange()
		if (this.echoTimer === null)
			this.echoTimer = this.timers.setTimeout(() => {
				this.echoTimer = null
				if (!this.stopped) this.options.onChange()
			}, STREAM_ECHO_MS)
	}

	/** UI-owned lease over: close cleanly and reconnect right away (see the header). */
	private release(): void {
		this.leaseTimer = null
		if (this.stopped || this.state !== 'open' || !this.socket) return
		this.renewing = true
		this.socket.close()
	}

	private closed(end: OkenaStreamEnd): void {
		this.clear('leaseTimer')
		const wasHealthy = this.state === 'open'
		if (wasHealthy && this.now() - this.openedAt >= STREAM_STABLE_MS) this.failures = 0
		if (this.renewing && wasHealthy) {
			// Lease release: a fresh read of remote.json (the daemon may be exiting after an Okena quit).
			this.current = this.resolve()
			if (this.current) {
				this.connect(this.current)
				return
			}
			this.renewing = false
			this.markDown()
			this.options.onChange()
			return
		}
		const wasRenewing = this.renewing
		this.renewing = false
		if (end.httpStatus === 404) {
			// An Okena without /v1/stream: polling, silently; retried rarely in case it is upgraded.
			this.state = 'unsupported'
			this.scheduleRetry(STREAM_BACKOFF_MAX_MS)
		} else {
			this.failures += 1
			this.state = 'backoff'
			if (this.announced !== 'down') {
				this.options.log?.(`Okena stream unavailable (${end.reason}); polling until it reconnects`)
				this.announced = 'down'
			}
			this.scheduleRetry(Math.min(STREAM_BACKOFF_MAX_MS, STREAM_BACKOFF_MIN_MS * 2 ** (this.failures - 1)))
		}
		// Re-arm the watcher at the polling cadence (and read what the stream can no longer push).
		if (wasHealthy || wasRenewing) this.options.onChange()
	}

	private scheduleRetry(delay: number): void {
		this.clear('retryTimer')
		this.retryTimer = this.timers.setTimeout(() => {
			this.retryTimer = null
			if (this.stopped) return
			// Credentials, endpoint and pid as they are now (a token refresh, a restarted daemon).
			const next = this.resolve()
			this.current = next
			if (next) this.connect(next)
			else this.markDown()
		}, delay)
	}

	/** No daemon to connect to: wait for sync() to find one. */
	private markDown(): void {
		this.clear('retryTimer')
		this.current = null
		this.state = 'off'
		if (this.announced === 'up') {
			this.options.log?.('Okena stream closed (Okena not running); polling')
			this.announced = 'down'
		}
	}

	/** Close the current socket (cleanly) and forget its callbacks. */
	private drop(): void {
		this.generation += 1
		this.clear('retryTimer')
		this.clear('leaseTimer')
		const socket = this.socket
		this.socket = null
		this.state = 'off'
		this.renewing = false
		socket?.close()
	}

	private clear(name: 'retryTimer' | 'echoTimer' | 'leaseTimer'): void {
		const handle = this[name]
		if (handle !== null) this.timers.clearTimeout(handle)
		this[name] = null
	}
}
