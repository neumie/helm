// Agent dock watcher scheduling with a fake clock and fake timers: push nudges from
// Helm's hub (coalesced), the settle tick at idle edge + TURN_IDLE_MS, and cadence by
// agent activity rather than window focus.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import modelModule from '../app/src/agent-dock/model.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'
import watcherModule from '../app/src/agent-dock/watcher.ts'
import hubCoreModule from '../app/src/claude-remote/hub-core.ts'
import { okenaFixture, until } from './helpers/agent-dock'

type WatcherModule = typeof import('../app/src/agent-dock/watcher.ts')
type AgentDockObservation = import('../app/src/agent-dock/model.ts').AgentDockObservation
const {
	ACTIVE_INTERVAL_MS,
	AgentDockWatcher,
	BACKGROUND_INTERVAL_MS,
	DIAGNOSTICS_FILE,
	FOCUSED_INTERVAL_MS,
	NUDGE_DEBOUNCE_MS,
	NUDGE_MIN_GAP_MS,
	SETTLE_EPSILON_MS,
	UNFOCUSED_INTERVAL_MS,
} = watcherModule as WatcherModule
const { TURN_IDLE_MS, TURN_RESUMED_MS } = reduceModule as typeof import('../app/src/agent-dock/reduce.ts')
const { sessionKey } = modelModule as typeof import('../app/src/agent-dock/model.ts')
const { ClaudeHubCore } = hubCoreModule as typeof import('../app/src/claude-remote/hub-core.ts')

type Json = Record<string, unknown>
const SHOW_IDLE = { ...okenaFixture('show-idle.json'), channel_attached: false }
const STATE_ASK = okenaFixture('state-ask.json')
const TID = SHOW_IDLE.terminal_id as string
const SID = SHOW_IDLE.session_id as string
const PROFILE = 'p1'
const T0 = 1_793_364_800_000

const idle = (overrides: Json = {}): Json => ({ ...SHOW_IDLE, ...overrides })
const working = (): Json => idle({ busy: true })
const page = (entries: Json[], cursor: number, reset = false): Json => ({ session_id: SID, entries, cursor, reset })
const assistant = (uuid: string): Json => ({ kind: 'assistant', uuid, text: 'Done.' })

let version = 100
function poll(detail: Json, transcript?: Json): AgentDockObservation {
	version += 1
	return {
		type: 'poll',
		source: 'okena',
		profile: PROFILE,
		state: { ok: true, body: { ...STATE_ASK, state_version: version, claude_sessions: [TID], claude_dialogs: {} } },
		terminals: [
			{
				terminalId: TID,
				detail: { ok: true, body: detail },
				...(transcript ? { transcript: { ok: true as const, body: transcript } } : {}),
			},
		],
	}
}

class FakeTimers {
	private nextId = 1
	/** Timers armed so far (a tick's re-arm is the next one after it). */
	armed = 0
	readonly pending = new Map<number, { run: () => void; ms: number }>()
	setTimeout = (run: () => void, ms: number): unknown => {
		const id = this.nextId++
		this.armed += 1
		this.pending.set(id, { run, ms })
		return id
	}
	clearTimeout = (handle: unknown): void => {
		this.pending.delete(handle as number)
	}
	delays(): number[] {
		return [...this.pending.values()].map(timer => timer.ms)
	}
	/** Runs the only pending timer with `ms` (asserts there is exactly one). */
	fire(ms: number): void {
		const matches = [...this.pending.entries()].filter(([, timer]) => timer.ms === ms)
		assert.equal(matches.length, 1, `one pending ${ms} ms timer (pending: ${this.delays().join(', ')})`)
		const [id, timer] = matches[0] as [number, { run: () => void; ms: number }]
		this.pending.delete(id)
		timer.run()
	}
}

class ScriptedSource {
	queue: AgentDockObservation[] = []
	observed = 0
	/** Resolve to let a held observe() finish (simulates a slow Okena). */
	hold: Promise<void> | null = null
	async observe(): Promise<AgentDockObservation[]> {
		this.observed += 1
		if (this.hold) await this.hold
		const next = this.queue.shift()
		if (!next) throw new Error('no scripted observation')
		return [next]
	}
}

