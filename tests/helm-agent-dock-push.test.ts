// Okena push for the agent dock: OkenaStreamSubscription (okena-stream.ts) with a
// fake opener and fake timers (nudge on state_changed, echo, backoff, no route,
// profile/daemon following, UI-owned lease, resume, stop), the same over a real
// socket to a fake Okena, the watcher cadence with the stream up/down, and the
// Okena source's push coverage (every Claude pane reports a lifecycle).

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sourceModule from '../app/src/agent-dock/okena-claude-source.ts'
import streamModule from '../app/src/agent-dock/okena-stream.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'
import watcherModule from '../app/src/agent-dock/watcher.ts'
import type { OkenaStreamTarget } from '../src/extensions/okena/client.js'
import type { OkenaStreamEnd, OkenaStreamHandlers } from '../src/extensions/okena/stream.js'
import { okenaFixture, until } from './helpers/agent-dock'
import { FakeOkenaStreamServer } from './helpers/fake-okena-stream'

type StreamModule = typeof import('../app/src/agent-dock/okena-stream.ts')
type WatcherModule = typeof import('../app/src/agent-dock/watcher.ts')
type AgentDockObservation = import('../app/src/agent-dock/model.ts').AgentDockObservation
type OkenaClaudeClient = import('../app/src/agent-dock/okena-claude-source.ts').OkenaClaudeClient

const {
	OkenaStreamSubscription,
	STREAM_BACKOFF_MAX_MS,
	STREAM_BACKOFF_MIN_MS,
	STREAM_ECHO_MS,
	STREAM_STABLE_MS,
	UI_OWNED_LEASE_MS,
} = streamModule as StreamModule
const {
	ACTIVE_INTERVAL_MS,
	AgentDockWatcher,
	BACKGROUND_INTERVAL_MS,
	FOCUSED_INTERVAL_MS,
	RECONCILE_INTERVAL_MS,
	UNFOCUSED_INTERVAL_MS,
} = watcherModule as WatcherModule
const { OkenaClaudeSource } = sourceModule as typeof import('../app/src/agent-dock/okena-claude-source.ts')
const { createAgentDockState } = reduceModule as typeof import('../app/src/agent-dock/reduce.ts')

class FakeTimers {
	private nextId = 1
	now = 0
	readonly pending = new Map<number, { run: () => void; at: number; ms: number }>()
	setTimeout = (run: () => void, ms: number): unknown => {
		const id = this.nextId++
		this.pending.set(id, { run, at: this.now + ms, ms })
		return id
	}
	clearTimeout = (handle: unknown): void => {
		this.pending.delete(handle as number)
	}
	delays(): number[] {
		return [...this.pending.values()].map(timer => timer.ms).sort((a, b) => a - b)
	}
	/** Advance the clock by `ms`, running every timer due on the way (in order). */
	advance(ms: number): void {
		const end = this.now + ms
		for (;;) {
			const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)
			const first = due[0]
			if (!first) break
			this.pending.delete(first[0])
			this.now = Math.max(this.now, first[1].at)
			first[1].run()
		}
		this.now = end
	}
}

interface FakeSocket {
	target: { endpoint: OkenaStreamTarget['endpoint']; token?: string }
	handlers: OkenaStreamHandlers
	closed: boolean
	open(): void
	state(version: number): void
	other(name: string): void
	/** Okena ends it (the real client reports every end through onClose, asynchronously). */
	end(end: Partial<OkenaStreamEnd>): void
}

/** An opener recording every socket; tests drive each one (open, frames, end). */
function fakeOpener() {
	const sockets: FakeSocket[] = []
	const open = (target: FakeSocket['target'], handlers: OkenaStreamHandlers) => {
		let ended = false
		let opened = false
		const finish = (end: Partial<OkenaStreamEnd>) => {
			if (ended) return
			ended = true
			handlers.onClose({ reason: 'closed', opened, ...end })
		}
		const socket: FakeSocket = {
			target,
			handlers,
			closed: false,
			open: () => {
				opened = true
				handlers.onOpen()
			},
			state: version => handlers.onFrame({ type: 'state_changed', stateVersion: version }),
			other: name => handlers.onFrame({ type: 'other', name }),
			end: end => finish(end),
		}
		sockets.push(socket)
		return {
			close: () => {
				socket.closed = true
				finish({ reason: 'closed' })
			},
		}
	}
	return { sockets, open, last: () => sockets.at(-1) as FakeSocket }
}

