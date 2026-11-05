import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import cadenceModule from '../app/src/agent-dock/cadence.ts'
import modelModule from '../app/src/agent-dock/model.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'
import { okenaFixture } from './helpers/agent-dock'

type ModelModule = typeof import('../app/src/agent-dock/model.ts')
type ReduceModule = typeof import('../app/src/agent-dock/reduce.ts')
type AgentDockState = import('../app/src/agent-dock/reduce.ts').AgentDockState
type AgentDockObservation = import('../app/src/agent-dock/model.ts').AgentDockObservation
type DockItem = import('../app/src/agent-dock/model.ts').DockItem

const {
	okenaClaudeCandidates,
	okenaDialogPrefix,
	parseOkenaClaudeSession,
	parseOkenaClaudeTranscriptPage,
	parseOkenaState,
	sessionKey,
} = modelModule as ModelModule
const {
	OBSERVATION_GAP_MS,
	TURN_IDLE_MS,
	TURN_RESUMED_MS,
	TURN_TEXT_MAX,
	agentDockActive,
	agentDockAwaitingReply,
	agentDockNextDeadline,
	agentDockPersisted,
	agentDockSnapshot,
	agentDockTranscriptRequest,
	createAgentDockState,
	reduce,
} = reduceModule as ReduceModule
type CadenceModule = typeof import('../app/src/agent-dock/cadence.ts')
const { RECONCILE_INTERVAL_MS, SLOWEST_INTERVAL_MS } = cadenceModule as CadenceModule

const fixture = okenaFixture

type Json = Record<string, unknown>
const SHOW_ASK = fixture('show-ask.json')
const SHOW_IDLE = fixture('show-idle.json')
const STATE_ASK = fixture('state-ask.json')
const LOG_FULL = fixture('log-full.json')
const LS_ASK = fixture<Json[]>('ls-ask.json')
/**
 * Shape of a real reset page (`okena claude log`, no cursor: last 200 entries, reset: true)
 * from the pane where the bug showed: texts replaced, kinds/uuids/order kept. Entry 52 is the
 * turn's assistant message, entry 53 Jakub's reply typed in the terminal, then 146 entries of work.
 */
const LOG_RESET_REPLY = fixture('log-reset-reply.json')

const PROFILE = 'p1'
const TID = SHOW_ASK.terminal_id as string
const SID = SHOW_ASK.session_id as string
const KEY = sessionKey(PROFILE, TID)
const DIALOG_ID = (SHOW_ASK.dialogs as Json[])[0]?.id as string
const ASSISTANT_UUID = 'a496fe0c-9dec-4a6d-8c2e-f9050c5c1f81'
const T0 = 1_793_364_800_000

const clone = <T>(value: T): T => structuredClone(value)

/** Okena runs with the MCP channel OFF: no channel attachment, terminal-origin prompts. */
function channelOff<T extends Json>(body: T): T {
	const next = clone(body)
	if ('channel_attached' in next) (next as Json).channel_attached = false
	if (Array.isArray(next.entries)) {
		for (const entry of next.entries as Json[]) if (entry.kind === 'user') entry.origin = 'terminal'
	}
	return next
}

const ask = (overrides: Json = {}): Json => ({ ...channelOff(SHOW_ASK), ...overrides })
const idle = (overrides: Json = {}): Json => ({ ...channelOff(SHOW_IDLE), ...overrides })
const working = (overrides: Json = {}): Json => idle({ busy: true, ...overrides })

function dialog(id: string, createdAt = T0): Json {
	return { ...clone((SHOW_ASK.dialogs as Json[])[0] as Json), id, created_at_ms: createdAt }
}

function okenaState(version: number, terminals: string[], dialogs: Record<string, number> = {}): Json {
	return {
		...clone(STATE_ASK),
		state_version: version,
		claude_sessions: terminals,
		claude_dialogs: dialogs,
		projects: [
			{
				id: 'proj-1',
				name: 'helm',
				path: '/repo/helm',
				layout: { type: 'split', children: [{ type: 'terminal', terminal_id: TID }] },
				terminal_names: { [TID]: 'dock-test' },
			},
		],
	}
}

function page(entries: Json[], opts: { cursor: number; reset?: boolean; sessionId?: string }): Json {
	return { session_id: opts.sessionId ?? SID, entries, cursor: opts.cursor, reset: opts.reset ?? false }
}
const user = (uuid: string): Json => ({ kind: 'user', uuid, text: 'go on', origin: 'terminal' })
const assistant = (uuid: string, text = 'Done.'): Json => ({ kind: 'assistant', uuid, text })

let stateVersion = 2000
function poll(
	detail: Json | null,
	opts: { transcript?: Json; version?: number; background?: unknown } = {},
): AgentDockObservation {
	stateVersion += 1
	const dialogs = (detail?.dialogs as Json[] | undefined)?.length
	return {
		type: 'poll',
		source: 'okena',
		profile: PROFILE,
		state: {
			ok: true,
			body: okenaState(opts.version ?? stateVersion, detail ? [TID] : [], dialogs ? { [TID]: dialogs } : {}),
		},
		terminals: detail
			? [
					{
						terminalId: TID,
						detail: { ok: true, body: detail },
						transcript: opts.transcript ? { ok: true, body: opts.transcript } : undefined,
						...(opts.background !== undefined
							? { background: opts.background as { sessionId: string; tasks: number; shells: number } }
							: {}),
					},
				]
			: [],
	}
}
const down = (error = 'connect ECONNREFUSED'): AgentDockObservation => ({
	type: 'poll',
	source: 'okena',
	profile: PROFILE,
	state: { ok: false, error },
	terminals: [],
})

/** Runs observations in order; returns final state and all events. */
function run(start: AgentDockState, steps: Array<[number, AgentDockObservation]>) {
	let state = start
	const events: ReturnType<typeof reduce>['events'] = []
	for (const [at, observation] of steps) {
		const next = reduce(state, observation, at)
		state = next.state
		events.push(...next.events)
	}
	return { state, events }
}

const itemsOf = (state: AgentDockState, kind: DockItem['kind']) => state.items.filter(item => item.kind === kind)
const fullLog = () => channelOff(LOG_FULL)

// --- schemas -----------------------------------------------------------------

test('recorded Okena fixtures parse; CLI-only fields are ignored', () => {
	const detail = parseOkenaClaudeSession(SHOW_ASK)
	assert.equal(detail.ok, true)
	if (detail.ok) {
		assert.equal(detail.value.dialogs[0]?.tool_name, 'AskUserQuestion')
		assert.equal('project_name' in detail.value, false)
	}
	assert.equal(parseOkenaClaudeSession(SHOW_IDLE).ok, true)
	assert.equal(parseOkenaClaudeSession(LS_ASK[0]).ok, true)
	const transcript = parseOkenaClaudeTranscriptPage(LOG_FULL)
	assert.equal(transcript.ok, true)
	if (transcript.ok) assert.deepEqual(transcript.value.entries.map(entry => entry.kind).slice(-1), ['assistant'])
	const state = parseOkenaState(STATE_ASK)
	assert.equal(state.ok, true)
	if (state.ok) assert.deepEqual(okenaClaudeCandidates(state.value), [TID])
})

test('channel-off variants parse too', () => {
	assert.equal(parseOkenaClaudeSession(ask()).ok, true)
	const transcript = parseOkenaClaudeTranscriptPage(fullLog())
	assert.equal(transcript.ok, true)
	if (transcript.ok) assert.equal(transcript.value.entries.find(entry => entry.kind === 'user')?.origin, 'terminal')
})

test('schemas fail closed on drift', () => {
	assert.equal(parseOkenaClaudeSession(ask({ busy: 'yes' })).ok, false)
	assert.equal(parseOkenaClaudeSession(ask({ dialogs: undefined })).ok, false)
	assert.equal(parseOkenaClaudeTranscriptPage({ ...LOG_FULL, entries: [{ kind: 'mystery', uuid: 'x' }] }).ok, false)
	const bad = parseOkenaState({ claude_sessions: [TID] })
	assert.equal(bad.ok, false)
	if (!bad.ok) assert.match(bad.error, /state_version/)
})

test('candidates are the sorted union of sessions and dialog keys', () => {
	const parsed = parseOkenaState({ state_version: 1, claude_sessions: ['b', 'a'], claude_dialogs: { c: 1, a: 2 } })
	assert.equal(parsed.ok, true)
	if (parsed.ok) assert.deepEqual(okenaClaudeCandidates(parsed.value), ['a', 'b', 'c'])
	assert.equal(okenaDialogPrefix('4b4eb160-4'), '4b4eb160')
	assert.equal(okenaDialogPrefix('a-b-c-12'), 'a-b-c')
	assert.equal(okenaDialogPrefix('opaque'), 'opaque')
})

