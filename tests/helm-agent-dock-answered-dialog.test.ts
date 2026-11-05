// An Okena dialog Jakub already answered in the terminal, which Okena keeps listing
// (its PostToolUse match is exact, and Claude adds `answers` to the input): the
// session's own transcript file proves it answered, so the dock closes the ask
// `outside`, opens none for it, and never sends a decision for it. A dialog that
// genuinely waits (no result for its call, or only an older call's) stays.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import tailModule from '../app/src/agent-dock/claude-transcript-tail.ts'
import modelModule from '../app/src/agent-dock/model.ts'
import sourceModule from '../app/src/agent-dock/okena-claude-source.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'
import toolCallsModule from '../app/src/agent-dock/tool-calls.ts'
import { okenaFixture } from './helpers/agent-dock'

type TailModule = typeof import('../app/src/agent-dock/claude-transcript-tail.ts')
type ModelModule = typeof import('../app/src/agent-dock/model.ts')
type SourceModule = typeof import('../app/src/agent-dock/okena-claude-source.ts')
type ReduceModule = typeof import('../app/src/agent-dock/reduce.ts')
type ToolCallsModule = typeof import('../app/src/agent-dock/tool-calls.ts')
type AgentDockState = import('../app/src/agent-dock/reduce.ts').AgentDockState
type AgentDockObservation = import('../app/src/agent-dock/model.ts').AgentDockObservation
type ToolCall = import('../app/src/agent-dock/tool-calls.ts').ToolCall
type OkenaClaudeClient = import('../app/src/agent-dock/okena-claude-source.ts').OkenaClaudeClient
type BackgroundTaskObserver = import('../app/src/agent-dock/claude-transcript-tail.ts').BackgroundTaskObserver

const { ClaudeTranscriptTail } = tailModule as TailModule
const { sessionKey } = modelModule as ModelModule
const { OkenaClaudeSource } = sourceModule as SourceModule
const { agentDockSnapshot, createAgentDockState, reduce } = reduceModule as ReduceModule
const { CALL_STRING_MAX, TOOL_CALLS_MAX, applyToolCallLine, dialogAnsweredInTranscript, emptyToolCalls } =
	toolCallsModule as ToolCallsModule

type Json = Record<string, unknown>
const SHOW_ASK = okenaFixture('show-ask.json')
const STATE_ASK = okenaFixture('state-ask.json')
const PROFILE = 'p1'
const TID = SHOW_ASK.terminal_id as string
const SID = SHOW_ASK.session_id as string
const KEY = sessionKey(PROFILE, TID)
const QUESTIONS = ((SHOW_ASK.dialogs as Json[])[0] as Json).tool_input as Json
const DIALOG_ID = 'cb5e65f6-1'
/** The incident (2026-11-05, UTC): call 11:33:34.091, dialog raised, answered 11:34:13.618, Stop 11:35:27. */
const CALL_AT = Date.parse('2026-11-05T11:33:34.091Z')
const DIALOG_AT = CALL_AT + 150
const ANSWER_AT = Date.parse('2026-11-05T11:34:13.618Z')
const clone = <T>(value: T): T => structuredClone(value)

// ---------------------------------------------------------------------------
// Transcript lines, shaped like Claude Code 2.1.318 writes them (texts shortened).
// ---------------------------------------------------------------------------

const toolUseLine = (id: string, name: string, input: unknown, at: number, extra: Json = {}): string =>
	JSON.stringify({
		parentUuid: 'p',
		isSidechain: false,
		message: {
			model: 'claude-opus-5-5',
			id: `msg_${id}`,
			type: 'message',
			role: 'assistant',
			content: [{ type: 'tool_use', id, name, input }],
		},
		type: 'assistant',
		uuid: `a-${id}`,
		timestamp: new Date(at).toISOString(),
		sessionId: SID,
		...extra,
	})

const toolResultLine = (id: string, content: string, at: number, toolUseResult: unknown = {}, extra: Json = {}) =>
	JSON.stringify({
		parentUuid: `a-${id}`,
		isSidechain: false,
		type: 'user',
		message: { role: 'user', content: [{ type: 'tool_result', content, tool_use_id: id }] },
		uuid: `u-${id}`,
		timestamp: new Date(at).toISOString(),
		toolUseResult,
		sessionId: SID,
		...extra,
	})

const ANSWERS = { 'Barva?': 'Blue', 'Velikost?': 'M' }
const askCall = (id = 'toolu_01AJipBLNwub9BPmDUVm4PGd', at = CALL_AT) =>
	toolUseLine(id, 'AskUserQuestion', QUESTIONS, at)