function harness() {
	const dir = mkdtempSync(join(tmpdir(), 'hdc-'))
	const clock = { now: T0 }
	const timers = new FakeTimers()
	const source = new ScriptedSource()
	let focused = false
	const watcher = new AgentDockWatcher({
		dir: join(dir, 'agent-dock'),
		source,
		publish: () => {},
		isFocused: () => focused,
		now: () => clock.now,
		log: () => {},
		timers,
	})
	/** Fires the pending `ms` timer at the current clock and waits for its tick to re-arm the cadence timer. */
	const fireTick = async (ms: number, observation?: AgentDockObservation) => {
		if (observation) source.queue.push(observation)
		const armed = timers.armed
		timers.fire(ms)
		await until(() => timers.armed > armed, 'tick re-armed')
		await watcher.drain()
	}
	return {
		dir,
		clock,
		timers,
		source,
		watcher,
		fireTick,
		setFocused: (value: boolean) => {
			focused = value
		},
		cleanup: () => {
			watcher.stop()
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

test('settle timer: the tick lands at idle edge + TURN_IDLE_MS (+epsilon) and opens the turn then', async () => {
	const h = harness()
	try {
		await h.watcher.start()
		assert.deepEqual(h.timers.delays(), [0])
		await h.fireTick(0, poll(working(), page([assistant('a0')], 1000, true)))
		assert.deepEqual(h.timers.delays(), [ACTIVE_INTERVAL_MS], 'a busy agent: 1 s cadence even unfocused and hidden')

		const edge = T0 + 1000
		h.clock.now = edge
		await h.fireTick(ACTIVE_INTERVAL_MS, poll(idle(), page([assistant('b1')], 1100)))
		assert.deepEqual(h.timers.delays(), [ACTIVE_INTERVAL_MS], 'held turn: still 1 s, the deadline is 8 s away')

		h.clock.now = edge + 7_500
		await h.fireTick(ACTIVE_INTERVAL_MS, poll(idle()))
		const settle = TURN_IDLE_MS - 7_500 + SETTLE_EPSILON_MS
		assert.deepEqual(h.timers.delays(), [settle], 'next tick exactly at the deadline, not the next cadence tick')

		h.clock.now = edge + 7_500 + settle
		await h.fireTick(settle, poll(idle()))
		const opened = h.watcher.snapshot().items.find(item => item.kind === 'turn')
		assert.equal(opened?.state, 'open')
		assert.equal(opened?.openedAt, edge + TURN_IDLE_MS + SETTLE_EPSILON_MS)
		assert.deepEqual(h.timers.delays(), [BACKGROUND_INTERVAL_MS], 'all idle, dock hidden: back to 5 s')
	} finally {
		h.cleanup()
	}
})

test('settle timer: a live turn on a busy pane closes right at busy edge + TURN_RESUMED_MS', async () => {
	const h = harness()
	try {
		await h.watcher.start()
		await h.fireTick(0, poll(working(), page([assistant('a0')], 1000, true)))
		h.clock.now = T0 + 1000
		await h.fireTick(ACTIVE_INTERVAL_MS, poll(idle(), page([assistant('b1')], 1100)))
		h.clock.now = T0 + 1000 + TURN_IDLE_MS
		await h.fireTick(ACTIVE_INTERVAL_MS, poll(idle()))
		assert.equal(h.watcher.snapshot().items[0]?.state, 'open')

		const busyAt = h.clock.now + 4_000
		h.clock.now = busyAt
		await h.fireTick(BACKGROUND_INTERVAL_MS, poll(working()))
		h.clock.now = busyAt + TURN_RESUMED_MS - 200
		await h.fireTick(ACTIVE_INTERVAL_MS, poll(working()))
		assert.deepEqual(h.timers.delays(), [200 + SETTLE_EPSILON_MS])
		h.clock.now += 200 + SETTLE_EPSILON_MS
		await h.fireTick(200 + SETTLE_EPSILON_MS, poll(working()))
		assert.equal(h.watcher.snapshot().items[0]?.resolution?.by, 'superseded')
		assert.deepEqual(h.timers.delays(), [ACTIVE_INTERVAL_MS], 'still busy: 1 s, no settle timer left')
	} finally {
		h.cleanup()
	}
})

test('cadence follows agent activity first, then dock visibility and focus', async () => {
	const h = harness()
	try {
		await h.watcher.start()
		await h.fireTick(0, poll(idle(), page([assistant('a0')], 1000, true)))
		assert.equal(h.watcher.interval(), BACKGROUND_INTERVAL_MS, 'idle fleet, dock hidden')
		h.watcher.setVisible(true)
		assert.equal(h.watcher.interval(), UNFOCUSED_INTERVAL_MS)
		h.setFocused(true)
		assert.equal(h.watcher.interval(), FOCUSED_INTERVAL_MS, 'the focused fast path stays')
		h.watcher.setVisible(false)
		h.setFocused(false)
		// setVisible(true) poked: run that tick with a busy pane.
		h.clock.now += 1000
		await h.fireTick(0, poll(working()))
		assert.equal(h.watcher.interval(), ACTIVE_INTERVAL_MS, 'busy agent: 1 s while hidden and unfocused')
		assert.deepEqual(h.timers.delays(), [ACTIVE_INTERVAL_MS])
	} finally {
		h.cleanup()
	}
})

test('nudge: a burst of hub changes is one debounced tick; a tick that began after it covers it', async () => {
	const h = harness()
	try {
		await h.watcher.start()
		await h.fireTick(0, poll(idle(), page([assistant('a0')], 1000, true)))
		assert.deepEqual(h.timers.delays(), [BACKGROUND_INTERVAL_MS])

		// Right after a tick: the min gap since that tick bounds the delay.
		for (let i = 0; i < 20; i++) h.watcher.nudge()
		assert.deepEqual(h.timers.delays().sort(), [BACKGROUND_INTERVAL_MS, NUDGE_MIN_GAP_MS].sort())
		h.clock.now += NUDGE_MIN_GAP_MS
		h.timers.fire(NUDGE_MIN_GAP_MS)
		assert.deepEqual(h.timers.delays(), [0], 'the nudge replaced the cadence timer with an immediate tick')
		await h.fireTick(0, poll(idle()))
		assert.equal(h.source.observed, 2)

		// Long after the last tick: just the debounce.
		h.clock.now += 2_000
		h.watcher.nudge()
		h.watcher.nudge()
		assert.deepEqual(
			h.timers.delays().sort((a, b) => a - b),
			[NUDGE_DEBOUNCE_MS, BACKGROUND_INTERVAL_MS],
		)
		// The cadence tick happens to begin first: it read the change, so the nudge does nothing.
		h.clock.now += 50
		await h.fireTick(BACKGROUND_INTERVAL_MS, poll(idle()))
		h.clock.now += 50
		h.timers.fire(NUDGE_DEBOUNCE_MS)
		assert.deepEqual(h.timers.delays(), [BACKGROUND_INTERVAL_MS], 'no extra tick')
		assert.equal(h.source.observed, 3)
	} finally {
		h.cleanup()
	}
})

test('nudge during a slow tick runs exactly one more tick after it; stop() cancels a pending nudge', async () => {
	const h = harness()
	try {
		await h.watcher.start()
		await h.fireTick(0, poll(idle(), page([assistant('a0')], 1000, true)))
		let release: () => void = () => {}
		h.source.hold = new Promise(resolve => {
			release = resolve
		})
		h.source.queue.push(poll(idle()))
		h.clock.now += BACKGROUND_INTERVAL_MS
		h.timers.fire(BACKGROUND_INTERVAL_MS)
		await until(() => h.source.observed === 2, 'slow tick started')
		// The change lands while that tick is waiting on Okena (it may have read the hub already).
		h.watcher.nudge()
		h.clock.now += NUDGE_MIN_GAP_MS
		h.timers.fire(NUDGE_MIN_GAP_MS)
		h.watcher.poke()
		assert.deepEqual(h.timers.delays(), [], 'no second tick while one is in flight')
		h.source.hold = null
		h.source.queue.push(poll(idle()))
		release()
		await until(() => h.timers.pending.size === 1, 'rerun armed')
		assert.deepEqual(h.timers.delays(), [0], 'one rerun right after the slow tick')
		await h.fireTick(0)
		assert.equal(h.source.observed, 3)
		assert.deepEqual(h.timers.delays(), [BACKGROUND_INTERVAL_MS])

		h.watcher.nudge()
		h.watcher.stop()
		assert.deepEqual(h.timers.delays(), [])
		h.watcher.nudge()
		assert.deepEqual(h.timers.delays(), [])
	} finally {
		h.cleanup()
	}
})

test('gate diagnostics land in their own file, never in the dispatcher event stream', async () => {
	const h = harness()
	try {
		await h.watcher.start()
		await h.fireTick(0, poll(working(), page([assistant('a0')], 1000, true)))
		h.clock.now = T0 + 1000
		await h.fireTick(ACTIVE_INTERVAL_MS, poll(idle(), page([assistant('b1')], 1100)))
		h.clock.now = T0 + 4000
		await h.fireTick(ACTIVE_INTERVAL_MS, poll(working()))
		const dir = join(h.dir, 'agent-dock')
		const lines = readFileSync(join(dir, DIAGNOSTICS_FILE), 'utf8').trim().split('\n')
		assert.deepEqual(
			lines.map(line => JSON.parse(line)),
			[
				{
					t: 'turn.gated',
					at: T0 + 4000,
					session: sessionKey(PROFILE, TID),
					idleMs: 3000,
					seenIdleMs: 0,
					by: 'working',
				},
			],
		)
		const events = existsSync(join(dir, 'events.ndjson')) ? readFileSync(join(dir, 'events.ndjson'), 'utf8') : ''
		assert.equal(events.includes('turn.gated'), false)
	} finally {
		h.cleanup()
	}
})

test('hub changes notify listeners synchronously; a throwing listener breaks nothing', () => {
	const core = new ClaudeHubCore({ prefix: 'abcd1234' })
	let calls = 0
	core.onChange(() => {
		throw new Error('listener bug')
	})
	const off = core.onChange(() => {
		calls += 1
	})
	const before = core.stateVersion
	core.shutdown()
	assert.equal(calls, 1)
	assert.equal(core.stateVersion, before + 1)
	off()
	core.shutdown()
	assert.equal(calls, 1)
})