// --- seed --------------------------------------------------------------------

test('seed: open dialog becomes an item silently; health ok emits nothing', () => {
	const { state, events } = run(createAgentDockState(null, T0), [[T0, poll(ask(), { transcript: fullLog() })]])
	assert.deepEqual(events, [])
	const [item] = itemsOf(state, 'ask')
	assert.equal(item?.key, `ask:${KEY}:${DIALOG_ID}`)
	assert.equal(item?.state, 'open')
	assert.equal(item?.fact.kind === 'ask' && item.fact.tool, 'AskUserQuestion')
	assert.equal(state.sessions[KEY]?.session.status, 'waiting')
	assert.equal(state.sessions[KEY]?.session.project, 'helm')
	assert.equal(state.sessions[KEY]?.session.name, 'dock-test')
	assert.equal(state.sessions[KEY]?.session.projectId, 'proj-1')
	assert.equal(state.sessions[KEY]?.session.channelAttached, false)
	assert.equal(state.sessions[KEY]?.session.repo, undefined)
	assert.equal(state.source.state, 'ok')
})

test("a worktree pane's repo is its parent project's name (Okena worktree_info)", () => {
	const observation = poll(idle())
	const body = (observation as { state: { body: Json } }).state.body
	const [project] = body.projects as Json[]
	body.projects = [
		{ ...project, name: 'fix/repair-done', worktree_info: { parent_project_id: 'proj-jvs' } },
		{ id: 'proj-jvs', name: 'JVS', path: '/repo/crane-rental', terminal_names: {} },
	]
	const { state } = run(createAgentDockState(null, T0), [[T0, observation]])
	assert.equal(state.sessions[KEY]?.session.project, 'fix/repair-done')
	assert.equal(state.sessions[KEY]?.session.repo, 'JVS')
})

test("ask facts keep Claude's permission_suggestions verbatim, and only when Okena sent some", () => {
	const suggestion = {
		type: 'addRules',
		rules: [{ toolName: 'Bash', ruleContent: 'npm run deploy:stage' }],
		behavior: 'allow',
		destination: 'localSettings',
	}
	const withSuggestion = { ...dialog('ffff0000-7'), tool_name: 'Bash', permission_suggestions: [suggestion] }
	const { state } = run(createAgentDockState(null, T0), [
		[T0, poll(ask({ dialogs: [withSuggestion, dialog('ffff0000-8')] }), { transcript: fullLog() })],
	])
	const [bash, question] = itemsOf(state, 'ask')
	assert.deepEqual(bash?.fact.kind === 'ask' && bash.fact.suggestions, [suggestion])
	assert.equal(question?.fact.kind === 'ask' && 'suggestions' in question.fact, false)
})

test('seed: first-ever idle pane adopts its last assistant uuid as seen, without an item', () => {
	const { state, events } = run(createAgentDockState(null, T0), [[T0, poll(idle(), { transcript: fullLog() })]])
	assert.deepEqual(events, [])
	assert.equal(state.items.length, 0)
	assert.equal(state.seen[KEY], ASSISTANT_UUID)
})

test('seed: persisted seen equal to the last uuid stays quiet', () => {
	const start = createAgentDockState({ version: 1, nextItemId: 5, seen: { [KEY]: ASSISTANT_UUID } }, T0)
	const { state, events } = run(start, [[T0, poll(idle(), { transcript: fullLog() })]])
	assert.deepEqual(events, [])
	assert.equal(state.items.length, 0)
})

test('seed: unseen assistant uuid vs persisted seen opens a turn immediately', () => {
	const start = createAgentDockState({ version: 1, nextItemId: 5, seen: { [KEY]: 'older-uuid' } }, T0)
	const { state, events } = run(start, [[T0, poll(idle(), { transcript: fullLog() })]])
	assert.deepEqual(
		events.map(event => event.t),
		['item.opened'],
	)
	const [turn] = itemsOf(state, 'turn')
	assert.equal(turn?.id, 5)
	assert.equal(turn?.key, `turn:${SID}:${ASSISTANT_UUID}`)
	assert.equal(turn?.fact.kind === 'turn' && turn.fact.text, 'Odpovědi: Barva = **Blue**, Velikost = **M**.')
	assert.equal(state.nextItemId, 6)
})

test('seed waits for the transcript before judging a pane', () => {
	const start = createAgentDockState({ version: 1, nextItemId: 1, seen: {} }, T0)
	const { state, events } = run(start, [
		[T0, poll(idle())],
		[T0 + 1000, poll(idle(), { transcript: fullLog() })],
	])
	assert.deepEqual(events, [])
	assert.equal(state.seen[KEY], ASSISTANT_UUID)
})

test('seed without a transcript adopts nothing: the first turn after start opens after the idle window', () => {
	const start = createAgentDockState({ version: 1, nextItemId: 1, seen: {} }, T0)
	const firstTurn = page([user('u1'), assistant('a1', 'Hotovo.')], { cursor: 900, reset: true })
	const { state, events } = run(start, [
		[T0, poll(idle({ has_transcript: false }))],
		[T0 + 5000, poll(idle(), { transcript: firstTurn })],
		[T0 + 10_000, poll(idle())],
	])
	assert.deepEqual(
		events.map(event => event.t),
		['item.opened'],
	)
	assert.equal(itemsOf(state, 'turn')[0]?.fact.kind === 'turn' && itemsOf(state, 'turn')[0]?.fact.assistantUuid, 'a1')
	assert.equal(state.seen[KEY], undefined)
})

test('seed with a failed transcript read stops adopting once the pane is seen busy', () => {
	const start = createAgentDockState({ version: 1, nextItemId: 1, seen: {} }, T0)
	const { state, events } = run(start, [
		[T0, poll(idle())], // has_transcript, but the transcript read failed
		[T0 + 1500, poll(working())],
		[T0 + 3000, poll(idle(), { transcript: page([user('u1'), assistant('a1')], { cursor: 900, reset: true }) })],
		[T0 + 3000 + TURN_IDLE_MS, poll(idle())],
	])
	assert.deepEqual(
		events.map(event => event.t),
		['item.opened'],
	)
	assert.equal(state.seen[KEY], undefined)
	assert.equal(itemsOf(state, 'turn').length, 1)
})

// --- asks --------------------------------------------------------------------

test('ask opens on dialog appear and resolves outside when it vanishes', () => {
	const seeded = run(createAgentDockState(null, T0), [[T0, poll(idle(), { transcript: fullLog() })]]).state
	const opened = reduce(seeded, poll(ask()), T0 + 1000)
	assert.deepEqual(
		opened.events.map(event => event.t),
		['item.opened'],
	)
	assert.equal(opened.events[0]?.t === 'item.opened' && opened.events[0].kind, 'ask')
	const vanished = reduce(opened.state, poll(idle()), T0 + 2000)
	assert.deepEqual(vanished.events, [{ t: 'item.resolved', at: T0 + 2000, id: 1, by: 'outside' }])
	// The same dialog id never reopens (the resolved item keeps its dedupe key).
	assert.equal(reduce(vanished.state, poll(ask()), T0 + 3000).events.length, 0)
})

test('dialog-id prefix change while an ask is open orphans it', () => {
	const seeded = run(createAgentDockState(null, T0), [[T0, poll(ask(), { transcript: fullLog() })]]).state
	const restarted = reduce(seeded, poll(ask({ dialogs: [dialog('ffff0000-1', T0 + 5000)] })), T0 + 5000)
	const old = restarted.state.items.find(item => item.key.endsWith(DIALOG_ID))
	assert.equal(old?.state, 'orphaned')
	assert.deepEqual(
		restarted.events.map(event => event.t),
		['item.opened', 'item.orphaned'],
	)
	assert.equal(restarted.state.sources.okena?.hubPrefix, 'ffff0000')
	// Sticky: an idle poll does not resolve it from absence.
	const later = reduce(restarted.state, poll(idle()), T0 + 6000)
	assert.equal(later.state.items.find(item => item.id === old?.id)?.state, 'orphaned')
})