const askAnswer = (id = 'toolu_01AJipBLNwub9BPmDUVm4PGd', at = ANSWER_AT) =>
	toolResultLine(id, 'Your questions have been answered: "Barva?"="Blue", "Velikost?"="M".', at, {
		...QUESTIONS,
		answers: ANSWERS,
	})

const scan = (lines: string[]): ToolCall[] => lines.reduce(applyToolCallLine, emptyToolCalls()).calls
const askDialog = (overrides: Json = {}) => ({
	tool_name: 'AskUserQuestion',
	tool_input: clone(QUESTIONS),
	created_at_ms: DIALOG_AT,
	...overrides,
})

// ---------------------------------------------------------------------------
// Pure: tool calls and the answered proof
// ---------------------------------------------------------------------------

test('the transcript lines give the main agent calls with their result times; sidechains and junk claim nothing', () => {
	const calls = scan([
		askCall(),
		'{"type":"assistant","message":{"content":"not blocks"}}',
		'not json "tool_use"',
		toolUseLine('toolu_side', 'Bash', { command: 'ls' }, CALL_AT, { isSidechain: true }),
		toolUseLine('toolu_notime', 'Bash', { command: 'ls' }, CALL_AT, { timestamp: 'never' }),
		toolResultLine('toolu_unknown', 'ok', ANSWER_AT),
		askAnswer(),
		// A second result for the same call never moves its time.
		askAnswer(undefined, ANSWER_AT + 5_000),
	])
	assert.deepEqual(calls, [
		{
			id: 'toolu_01AJipBLNwub9BPmDUVm4PGd',
			name: 'AskUserQuestion',
			input: QUESTIONS,
			at: CALL_AT,
			resultAt: ANSWER_AT,
		},
	])
	// Strings are clipped; the list is bounded.
	const long = scan([toolUseLine('toolu_long', 'Write', { file_path: '/a', content: 'x'.repeat(5_000) }, CALL_AT)])
	assert.equal(((long[0]?.input as Json).content as string).length, CALL_STRING_MAX)
	const many = scan(
		Array.from({ length: TOOL_CALLS_MAX + 5 }, (_, i) =>
			toolUseLine(`toolu_${i}`, 'Bash', { command: `${i}` }, CALL_AT),
		),
	)
	assert.equal(many.length, TOOL_CALLS_MAX)
	assert.equal(many[0]?.id, 'toolu_5')
})

test('a question answered in the terminal is proven answered; one still waiting is not', () => {
	assert.equal(dialogAnsweredInTranscript(askDialog(), scan([askCall(), askAnswer()]), false), true)
	// Subagents running (the agent launched a workflow right after): a question is the main agent's own.
	assert.equal(dialogAnsweredInTranscript(askDialog(), scan([askCall(), askAnswer()]), true), true)
	// Waiting: the call has no result yet.
	assert.equal(dialogAnsweredInTranscript(askDialog(), scan([askCall()]), false), false)
	// No call read at all (outside the tail's window): no claim.
	assert.equal(dialogAnsweredInTranscript(askDialog(), [], false), false)
	// Other questions: not this dialog's call.
	const other = { questions: [{ question: 'Jinak?', header: 'X', options: [], multiSelect: false }] }
	assert.equal(
		dialogAnsweredInTranscript(askDialog({ tool_input: other }), scan([askCall(), askAnswer()]), false),
		false,
	)
	// The same questions asked again: the earlier call was answered, the new one waits.
	const again = scan([askCall('toolu_old', CALL_AT - 60_000), askAnswer('toolu_old', CALL_AT - 30_000), askCall()])
	assert.equal(dialogAnsweredInTranscript(askDialog(), again, false), false)
	// A result older than the dialog belongs to an older call, never to this dialog.
	const stale = scan([askCall('toolu_old', CALL_AT - 60_000), askAnswer('toolu_old', CALL_AT - 30_000)])
	assert.equal(dialogAnsweredInTranscript(askDialog(), stale, false), false)
	// A call written well after the dialog was raised is another call.
	const later = scan([askCall('toolu_later', DIALOG_AT + 5_000), askAnswer('toolu_later', DIALOG_AT + 9_000)])
	assert.equal(dialogAnsweredInTranscript(askDialog(), later, false), false)
	// Okena cuts dialog strings over 16 KiB: the clipped prefix still matches.
	const big = { questions: [{ question: `${'q'.repeat(20_000)}`, header: 'H', options: [], multiSelect: false }] }
	const cut = clone(big)
	;(cut.questions[0] as Json).question = `${'q'.repeat(16_384)}…`
	assert.equal(
		dialogAnsweredInTranscript(
			askDialog({ tool_input: cut }),
			scan([toolUseLine('toolu_big', 'AskUserQuestion', big, CALL_AT), askAnswer('toolu_big')]),
			false,
		),
		true,
	)
})