const unix = (path: string, pid = 100, uiOwned = false): OkenaStreamTarget => ({
	endpoint: { kind: 'unixSocket', socketPath: path },
	token: 'tok',
	pid,
	uiOwned,
})

function subscription(initial: { profile: string | null; targets: Record<string, OkenaStreamTarget | null> }) {
	const timers = new FakeTimers()
	const opener = fakeOpener()
	const okena = { ...initial }
	let changes = 0
	const logs: string[] = []
	const stream = new OkenaStreamSubscription({
		client: {
			activeProfileId: () => okena.profile,
			forProfile: profile => ({ streamTarget: () => okena.targets[profile] ?? null }),
		},
		onChange: () => {
			changes += 1
		},
		open: opener.open,
		timers,
		now: () => timers.now,
		log: message => logs.push(message),
	})
	return {
		stream,
		timers,
		opener,
		okena,
		logs,
		changes: () => changes,
	}
}

test('stream: open sweeps; state_changed nudges at once plus one trailing echo per burst; other frames are ignored', () => {
	const h = subscription({ profile: 'p', targets: { p: unix('/s1') } })
	h.stream.start()
	assert.equal(h.opener.sockets.length, 1)
	assert.deepEqual(h.opener.last().target, { endpoint: { kind: 'unixSocket', socketPath: '/s1' } }, 'no token on unix')
	assert.equal(h.stream.healthy(), false, 'not before auth_ok')
	h.opener.last().open()
	assert.equal(h.stream.healthy(), true)
	assert.equal(h.changes(), 1, 'a sweep on connect')
	assert.deepEqual(h.logs, ['Okena stream connected (profile p)'])

	h.opener.last().other('system_stats_changed')
	h.opener.last().other('usage_changed')
	assert.equal(h.changes(), 1, 'stats and usage are not changes')
	h.opener.last().state(10)
	assert.equal(h.changes(), 2, 'nudged synchronously')
	h.opener.last().state(11)
	h.opener.last().state(12)
	assert.equal(h.changes(), 4, 'every frame nudges (the watcher coalesces)')
	h.timers.advance(STREAM_ECHO_MS)
	assert.equal(h.changes(), 5, 'one echo for the burst')
	h.timers.advance(10 * STREAM_ECHO_MS)
	assert.equal(h.changes(), 5)
})

test('backoff: 1 s doubling to 30 s; one log per transition; a reconnect sweeps; a stable stream resets it', () => {
	const h = subscription({ profile: 'p', targets: { p: unix('/s1') } })
	h.stream.start()
	h.opener.last().open()
	h.timers.advance(STREAM_STABLE_MS)
	const before = h.changes()
	h.opener.last().end({ reason: 'connection closed by Okena' })
	assert.equal(h.stream.healthy(), false)
	assert.equal(h.stream.status(), 'backoff')
	assert.equal(h.changes(), before + 1, 'lost: the watcher re-arms at the polling cadence')

	const delays: number[] = []
	for (let attempt = 0; attempt < 8; attempt++) {
		delays.push(...h.timers.delays())
		h.timers.advance(h.timers.delays()[0] as number)
		h.opener.last().end({ reason: 'connect failed: ECONNREFUSED' })
	}
	assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
	assert.equal(STREAM_BACKOFF_MIN_MS, 1_000)
	assert.equal(STREAM_BACKOFF_MAX_MS, 30_000)
	assert.deepEqual(h.logs, [
		'Okena stream connected (profile p)',
		'Okena stream unavailable (connection closed by Okena); polling until it reconnects',
	])
	assert.equal(h.changes(), before + 1, 'failed attempts do not tick the dock')

	h.timers.advance(30_000)
	h.opener.last().open()
	assert.equal(h.stream.healthy(), true)
	assert.equal(h.changes(), before + 2, 'sweep after reconnect')
	assert.equal(h.logs.length, 3)
	assert.equal(h.logs[2], 'Okena stream connected (profile p)')
	// Flapping (lost before STREAM_STABLE_MS): the backoff keeps growing.
	h.opener.last().end({ reason: 'connection closed by Okena' })
	assert.deepEqual(h.timers.delays(), [30_000])
	h.timers.advance(30_000)
	h.opener.last().open()
	h.timers.advance(STREAM_STABLE_MS)
	h.opener.last().end({ reason: 'connection closed by Okena' })
	assert.deepEqual(h.timers.delays(), [1_000], 'stable for STREAM_STABLE_MS: back to the minimum')
})