test('orphaned ask resolves outside on new transcript activity', () => {
	const seeded = run(createAgentDockState(null, T0), [
		[T0, poll(ask(), { transcript: fullLog() })],
		[T0 + 1000, down()],
		[T0 + 2000, poll(working(), { transcript: page([], { cursor: 1_276_753 }) })],
	]).state
	const orphan = seeded.items.find(item => item.kind === 'ask')
	assert.equal(orphan?.state, 'orphaned')
	const recovered = reduce(
		seeded,
		poll(working(), {
			transcript: page(
				[{ kind: 'tool_use', uuid: 't1', tool_use_id: 'x', name: 'Bash', summary: 'ls' }, assistant('b2')],
				{ cursor: 1_300_000 },
			),
		}),
		T0 + 3000,
	)
	assert.deepEqual(recovered.events, [{ t: 'item.resolved', at: T0 + 3000, id: orphan?.id, by: 'outside' }])
})

// --- source health -----------------------------------------------------------

test('source down freezes everything; reconnect orphans asks that vanished meanwhile', () => {
	const seeded = run(createAgentDockState(null, T0), [[T0, poll(ask(), { transcript: fullLog() })]]).state
	const frozen = reduce(seeded, down(), T0 + 1000)
	assert.deepEqual(frozen.events, [
		{ t: 'source.health', at: T0 + 1000, state: 'down', source: 'okena', detail: 'connect ECONNREFUSED' },
	])
	assert.equal(frozen.state.source.lastObservedAt, T0)
	assert.equal(frozen.state.sessions[KEY]?.session.status, 'unreachable')
	assert.equal(frozen.state.items[0]?.state, 'open')
	// Still down: no duplicate health event, no resolution.
	const still = reduce(frozen.state, down('timeout'), T0 + 2000)
	assert.deepEqual(still.events, [])
	assert.equal(still.state.source.since, T0 + 1000)

	const back = reduce(still.state, poll(idle()), T0 + 3000)
	assert.deepEqual(
		back.events.map(event => event.t),
		['source.health', 'item.orphaned'],
	)
	assert.equal(back.state.sessions[KEY]?.session.status, 'idle')
})

test('reconnect keeps an ask open when its dialog is still present', () => {
	const { state, events } = run(createAgentDockState(null, T0), [
		[T0, poll(ask(), { transcript: fullLog() })],
		[T0 + 1000, down()],
		[T0 + 2000, poll(ask())],
	])
	assert.deepEqual(
		events.map(event => event.t),
		['source.health', 'source.health'],
	)
	assert.equal(state.items[0]?.state, 'open')
})

test('invalid /v1/state counts as source down; invalid detail makes the session unknown and changes nothing', () => {
	const seeded = run(createAgentDockState(null, T0), [[T0, poll(ask(), { transcript: fullLog() })]]).state
	const badState = reduce(seeded, { ...poll(ask()), state: { ok: true, body: { nope: 1 } } }, T0 + 1000)
	assert.equal(badState.state.source.state, 'down')
	assert.match(badState.state.source.detail ?? '', /invalid \/v1\/state/)

	const badDetail = reduce(seeded, poll(ask({ busy: 'maybe', dialogs: [] })), T0 + 1000)
	assert.deepEqual(badDetail.events, [])
	assert.equal(badDetail.state.sessions[KEY]?.session.status, 'unknown')
	assert.equal(badDetail.state.items[0]?.state, 'open')
})

// --- turns -------------------------------------------------------------------

function seededWorking(): AgentDockState {
	return run(createAgentDockState(null, T0), [[T0, poll(working(), { transcript: fullLog() })]]).state
}

test('turn opens only after 8 s of observed idle with a new assistant uuid', () => {
	const t1 = T0 + 1000
	const finished = reduce(
		seededWorking(),
		poll(idle(), { transcript: page([assistant('b1', 'PR ready?')], { cursor: 1_300_000 }) }),
		t1,
	)
	assert.deepEqual(finished.events, [])
	const early = reduce(finished.state, poll(idle()), t1 + TURN_IDLE_MS - 1)
	assert.deepEqual(early.events, [])
	const due = reduce(early.state, poll(idle()), t1 + TURN_IDLE_MS)
	assert.equal(due.events[0]?.t, 'item.opened')
	const [turn] = itemsOf(due.state, 'turn')
	assert.equal(turn?.fact.kind === 'turn' && turn.fact.endedAt, t1)
	assert.equal(turn?.fact.kind === 'turn' && turn.fact.hadBackground, false)
})

test('a quick resume inside the idle window opens nothing', () => {
	const t1 = T0 + 1000
	const { state, events } = run(seededWorking(), [
		[t1, poll(idle(), { transcript: page([assistant('b1')], { cursor: 1_300_000 }) })],
		[t1 + 3000, poll(working(), { transcript: page([user('u1')], { cursor: 1_310_000 }) })],
		[t1 + TURN_IDLE_MS + 1, poll(working())],
	])
	assert.deepEqual(events, [])
	assert.equal(state.items.length, 0)
})

// --- idle gate: settle deadline, activity, diagnostics -------------------------

test('a turn held by the idle gate sets the settle deadline at its idle edge + TURN_IDLE_MS and keeps the dock active', () => {
	const t1 = T0 + 1000
	const adopted = run(createAgentDockState(null, T0), [
		[T0, poll(idle(), { transcript: fullLog() })],
		[T0 + 500, poll(idle())],
	]).state
	assert.equal(agentDockActive(adopted), false, 'idle at an adopted message: nothing to watch closely')
	assert.equal(agentDockNextDeadline(adopted, T0 + 500), undefined)
	const held = reduce(
		seededWorking(),
		poll(idle(), { transcript: page([assistant('b1', 'PR ready?')], { cursor: 1_300_000 }) }),
		t1,
	)
	assert.deepEqual(held.events, [])
	assert.deepEqual(held.diagnostics, [])
	assert.equal(held.state.sessions[KEY]?.gateCandidate?.uuid, 'b1')
	assert.equal(agentDockNextDeadline(held.state, t1), t1 + TURN_IDLE_MS)
	assert.equal(agentDockActive(held.state), true)
	// Still held a tick later: same deadline; a past deadline is never returned (no tick storm).
	const later = reduce(held.state, poll(idle()), t1 + 3000)
	assert.equal(agentDockNextDeadline(later.state, t1 + 3000), t1 + TURN_IDLE_MS)
	assert.equal(agentDockNextDeadline(later.state, t1 + TURN_IDLE_MS), undefined)
	const opened = reduce(later.state, poll(idle()), t1 + TURN_IDLE_MS)
	assert.equal(opened.events[0]?.t, 'item.opened')
	assert.equal(opened.state.sessions[KEY]?.gateCandidate, undefined)
	assert.deepEqual(opened.diagnostics, [])
	assert.equal(agentDockNextDeadline(opened.state, t1 + TURN_IDLE_MS), undefined)
	assert.equal(agentDockActive(opened.state), false, 'an open turn on an idle pane needs no fast cadence')
})

test('a live turn on a busy pane sets the settle deadline at the busy edge + TURN_RESUMED_MS', () => {
	const { state, at } = withOpenTurn()
	const busy = reduce(state, poll(working()), at + 2000)
	assert.equal(agentDockNextDeadline(busy.state, at + 2000), at + 2000 + TURN_RESUMED_MS)
	assert.equal(agentDockActive(busy.state), true)
	const closed = reduce(busy.state, poll(working()), at + 2000 + TURN_RESUMED_MS)
	assert.equal(itemsOf(closed.state, 'turn')[0]?.resolution?.by, 'superseded')
	assert.equal(agentDockNextDeadline(closed.state, at + 2000 + TURN_RESUMED_MS), undefined)
})

test('a quick resume logs the suppressed turn (turn.gated) with its idle stretch', () => {
	const t1 = T0 + 1000
	const held = run(seededWorking(), [
		[t1, poll(idle(), { transcript: page([assistant('b1')], { cursor: 1_300_000 }) })],
		[t1 + 2000, poll(idle())],
	]).state
	const resumed = reduce(held, poll(working(), { transcript: page([user('u1')], { cursor: 1_310_000 }) }), t1 + 3000)
	assert.deepEqual(resumed.events, [])
	assert.deepEqual(resumed.diagnostics, [
		{ t: 'turn.gated', at: t1 + 3000, session: KEY, idleMs: 3000, seenIdleMs: 2000, by: 'working' },
	])
	assert.equal(resumed.state.sessions[KEY]?.gateCandidate, undefined)
	// Logged once: the stretch is over.
	assert.deepEqual(reduce(resumed.state, poll(working()), t1 + 4000).diagnostics, [])
})