test('plans and permissions: the same rule, and a permission while subagents run is never claimed', () => {
	// ExitPlanMode: the model's input may lack the plan its permission dialog shows.
	const plan = { tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n\n1. do it' }, created_at_ms: DIALOG_AT }
	const planCalls = scan([
		toolUseLine('toolu_plan', 'ExitPlanMode', {}, CALL_AT),
		toolResultLine('toolu_plan', 'ok', ANSWER_AT),
	])
	assert.equal(dialogAnsweredInTranscript(plan, planCalls, false), true)
	// A permission: the same Bash command run earlier (finished before the dialog) proves nothing.
	const bash = {
		tool_name: 'Bash',
		tool_input: { command: 'rm -rf dist', description: 'Clean' },
		created_at_ms: DIALOG_AT,
	}
	const earlier = scan([
		toolUseLine('toolu_b1', 'Bash', { command: 'rm -rf dist', description: 'Clean' }, CALL_AT - 60_000),
		toolResultLine('toolu_b1', '', CALL_AT - 59_000),
	])
	assert.equal(dialogAnsweredInTranscript(bash, earlier, false), false)
	const ran = scan([
		toolUseLine('toolu_b2', 'Bash', { command: 'rm -rf dist', description: 'Clean' }, CALL_AT),
		toolResultLine('toolu_b2', '', ANSWER_AT),
	])
	assert.equal(dialogAnsweredInTranscript(bash, ran, false), true)
	// A subagent may have raised a permission for the same call: no claim while subagents run.
	assert.equal(dialogAnsweredInTranscript(bash, ran, true), false)
})

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function okenaState(version: number, dialogs: number): Json {
	return {
		...clone(STATE_ASK),
		state_version: version,
		claude_sessions: [TID],
		claude_dialogs: dialogs ? { [TID]: dialogs } : {},
		projects: [
			{
				id: 'proj-1',
				name: 'fix/mobile-project-crane-search',
				path: '/repo/crane',
				layout: { type: 'split', children: [{ type: 'terminal', terminal_id: TID }] },
			},
		],
	}
}

const detail = (overrides: Json = {}): Json => ({
	...clone(SHOW_ASK),
	channel_attached: false,
	busy: true,
	dialogs: [
		{
			id: DIALOG_ID,
			tool_name: 'AskUserQuestion',
			tool_input: clone(QUESTIONS),
			permission_suggestions: [],
			created_at_ms: DIALOG_AT,
		},
	],
	...overrides,
})

let version = 4_000
function poll(body: Json, background?: unknown): AgentDockObservation {
	version += 1
	return {
		type: 'poll',
		source: 'okena',
		profile: PROFILE,
		state: { ok: true, body: okenaState(version, (body.dialogs as Json[]).length) },
		terminals: [{ terminalId: TID, detail: { ok: true, body }, ...(background ? { background } : {}) }],
	}
}

const observed = (lines: string[], sessionId = SID) => ({ sessionId, tasks: 0, shells: 0, calls: scan(lines) })

/** Seeded, then the dialog is listed (the ask opens) while the call has no result yet. */
function waitingAsk(): AgentDockState {
	let state = createAgentDockState(null, DIALOG_AT - 2_000)
	state = reduce(state, poll(detail({ dialogs: [], busy: true })), DIALOG_AT - 2_000).state
	state = reduce(state, poll(detail(), observed([askCall()])), DIALOG_AT + 200).state
	const ask = state.items.find(item => item.kind === 'ask')
	assert.equal(ask?.state, 'open')
	return state
}

test('Okena still lists the answered question: the ask closes "answered in terminal" and the agent reads working', () => {
	let state = waitingAsk()
	// Jakub answered in the terminal; Okena still lists the dialog, the agent works on.
	const after = reduce(state, poll(detail(), observed([askCall(), askAnswer()])), ANSWER_AT + 3_000)
	state = after.state
	const ask = state.items.find(item => item.kind === 'ask')
	assert.equal(ask?.state, 'resolved')
	assert.equal(ask?.resolution?.by, 'outside')
	assert.deepEqual(
		after.events.filter(event => event.t === 'item.resolved').map(event => (event as { by: string }).by),
		['outside'],
	)
	const session = agentDockSnapshot(state, ANSWER_AT + 3_000).sessions.find(entry => entry.key === KEY)
	assert.equal(session?.status, 'working')
	// Listed again on the next polls: it never reopens, and no new ask opens for it.
	state = reduce(state, poll(detail(), observed([askCall(), askAnswer()])), ANSWER_AT + 5_000).state
	assert.equal(state.items.filter(item => item.kind === 'ask').length, 1)
	assert.equal(state.items.find(item => item.kind === 'ask')?.state, 'resolved')
})

test('a dialog that still waits stays: no result, busy without a result, or calls of another session', () => {
	let state = waitingAsk()
	// Busy for a minute, the transcript shows nothing after the call: the agent is blocked on it.
	state = reduce(state, poll(detail(), observed([askCall()])), ANSWER_AT).state
	assert.equal(state.items.find(item => item.kind === 'ask')?.state, 'open')
	assert.equal(agentDockSnapshot(state, ANSWER_AT).sessions[0]?.status, 'waiting')
	// No transcript observation at all: no claim.
	state = reduce(state, poll(detail()), ANSWER_AT + 1_000).state
	assert.equal(state.items.find(item => item.kind === 'ask')?.state, 'open')
	// An answer read from another session's file proves nothing about this pane.
	state = reduce(state, poll(detail(), observed([askCall(), askAnswer()], 'other-session-id')), ANSWER_AT + 2_000).state
	assert.equal(state.items.find(item => item.kind === 'ask')?.state, 'open')
	// Calls of an odd shape (another process) are dropped: no claim.
	state = reduce(
		state,
		poll(detail(), { sessionId: SID, tasks: 0, shells: 0, calls: [{ id: 1, name: 'AskUserQuestion' }] }),
		ANSWER_AT + 3_000,
	).state
	assert.equal(state.items.find(item => item.kind === 'ask')?.state, 'open')
})

test('a dialog first seen already answered never opens an ask', () => {
	let state = createAgentDockState(null, ANSWER_AT)
	state = reduce(state, poll(detail({ dialogs: [], busy: true })), ANSWER_AT).state
	state = reduce(state, poll(detail(), observed([askCall(), askAnswer()])), ANSWER_AT + 1_000).state
	assert.equal(state.items.filter(item => item.kind === 'ask').length, 0)
})

// ---------------------------------------------------------------------------
// The tail reads the calls from the file; the act never answers a proven-answered dialog
// ---------------------------------------------------------------------------

test('the transcript tail reports the main agent calls with the background counts', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-answered-'))
	try {
		const folder = join(root, 'projects', '-repo-crane')
		mkdirSync(folder, { recursive: true })
		writeFileSync(join(folder, `${SID}.jsonl`), `${[askCall(), askAnswer()].join('\n')}\n`)
		const tail = new ClaudeTranscriptTail([root])
		const result = await tail.observe(SID, { cwd: '/repo/crane', refresh: true, now: ANSWER_AT })
		assert.equal(result?.tasks, 0)
		assert.equal(result?.calls?.[0]?.resultAt, ANSWER_AT)
		assert.equal(dialogAnsweredInTranscript(askDialog(), result?.calls ?? [], false), true)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

class FakeOkena implements OkenaClaudeClient {
	posts: unknown[] = []
	activeProfileId(): string | null {
		return PROFILE
	}
	forProfile(): OkenaClaudeClient {
		return this
	}
	async getStateJson(): Promise<unknown> {
		return okenaState(version, 1)
	}
	async getClaudeSession(): Promise<unknown> {
		return detail()
	}
	async getClaudeTranscript(): Promise<unknown> {
		return { session_id: SID, entries: [], cursor: 10, reset: true }
	}
	async postClaudeDialogDecision(_t: string, dialogId: string, decision: unknown): Promise<void> {
		this.posts.push({ dialogId, decision })
	}
}

test('answering a dialog the transcript proves answered is refused before any POST', async () => {
	const state = waitingAsk()
	const item = state.items.find(entry => entry.kind === 'ask')
	assert.ok(item)
	const target = { source: 'okena' as const, profile: PROFILE, terminalId: TID }
	const action = { type: 'answer' as const, picks: [{ options: [1] }, { options: [1] }] }
	let lines = [askCall(), askAnswer()]
	const observer: BackgroundTaskObserver = {
		async observe(sessionId) {
			return { sessionId, tasks: 0, shells: 0, calls: scan(lines) }
		},
	}
	const okena = new FakeOkena()
	const source = new OkenaClaudeSource(okena, 'okena', observer)
	assert.deepEqual(await source.act(target, item, action), {
		status: 'refused',
		reason: 'gone',
		detail: 'already answered elsewhere',
	})
	assert.deepEqual(okena.posts, [])
	// Still waiting (no result yet): the answer goes through.
	lines = [askCall()]
	assert.deepEqual(await source.act(target, item, action), { status: 'sent' })
	assert.equal(okena.posts.length, 1)
	// An observer that throws claims nothing.
	const broken = new OkenaClaudeSource(okena, 'okena', {
		observe: async () => {
			throw new Error('EACCES')
		},
	})
	assert.deepEqual(await broken.act(target, item, action), { status: 'sent' })
})