test('no route: an Okena answering 404 stays on polling silently and is retried at the cap', () => {
	const h = subscription({ profile: 'p', targets: { p: unix('/s1') } })
	h.stream.start()
	h.opener.last().end({ reason: 'upgrade refused (HTTP 404)', httpStatus: 404 })
	assert.equal(h.stream.status(), 'unsupported')
	assert.equal(h.stream.healthy(), false)
	assert.deepEqual(h.logs, [])
	assert.equal(h.changes(), 0)
	assert.deepEqual(h.timers.delays(), [STREAM_BACKOFF_MAX_MS])
	h.timers.advance(STREAM_BACKOFF_MAX_MS)
	h.opener.last().end({ reason: 'upgrade refused (HTTP 404)', httpStatus: 404 })
	assert.equal(h.opener.sockets.length, 2)
	assert.deepEqual(h.logs, [])
	// Okena upgraded in place: the next retry connects.
	h.timers.advance(STREAM_BACKOFF_MAX_MS)
	h.opener.last().open()
	assert.equal(h.stream.healthy(), true)
})

test('follows the dock profile and daemon: a switch or restart reconnects; removal closes cleanly', () => {
	const h = subscription({ profile: 'p', targets: { p: unix('/s1'), q: unix('/s2', 200) } })
	h.stream.start()
	h.opener.last().open()
	h.stream.sync()
	assert.equal(h.opener.sockets.length, 1, 'same target: nothing to do')

	h.okena.profile = 'q'
	h.stream.sync()
	assert.equal(h.opener.sockets[0]?.closed, true, 'old profile closed cleanly')
	assert.equal(h.opener.sockets.length, 2)
	assert.deepEqual(h.opener.last().target.endpoint, { kind: 'unixSocket', socketPath: '/s2' })
	h.opener.last().open()

	h.okena.targets.q = unix('/s2', 201)
	h.stream.sync()
	assert.equal(h.opener.sockets[1]?.closed, true, 'restarted daemon (new pid): reconnect')
	assert.equal(h.opener.sockets.length, 3)
	h.opener.last().open()

	h.okena.targets.q = null
	h.stream.sync()
	assert.equal(h.opener.sockets[2]?.closed, true, 'Okena gone / profile removed: closed')
	assert.equal(h.stream.status(), 'off')
	assert.equal(h.stream.healthy(), false)
	assert.equal(h.logs.at(-1), 'Okena stream closed (Okena not running); polling')
	h.timers.advance(5 * STREAM_BACKOFF_MAX_MS)
	assert.equal(h.opener.sockets.length, 3, 'no retries without a daemon; sync() finds the next one')

	h.okena.targets.q = unix('/s3', 300)
	h.stream.sync()
	assert.equal(h.opener.sockets.length, 4)
	assert.deepEqual(h.opener.last().target.endpoint, { kind: 'unixSocket', socketPath: '/s3' })
})

test('TCP: the token travels to the opener; a stale one backs off', () => {
	const target: OkenaStreamTarget = {
		endpoint: { kind: 'http', baseUrl: 'http://127.0.0.1:19100' },
		token: 'tok',
		pid: 1,
		uiOwned: false,
	}
	const h = subscription({ profile: 'p', targets: { p: target } })
	h.stream.start()
	assert.deepEqual(h.opener.last().target, { endpoint: target.endpoint, token: 'tok' })
	h.opener.last().end({ reason: 'auth failed', authFailed: true })
	assert.equal(h.stream.status(), 'backoff')
	assert.deepEqual(h.timers.delays(), [STREAM_BACKOFF_MIN_MS])
})