test('the gate log names a dialog, a newer message and an observation gap (silent) apart', () => {
	const t1 = T0 + 1000
	const held = reduce(
		seededWorking(),
		poll(idle(), { transcript: page([assistant('b1')], { cursor: 1_300_000 }) }),
		t1,
	).state
	assert.equal(reduce(held, poll(ask()), t1 + 1000).diagnostics[0]?.by, 'waiting')
	const newer = reduce(held, poll(idle(), { transcript: page([assistant('b2')], { cursor: 1_310_000 }) }), t1 + 1000)
	assert.equal(newer.diagnostics[0]?.by, 'superseded')
	assert.equal(newer.state.sessions[KEY]?.gateCandidate?.uuid, 'b2', 'the newer message is held in the same stretch')
	const gap = reduce(held, poll(working()), t1 + OBSERVATION_GAP_MS + 1_000)
	assert.deepEqual(gap.diagnostics, [], 'a broken stretch is no evidence of a quick resume')
	const unreadable = reduce(held, poll(idle({ busy: 'yes' })), t1 + 1000)
	assert.deepEqual(unreadable.diagnostics, [])
	assert.equal(unreadable.state.sessions[KEY]?.gateCandidate, undefined)
})

test('observation gap: scaled to the slowest tick, so reconciliation ticks keep one stretch', () => {
	assert.ok(OBSERVATION_GAP_MS > 2.5 * SLOWEST_INTERVAL_MS, 'gap > 2.5× the slowest interval')
	assert.equal(SLOWEST_INTERVAL_MS, RECONCILE_INTERVAL_MS)
	const t1 = T0 + 1000
	const held = reduce(
		seededWorking(),
		poll(idle(), { transcript: page([assistant('b1')], { cursor: 1_300_000 }) }),
		t1,
	).state
	// The stream is up and nothing is active: the next tick is a (slightly late) reconciliation.
	const late = reduce(held, poll(idle()), t1 + RECONCILE_INTERVAL_MS + 2_000).state
	assert.equal(itemsOf(late, 'turn')[0]?.state, 'open', 'the idle stretch held across a 17 s tick')
	// A real outage (or sleep) still breaks it: no turn from an unobserved stretch.
	const after = t1 + OBSERVATION_GAP_MS + 1
	const broken = reduce(held, poll(idle()), after).state
	assert.equal(itemsOf(broken, 'turn').length, 0)
	assert.equal(broken.sessions[KEY]?.gateCandidate?.idleSince, after, 'the stretch restarts at the new observation')
})

test('activity: a busy or dialog pane is active; a down source is not', () => {
	const working1 = reduce(createAgentDockState(null, T0), poll(working(), { transcript: fullLog() }), T0)
	assert.equal(agentDockActive(working1.state), true)
	const asking = reduce(working1.state, poll(ask()), T0 + 1000)
	assert.equal(agentDockActive(asking.state), true)
	const gone = reduce(working1.state, down(), T0 + 1000)
	assert.equal(agentDockActive(gone.state), false, 'a frozen row of a down source does not speed up polling')
})

function withOpenTurn(): { state: AgentDockState; at: number } {
	const t1 = T0 + 1000
	const { state } = run(seededWorking(), [
		[t1, poll(idle(), { transcript: page([assistant('b1')], { cursor: 1_300_000 }) })],
		[t1 + TURN_IDLE_MS, poll(idle())],
	])
	assert.equal(itemsOf(state, 'turn')[0]?.state, 'open')
	return { state, at: t1 + TURN_IDLE_MS }
}

test('a later user entry resolves the turn as replied (any origin)', () => {
	const { state, at } = withOpenTurn()
	const replied = reduce(
		state,
		poll(working(), { transcript: page([{ ...user('u2'), origin: 'channel' }], { cursor: 1_320_000 }) }),
		at + 1000,
	)
	assert.deepEqual(replied.events, [{ t: 'item.resolved', at: at + 1000, id: 1, by: 'replied' }])
})

test('a reset page still finds the reply after the turn uuid', () => {
	const { state, at } = withOpenTurn()
	const replied = reduce(
		state,
		poll(working(), { transcript: page([assistant('b1'), user('u2')], { cursor: 900, reset: true }) }),
		at + 1000,
	)
	assert.equal(replied.events[0]?.t === 'item.resolved' && replied.events[0].by, 'replied')
})

test('a newer turn supersedes the open one', () => {
	const { state, at } = withOpenTurn()
	const { state: final, events } = run(state, [
		[at + 1000, poll(idle(), { transcript: page([assistant('b2')], { cursor: 1_340_000 }) })],
		[at + 1000 + TURN_IDLE_MS, poll(idle())],
	])
	assert.deepEqual(
		events.map(event => event.t),
		['item.resolved', 'item.opened'],
	)
	assert.equal(final.items.find(item => item.id === 1)?.resolution?.by, 'superseded')
	assert.equal(itemsOf(final, 'turn').find(item => item.state === 'open')?.key, `turn:${SID}:b2`)
})

test('a long day in one pane: every answered turn and question closes, never more than one live turn', () => {
	// The shape behind "things I already answered stay in the dock" (#179–#187, one pane over an hour):
	// replies typed in the terminal (read, or only seen as busy), background wakes, a question
	// answered in the terminal. Each closes in the reducer, so the queue (live items) holds only the
	// latest unanswered turn; the snapshot keeps the rest as RECENT (`helm dock ls --all`) only.
	let state = seededWorking()
	let at = T0 + 1000
	let cursor = 1_300_000
	const step = (detail: Json, entries?: Json[], wait = 1000) => {
		at += wait
		cursor += 10_000
		state = reduce(state, poll(detail, entries ? { transcript: page(entries, { cursor }) } : {}), at).state
		const live = agentDockSnapshot(state, at).items.filter(item => item.state !== 'resolved')
		assert.ok(live.filter(item => item.kind === 'turn').length <= 1, `one live turn at most (${at - T0} ms)`)
		return live
	}
	const settle = () => step(idle(), undefined, TURN_IDLE_MS)
	const liveKeys = (live: DockItem[]) => live.map(item => item.key)

	step(idle(), [assistant('t1')])
	assert.deepEqual(liveKeys(settle()), [`turn:${SID}:t1`])
	// Replied in the terminal, the reply read while the agent works.
	assert.deepEqual(step(working(), [user('u1')]), [])
	step(idle(), [assistant('t2')])
	assert.deepEqual(liveKeys(settle()), [`turn:${SID}:t2`])
	// Replied in the terminal, the reply not read until the agent is long busy.
	step(working())
	assert.deepEqual(step(working(), undefined, TURN_RESUMED_MS), [])
	step(idle(), [user('u2'), assistant('t3')])
	assert.deepEqual(liveKeys(settle()), [`turn:${SID}:t3`])
	// A background wake says something new while the pane stays idle: the new turn replaces the old one.
	assert.deepEqual(liveKeys(step(idle(), [assistant('t4')])), [`turn:${SID}:t4`])
	// A question raised and answered in the terminal.
	step(working(), [user('u4')])
	assert.equal(step(ask()).filter(item => item.kind === 'ask').length, 1)
	assert.deepEqual(step(working()), [])
	step(idle(), [assistant('t5')])
	assert.deepEqual(liveKeys(settle()), [`turn:${SID}:t5`])

	const closed = state.items
		.filter(item => item.state === 'resolved')
		.sort((a, b) => a.id - b.id)
		.map(item => `${item.kind}:${item.resolution?.by}`)
	assert.deepEqual(closed, ['turn:replied', 'turn:superseded', 'turn:superseded', 'turn:replied', 'ask:outside'])
})

// --- the agent moved on (Jakub replied in the terminal, or it woke by itself) ----

const RESET_ENTRIES = LOG_RESET_REPLY.entries as Json[]
const TURN_UUID = '1c3039d1-8e3a-4a5b-b212-bbd5942221d0'
const tool = (uuid: string): Json => ({ kind: 'tool_use', uuid, tool_use_id: `x-${uuid}`, name: 'Bash', summary: 'ls' })

