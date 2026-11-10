// Agent dock watcher (Electron main side, but no Electron import: main.ts
// injects publish/focus so this stays unit-testable under node --test).
//
// Cadence follows the agents, not the window (intervals in cadence.ts): 1 s while
// some agent is active (main agent busy/working, a dialog open, a turn held by the
// idle gate, a dock answer waiting to be observed: agentDockActive). Otherwise, with
// a healthy push channel (Okena's /v1/stream connected and covering every Okena
// pane, okena-stream.ts), a 15 s reconciliation; without one 1.5 s while the dock is
// shown AND Helm is focused, else 5 s (shown but unfocused, or hidden). Hidden still
// ticks on purpose: `helm dock watch` (the dispatcher's event stream) must get
// events while the dock is collapsed. The active 1 s stays even with the stream up:
// Okena's `busy` flip from a hook alone does not bump state_version (only the
// lifecycle OSC from a separate hook pipeline does, and may land first), and a
// reply typed in the terminal shows only in the transcript (REPLY_READ_MS).
// On top of the cadence:
//   - settle timer: the next tick is never later than the moment a turn can be
//     decided without new data (agentDockNextDeadline: idle edge + TURN_IDLE_MS,
//     busy edge + TURN_RESUMED_MS), plus SETTLE_EPSILON_MS;
//   - nudge(): a source pushed a change (Helm's hub, Okena's stream): one tick
//     NUDGE_DEBOUNCE_MS later (at least NUDGE_MIN_GAP_MS after the last tick began);
//     a burst is one tick, and a tick that began after the burst's latest change
//     already covers it.
// One timer, re-armed after every tick; ticks never overlap (a poke during a
// tick runs one more right after it). After every tick the push channel syncs
// (follows Okena's active profile and daemon).
//
// Disk (`<userData>/agent-dock`, 0700; files 0600, atomic replace; shapes from
// spool-projection.ts):
//   state.json     counters (item id, event seq), seen assistant uuids, 24 h resolved ledger (heads only)
//   snapshot.json  spool view for the CLI; rewritten on change or every SNAPSHOT_REFRESH_MS
//   events.ndjson  appended events, ≤300-char lines, monotonic seq, rotated per local day
//   turn-gate.ndjson  diagnostics: turns the idle gate held back that never opened
//                  (`turn.gated`: session key, durations, why). Not a dispatcher event;
//                  rotated to turn-gate.1.ndjson past DIAGNOSTICS_MAX_BYTES.
// Transcript text, dialog `tool_input` and dock answer text never reach disk
// (receipts keep only the action kind and status). Transcript cursors
// are intentionally NOT persisted: the reducer's restart seed needs a fresh
// first page to learn each pane's last assistant message (a restored cursor
// would skip it and lose "turn finished while Helm was closed").

import { rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { dockSourceOfSessionKey } from '../../../src/agent-dock/claude-hub-wire'
import { DOCK_SOURCE_TEXT } from '../../../src/agent-dock/dock-vocabulary'
import {
	SPOOL_EVENTS_FILE,
	SPOOL_SNAPSHOT_FILE,
	SPOOL_STATE_FILE,
	type SpoolItem,
	appendPrivateText,
	ensurePrivateDir,
	readSpoolFile,
	rotateSpoolEvents,
	spoolHighWater,
	spoolItemSchema,
	writePrivateFileAtomic,
} from '../../../src/agent-dock/spool'
import { REFUSAL_TEXT } from './act'
import {
	ACTIVE_INTERVAL_MS,
	BACKGROUND_INTERVAL_MS,
	FOCUSED_INTERVAL_MS,
	RECONCILE_INTERVAL_MS,
	UNFOCUSED_INTERVAL_MS,
} from './cadence'
import type { DockPromptExpect } from './composite-source'
import {
	type AgentDockActResult,
	type AgentDockEvent,
	type AgentDockMessageResult,
	type AgentDockObservation,
	type AgentDockSnapshot,
	type DockActOutcome,
	type DockAction,
	type DockItem,
	type DockRefusalReason,
	type DockSourceId,
	agentDockPersistedSchema,
	parseAgentDockActRequest,
	parseAgentDockPromptRequest,
} from './model'
import type { AgentDockUpdate } from './notifier'
import {
	type AgentDockState,
	type DockTurnGated,
	agentDockActive,
	agentDockNextDeadline,
	agentDockPersisted,
	agentDockSnapshot,
	createAgentDockState,
	reduce,
} from './reduce'
import { contentDigest, dockEventLine, dockSpoolItem, dockSpoolSnapshot, pruneLedger } from './spool-projection'

export {
	ACTIVE_INTERVAL_MS,
	BACKGROUND_INTERVAL_MS,
	FOCUSED_INTERVAL_MS,
	RECONCILE_INTERVAL_MS,
	UNFOCUSED_INTERVAL_MS,
} from './cadence'
export const SNAPSHOT_REFRESH_MS = 10_000
/** A pushed change (nudge) ticks this much later, so a burst of hook events is one tick. */
export const NUDGE_DEBOUNCE_MS = 100
/** …and never sooner than this after the previous tick began (bounds ticks under a flapping source). */
export const NUDGE_MIN_GAP_MS = 250
/** The settle tick lands this much past the deadline (the reducer's clock reads a little later than the source's). */
export const SETTLE_EPSILON_MS = 25
export const DIAGNOSTICS_FILE = 'turn-gate.ndjson'
export const DIAGNOSTICS_MAX_BYTES = 1024 * 1024

/** The timer surface the scheduler uses (tests inject a fake). */
export interface WatcherTimers {
	setTimeout(run: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

/** Node timers, unref'd (they never keep Electron main alive). */
export const realTimers: WatcherTimers = {
	setTimeout: (run, ms) => {
		const handle = setTimeout(run, ms)
		handle.unref?.()
		return handle
	},
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const watcherStateSchema = agentDockPersistedSchema.extend({
	nextSeq: z.number().int().positive().default(1),
	ledger: z.array(spoolItemSchema).default([]),
})
type WatcherPersisted = z.infer<typeof watcherStateSchema>

/** The pane an act or expedite targets; `source` routes it (composite-source.ts). */
export interface AgentDockTarget {
	source: DockSourceId
	profile: string
	terminalId: string
}

export interface AgentDockObservationSource {
	/** One tick: a poll per source (CompositeDockSource). */
	observe(state: AgentDockState, now: number): Promise<AgentDockObservation[]>
	/** CAS read + source write for one dock answer. Absent = the dock cannot answer. */
	act?(target: AgentDockTarget, item: DockItem, action: DockAction): Promise<DockActOutcome>
	/** CAS read + prompt POST for a reply from the agent detail (no item). */
	prompt?(target: AgentDockTarget, expect: DockPromptExpect, text: string): Promise<DockActOutcome>
	/** The pane's last assistant message, read live (agent detail). */
	readMessage?(target: AgentDockTarget): Promise<AgentDockMessageResult>
	/** Read this pane's transcript every tick until `until` (a dock reply waits to be seen). */
	expedite?(target: AgentDockTarget, until: number): void
}

/**
 * A source's push channel (okena-stream.ts). While healthy, every change the sources make
 * reaches nudge(), so idle ticks relax to RECONCILE_INTERVAL_MS.
 */
export interface AgentDockPushChannel {
	healthy(): boolean
	/** After every tick: follow the source's target (profile switch, daemon restart). Cheap; never throws. */
	sync?(): void
}

/** How long after a sent dock reply the source keeps reading that pane's transcript. */
export const ACT_EXPEDITE_MS = 20_000

/**
 * After a source's seed tick, opens count as replays for this long (observe() `replayed`: never
 * notified). Helm's hub starts empty with every Helm launch, and the permission hooks still waiting
 * from the previous run reconnect to it within RECONNECT_DELAY_MS (hook-client.cjs, 500 ms) of it
 * listening, i.e. just after the seed tick: their dialogs are asks Jakub was already told about,
 * not new ones. Generous for a loaded machine.
 */
export const SEED_REPLAY_GRACE_MS = 5_000

export interface AgentDockWatcherOptions {
	/** `<userData>/agent-dock`. */
	dir: string
	source: AgentDockObservationSource
	/** Push to the renderer (main.ts: webContents send on AGENT_DOCK_IPC.snapshot). */
	publish(snapshot: AgentDockSnapshot): void
	isFocused(): boolean
	now?: () => number
	pid?: number
	log?: (message: string) => void
	timers?: WatcherTimers
	/** Absent: no push channel, the polling cadence only. */
	push?: AgentDockPushChannel
	/**
	 * After every tick, ack and act step, shown or hidden: the snapshot and the items it newly opened,
	 * split into live opens and seed/restart replays (notifier.ts: notifications and the Dock badge).
	 */
	observe?(update: AgentDockUpdate): void
}

export class AgentDockWatcher {
	private state: AgentDockState
	private ledger: SpoolItem[] = []
	private nextSeq = 1
	private visible = false
	private started = false
	private loaded = false
	private stopped = false
	private inFlight = false
	/** A dock act is running: ticks wait so no observation lands between its CAS read and its POST result. */
	private acting = false
	private timer: unknown = null
	private nudgeTimer: unknown = null
	/** A poke arrived while a tick ran: run one more right after it. */
	private rerun = false
	/** Ticks begun so far, and when the last one began (nudge coalescing). */
	private tickStarts = 0
	private lastTickAt = Number.NEGATIVE_INFINITY
	/** `tickStarts` when the latest nudge came: a tick numbered past it read that change. */
	private nudgeMark = 0
	private pendingDiagnostics: string[] = []
	private readonly timers: WatcherTimers
	private io: Promise<void> = Promise.resolve()
	private pendingLines: string[] = []
	private lastPersisted = ''
	private lastSnapshotDigest = ''
	private lastSnapshotWriteAt = 0
	private lastPublishedDigest = ''
	private lastPublishAt = 0
	private lastLog = ''
	/** Items opened since the last observe() report: live, and replayed by a seed tick or restart adoption. */
	private opened: number[] = []
	private replayed: number[] = []
	/** When each source's seed tick landed (SEED_REPLAY_GRACE_MS). */
	private readonly seededAt = new Map<DockSourceId, number>()
	private readonly now: () => number
	private readonly pid: number

	constructor(private readonly options: AgentDockWatcherOptions) {
		this.now = options.now ?? Date.now
		this.pid = options.pid ?? process.pid
		this.timers = options.timers ?? realTimers
		this.state = createAgentDockState(null, this.now())
	}

	/** Loads persisted counters and schedules the first tick. Never throws; never waits on Okena. */
	async start(): Promise<void> {
		if (this.started) return
		this.started = true
		await this.load()
		if (!this.stopped) this.schedule(0)
	}

	/** Loads state.json and the event seq high-water mark (start() does this; tests call it directly). */
	async load(): Promise<void> {
		if (this.loaded) return
		this.loaded = true
		try {
			await ensurePrivateDir(this.options.dir)
			const persisted = await this.loadPersisted()
			this.state = createAgentDockState(persisted, this.now())
			this.ledger = pruneLedger(persisted?.ledger ?? [], this.now())
			this.nextSeq = persisted?.nextSeq ?? 1
		} catch (error) {
			this.warn(`state unavailable, starting fresh: ${errorMessage(error)}`)
		}
		try {
			// seq and item ids stay monotonic for `helm dock watch` cursors and the
			// dispatcher's `#id` references even if state.json was lost or invalid.
			const high = await spoolHighWater(this.options.dir)
			this.nextSeq = Math.max(this.nextSeq, high.seq + 1)
			this.state = { ...this.state, nextItemId: Math.max(this.state.nextItemId, high.itemId + 1) }
		} catch (error) {
			this.warn(`event spool unreadable: ${errorMessage(error)}`)
		}
	}

	stop(): void {
		this.stopped = true
		if (this.timer !== null) this.timers.clearTimeout(this.timer)
		if (this.nudgeTimer !== null) this.timers.clearTimeout(this.nudgeTimer)
		this.timer = null
		this.nudgeTimer = null
	}

	/** Some renderer shows (true) or hid (false) the dock. Showing pushes the current snapshot right away. */
	setVisible(visible: boolean): void {
		const wasVisible = this.visible
		this.visible = visible
		if (visible) {
			this.publish(true)
			if (!wasVisible) this.poke()
		}
	}

	/** Tick now (window focus changed, dock shown, a dock act finished). During a tick: one more right after it. */
	poke(): void {
		if (!this.started || this.stopped) return
		if (this.inFlight) this.rerun = true
		else this.schedule(0)
	}

	/**
	 * A source changed (Helm's hub bumped its state): tick soon, whatever the window does.
	 * Debounced and coalesced: one pending nudge at a time, and none at all when a tick
	 * began after the change (it already read it). Cheap and synchronous (hub hot path).
	 */
	nudge(): void {
		if (!this.started || this.stopped) return
		// Every change moves the mark, also one coalesced into a pending nudge: a tick that
		// began between two changes covers only the first.
		this.nudgeMark = this.tickStarts
		if (this.nudgeTimer === null) this.armNudge(NUDGE_DEBOUNCE_MS)
	}

	private armNudge(minDelay: number): void {
		// Clamped: a wall clock set back must not park the nudge (and every change coalesced into it).
		const delay = Math.min(NUDGE_MIN_GAP_MS, Math.max(minDelay, this.lastTickAt + NUDGE_MIN_GAP_MS - this.now()))
		this.nudgeTimer = this.timers.setTimeout(() => {
			this.nudgeTimer = null
			if (this.stopped) return
			// A tick that began after the latest change read it; one already running when it came may not have (poke reruns).
			if (this.tickStarts > this.nudgeMark) return
			// A tick began after an earlier change in the burst: wait out its min gap first.
			const sinceTick = this.now() - this.lastTickAt
			if (sinceTick >= 0 && sinceTick < NUDGE_MIN_GAP_MS) this.armNudge(0)
			else this.poke()
		}, delay)
	}

	/** Jakub acked an item. Resolves true when it was resolved (turns and orphaned asks only). */
	async ack(itemId: number): Promise<boolean> {
		if (!Number.isSafeInteger(itemId) || itemId <= 0) return false
		const events = this.apply({ type: 'ack', itemId })
		const acked = events.some(event => event.t === 'item.resolved' && event.id === itemId)
		this.publish(true)
		this.report()
		await this.flush()
		return acked
	}

	/**
	 * One dock answer (renderer IPC input, validated here). Order: preconditions
	 * on the live item → `sending` (published) → source CAS read + Okena POST →
	 * receipt. Ticks pause meanwhile. Resolves; never throws.
	 */
	async act(request: unknown): Promise<AgentDockActResult> {
		const refused = (reason: DockRefusalReason, detail = REFUSAL_TEXT[reason]): AgentDockActResult => ({
			ok: false,
			outcome: { status: 'refused', reason, detail },
		})
		const parsed = parseAgentDockActRequest(request)
		if (!parsed.ok) return refused('invalid', parsed.error)
		const { itemId, action } = parsed.value
		if (this.stopped) return { ok: false, outcome: { status: 'failed', detail: 'The agent dock stopped.' } }
		if (this.acting) return refused('in_flight')
		const item = this.state.items.find(candidate => candidate.id === itemId)
		if (!item) return refused('unknown_item')
		if (item.state !== 'open') return refused(item.state === 'resolved' ? 'gone' : 'not_open')
		const session = this.state.sessions[item.session]?.session
		if (!session) return refused('gone', DOCK_SOURCE_TEXT[dockSourceOfSessionKey(item.session)].notListed)
		if (this.state.sources[session.source]?.health.state !== 'ok')
			return refused('source_down', DOCK_SOURCE_TEXT[session.source].sourceDown)
		const source = this.options.source
		if (!source.act) return { ok: false, outcome: { status: 'failed', detail: 'This Helm build cannot answer.' } }
		const target: AgentDockTarget = { source: session.source, profile: session.profile, terminalId: session.terminalId }

		this.acting = true
		let outcome: DockActOutcome
		// Whether the reducer kept the outcome on the item (it drops a result for an item that moved on).
		let recorded = false
		try {
			this.apply({
				type: 'act.sending',
				itemId,
				action: action.type,
				...(action.type === 'allow' && action.always ? { always: true } : {}),
			})
			this.publish(true)
			this.report()
			try {
				outcome = await source.act(target, item, action)
			} catch (error) {
				outcome = { status: 'failed', detail: errorMessage(error) }
			}
			this.apply({ type: 'act.result', itemId, outcome })
			recorded = this.state.items.find(candidate => candidate.id === itemId)?.receipt?.status === outcome.status
			if (outcome.status === 'sent' && action.type === 'prompt') source.expedite?.(target, this.now() + ACT_EXPEDITE_MS)
			this.publish(true)
			this.report()
			await this.flush()
		} finally {
			this.acting = false
		}
		// See it land as soon as possible.
		this.poke()
		return { ok: outcome.status === 'sent', outcome, recorded }
	}

	/**
	 * A reply from the agent detail to an agent that owes Jakub nothing (renderer IPC input,
	 * validated here). Like act(): preconditions → `prompt.sending` (published) → source CAS read
	 * + prompt POST → the session's reply receipt. An agent with a live item is answered through
	 * that item instead. `queue` (a Signals hand-off) lets a working agent take it queued for after
	 * its turn. Resolves; never throws.
	 */
	async prompt(request: unknown): Promise<AgentDockActResult> {
		const refused = (reason: DockRefusalReason, detail = REFUSAL_TEXT[reason]): AgentDockActResult => ({
			ok: false,
			outcome: { status: 'refused', reason, detail },
		})
		const parsed = parseAgentDockPromptRequest(request)
		if (!parsed.ok) return refused('invalid', parsed.error)
		const { session: key, sessionId, assistantUuid, queue, text } = parsed.value
		if (this.stopped) return { ok: false, outcome: { status: 'failed', detail: 'The agent dock stopped.' } }
		if (this.acting) return refused('in_flight')
		const session = this.state.sessions[key]?.session
		if (!session) return refused('gone', DOCK_SOURCE_TEXT[dockSourceOfSessionKey(key)].notListed)
		if (this.state.sources[session.source]?.health.state !== 'ok')
			return refused('source_down', DOCK_SOURCE_TEXT[session.source].sourceDown)
		if (this.state.items.some(item => item.session === key && item.state !== 'resolved'))
			return refused('not_open', 'The agent has an open item; answer it there.')
		if (session.reply?.status === 'sending') return refused('in_flight')
		const source = this.options.source
		if (!source.prompt) return { ok: false, outcome: { status: 'failed', detail: 'This Helm build cannot reply.' } }
		const target: AgentDockTarget = { source: session.source, profile: session.profile, terminalId: session.terminalId }
		const expect = {
			...(sessionId ? { sessionId } : {}),
			...(assistantUuid ? { assistantUuid } : {}),
			...(queue ? { queue: true } : {}),
		}

		this.acting = true
		let outcome: DockActOutcome
		let recorded = false
		try {
			this.apply({ type: 'prompt.sending', session: key, ...(assistantUuid ? { assistantUuid } : {}) })
			this.publish(true)
			this.report()
			try {
				outcome = await source.prompt(target, expect, text)
			} catch (error) {
				outcome = { status: 'failed', detail: errorMessage(error) }
			}
			this.apply({ type: 'prompt.result', session: key, outcome })
			// A session dropped meanwhile (its source went down) keeps no reply: the renderer keeps the words.
			recorded = this.state.sessions[key]?.session.reply?.status === outcome.status
			if (outcome.status === 'sent') source.expedite?.(target, this.now() + ACT_EXPEDITE_MS)
			this.publish(true)
			this.report()
			await this.flush()
		} finally {
			this.acting = false
		}
		this.poke()
		return { ok: outcome.status === 'sent', outcome, recorded }
	}

	/** The agent's last message, read live through its source (agent detail). Never throws. */
	async readMessage(key: unknown): Promise<AgentDockMessageResult> {
		if (typeof key !== 'string' || key.length === 0 || key.length > 512) return { ok: false, detail: 'invalid agent' }
		const session = this.state.sessions[key]?.session
		if (!session) return { ok: false, detail: DOCK_SOURCE_TEXT[dockSourceOfSessionKey(key)].notListed }
		if (this.state.sources[session.source]?.health.state !== 'ok')
			return { ok: false, detail: `${DOCK_SOURCE_TEXT[session.source].label} is unreachable.` }
		const source = this.options.source
		if (!source.readMessage) return { ok: false, detail: 'This Helm build cannot read messages.' }
		try {
			return await source.readMessage({
				source: session.source,
				profile: session.profile,
				terminalId: session.terminalId,
			})
		} catch (error) {
			return { ok: false, detail: errorMessage(error) }
		}
	}

	snapshot(): AgentDockSnapshot {
		return agentDockSnapshot(this.state, this.now())
	}

	/** Current cadence interval (exported behavior for tests). */
	interval(): number {
		if (agentDockActive(this.state)) return ACTIVE_INTERVAL_MS
		if (this.pushHealthy()) return RECONCILE_INTERVAL_MS
		if (!this.visible) return BACKGROUND_INTERVAL_MS
		return this.options.isFocused() ? FOCUSED_INTERVAL_MS : UNFOCUSED_INTERVAL_MS
	}

	/** Delay to the next tick: the cadence, or sooner when a turn can be decided (settle timer). */
	nextDelay(): number {
		const now = this.now()
		const cadence = this.interval()
		const deadline = agentDockNextDeadline(this.state, now)
		if (deadline === undefined) return cadence
		return Math.min(cadence, deadline - now + SETTLE_EPSILON_MS)
	}

	/** One poll + spool write. Public for tests; the scheduler calls it. */
	async tick(): Promise<void> {
		if (this.inFlight || this.stopped || this.acting) return
		this.inFlight = true
		this.tickStarts += 1
		const readFrom = this.now()
		this.lastTickAt = readFrom
		try {
			const observed = await this.options.source.observe(this.state, readFrom)
			if (this.stopped) return
			// Stamped with when its reads began: a dock answer refused meanwhile stays refused (see reduce).
			for (const observation of observed)
				this.apply(observation.type === 'poll' ? { ...observation, readFrom } : observation)
			// Only while shown: on content change, plus a slow freshness refresh for "stale Ns" meta.
			if (this.visible) this.publish(this.now() - this.lastPublishAt >= SNAPSHOT_REFRESH_MS)
			this.report()
			await this.flush()
		} catch (error) {
			this.warn(`tick failed: ${errorMessage(error)}`)
		} finally {
			this.inFlight = false
		}
		if (this.stopped) return
		try {
			this.options.push?.sync?.()
		} catch (error) {
			this.warn(`push channel sync failed: ${errorMessage(error)}`)
		}
	}

	private pushHealthy(): boolean {
		try {
			return this.options.push?.healthy() === true
		} catch {
			return false
		}
	}

	/** Waits for queued disk writes (tests, shutdown). */
	drain(): Promise<void> {
		return this.io
	}

	private schedule(delay: number): void {
		if (this.stopped) return
		if (this.timer !== null) this.timers.clearTimeout(this.timer)
		this.timer = this.timers.setTimeout(() => {
			this.timer = null
			void this.tick().finally(() => {
				const rerun = this.rerun
				this.rerun = false
				if (this.timer === null) this.schedule(rerun ? 0 : this.nextDelay())
			})
		}, delay)
	}

	private apply(observation: AgentDockObservation): AgentDockEvent[] {
		const now = this.now()
		const replay = this.replayScope(observation)
		const { state, events, diagnostics } = reduce(this.state, observation, now)
		this.state = state
		if (
			observation.type === 'poll' &&
			state.sources[observation.source]?.seeded &&
			!this.seededAt.has(observation.source)
		)
			this.seededAt.set(observation.source, now)
		for (const event of events) {
			if (event.t !== 'item.opened') continue
			// Past its seed grace a source opens asks only for dialogs it had not listed: always live.
			if (replay === 'all' || (event.kind === 'turn' && replay?.has(event.session))) this.replayed.push(event.id)
			else this.opened.push(event.id)
		}
		for (const entry of diagnostics) this.pendingDiagnostics.push(diagnosticLine(entry))
		if (events.length > 0) {
			const sessions = Object.values(state.sessions).map(entry => entry.session)
			for (const event of events) this.pendingLines.push(dockEventLine(event, this.nextSeq++, state.items, sessions))
			const resolved = state.items.filter(item => item.state === 'resolved').map(dockSpoolItem)
			const byId = new Map(this.ledger.map(item => [item.id, item]))
			for (const item of resolved) byId.set(item.id, item)
			this.ledger = pruneLedger([...byId.values()], now)
		}
		return events
	}

	/**
	 * Which items a poll may open only as replays (state the reducer already knew, or a turn that ended
	 * while Helm was closed): all of a source's first successful poll (its seed tick) and of the
	 * SEED_REPLAY_GRACE_MS after it (asks re-registered by hooks reconnecting to a restarted Helm hub),
	 * else the turns of panes still awaiting their seed adoption (reduce.ts `seedPending`). Null: anything
	 * it opens is live.
	 */
	private replayScope(observation: AgentDockObservation): 'all' | Set<string> | null {
		if (observation.type !== 'poll') return null
		if (!this.state.sources[observation.source]?.seeded) return 'all'
		const seededAt = this.seededAt.get(observation.source)
		if (seededAt !== undefined && this.now() - seededAt < SEED_REPLAY_GRACE_MS) return 'all'
		const pending = new Set<string>()
		for (const [key, record] of Object.entries(this.state.sessions))
			if (record.seedPending && record.session.source === observation.source) pending.add(key)
		return pending.size > 0 ? pending : null
	}

	/** Tells observe() what changed (every tick, also hidden: the badge and notifications work without the dock shown). */
	private report(): void {
		const opened = this.opened.splice(0)
		const replayed = this.replayed.splice(0)
		const observe = this.options.observe
		if (!observe) return
		try {
			observe({ snapshot: this.snapshot(), opened, replayed })
		} catch (error) {
			this.warn(`observer failed: ${errorMessage(error)}`)
		}
	}

	private publish(force: boolean): void {
		const snapshot = this.snapshot()
		const digest = contentDigest(snapshot)
		if (!force && digest === this.lastPublishedDigest) return
		this.lastPublishedDigest = digest
		this.lastPublishAt = this.now()
		try {
			this.options.publish(snapshot)
		} catch (error) {
			this.warn(`publish failed: ${errorMessage(error)}`)
		}
	}

	private flush(): Promise<void> {
		this.io = this.io.then(
			() => this.writeSpool(),
			() => this.writeSpool(),
		)
		this.io = this.io.catch(error => this.warn(`spool write failed: ${errorMessage(error)}`))
		return this.io
	}

	private async writeSpool(): Promise<void> {
		const { dir } = this.options
		const now = this.now()
		await ensurePrivateDir(dir)
		if (this.pendingLines.length > 0) {
			const lines = this.pendingLines.splice(0)
			await rotateSpoolEvents(dir, now)
			await appendPrivateText(join(dir, SPOOL_EVENTS_FILE), `${lines.join('\n')}\n`)
		}
		if (this.pendingDiagnostics.length > 0) {
			const lines = this.pendingDiagnostics.splice(0)
			const path = join(dir, DIAGNOSTICS_FILE)
			const size = await stat(path).then(
				info => info.size,
				() => 0,
			)
			if (size >= DIAGNOSTICS_MAX_BYTES) await rename(path, join(dir, DIAGNOSTICS_ROTATED_FILE))
			await appendPrivateText(path, `${lines.join('\n')}\n`)
		}
		const persisted: WatcherPersisted = {
			...agentDockPersisted(this.state),
			nextSeq: this.nextSeq,
			ledger: pruneLedger(this.ledger, now),
		}
		const persistedText = JSON.stringify(persisted)
		if (persistedText !== this.lastPersisted) {
			await writePrivateFileAtomic(join(dir, SPOOL_STATE_FILE), persistedText)
			this.lastPersisted = persistedText
		}
		const snapshot = this.snapshot()
		const digest = contentDigest(snapshot)
		if (digest !== this.lastSnapshotDigest || now - this.lastSnapshotWriteAt >= SNAPSHOT_REFRESH_MS) {
			const spool = dockSpoolSnapshot(snapshot, this.ledger, now, this.pid)
			await writePrivateFileAtomic(join(dir, SPOOL_SNAPSHOT_FILE), JSON.stringify(spool))
			this.lastSnapshotDigest = digest
			this.lastSnapshotWriteAt = now
		}
	}

	private async loadPersisted(): Promise<WatcherPersisted | null> {
		const text = await readSpoolFile(join(this.options.dir, SPOOL_STATE_FILE), 4 * 1024 * 1024)
		if (text === null) return null
		let body: unknown
		try {
			body = JSON.parse(text)
		} catch {
			body = undefined
		}
		const parsed = watcherStateSchema.safeParse(body)
		if (parsed.success) return parsed.data
		// Keep the bad file for inspection instead of silently overwriting it on the next flush.
		const path = join(this.options.dir, SPOOL_STATE_FILE)
		await rename(path, `${path}.corrupt-${this.now()}`).catch(() => {})
		throw new Error(`state.json invalid: ${parsed.error.issues[0]?.message ?? 'parse failed'}`)
	}

	private warn(message: string): void {
		if (message === this.lastLog) return
		this.lastLog = message
		;(this.options.log ?? (text => console.warn(`[helm] agent dock: ${text}`)))(message)
	}
}

const DIAGNOSTICS_ROTATED_FILE = 'turn-gate.1.ndjson'

/** One turn-gate diagnostics line (session key and durations only, never transcript text). */
function diagnosticLine(entry: DockTurnGated): string {
	return JSON.stringify({
		t: entry.t,
		at: entry.at,
		session: entry.session.slice(0, 160),
		idleMs: entry.idleMs,
		seenIdleMs: entry.seenIdleMs,
		by: entry.by,
	})
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300)
