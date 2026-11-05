// Agent dock background notifications + Dock badge: the policy (agent-dock/notifier.ts), the
// watcher's live-vs-replay split it relies on, its Electron wiring with a mocked Notification and
// app.dock (agent-dock-notify-main.ts), the setting's IPC (agent-dock-main.ts) and main.ts' use.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import dockMainModule from '../app/src/agent-dock-main.ts'
import notifyMainModule from '../app/src/agent-dock-notify-main.ts'
import notifierModule from '../app/src/agent-dock/notifier.ts'
import watcherModule from '../app/src/agent-dock/watcher.ts'
import runtimeModule from '../app/src/claude-remote/runtime.ts'
import { okenaFixture } from './helpers/agent-dock'

type NotifierModule = typeof import('../app/src/agent-dock/notifier.ts')
type NotifyMainModule = typeof import('../app/src/agent-dock-notify-main.ts')
type WatcherModule = typeof import('../app/src/agent-dock/watcher.ts')
type DockMainModule = typeof import('../app/src/agent-dock-main.ts')
type RuntimeModule = typeof import('../app/src/claude-remote/runtime.ts')
type AgentDockSnapshot = import('../app/src/agent-dock/model.ts').AgentDockSnapshot
type AgentDockObservation = import('../app/src/agent-dock/model.ts').AgentDockObservation
type DockItem = import('../app/src/agent-dock/model.ts').DockItem
type DockSession = import('../app/src/agent-dock/model.ts').DockSession
type AgentDockNotice = import('../app/src/agent-dock/notifier.ts').AgentDockNotice
type AgentDockUpdate = import('../app/src/agent-dock/notifier.ts').AgentDockUpdate

const {
	AgentDockNotifier,
	NOTIFY_BODY_MAX,
	NOTIFY_BURST_MS,
	NOTIFY_RELIST_MS,
	NOTIFY_TURN_COOLDOWN_MS,
	itemNotice,
	noticeBody,
} = notifierModule as NotifierModule
const { agentDockNotifyOptions } = notifyMainModule as NotifyMainModule
const { AgentDockWatcher, SEED_REPLAY_GRACE_MS } = watcherModule as WatcherModule
const { createAgentDockMain } = dockMainModule as DockMainModule
const { HOOK_FILE, PRELOAD_FILE } = runtimeModule as RuntimeModule

// ---------------------------------------------------------------------------
// Synthetic snapshots
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000

function session(key: string, branch: string, project = 'helm'): DockSession {
	return {
		key,
		source: 'okena',
		profile: 'p',
		terminalId: key.split(':')[1] ?? key,
		project,
		name: `pane ${key}`,
		branch,
		status: 'waiting',
		since: T0,
		observedAt: T0,
		subagents: 0,
		backgroundTasks: 0,
		backgroundShells: 0,
		queuedPrompts: 0,
		prLinks: [],
		hasTranscript: true,
		hooksAttached: true,
		channelAttached: false,
	}
}

function ask(id: number, sessionKey: string, tool = 'AskUserQuestion', input?: unknown): DockItem {
	return {
		id,
		key: `ask:${sessionKey}:d${id}`,
		kind: 'ask',
		session: sessionKey,
		openedAt: T0,
		state: 'open',
		fact: {
			kind: 'ask',
			dialogId: `d${id}`,
			tool,
			input: input ?? { questions: [{ question: `Which colour, #${id}?\nsecond line`, options: [{ label: 'Red' }] }] },
			createdAtMs: T0,
		},
	}
}

function turn(id: number, sessionKey: string, text = 'Done: shipped the fix.\n\nAnything else?'): DockItem {
	return {
		id,
		key: `turn:${sessionKey}:u${id}`,
		kind: 'turn',
		session: sessionKey,
		openedAt: T0,
		state: 'open',
		fact: { kind: 'turn', assistantUuid: `u${id}`, text, endedAt: T0, hadBackground: false },
	}
}