/** The real timeline up to the turn: a reset page while working, then the turn ends and settles. */
function realTurnOpen(): { state: AgentDockState; at: number } {
	const t1 = T0 + 1000
	const { state } = run(createAgentDockState(null, T0), [
		[T0, poll(working(), { transcript: page(RESET_ENTRIES.slice(0, 52), { cursor: 10_000_000, reset: true }) })],
		[t1, poll(idle(), { transcript: page(RESET_ENTRIES.slice(52, 53), { cursor: 10_010_000 }) })],
		[t1 + TURN_IDLE_MS, poll(idle())],
	])
	const [turn] = itemsOf(state, 'turn')
	assert.equal(turn?.state, 'open')
	assert.equal(turn?.fact.kind === 'turn' && turn.fact.assistantUuid, TURN_UUID)
	return { state, at: t1 + TURN_IDLE_MS }
}

test('real shape: a terminal reply never read while the agent works closes the turn after the debounce', () => {
	// Jakub replied in the terminal; the pane is busy from then on. Okena's busy flag is all the
	// dock sees on those ticks (no transcript read), which used to leave the turn open for good
	// with "tools ran again" for as long as the agent worked (17 min in the report).
	const { state, at } = realTurnOpen()
	assert.equal(agentDockAwaitingReply(state, PROFILE, TID), true)
	const early = run(state, [
		[at + 1500, poll(working())],
		[at + 1500 + TURN_RESUMED_MS - 1, poll(working())],
	])
	assert.deepEqual(early.events, [])
	assert.equal(itemsOf(early.state, 'turn')[0]?.state, 'open')

	const late = reduce(early.state, poll(working()), at + 1500 + TURN_RESUMED_MS)
	assert.deepEqual(late.events, [{ t: 'item.resolved', at: at + 1500 + TURN_RESUMED_MS, id: 1, by: 'superseded' }])
	assert.equal(agentDockAwaitingReply(late.state, PROFILE, TID), false)
	// 17 minutes later it is still closed and nothing else opened.
	const later = run(late.state, [[at + 17 * 60_000, poll(working())]])
	assert.deepEqual(later.events, [])
})

test('real shape: the reply entry read while busy (continuation page) resolves the turn as replied', () => {
	const { state, at } = realTurnOpen()
	const replied = reduce(
		state,
		poll(working(), { transcript: page(RESET_ENTRIES.slice(53, 60), { cursor: 10_050_000 }) }),
		at + 1500,
	)
	assert.deepEqual(replied.events, [{ t: 'item.resolved', at: at + 1500, id: 1, by: 'replied' }])
})

test('real shape: a reset page of the last 200 entries still attributes the reply after the turn', () => {
	const { state, at } = realTurnOpen()
	const replied = reduce(state, poll(working(), { transcript: channelOff(LOG_RESET_REPLY) }), at + 17 * 60_000)
	assert.deepEqual(replied.events, [{ t: 'item.resolved', at: at + 17 * 60_000, id: 1, by: 'replied' }])
	// The tail restarts from the reset page: the agent's latest message, with no reply after it.
	const tail = replied.state.sessions[KEY]?.tail
	assert.equal(tail?.cursor, LOG_RESET_REPLY.cursor)
	assert.notEqual(tail?.lastAssistant?.uuid, TURN_UUID)
	assert.equal(tail?.userAfterLastAssistant, false)
})

test('real shape: a reset page whose window no longer reaches the turn closes it as superseded', () => {
	const { state, at } = realTurnOpen()
	const moved = reduce(
		state,
		poll(working(), { transcript: page(RESET_ENTRIES.slice(60), { cursor: 15_000_000, reset: true }) }),
		at + 1500,
	)
	assert.deepEqual(moved.events, [{ t: 'item.resolved', at: at + 1500, id: 1, by: 'superseded' }])
})

test('background continuation without a reply: a newer message closes the turn at once', () => {
	const { state, at } = withOpenTurn()
	const woke = reduce(
		state,
		poll(working(), {
			transcript: page([tool('t1'), assistant('b2', 'Background build finished.')], { cursor: 1_330_000 }),
		}),
		at + 1000,
	)
	assert.deepEqual(woke.events, [{ t: 'item.resolved', at: at + 1000, id: 1, by: 'superseded' }])
})

test('background continuation that stops at the same message again opens the turn again', () => {
	const { state, at } = withOpenTurn()
	// Tools ran (no reply, no new message) for longer than the debounce, then the agent stopped.
	const { state: final, events } = run(state, [
		[at + 1000, poll(working())],
		[at + 1000 + TURN_RESUMED_MS, poll(working())],
		[at + 20_000, poll(idle(), { transcript: page([tool('t1')], { cursor: 1_330_000 }) })],
		[at + 20_000 + TURN_IDLE_MS, poll(idle())],
	])
	assert.deepEqual(
		events.map(event => (event.t === 'item.resolved' ? `${event.t}:${event.by}` : event.t)),
		['item.resolved:superseded', 'item.opened'],
	)
	const turns = itemsOf(final, 'turn')
	assert.deepEqual(
		turns.map(item => [item.id, item.state]),
		[
			[1, 'resolved'],
			[2, 'open'],
		],
	)
	// The reopened turn keeps when the agent first stopped: its waiting age is not reset.
	assert.equal(turns[1]?.fact.kind === 'turn' && turns[1].fact.endedAt, at - TURN_IDLE_MS)
	assert.equal(turns[0]?.fact.kind === 'turn' && turns[0].fact.endedAt, at - TURN_IDLE_MS)
	// Once only: further idle ticks do not open a third item.
	assert.deepEqual(run(final, [[at + 60_000, poll(idle())]]).events, [])
})

test('repeated wake cycles at the same message keep the first endedAt on every reopen', () => {
	const { state, at } = withOpenTurn()
	let current = state
	let t = at
	for (let cycle = 0; cycle < 3; cycle++) {
		current = run(current, [
			[t + 1000, poll(working())],
			[t + 1000 + TURN_RESUMED_MS, poll(working())],
			[t + 12_000, poll(idle())],
			[t + 12_000 + TURN_IDLE_MS, poll(idle())],
		]).state
		t += 12_000 + TURN_IDLE_MS
	}
	const open = itemsOf(current, 'turn').filter(item => item.state === 'open')
	assert.equal(open.length, 1)
	assert.equal(open[0]?.fact.kind === 'turn' && open[0].fact.endedAt, at - TURN_IDLE_MS)
})

test('a busy blip shorter than the debounce leaves the same turn open with no events', () => {
	const { state, at } = withOpenTurn()
	const { state: final, events } = run(state, [
		[at + 1000, poll(working())],
		[at + 1000 + TURN_RESUMED_MS - 1, poll(working())],
		[at + 1000 + TURN_RESUMED_MS + 500, poll(idle())],
		[at + 1000 + TURN_RESUMED_MS + 500 + TURN_IDLE_MS, poll(idle())],
	])
	assert.deepEqual(events, [])
	const turns = itemsOf(final, 'turn')
	assert.deepEqual(
		turns.map(item => [item.id, item.state]),
		[[1, 'open']],
	)
})

test('a background subagent dialog while the main agent idles does not close the turn', () => {
	const bg = { running_subagents: [{ agent_id: 'a1', agent_type: 'Explore' }] }
	const { state, at } = withOpenTurn()
	const subDialog = ask({ busy: false, ...bg, dialogs: [dialog('4b4eb160-7', at + 1000)] })
	const { state: final, events } = run(state, [
		[at + 1000, poll(idle(bg))],
		[at + 2000, poll(subDialog)],
		[at + 2000 + TURN_RESUMED_MS, poll(subDialog)],
		[at + 30_000, poll(subDialog)],
		[at + 31_000, poll(idle(bg))],
		[at + 31_000 + TURN_IDLE_MS, poll(idle(bg))],
	])
	assert.equal(final.sessions[KEY]?.session.status, 'background')
	// Only the ask item opened and went away; the turn (id 1) stayed open throughout.
	assert.deepEqual(
		events.map(event => (event.t === 'item.resolved' ? `${event.t}:${event.id}:${event.by}` : event.t)),
		['item.opened', 'item.resolved:2:outside'],
	)
	const turn = itemsOf(final, 'turn')[0]
	assert.equal(turn?.id, 1)
	assert.equal(turn?.state, 'open')
})

test('busy stretches split by an observation gap do not add up to the debounce', () => {
	const { state, at } = withOpenTurn()
	// Busy briefly, then nothing observed (Helm asleep / pane unreadable), then busy again.
	const gapped = run(state, [
		[at + 1000, poll(working())],
		[at + 60_000, poll(working())],
	])
	assert.deepEqual(gapped.events, [])
	assert.equal(itemsOf(gapped.state, 'turn')[0]?.state, 'open')
	// A continuous stretch after the gap still closes it.
	const later = reduce(gapped.state, poll(working()), at + 60_000 + TURN_RESUMED_MS)
	assert.deepEqual(later.events, [{ t: 'item.resolved', at: at + 60_000 + TURN_RESUMED_MS, id: 1, by: 'superseded' }])
})

