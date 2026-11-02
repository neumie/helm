import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import modelModule from '../app/src/agent-dock/model.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'

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
	TURN_IDLE_MS,
	TURN_RESUMED_MS,
	TURN_TEXT_MAX,
	agentDockAwaitingReply,
	agentDockPersisted,
	agentDockSnapshot,
	agentDockTranscriptRequest,
	createAgentDockState,
	reduce,
} = reduceModule as ReduceModule

function fixture<T = Record<string, unknown>>(name: string): T {
	return JSON.parse(readFileSync(new URL(`./fixtures/okena-claude/${name}`, import.meta.url), 'utf8')) as T
}

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
function poll(detail: Json | null, opts: { transcript?: Json; version?: number } = {}): AgentDockObservation {
	stateVersion += 1
	const dialogs = (detail?.dialogs as Json[] | undefined)?.length
	return {
		type: 'poll',
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
					},
				]
			: [],
	}
}
const down = (error = 'connect ECONNREFUSED'): AgentDockObservation => ({
	type: 'poll',
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
	assert.equal(state.source.state, 'ok')
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
	// The same dialog id never reopens (dedupe key retained in Recent).
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
	assert.equal(itemsOf(early.state, 'turn')[0]?.rev, 1)

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