const SESSIONS = [
	session('p:t1', 'feat/agent-dock-notifications'),
	session('p:t2', 'fix/company-create-save-firm', 'crm'),
	session('p:t3', 'chore/bump-deps'),
	session('p:t4', 'feat/fourth'),
]

function snap(items: DockItem[]): AgentDockSnapshot {
	const health = { state: 'ok' as const, since: T0, lastObservedAt: T0 }
	return { generatedAt: T0, source: health, sources: { okena: health }, sessions: SESSIONS, items }
}

const update = (items: DockItem[], opened: number[] = [], replayed: number[] = []): AgentDockUpdate => ({
	snapshot: snap(items),
	opened,
	replayed,
})

function rig(options: { foreground?: boolean; idleBadge?: string } = {}) {
	const clock = { now: T0 }
	const shown: Array<{ notice: AgentDockNotice; click: () => void; closed: boolean }> = []
	const badges: string[] = []
	const opened: Array<number | null> = []
	let foreground = options.foreground ?? false
	const notifier = new AgentDockNotifier({
		show: (notice, click) => {
			const entry = { notice, click, closed: false }
			shown.push(entry)
			return {
				close: () => {
					entry.closed = true
				},
			}
		},
		setBadge: text => badges.push(text),
		isForeground: () => foreground,
		openItem: itemId => opened.push(itemId),
		now: () => clock.now,
		...(options.idleBadge !== undefined ? { idleBadge: options.idleBadge } : {}),
		log: () => {},
	})
	const live = () => shown.filter(entry => !entry.closed)
	return {
		clock,
		notifier,
		shown,
		live,
		badges,
		opened,
		setForeground: (value: boolean) => {
			foreground = value
		},
	}
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test('notifier: a newly opened ask notifies with the agent name, kind · project and the first line; sound on', () => {
	const r = rig()
	r.notifier.update(update([ask(1, 'p:t2')], [1]))
	assert.equal(r.shown.length, 1)
	assert.deepEqual(r.shown[0]?.notice, {
		title: 'company-create-save-firm',
		subtitle: 'Question · crm',
		body: 'Which colour, #1?',
		silent: false,
	})
})

test('notifier: turns are silent and say "Turn ended"; permission and plan bodies are the command and the plan title', () => {
	const t = turn(1, 'p:t1')
	assert.deepEqual(itemNotice(snap([t]), t), {
		title: 'agent-dock-notifications',
		subtitle: 'Turn ended · helm',
		body: 'Done: shipped the fix.',
		silent: true,
	})
	const bash = ask(2, 'p:t1', 'Bash', { command: 'git push --force-with-lease\necho done', description: 'push' })
	assert.equal(itemNotice(snap([bash]), bash).subtitle, 'Permission · helm')
	assert.equal(noticeBody(bash), 'git push --force-with-lease')
	assert.equal(noticeBody(ask(3, 'p:t1', 'WebFetch', { url: 'https://example.com' })), 'Allow WebFetch?')
	const plan = ask(4, 'p:t1', 'ExitPlanMode', { plan: '\n# Notifications plan\n\n1. Do it' })
	assert.equal(itemNotice(snap([plan]), plan).subtitle, 'Plan · helm')
	assert.equal(noticeBody(plan), 'Notifications plan')
	// Bounded to one line of NOTIFY_BODY_MAX characters, control characters stripped.
	const long = turn(5, 'p:t1', `${'x'.repeat(400)}\u0007`)
	assert.ok(noticeBody(long).length <= NOTIFY_BODY_MAX)
	assert.ok(!noticeBody(long).includes('\u0007'))
})

test('notifier: nothing while Helm is in front, for replays, twice for one item, or with the setting off', () => {
	const r = rig({ foreground: true })
	r.notifier.update(update([ask(1, 'p:t1')], [1]))
	assert.equal(r.shown.length, 0, 'Helm focused: the strip pulse covers it')
	r.setForeground(false)
	// The same item reported again later (re-observation) is never notified after the fact.
	r.notifier.update(update([ask(1, 'p:t1')], [1]))
	assert.equal(r.shown.length, 0)
	// A seed/restart replay is never notified.
	r.notifier.update(update([ask(1, 'p:t1'), turn(2, 'p:t2')], [], [2]))
	r.notifier.update(update([ask(1, 'p:t1'), turn(2, 'p:t2')], [2]))
	assert.equal(r.shown.length, 0)
	// Setting off.
	r.notifier.setEnabled(false)
	r.notifier.update(update([ask(3, 'p:t3')], [3]))
	assert.equal(r.shown.length, 0)
	r.notifier.setEnabled(true)
	r.notifier.update(update([ask(3, 'p:t3'), ask(4, 'p:t3')], [4]))
	assert.equal(r.shown.length, 1)
	// An item already answered by the time it is reported never notifies.
	const sending = { ...ask(5, 'p:t4'), state: 'sending' as const }
	r.notifier.update(update([sending], [5]))
	assert.equal(r.shown.length, 1)
})

test('notifier: one live notification per agent; a newer one replaces the older', () => {
	const r = rig()
	r.notifier.update(update([turn(1, 'p:t1')], [1]))
	r.clock.now += 5_000
	r.notifier.update(update([turn(1, 'p:t1'), ask(2, 'p:t1')], [2]))
	assert.equal(r.shown.length, 2)
	assert.equal(r.shown[0]?.closed, true, 'the older notification of the same agent closed')
	assert.deepEqual(
		r.live().map(entry => entry.notice.subtitle),
		['Question · helm'],
	)
	// Two asks of one agent in one update: only the newest shows.
	r.notifier.update(update([ask(3, 'p:t2'), ask(4, 'p:t2')], [3, 4]))
	assert.equal(r.live().filter(entry => entry.notice.title === 'company-create-save-firm').length, 1)
})

test('notifier: turns cool down per agent for NOTIFY_TURN_COOLDOWN_MS; asks never do', () => {
	const r = rig()
	r.notifier.update(update([turn(1, 'p:t1')], [1]))
	r.clock.now += 10_000
	r.notifier.update(update([turn(2, 'p:t1')], [2]))
	assert.equal(r.shown.length, 1, 'second turn of the same agent within the cooldown')
	// Turn 2 superseded turn 1 in the same update: the agent still waits, so its one notification stays
	// (no new banner) and now stands for turn 2.
	assert.equal(r.live().length, 1, "the superseded turn does not take the agent's notification with it")
	r.live()[0]?.click()
	assert.deepEqual(r.opened, [2])
	r.notifier.update(update([turn(3, 'p:t2')], [3]))
	assert.equal(r.shown.length, 2, 'another agent is not cooled down')
	r.notifier.update(update([ask(4, 'p:t1')], [4]))
	r.clock.now += 1_000
	r.notifier.update(update([ask(5, 'p:t1')], [5]))
	assert.equal(r.shown.length, 4, 'asks are never suppressed')
	r.clock.now += NOTIFY_TURN_COOLDOWN_MS
	r.notifier.update(update([turn(6, 'p:t1')], [6]))
	assert.equal(r.shown.length, 5, 'after the cooldown a turn notifies again')
})

test('notifier: an ask re-listed under a new dialog id (Okena hub restart) never notifies again; its notification follows it', () => {
	const r = rig()
	const bash = (id: number, at = T0) => ({
		...ask(id, 'p:t1', 'Bash', { command: 'npm test', description: 'tests' }),
		openedAt: at,
	})
	const orphan = (id: number, at: number) => ({ ...bash(id), state: 'orphaned' as const, orphanedAt: at })
	r.notifier.update(update([bash(1)], [1]))
	assert.equal(r.shown.length, 1)
	// The reducer orphans the old item and opens the same dialog under the new hub's id (same or a later tick).
	r.notifier.update(update([orphan(1, T0 + 5_000), bash(2, T0 + 6_000)], [2]))
	assert.equal(r.shown.length, 1, 'no second notification for the same waiting dialog')
	assert.equal(r.live().length, 1)
	// Answered: its notification closes although the orphan lingers.
	r.notifier.update(update([orphan(1, T0 + 5_000)]))
	assert.equal(r.live().length, 0)
	// Each orphan stands for one re-listing: the agent asking the same command again later is new.
	r.notifier.update(update([orphan(1, T0 + 5_000), bash(3, T0 + 9_000)], [3]))
	assert.equal(r.shown.length, 2)
	// So is an identical ask long after an orphan appeared.
	const s2 = rig()
	s2.notifier.update(update([orphan(1, T0), bash(2, T0 + NOTIFY_RELIST_MS + 1)], [2]))
	assert.equal(s2.shown.length, 1)
	// A click on a re-listed notification opens the live item, not the orphan.
	const c = rig()
	c.notifier.update(update([bash(1)], [1]))
	c.notifier.update(update([orphan(1, T0 + 1_000), bash(2, T0 + 1_000)], [2]))
	c.live()[0]?.click()
	assert.deepEqual(c.opened, [2])
})

test('notifier: three agents within NOTIFY_BURST_MS share one summary that replaces their own', () => {
	const r = rig()
	const items = [ask(1, 'p:t1'), turn(2, 'p:t2'), ask(3, 'p:t3')]
	r.notifier.update(update(items.slice(0, 1), [1]))
	r.clock.now += 500
	r.notifier.update(update(items.slice(0, 2), [2]))
	assert.equal(r.live().length, 2)
	r.clock.now += 500
	r.notifier.update(update(items, [3]))
	const live = r.live()
	assert.equal(live.length, 1)
	assert.deepEqual(live[0]?.notice, {
		title: '3 agents need you',
		subtitle: '2 asks · 1 turn ended',
		body: 'agent-dock-notifications, company-create-save-firm, bump-deps',
		silent: false,
	})
	// A fourth agent inside the burst joins the summary (still one notification).
	r.clock.now += 500
	r.notifier.update(update([...items, turn(4, 'p:t4')], [4]))
	assert.equal(r.live().length, 1)
	assert.equal(r.live()[0]?.notice.title, '4 agents need you')
	assert.equal(r.live()[0]?.notice.silent, true, 'only a new ask sounds again')
	// After the burst window, a new item is its own notification again.
	r.clock.now += NOTIFY_BURST_MS + 1
	r.notifier.update(update([...items, turn(4, 'p:t4'), ask(5, 'p:t2')], [5]))
	assert.equal(r.live().length, 2)
	// Three asks in one tick: straight to the summary, no individual flash.
	const s = rig()
	s.notifier.update(update(items, [1, 2, 3]))
	assert.equal(s.shown.length, 1)
	assert.equal(s.shown[0]?.notice.title, '3 agents need you')
})

test('notifier: an item that stops waiting closes its notification; a summary closes with its last item', () => {
	const r = rig()
	r.notifier.update(update([ask(1, 'p:t1')], [1]))
	r.notifier.update(update([{ ...ask(1, 'p:t1'), state: 'sending' }]))
	assert.equal(r.shown[0]?.closed, true, 'answered from the dock')
	r.notifier.update(update([turn(2, 'p:t2')], [2]))
	r.notifier.update(update([]))
	assert.equal(r.shown[1]?.closed, true, 'gone from the snapshot (acked, resolved)')

	const s = rig()
	const items = [ask(1, 'p:t1'), ask(2, 'p:t2'), ask(3, 'p:t3')]
	s.notifier.update(update(items, [1, 2, 3]))
	s.notifier.update(update([items[0] as DockItem, { ...(items[1] as DockItem), state: 'resolved' }]))
	assert.equal(s.live().length, 1, 'one item still waits: the summary stays')
	s.notifier.update(update([]))
	assert.equal(s.live().length, 0)
	// Turning the setting off closes what is shown.
	s.notifier.update(update([ask(9, 'p:t4')], [9]))
	assert.equal(s.live().length, 1)
	s.notifier.setEnabled(false)
	assert.equal(s.live().length, 0)
})

test('notifier: a click opens the dock on its item, else the next waiting one, else nothing', () => {
	const r = rig()
	r.notifier.update(update([ask(1, 'p:t1')], [1]))
	r.shown[0]?.click()
	assert.deepEqual(r.opened, [1])
	r.notifier.update(update([ask(1, 'p:t1'), turn(2, 'p:t2')], [2]))
	// Item 2 was resolved meanwhile (the notification closed too late to matter): the next waiting item.
	r.notifier.update(update([ask(1, 'p:t1')]))
	r.shown[1]?.click()
	assert.deepEqual(r.opened, [1, 1])
	r.notifier.update(update([]))
	r.shown[0]?.click()
	assert.deepEqual(r.opened, [1, 1, null])
	// A summary opens its most urgent item still waiting (queue order).
	const s = rig()
	s.notifier.update(update([ask(1, 'p:t1'), ask(2, 'p:t2'), ask(3, 'p:t3')], [1, 2, 3]))
	s.notifier.update(update([ask(2, 'p:t2'), ask(3, 'p:t3')]))
	s.shown[0]?.click()
	assert.deepEqual(s.opened, [2])
})

test('notifier: the Dock badge counts what the queue row shows, on change only; side-by-side idles on "dev"', () => {
	const r = rig({ foreground: true })
	r.notifier.update(update([]))
	assert.deepEqual(r.badges, [], 'idle badge is what main set at launch: no write')
	r.notifier.update(update([ask(1, 'p:t1'), { ...turn(2, 'p:t2'), state: 'unconfirmed' }]))
	r.notifier.update(update([ask(1, 'p:t1'), { ...turn(2, 'p:t2'), state: 'unconfirmed' }]))
	r.notifier.update(update([ask(1, 'p:t1'), { ...turn(2, 'p:t2'), state: 'resolved' }]))
	r.notifier.update(update([]))
	assert.deepEqual(r.badges, ['2', '1', ''])
	const dev = rig({ idleBadge: 'dev' })
	dev.notifier.update(update([ask(1, 'p:t1')], [1]))
	dev.notifier.update(update([]))
	assert.deepEqual(dev.badges, ['1', 'dev'])
	// The badge stays on with notifications off.
	dev.notifier.setEnabled(false)
	dev.notifier.update(update([ask(2, 'p:t1')], [2]))
	assert.deepEqual(dev.badges, ['1', 'dev', '1'])
})

// ---------------------------------------------------------------------------
// Watcher: live opens vs seed/restart replays
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>
const STATE_ASK = okenaFixture('state-ask.json')
const SHOW_ASK = { ...okenaFixture('show-ask.json'), channel_attached: false }
const SHOW_IDLE = { ...okenaFixture('show-idle.json'), channel_attached: false }
const LOG_FULL = okenaFixture('log-full.json')
const TID = SHOW_ASK.terminal_id as string
const PROFILE = 'okena-profile'
const LAST_UUID = (LOG_FULL.entries as Json[]).filter(entry => entry.kind === 'assistant').at(-1)?.uuid as string

const pollAsk = (dialogId: string): AgentDockObservation => ({
	type: 'poll',
	source: 'okena',
	profile: PROFILE,
	state: { ok: true, body: STATE_ASK },
	terminals: [
		{
			terminalId: TID,
			detail: {
				ok: true,
				body: { ...SHOW_ASK, dialogs: (SHOW_ASK.dialogs as Json[]).map(dialog => ({ ...dialog, id: dialogId })) },
			},
		},
	],
})
const pollIdle = (withTranscript: boolean): AgentDockObservation => ({
	type: 'poll',
	source: 'okena',
	profile: PROFILE,
	state: { ok: true, body: { ...STATE_ASK, claude_dialogs: {} } },
	terminals: [
		{
			terminalId: TID,
			detail: { ok: true, body: SHOW_IDLE },
			...(withTranscript ? { transcript: { ok: true as const, body: LOG_FULL } } : {}),
		},
	],
})

function watched(dir: string) {
	const clock = { now: T0 }
	const queue: AgentDockObservation[] = []
	const updates: AgentDockUpdate[] = []
	const watcher = new AgentDockWatcher({
		dir,
		source: {
			observe: async () => {
				const next = queue.shift()
				if (!next) throw new Error('no scripted observation')
				return [next]
			},
		},
		publish: () => {},
		isFocused: () => false,
		now: () => clock.now,
		log: () => {},
		observe: next => updates.push(next),
	})
	const step = async (observation: AgentDockObservation) => {
		clock.now += 1_500
		queue.push(observation)
		await watcher.tick()
		await watcher.drain()
	}
	return { watcher, step, updates, clock }
}

const ids = (updates: AgentDockUpdate[], key: 'opened' | 'replayed') => updates.flatMap(entry => entry[key])

test('watcher observe: reports every tick (dock hidden), asks after the seed tick are live', async () => {
	const root = mkdtempSync(join(tmpdir(), 'hdn-'))
	try {
		const { watcher, step, updates, clock } = watched(join(root, 'agent-dock'))
		await watcher.load()
		await step(pollAsk('4b4eb160-4')) // seed: the open ask is adopted silently (no event at all)
		await step(pollIdle(false))
		clock.now += SEED_REPLAY_GRACE_MS
		await step(pollAsk('4b4eb160-5')) // a new dialog: live
		assert.equal(updates.length, 3, 'one report per tick while the dock is hidden')
		assert.deepEqual(ids(updates, 'replayed'), [])
		assert.equal(ids(updates, 'opened').length, 1)
		const item = updates.at(-1)?.snapshot.items.find(entry => entry.state === 'open')
		assert.equal(item?.id, ids(updates, 'opened')[0])
		assert.equal(item?.kind, 'ask')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('watcher observe: asks re-registered by hooks reconnecting to a restarted Helm hub (just after the seed tick) are replays', async () => {
	const root = mkdtempSync(join(tmpdir(), 'hdn-'))
	try {
		const { watcher, step, updates, clock } = watched(join(root, 'agent-dock'))
		await watcher.load()
		await step(pollIdle(false)) // seed tick: the new hub lists no dialog yet
		await step(pollAsk('5c5fc271-1')) // a waiting hook reconnected (≤500 ms retry) and asked again
		assert.deepEqual(ids(updates, 'opened'), [])
		assert.equal(ids(updates, 'replayed').length, 1)
		await step(pollIdle(false))
		clock.now += SEED_REPLAY_GRACE_MS
		await step(pollAsk('5c5fc271-2')) // well after the seed: a new ask
		assert.equal(ids(updates, 'opened').length, 1)
		assert.equal(ids(updates, 'replayed').length, 1)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('watcher observe: a turn that ended while Helm was closed opens as a replay, never a live open', async () => {
	for (const transcriptAtSeed of [true, false]) {
		const root = mkdtempSync(join(tmpdir(), 'hdn-'))
		const dir = join(root, 'agent-dock')
		try {
			// Before the restart Jakub had seen an earlier message of this pane.
			mkdirSync(dir, { recursive: true, mode: 0o700 })
			writeFileSync(
				join(dir, 'state.json'),
				JSON.stringify({
					version: 1,
					nextItemId: 5,
					seen: { [`${PROFILE}:${TID}`]: 'older-uuid' },
					nextSeq: 1,
					ledger: [],
				}),
				{ mode: 0o600 },
			)
			const { watcher, step, updates } = watched(dir)
			await watcher.load()
			await step(pollIdle(transcriptAtSeed)) // the source's seed tick
			if (!transcriptAtSeed) await step(pollIdle(true)) // the pane's seed adoption lands one tick later
			const turnItem = updates.at(-1)?.snapshot.items.find(item => item.kind === 'turn')
			assert.ok(turnItem, `turn opened (transcript at seed: ${transcriptAtSeed})`)
			assert.equal(turnItem.fact.kind === 'turn' && turnItem.fact.assistantUuid, LAST_UUID)
			assert.deepEqual(ids(updates, 'replayed'), [turnItem.id])
			assert.deepEqual(ids(updates, 'opened'), [])
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	}
})

test('watcher observe: acks and dock answers report too (the badge follows them at once)', async () => {
	const root = mkdtempSync(join(tmpdir(), 'hdn-'))
	try {
		const { watcher, step, updates } = watched(join(root, 'agent-dock'))
		await watcher.load()
		await step(pollAsk('4b4eb160-4'))
		const before = updates.length
		await watcher.ack(999)
		assert.equal(updates.length, before + 1)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// Electron wiring (mocked Notification + app.dock)
// ---------------------------------------------------------------------------

class FakeNotification {
	static supported = true
	static made: FakeNotification[] = []
	static isSupported() {
		return FakeNotification.supported
	}
	readonly listeners = new Map<string, () => void>()
	shown = false
	closed = false
	constructor(readonly options: { title: string; subtitle?: string; body: string; silent?: boolean }) {
		FakeNotification.made.push(this)
	}
	on(event: string, listener: () => void) {
		this.listeners.set(event, listener)
		return this
	}
	show() {
		this.shown = true
	}
	close() {
		this.closed = true
	}
}

function fakeWindow(state: Partial<Record<'destroyed' | 'visible' | 'minimized' | 'focused', boolean>> = {}) {
	const s = { destroyed: false, visible: true, minimized: false, focused: true, ...state }
	return {
		s,
		win: {
			isDestroyed: () => s.destroyed,
			isVisible: () => s.visible,
			isMinimized: () => s.minimized,
			isFocused: () => s.focused,
		},
	}
}

test('notify main: Electron Notification gets title/subtitle/body/silent; click focuses Helm and asks the renderer to open the item', () => {
	FakeNotification.made = []
	const badges: string[] = []
	const calls: string[] = []
	const { s, win } = fakeWindow()
	const options = agentDockNotifyOptions({
		Notification: FakeNotification,
		dock: { setBadge: text => badges.push(text) },
		mainWindow: () => win,
		focusAndRestore: () => calls.push('focus'),
		sendOpenItem: itemId => calls.push(`open:${itemId}`),
		idleBadge: 'dev',
	})
	assert.equal(options.idleBadge, 'dev')
	// Foreground = main window focused, shown and not minimized.
	assert.equal(options.isForeground(), true)
	for (const change of [{ focused: false }, { visible: false }, { minimized: true }, { destroyed: true }]) {
		Object.assign(s, { destroyed: false, visible: true, minimized: false, focused: true }, change)
		assert.equal(options.isForeground(), false, JSON.stringify(change))
	}

	const notifier = new AgentDockNotifier({ ...options, now: () => T0, log: () => {} })
	notifier.update(update([ask(1, 'p:t2')], [1]))
	assert.equal(FakeNotification.made.length, 1)
	const native = FakeNotification.made[0] as FakeNotification
	assert.deepEqual(native.options, {
		title: 'company-create-save-firm',
		subtitle: 'Question · crm',
		body: 'Which colour, #1?',
		silent: false,
	})
	assert.equal(native.shown, true)
	assert.deepEqual(badges, ['1'])
	native.listeners.get('click')?.()
	assert.deepEqual(calls, ['focus', 'open:1'])
	// Resolved: closed through Electron's close().
	notifier.update(update([turn(2, 'p:t1')], [2]))
	const second = FakeNotification.made[1] as FakeNotification
	assert.equal(second.options.silent, true)
	notifier.update(update([]))
	assert.equal(second.closed, true)
	assert.deepEqual(badges, ['1', 'dev'])
	// Unsupported OS: nothing shown, nothing thrown.
	FakeNotification.supported = false
	notifier.update(update([ask(3, 'p:t3')], [3]))
	assert.equal(FakeNotification.made.length, 2)
	FakeNotification.supported = true
	// No app.dock (not macOS): the badge is a no-op.
	assert.doesNotThrow(() =>
		agentDockNotifyOptions({
			Notification: FakeNotification,
			mainWindow: () => null,
			focusAndRestore: () => {},
			sendOpenItem: () => {},
		}).setBadge('3'),
	)
})

test('agent dock main: set-notify is gated like the other dock channels and switches notifications', () => {
	const root = mkdtempSync('/tmp/hdn-ipc-')
	try {
		const dist = join(root, 'dist')
		mkdirSync(dist, { recursive: true })
		writeFileSync(join(dist, PRELOAD_FILE), '// preload\n')
		writeFileSync(join(dist, HOOK_FILE), '// hook\n')
		const WINDOW = { id: 'main' }
		const dock = createAgentDockMain({
			enabled: true,
			socketRoot: join(root, 's'),
			distDir: dist,
			userDataDir: join(root, 'ud'),
			electronPath: process.execPath,
			activeProfileId: () => 'work',
			writeAttached: () => false,
			dtachSocket: () => null,
			dtachBinary: () => null,
			terminalName: () => undefined,
			publish: () => {},
			isFocused: () => false,
			acceptsIpc: (sender, token) => sender === WINDOW && token === 'work:1',
			notify: {
				show: () => null,
				setBadge: () => {},
				isForeground: () => false,
				openItem: () => {},
			},
		})
		const channels = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
		dock.registerIpc({
			on: (channel, listener) => channels.set(channel, listener),
			handle: (channel, listener) => channels.set(channel, listener),
		})
		const setNotify = channels.get('agent-dock:set-notify')
		assert.ok(setNotify)
		assert.equal(dock.notificationsEnabled(), true, 'default on until the renderer reports')
		setNotify({ sender: { id: 'other' } }, false, 'work:1')
		setNotify({ sender: WINDOW }, false, 'work:0')
		setNotify({ sender: WINDOW }, 'off', 'work:1')
		assert.equal(dock.notificationsEnabled(), true, 'foreign window, stale token or a non-boolean change nothing')
		setNotify({ sender: WINDOW }, false, 'work:1')
		assert.equal(dock.notificationsEnabled(), false)
		dock.stop()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('main.ts builds the dock notifications from Electron Notification + app.dock and pushes clicks to the renderer', () => {
	const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
	assert.match(main, /notify: agentDockNotifyOptions\(\{\n\t\tNotification,\n\t\tdock: app\.dock,/)
	assert.match(main, /AGENT_DOCK_IPC\.openItem, itemId, sessionProfileToken\(\)/)
	assert.match(main, /idleBadge: sideBySideLaunch \? 'dev' : ''/)
	// The dev badge is still set at launch (the notifier writes only changes).
	assert.match(main, /if \(sideBySideLaunch\) app\.dock\?\.setBadge\('dev'\)/)
	// Both notification kinds bring the window forward the same way.
	assert.equal(main.split('focusAndRestore: () => focusAndRestoreMainWindow()').length - 1, 2)
	const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
	assert.match(preload, /setNotify: 'agent-dock:set-notify'/)
	assert.match(preload, /openItem: 'agent-dock:open-item'/)
	assert.match(preload, /if \(profileToken !== sessionProfileToken\) return/)
})