test('an unreadable session detail breaks the busy stretch', () => {
	const { state, at } = withOpenTurn()
	const broken = run(state, [
		[at + 1000, poll(working())],
		[at + 3000, poll({ ...working(), terminal_id: 'someone-else' })],
		[at + 1000 + TURN_RESUMED_MS, poll(working())],
	])
	assert.deepEqual(broken.events, [])
	assert.equal(itemsOf(broken.state, 'turn')[0]?.state, 'open')
})

test('a dialog that stays open past the debounce also closes the turn (the agent moved on)', () => {
	const { state, at } = withOpenTurn()
	const { events } = run(state, [
		[at + 1000, poll(ask({ dialogs: [dialog('4b4eb160-9', at + 1000)] }))],
		[at + 1000 + TURN_RESUMED_MS, poll(ask({ dialogs: [dialog('4b4eb160-9', at + 1000)] }))],
	])
	assert.deepEqual(
		events.map(event => (event.t === 'item.resolved' ? `${event.t}:${event.id}:${event.by}` : event.t)),
		['item.opened', 'item.resolved:1:superseded'],
	)
})

test('subagents still running after the turn: background status and hadBackground', () => {
	const bg = { running_subagents: [{ agent_id: 'a1', agent_type: 'Explore' }] }
	const t1 = T0 + 1000
	const { state } = run(seededWorking(), [
		[t1, poll(idle(bg), { transcript: page([assistant('b1')], { cursor: 1_300_000 }) })],
		[t1 + TURN_IDLE_MS, poll(idle(bg))],
	])
	assert.equal(state.sessions[KEY]?.session.status, 'background')
	assert.equal(state.sessions[KEY]?.session.subagents, 1)
	const [turn] = itemsOf(state, 'turn')
	assert.equal(turn?.fact.kind === 'turn' && turn.fact.hadBackground, true)
})

test('a background shell still running after the turn: background status, "1 shell" counts and hadBackground', () => {
	const shell = { sessionId: SID, tasks: 1, shells: 1 }
	const t1 = T0 + 1000
	const { state } = run(seededWorking(), [
		[t1, poll(idle(), { transcript: page([assistant('b1')], { cursor: 1_300_000 }), background: shell })],
		[t1 + TURN_IDLE_MS, poll(idle(), { background: shell })],
	])
	const session = state.sessions[KEY]?.session
	assert.equal(session?.status, 'background')
	assert.equal(session?.subagents, 0)
	assert.equal(session?.backgroundTasks, 1)
	assert.equal(session?.backgroundShells, 1)
	// The turn still opens (Jakub may want to read "I'll report back when it finishes").
	const [turn] = itemsOf(state, 'turn')
	assert.equal(turn?.state, 'open')
	assert.equal(turn?.fact.kind === 'turn' && turn.fact.hadBackground, true)
	// The shell ends (its notification was read): idle again, counts gone.
	const after = reduce(
		state,
		poll(idle(), { background: { sessionId: SID, tasks: 0, shells: 0 } }),
		t1 + TURN_IDLE_MS + 1500,
	).state
	assert.equal(after.sessions[KEY]?.session.status, 'idle')
	assert.equal(after.sessions[KEY]?.session.backgroundTasks, 0)
})

test('background tasks fail closed: another session, an odd shape or no read claims none', () => {
	const t1 = T0 + 1000
	const statusWith = (background: unknown) =>
		run(seededWorking(), [[t1, poll(idle(), { background })]]).state.sessions[KEY]?.session
	assert.equal(statusWith({ sessionId: 'another-session', tasks: 2, shells: 2 })?.status, 'idle')
	assert.equal(statusWith({ sessionId: SID, tasks: -1, shells: 0 })?.status, 'idle')
	assert.equal(statusWith({ sessionId: SID, tasks: 1.5, shells: 0 })?.status, 'idle')
	assert.equal(statusWith({ sessionId: SID, tasks: '1', shells: 1 })?.status, 'idle')
	assert.equal(statusWith(null)?.status, 'idle')
	const none = run(seededWorking(), [[t1, poll(idle())]]).state.sessions[KEY]?.session
	assert.equal(none?.status, 'idle')
	assert.equal(none?.backgroundTasks, 0)
	// Busy wins: a shell does not hide that the main agent works (the count still shows).
	const busy = run(seededWorking(), [[t1, poll(working(), { background: { sessionId: SID, tasks: 1, shells: 1 } })]])
		.state.sessions[KEY]?.session
	assert.equal(busy?.status, 'working')
	assert.equal(busy?.backgroundTasks, 1)
	// Shells counted beyond the tasks are clamped.
	assert.equal(statusWith({ sessionId: SID, tasks: 1, shells: 5 })?.backgroundShells, 1)
})

test("Helm's hub counts background tasks itself (background_tasks), apart from subagents", () => {
	const t1 = T0 + 1000
	const { state } = run(seededWorking(), [[t1, poll(idle({ background_tasks: 2 }))]])
	const session = state.sessions[KEY]?.session
	assert.equal(session?.status, 'background')
	assert.equal(session?.subagents, 0)
	assert.equal(session?.backgroundTasks, 2)
	assert.equal(session?.backgroundShells, 0, 'no background_shells: none claimed')
	// The hub's shells (Stop's task types) read like Okena's; more shells than tasks never show.
	const shells = run(seededWorking(), [[t1, poll(idle({ background_tasks: 2, background_shells: 5 }))]]).state
	assert.equal(shells.sessions[KEY]?.session.backgroundShells, 2)
	// A mistyped hub count fails the whole detail closed, like any other field.
	const odd = run(seededWorking(), [[t1, poll(idle({ background_tasks: 'two' }))]]).state.sessions[KEY]?.session
	assert.equal(odd?.status, 'unknown')
})

test('turn text is control-stripped and bounded', () => {
	const t1 = T0 + 1000
	const long = `\u001b[31mred\u0007 ${'x'.repeat(TURN_TEXT_MAX * 2)}`
	const { state } = run(seededWorking(), [
		[t1, poll(idle(), { transcript: page([assistant('b1', long)], { cursor: 1_300_000 }) })],
		[t1 + TURN_IDLE_MS, poll(idle())],
	])
	const text =
		itemsOf(state, 'turn')[0]?.fact.kind === 'turn' ? (itemsOf(state, 'turn')[0]?.fact as { text: string }).text : ''
	assert.ok(text.length <= TURN_TEXT_MAX)
	assert.ok(text.startsWith('[31mred '))
	assert.ok(text.endsWith('…'))
})

// --- session end -------------------------------------------------------------

test('session_id change ends the old conversation’s items', () => {
	const { state, at } = withOpenTurn()
	const next = reduce(state, poll(working({ session_id: 'new-session' })), at + 1000)
	assert.deepEqual(next.events, [{ t: 'item.resolved', at: at + 1000, id: 1, by: 'session_ended' }])
	assert.equal(next.state.sessions[KEY]?.tail.cursor, undefined)
	assert.deepEqual(agentDockTranscriptRequest(next.state, PROFILE, TID), {})
	assert.deepEqual(agentDockTranscriptRequest(state, PROFILE, TID), { cursor: 1_300_000, sessionId: SID })
})

test('a pane leaving claude_sessions within one epoch ends its items and drops the row', () => {
	const seeded = run(createAgentDockState(null, T0), [[T0, poll(ask(), { transcript: fullLog() })]]).state
	const gone = reduce(seeded, poll(null), T0 + 1000)
	assert.deepEqual(gone.events, [{ t: 'item.resolved', at: T0 + 1000, id: 1, by: 'session_ended' }])
	assert.equal(gone.state.sessions[KEY], undefined)
})

test('after a reconnect an unlisted pane is never resolved from absence', () => {
	const { state, at } = withOpenTurn()
	const { state: final, events } = run(state, [
		[at + 1000, down()],
		[at + 2000, poll(null)],
		[at + 3000, poll(null)],
	])
	assert.deepEqual(
		events.map(event => event.t),
		['source.health', 'source.health'],
	)
	assert.equal(final.items[0]?.state, 'open')
	assert.equal(final.sessions[KEY]?.session.status, 'unknown')
})