test('UI-owned daemon: the stream is a lease, released and renewed without a log or an unhealthy gap', () => {
	const h = subscription({ profile: 'p', targets: { p: unix('/s1', 100, true) } })
	h.stream.start()
	h.opener.last().open()
	const changes = h.changes()
	h.timers.advance(UI_OWNED_LEASE_MS)
	assert.equal(h.opener.sockets[0]?.closed, true, 'lease released with a clean close')
	assert.equal(h.opener.sockets.length, 2, 'renewed at once')
	assert.equal(h.stream.healthy(), true, 'healthy while renewing')
	h.opener.last().open()
	assert.equal(h.changes(), changes + 1, 'a sweep for the gap')
	assert.deepEqual(h.logs, ['Okena stream connected (profile p)'])

	// Okena quit: the daemon exits once Helm lets go, so the renewal finds nothing.
	h.timers.advance(UI_OWNED_LEASE_MS)
	h.okena.targets.p = null
	assert.equal(h.opener.sockets.length, 3)
	h.opener.last().end({ reason: 'connect failed: ENOENT' })
	assert.equal(h.stream.healthy(), false)
	assert.equal(h.logs.at(-1), 'Okena stream unavailable (connect failed: ENOENT); polling until it reconnects')
	h.timers.advance(STREAM_BACKOFF_MIN_MS)
	assert.equal(h.stream.status(), 'off')
	assert.equal(h.opener.sockets.length, 3)

	// A standalone daemon is never released.
	const s = subscription({ profile: 'p', targets: { p: unix('/s1', 100, false) } })
	s.stream.start()
	s.opener.last().open()
	s.timers.advance(10 * UI_OWNED_LEASE_MS)
	assert.equal(s.opener.sockets.length, 1)
})

test('resume reconnects at once and sweeps; stop closes and never reconnects', () => {
	const h = subscription({ profile: 'p', targets: { p: unix('/s1') } })
	h.stream.start()
	h.opener.last().open()
	const changes = h.changes()
	h.stream.resume()
	assert.equal(h.opener.sockets[0]?.closed, true)
	assert.equal(h.opener.sockets.length, 2)
	assert.equal(h.changes(), changes + 1, 'resume sweeps right away')
	h.opener.last().open()
	assert.equal(h.changes(), changes + 2, 'and again once reconnected')

	// While backing off, resume skips the wait.
	h.opener.last().end({ reason: 'stream silent' })
	assert.deepEqual(h.timers.delays(), [STREAM_BACKOFF_MIN_MS])
	h.stream.resume()
	assert.equal(h.opener.sockets.length, 3)

	h.stream.stop()
	assert.equal(h.opener.sockets[2]?.closed, true)
	assert.equal(h.stream.healthy(), false)
	h.timers.advance(10 * STREAM_BACKOFF_MAX_MS)
	h.stream.sync()
	h.stream.resume()
	assert.equal(h.opener.sockets.length, 3, 'stopped for good')
})

test('over a real socket: state_changed nudges within milliseconds; a killed daemon is swept after the reconnect', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hdp-'))
	const path = join(dir, 's.sock')
	const server = await FakeOkenaStreamServer.listen(path)
	let changes = 0
	const at: number[] = []
	const stream = new OkenaStreamSubscription({
		client: { activeProfileId: () => 'p', forProfile: () => ({ streamTarget: () => unix(path) }) },
		onChange: () => {
			changes += 1
			at.push(Date.now())
		},
		log: () => {},
	})
	try {
		stream.start()
		await until(() => stream.healthy() && changes === 1, 'connected + sweep')
		const sent = Date.now()
		server.last?.sendText('{"type":"system_stats_changed","stats":{}}')
		server.last?.sendText('{"type":"state_changed","state_version":3359}')
		await until(() => changes === 2, 'nudge')
		assert.ok((at[1] as number) - sent < 200, `nudged ${(at[1] as number) - sent} ms after the frame`)

		server.last?.kill()
		await until(() => !stream.healthy(), 'lost')
		await until(() => stream.healthy(), 'reconnected after the 1 s backoff', 4_000)
		await until(() => server.upgrades === 2, 'second upgrade')
		const sweeps = changes
		assert.ok(sweeps >= 4, 'lost + echo + reconnect sweep')
		stream.stop()
		await until(() => server.live().length === 0, 'closed on stop')
	} finally {
		stream.stop()
		await server.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

test('over a real socket: an Okena without the route stays unsupported, never healthy', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hdp-'))
	const path = join(dir, 's.sock')
	const server = await FakeOkenaStreamServer.listen(path, { notFound: true })
	const logs: string[] = []
	const stream = new OkenaStreamSubscription({
		client: { activeProfileId: () => 'p', forProfile: () => ({ streamTarget: () => unix(path) }) },
		onChange: () => {},
		log: message => logs.push(message),
	})
	try {
		stream.start()
		await until(() => stream.status() === 'unsupported', 'unsupported')
		assert.equal(stream.healthy(), false)
		assert.deepEqual(logs, [])
	} finally {
		stream.stop()
		await server.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

// --- watcher cadence with the push channel ----------------------------------------------

type Json = Record<string, unknown>
const SHOW_IDLE = { ...okenaFixture('show-idle.json'), channel_attached: false }
const STATE_ASK = okenaFixture('state-ask.json')
const TID = SHOW_IDLE.terminal_id as string
let version = 100
function poll(detail: Json): AgentDockObservation {
	version += 1
	return {
		type: 'poll',
		source: 'okena',
		profile: 'p1',
		state: { ok: true, body: { ...STATE_ASK, state_version: version, claude_sessions: [TID], claude_dialogs: {} } },
		terminals: [{ terminalId: TID, detail: { ok: true, body: detail } }],
	}
}

function watcherWith(push: { healthy(): boolean; sync?(): void }) {
	const dir = mkdtempSync(join(tmpdir(), 'hdw-'))
	const timers = new FakeTimers()
	const queue: AgentDockObservation[] = []
	let focused = false
	const watcher = new AgentDockWatcher({
		dir: join(dir, 'agent-dock'),
		source: {
			observe: async () => {
				const next = queue.shift()
				if (!next) throw new Error('no scripted observation')
				return [next]
			},
		},
		publish: () => {},
		isFocused: () => focused,
		now: () => 1_793_364_800_000 + timers.now,
		log: () => {},
		timers,
		push,
	})
	return {
		watcher,
		timers,
		queue,
		setFocused: (value: boolean) => {
			focused = value
		},
		cleanup: () => {
			watcher.stop()
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

test('cadence: a healthy stream relaxes idle ticks to the 15 s reconciliation; active stays 1 s; down = polling', async () => {
	let healthy = true
	let syncs = 0
	const h = watcherWith({
		healthy: () => healthy,
		sync: () => {
			syncs += 1
		},
	})
	try {
		await h.watcher.start()
		h.queue.push(poll(SHOW_IDLE))
		h.timers.advance(0)
		await until(() => h.timers.delays().length === 1 && syncs === 1, 'first tick re-armed')
		assert.deepEqual(h.timers.delays(), [RECONCILE_INTERVAL_MS], 'idle + stream up: 15 s, hidden')
		h.watcher.setVisible(true)
		h.setFocused(true)
		assert.equal(h.watcher.interval(), RECONCILE_INTERVAL_MS, 'focused and shown too: the stream pushes')

		healthy = false
		assert.equal(h.watcher.interval(), FOCUSED_INTERVAL_MS, 'stream down: the polling cadence')
		h.setFocused(false)
		assert.equal(h.watcher.interval(), UNFOCUSED_INTERVAL_MS)
		h.watcher.setVisible(false)
		assert.equal(h.watcher.interval(), BACKGROUND_INTERVAL_MS)

		// Busy agent: 1 s whatever the stream does (Okena's busy flip alone pushes nothing).
		healthy = true
		h.queue.push(poll({ ...SHOW_IDLE, busy: true }))
		h.watcher.poke()
		h.timers.advance(0)
		await until(() => syncs === 2, 'second tick')
		await until(() => h.timers.delays().includes(ACTIVE_INTERVAL_MS), 're-armed')
		assert.equal(h.watcher.interval(), ACTIVE_INTERVAL_MS)
		assert.equal(syncs, 2, 'the push channel syncs after every tick')
	} finally {
		h.cleanup()
	}
})

test('cadence: a push channel that throws counts as down', async () => {
	const h = watcherWith({
		healthy: () => {
			throw new Error('boom')
		},
		sync: () => {
			throw new Error('boom')
		},
	})
	try {
		await h.watcher.start()
		h.queue.push(poll(SHOW_IDLE))
		h.timers.advance(0)
		await until(() => h.timers.delays().length === 1, 're-armed')
		assert.deepEqual(h.timers.delays(), [BACKGROUND_INTERVAL_MS])
	} finally {
		h.cleanup()
	}
})

// --- Okena source push coverage --------------------------------------------------------

class CoverageOkena implements OkenaClaudeClient {
	state: unknown
	fail = false
	constructor(state: unknown) {
		this.state = state
	}
	activeProfileId(): string | null {
		return 'p'
	}
	forProfile(): OkenaClaudeClient {
		return this
	}
	async getStateJson(): Promise<unknown> {
		if (this.fail) throw new Error('ECONNREFUSED')
		return structuredClone(this.state)
	}
	async getClaudeSession(): Promise<unknown> {
		return structuredClone(SHOW_IDLE)
	}
	async getClaudeTranscript(): Promise<unknown> {
		return { session_id: SHOW_IDLE.session_id, entries: [], cursor: 0, reset: true }
	}
}

test('push coverage: only when every Claude pane reports a lifecycle and the state read succeeded', async () => {
	const project = (status?: Json): Json => ({
		id: 'proj',
		name: 'proj',
		...(status ? { terminal_agent_status: status } : {}),
	})
	const base = { ...STATE_ASK, claude_sessions: [TID], claude_dialogs: {} }
	const okena = new CoverageOkena({
		...base,
		projects: [project({ [TID]: { lifecycle: 'done', labels: { app: 'claude-code' } } })],
	})
	const source = new OkenaClaudeSource(okena)
	assert.equal(source.pushCovered(), false, 'nothing observed yet')
	await source.observe(createAgentDockState(null, 0), 1_000)
	assert.equal(source.pushCovered(), true)

	okena.state = {
		...base,
		claude_sessions: [TID, 'other-pane'],
		projects: [project({ [TID]: { lifecycle: 'working' } })],
	}
	await source.observe(createAgentDockState(null, 0), 2_000)
	assert.equal(source.pushCovered(), false, 'a pane without a lifecycle flips busy unseen by the stream')

	for (const lifecycle of ['working', 'blocked']) {
		okena.state = { ...base, projects: [project({ [TID]: { lifecycle } })] }
		await source.observe(createAgentDockState(null, 0), 2_500)
		assert.equal(
			source.pushCovered(),
			false,
			`${lifecycle}: Okena's busy hook may still be in flight, and its flip bumps no state_version`,
		)
	}
	for (const lifecycle of ['idle', 'error']) {
		okena.state = { ...base, projects: [project({ [TID]: { lifecycle } })] }
		await source.observe(createAgentDockState(null, 0), 2_600)
		assert.equal(source.pushCovered(), true, `${lifecycle}: at rest`)
	}

	okena.state = { ...base, projects: [project({ [TID]: { lifecycle: 42 } })] }
	await source.observe(createAgentDockState(null, 0), 3_000)
	assert.equal(source.pushCovered(), false, 'malformed status = absent, and the state still parses')

	okena.state = { ...base, claude_sessions: [], projects: [] }
	await source.observe(createAgentDockState(null, 0), 4_000)
	assert.equal(source.pushCovered(), true, 'no Claude panes: a new one bumps state_version')

	okena.fail = true
	await source.observe(createAgentDockState(null, 0), 5_000)
	assert.equal(source.pushCovered(), false, 'Okena unreadable')
})