test('state_version regression counts as an Okena restart', () => {
	const seeded = run(createAgentDockState(null, T0), [
		[T0, poll(ask(), { transcript: fullLog(), version: 5000 })],
	]).state
	const next = reduce(seeded, poll(idle(), { version: 3 }), T0 + 1000)
	assert.deepEqual(
		next.events.map(event => event.t),
		['item.orphaned'],
	)
	assert.equal(next.state.sources.okena?.epoch, (seeded.sources.okena?.epoch ?? 0) + 1)
})

// --- ack, snapshot, persistence ----------------------------------------------

test('ack resolves a turn and marks its uuid seen; open asks refuse ack; orphaned asks accept it', () => {
	const { state, at } = withOpenTurn()
	const acked = reduce(state, { type: 'ack', itemId: 1 }, at + 1000)
	assert.deepEqual(acked.events, [{ t: 'item.resolved', at: at + 1000, id: 1, by: 'acked' }])
	assert.equal(acked.state.seen[KEY], 'b1')
	assert.deepEqual(reduce(acked.state, { type: 'ack', itemId: 1 }, at + 2000).events, [])

	const withAsk = run(createAgentDockState(null, T0), [[T0, poll(ask(), { transcript: fullLog() })]]).state
	const refused = reduce(withAsk, { type: 'ack', itemId: 1 }, T0 + 1000)
	assert.deepEqual(refused.events, [])
	assert.equal(refused.state.items[0]?.state, 'open')

	const orphaned = reduce(withAsk, poll(ask({ dialogs: [dialog('ffff0000-1', T0 + 5)] })), T0 + 1000).state
	const dismissed = reduce(orphaned, { type: 'ack', itemId: 1 }, T0 + 2000)
	assert.equal(dismissed.events[0]?.t === 'item.resolved' && dismissed.events[0].by, 'acked')
})

test('live asks sort by how long they have been waiting, not by observation order', () => {
	const now = T0 + 3 * 60 * 60_000
	const { state } = run(createAgentDockState(null, T0), [
		[
			now,
			poll(ask({ dialogs: [dialog('4b4eb160-8', now - 5 * 60_000), dialog('4b4eb160-7', now - 2 * 60 * 60_000)] })),
		],
	])
	assert.deepEqual(
		agentDockSnapshot(state, now).items.map(item => item.fact.kind === 'ask' && item.fact.dialogId),
		['4b4eb160-7', '4b4eb160-8'],
	)
})

test('reduce never mutates its input state', () => {
	const { state, at } = withOpenTurn()
	const before = structuredClone(state)
	reduce(state, { type: 'ack', itemId: 1 }, at + 1)
	reduce(state, down(), at + 2)
	reduce(state, poll(working({ session_id: 'other' })), at + 3)
	assert.deepEqual(state, before)
})

test('snapshot orders open asks, orphaned, open turns, then recent; persistence keeps counter and seen only', () => {
	const { state, at } = withOpenTurn()
	const withAsks = run(state, [
		[at + 1000, poll(ask({ dialogs: [dialog('4b4eb160-9', at)] }))],
		[at + 2000, poll(ask({ dialogs: [dialog('ffff0000-1', at + 2000)] }))],
		[at + 3000, poll(ask({ dialogs: [dialog('ffff0000-1', at + 2000), dialog('ffff0000-2', at + 3000)] }))],
	]).state
	const snapshot = agentDockSnapshot(withAsks, at + 4000)
	assert.deepEqual(
		snapshot.items.map(item => `${item.state}:${item.kind}`),
		['open:ask', 'open:ask', 'orphaned:ask', 'open:turn'],
	)
	assert.equal(snapshot.generatedAt, at + 4000)
	assert.equal(snapshot.sessions[0]?.key, KEY)
	assert.equal('tail' in (snapshot.sessions[0] ?? {}), false)

	const persisted = agentDockPersisted(withAsks)
	assert.deepEqual(Object.keys(persisted).sort(), ['nextItemId', 'seen', 'version'])
	assert.equal(persisted.nextItemId, withAsks.nextItemId)
	const restored = createAgentDockState(persisted, at + 5000)
	assert.deepEqual(restored.sources, {})
	assert.equal(restored.items.length, 0)
	assert.equal(restored.nextItemId, withAsks.nextItemId)
})

// --- profile switch -----------------------------------------------------------

for (const [source, profileA, profileB] of [
	['okena', 'p1', 'p2'],
	['helm', 'helm:work', 'helm:home'],
] as const) {
	const pollAs = (profile: string, detail: Json | null): AgentDockObservation => ({
		...poll(detail),
		source,
		profile,
	})

	test(`${source}: a profile switch orphans the old profile's open asks instead of freezing them`, () => {
		const keyA = sessionKey(profileA, TID)
		const { state, events } = run(createAgentDockState(null, T0), [
			[T0, pollAs(profileA, ask())],
			[T0 + 1_500, pollAs(profileB, null)],
			[T0 + 600_000, pollAs(profileB, null)],
		])
		const item = itemsOf(state, 'ask')[0]
		assert.equal(item?.state, 'orphaned')
		assert.equal(state.sessions[keyA]?.session.status, 'unknown')
		// Nothing resolves from not being observed: the agent may still wait there.
		assert.deepEqual(
			events.map(event => event.t),
			['item.orphaned'],
		)
		// Jakub can clear it; an open ask could not be acked.
		const acked = reduce(state, { type: 'ack', itemId: item?.id ?? 0 }, T0 + 600_001)
		assert.equal(acked.state.items[0]?.resolution?.by, 'acked')
		// Nothing live any more: the next poll of the other profile drops the row.
		assert.equal(reduce(acked.state, pollAs(profileB, null), T0 + 601_500).state.sessions[keyA], undefined)
	})

	test(`${source}: switching back with the dialog still listed reopens the ask`, () => {
		const { state, events } = run(createAgentDockState(null, T0), [
			[T0, pollAs(profileA, ask())],
			[T0 + 1_500, pollAs(profileB, null)],
			[T0 + 3_000, pollAs(profileA, ask())],
		])
		const items = itemsOf(state, 'ask')
		assert.equal(items.length, 1)
		assert.equal(items[0]?.state, 'open')
		assert.equal(items[0]?.orphanedAt, undefined)
		assert.equal(state.sessions[sessionKey(profileA, TID)]?.session.status, 'waiting')
		assert.deepEqual(
			events.map(event => event.t),
			['item.orphaned', 'item.reopened'],
		)
	})

	test(`${source}: transcript activity never closes an orphaned ask whose dialog is listed again`, () => {
		const withPage = (profile: string, transcript: Json): AgentDockObservation => ({
			...poll(ask(), { transcript }),
			source,
			profile,
		})
		const { state } = run(createAgentDockState(null, T0), [
			[T0, withPage(profileA, fullLog())],
			[T0 + 1_500, pollAs(profileB, null)],
			[T0 + 3_000, withPage(profileA, page([assistant('after-switch')], { cursor: 999_999 }))],
		])
		assert.deepEqual(
			itemsOf(state, 'ask').map(item => item.state),
			['open'],
		)
	})
}

// --- boundary -------------------------------------------------------------------

test('the dock core never imports terminal output, pty or screen code', () => {
	const app = new URL('../app/src/', import.meta.url)
	const files = [
		...readdirSync(new URL('agent-dock/', app))
			.filter(name => name.endsWith('.ts'))
			.map(name => new URL(`agent-dock/${name}`, app)),
		new URL('claude-remote/hub-core.ts', app),
		new URL('claude-remote/hub.ts', app),
	]
	const forbidden = /node-pty|xterm|session-buffer|pty-host|\/pty\b|\/sessions?\//
	for (const bad of ['node-pty', '@xterm/headless', '../session-buffer', './pty-host', '../sessions/registry'])
		assert.match(bad, forbidden)
	for (const file of files) {
		const source = readFileSync(file, 'utf8')
		const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
			match => match[1] ?? match[2] ?? '',
		)
		for (const specifier of specifiers)
			assert.doesNotMatch(
				specifier,
				forbidden,
				`${file.pathname}: AGENTS.md: the dock never infers agent state from terminal output/screen/pty liveness`,
			)
	}
})

// --- Agents overview: last message and replies from the agent detail -------------

const sessionOf = (state: AgentDockState, at: number) => agentDockSnapshot(state, at).sessions[0]

test('the snapshot carries the last message as a bounded, sanitized first line; acking marks it seen', () => {
	const t1 = T0 + 1000
	const esc = String.fromCharCode(0x1b)
	const rlo = String.fromCharCode(0x202e)
	const text = `\n\n  ${esc}[31m**Hotovo**${rlo} ${'x'.repeat(400)}\nsecond line`
	const { state } = run(seededWorking(), [
		[t1, poll(idle(), { transcript: page([assistant('b1', text)], { cursor: 1_300_000 }) })],
	])
	const last = sessionOf(state, t1)?.lastMessage
	assert.equal(last?.uuid, 'b1')
	assert.equal(last?.at, t1)
	assert.equal(last?.seen, false)
	assert.ok((last?.text.length ?? 0) <= 160)
	assert.ok(last?.text.startsWith('[31m**Hotovo** xxx'), last?.text)
	assert.ok(last?.text.endsWith('…'))
	assert.ok(!last?.text.includes(esc) && !last?.text.includes(rlo) && !last?.text.includes('\n'))

	// The turn opens, Jakub acks it: the same message now reads as seen.
	const opened = reduce(state, poll(idle()), t1 + TURN_IDLE_MS).state
	const turn = itemsOf(opened, 'turn')[0]
	assert.ok(turn)
	const acked = reduce(opened, { type: 'ack', itemId: turn.id }, t1 + TURN_IDLE_MS + 1000).state
	assert.equal(sessionOf(acked, t1 + TURN_IDLE_MS + 1000)?.lastMessage?.seen, true)

	// A reset page re-reading the same message keeps when Helm first read it.
	const reread = reduce(
		acked,
		poll(idle(), { transcript: page([user('u0'), assistant('b1', text)], { cursor: 1_400_000, reset: true }) }),
		t1 + 60_000,
	).state
	assert.equal(sessionOf(reread, t1 + 60_000)?.lastMessage?.at, t1)
})

test('a first-ever idle pane adopts its last message as seen (read), with its excerpt', () => {
	const { state } = run(createAgentDockState(null, T0), [[T0, poll(idle(), { transcript: fullLog() })]])
	const last = sessionOf(state, T0)?.lastMessage
	assert.equal(last?.uuid, ASSISTANT_UUID)
	assert.equal(last?.seen, true)
	assert.ok(last?.text)
})

/** An idle pane whose last message Jakub has read (adopted at Helm's first look). */
function readPane(): { state: AgentDockState; at: number } {
	const { state } = run(createAgentDockState(null, T0), [[T0, poll(idle(), { transcript: fullLog() })]])
	return { state, at: T0 + 1000 }
}

test('a reply from the agent detail: sending → sent → confirmed once its user entry follows the message', () => {
	const { state, at } = readPane()
	const sending = reduce(state, { type: 'prompt.sending', session: KEY, assistantUuid: ASSISTANT_UUID }, at)
	assert.deepEqual(sending.events, [])
	assert.equal(sessionOf(sending.state, at)?.reply?.status, 'sending')
	assert.equal(sessionOf(sending.state, at)?.reply?.assistantUuid, ASSISTANT_UUID)
	const sent = reduce(
		sending.state,
		{ type: 'prompt.result', session: KEY, outcome: { status: 'sent', delivery: 'pty' } },
		at + 100,
	).state
	assert.deepEqual(
		{ ...sessionOf(sent, at + 100)?.reply },
		{
			action: 'prompt',
			status: 'sent',
			at: at + 100,
			sentAt: at + 100,
			delivery: 'pty',
			assistantUuid: ASSISTANT_UUID,
		},
	)
	// The pane works on it and its transcript shows the reply after the message Jakub read.
	const landed = reduce(
		sent,
		poll(working(), { transcript: page([user('u-dock')], { cursor: 1_500_000 }) }),
		at + 2000,
	).state
	assert.equal(sessionOf(landed, at + 2000)?.reply?.status, 'confirmed')
	// No item was ever opened for it.
	assert.deepEqual(landed.items, [])
})

test('a reply from the agent detail goes unconfirmed after 10 s unseen; refusals keep their reason', () => {
	const { state, at } = readPane()
	const sent = run(state, [
		[at, { type: 'prompt.sending', session: KEY, assistantUuid: ASSISTANT_UUID }],
		[at + 100, { type: 'prompt.result', session: KEY, outcome: { status: 'sent' } }],
		[at + 10_200, poll(idle())],
	]).state
	assert.equal(sessionOf(sent, at + 10_200)?.reply?.status, 'unconfirmed')

	const refused = run(state, [
		[at, { type: 'prompt.sending', session: KEY }],
		[
			at + 100,
			{ type: 'prompt.result', session: KEY, outcome: { status: 'refused', reason: 'changed', detail: 'new' } },
		],
	]).state
	assert.deepEqual(
		{ ...sessionOf(refused, at + 100)?.reply },
		{ action: 'prompt', status: 'refused', at: at + 100, reason: 'changed', detail: 'new' },
	)
	// A result for a reply that is not sending, or for an unknown pane, changes nothing.
	assert.deepEqual(
		reduce(refused, { type: 'prompt.result', session: KEY, outcome: { status: 'sent' } }, at + 200).state.sessions[KEY]
			?.session.reply?.status,
		'refused',
	)
	assert.deepEqual(reduce(state, { type: 'prompt.sending', session: 'p1:nope' }, at).state.sessions, state.sessions)
})

test('a new Claude session in the pane drops the old reply receipt', () => {
	const { state, at } = readPane()
	const sent = run(state, [
		[at, { type: 'prompt.sending', session: KEY, assistantUuid: ASSISTANT_UUID }],
		[at + 100, { type: 'prompt.result', session: KEY, outcome: { status: 'sent' } }],
		[at + 1000, poll(idle({ session_id: 'another-session' }))],
	]).state
	assert.equal(sessionOf(sent, at + 1000)?.reply, undefined)
})

test('a settled agent-detail reply (landed, refused, failed) clears once the agent says something new', () => {
	const { state, at } = readPane()
	for (const outcome of [
		{ status: 'refused', reason: 'changed', detail: 'The agent said something new; check it again.' },
		{ status: 'failed', detail: 'bridge unavailable' },
	] as const) {
		const settled = run(state, [
			[at, { type: 'prompt.sending', session: KEY, assistantUuid: ASSISTANT_UUID }],
			[at + 100, { type: 'prompt.result', session: KEY, outcome }],
			// The same message again: the receipt stays.
			[at + 1000, poll(idle())],
		]).state
		assert.equal(sessionOf(settled, at + 1000)?.reply?.status, outcome.status)
		const moved = reduce(
			settled,
			poll(idle(), { transcript: page([assistant('b-new', 'Něco nového.')], { cursor: 1_600_000 }) }),
			at + 2000,
		).state
		assert.equal(sessionOf(moved, at + 2000)?.lastMessage?.uuid, 'b-new')
		assert.equal(sessionOf(moved, at + 2000)?.reply, undefined, outcome.status)
	}
	// Landed (✓ replied), then the agent answers: the receipt goes with the message it answered.
	const landed = run(state, [
		[at, { type: 'prompt.sending', session: KEY, assistantUuid: ASSISTANT_UUID }],
		[at + 100, { type: 'prompt.result', session: KEY, outcome: { status: 'sent' } }],
		[at + 2000, poll(working(), { transcript: page([user('u-dock')], { cursor: 1_500_000 }) })],
	]).state
	assert.equal(sessionOf(landed, at + 2000)?.reply?.status, 'confirmed')
	const answered = reduce(
		landed,
		poll(idle(), { transcript: page([assistant('b-answer', 'Hotovo.')], { cursor: 1_600_000 }) }),
		at + 5000,
	).state
	assert.equal(sessionOf(answered, at + 5000)?.reply, undefined)
})

test('a reply naming an older message than the last one never moves seen back (no turn for an acked message)', () => {
	const { state, at } = readPane()
	// Jakub has seen ASSISTANT_UUID; the renderer's (stale) live read still shows an older uuid.
	const sending = reduce(state, { type: 'prompt.sending', session: KEY, assistantUuid: 'older-uuid' }, at).state
	assert.equal(sending.seen[KEY], ASSISTANT_UUID)
	assert.equal(sessionOf(sending, at)?.lastMessage?.seen, true)
	const refused = run(sending, [
		[
			at + 100,
			{ type: 'prompt.result', session: KEY, outcome: { status: 'refused', reason: 'changed', detail: 'new' } },
		],
		[at + 100 + TURN_IDLE_MS + 1000, poll(idle())],
	]).state
	assert.deepEqual(itemsOf(refused, 'turn'), [])
})
