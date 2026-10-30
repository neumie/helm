// Agent dock slice 2: answering from a card. Pure pieces only (reducer act
// lifecycle, CAS checks, Okena bodies, presentation receipts); the HTTP path
// against a fake Okena lives in helm-agent-dock-act-okena.test.ts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import actModule from '../app/src/agent-dock/act.ts'
import modelModule from '../app/src/agent-dock/model.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'
import presentationModule from '../app/src/renderer/agent-dock/presentation.ts'

type ActModule = typeof import('../app/src/agent-dock/act.ts')
type ModelModule = typeof import('../app/src/agent-dock/model.ts')
type ReduceModule = typeof import('../app/src/agent-dock/reduce.ts')
type PresentationModule = typeof import('../app/src/renderer/agent-dock/presentation.ts')
type AgentDockState = import('../app/src/agent-dock/reduce.ts').AgentDockState
type AgentDockObservation = import('../app/src/agent-dock/model.ts').AgentDockObservation
type DockItem = import('../app/src/agent-dock/model.ts').DockItem
type DockAction = import('../app/src/agent-dock/model.ts').DockAction

const { askStillOpen, dockActBody, dockPostFailure, turnStillWaiting } = actModule as ActModule
const {
	ACT_CONFIRM_MS,
	DOCK_RISKY_PROMPT,
	parseAgentDockActRequest,
	parseOkenaClaudeSession,
	parseOkenaClaudeTranscriptPage,
	sessionKey,
	stableJson,
} = modelModule as ModelModule
const { TURN_IDLE_MS, createAgentDockState, reduce } = reduceModule as ReduceModule
const { RISKY_PROMPT, lingeringItems, railItems, receiptView, riskyWord, RECEIPT_LINGER_MS } =
	presentationModule as PresentationModule

type Json = Record<string, unknown>
function fixture<T = Json>(name: string): T {
	return JSON.parse(readFileSync(new URL(`./fixtures/okena-claude/${name}`, import.meta.url), 'utf8')) as T
}
const SHOW_ASK = fixture('show-ask.json')
const SHOW_IDLE = fixture('show-idle.json')
const STATE_ASK = fixture('state-ask.json')
const clone = <T>(value: T): T => structuredClone(value)

const PROFILE = 'p1'
const TID = SHOW_ASK.terminal_id as string
const SID = SHOW_ASK.session_id as string
const KEY = sessionKey(PROFILE, TID)
const DIALOG = (SHOW_ASK.dialogs as Json[])[0] as Json
const DIALOG_ID = DIALOG.id as string
const T0 = 1_793_364_800_000

const ask = (overrides: Json = {}): Json => ({ ...clone(SHOW_ASK), channel_attached: false, ...overrides })
const idle = (overrides: Json = {}): Json => ({ ...clone(SHOW_IDLE), channel_attached: false, ...overrides })
const permissionDialog = (overrides: Json = {}): Json => ({
	id: `${DIALOG_ID.split('-')[0]}-9`,
	tool_name: 'Bash',
	tool_input: { command: 'npm run deploy:stage', description: 'Deploy to stage' },
	permission_suggestions: [
		{
			type: 'addRules',
			rules: [{ toolName: 'Bash', ruleContent: 'npm run deploy:stage' }],
			behavior: 'allow',
			destination: 'localSettings',
		},
	],
	created_at_ms: T0,
	...overrides,
})

let version = 5_000
function poll(detail: Json | null, transcript?: Json): AgentDockObservation {
	version += 1
	const dialogs = (detail?.dialogs as Json[] | undefined)?.length
	return {
		type: 'poll',
		profile: PROFILE,
		state: {
			ok: true,
			body: {
				...clone(STATE_ASK),
				state_version: version,
				claude_sessions: detail ? [TID] : [],
				claude_dialogs: dialogs ? { [TID]: dialogs } : {},
				projects: [
					{
						id: 'proj-1',
						name: 'helm',
						path: '/repo/helm',
						layout: { type: 'split', children: [{ type: 'terminal', terminal_id: TID }] },
						terminal_names: { [TID]: 'dock-test' },
					},
				],
			},
		},
		terminals: detail
			? [
					{
						terminalId: TID,
						detail: { ok: true, body: detail },
						...(transcript ? { transcript: { ok: true, body: transcript } } : {}),
					},
				]
			: [],
	}
}
const page = (entries: Json[], cursor: number, reset = false): Json => ({ session_id: SID, entries, cursor, reset })
const assistant = (uuid: string, text = 'Done.'): Json => ({ kind: 'assistant', uuid, text })
const user = (uuid: string): Json => ({ kind: 'user', uuid, text: 'go on', origin: 'terminal' })

function drive(steps: Array<[number, AgentDockObservation]>, start = createAgentDockState(null, T0)) {
	let state: AgentDockState = start
	const events: Array<Record<string, unknown>> = []
	for (const [at, observation] of steps) {
		const result = reduce(state, observation, at)
		state = result.state
		events.push(...(result.events as unknown as Array<Record<string, unknown>>))
	}
	return { state, events }
}

const only = (state: AgentDockState, kind: 'ask' | 'turn' = 'ask'): DockItem => {
	const item = state.items.find(candidate => candidate.kind === kind)
	assert.ok(item, `no ${kind} item`)
	return item
}

/** Seeded with the recorded two-question AskUserQuestion open. */
function askOpen() {
	return drive([[T0, poll(ask())]])
}

const ANSWER: DockAction = { type: 'answer', picks: [{ options: [1] }, { options: [0] }] }

// ---------------------------------------------------------------------------
// Reducer: act lifecycle
// ---------------------------------------------------------------------------

test('dock answer: sending → sent → dialog closes → resolved by dock with a confirmed receipt', () => {
	const { state: seeded } = askOpen()
	const item = only(seeded)
	assert.equal(item.rev, 1)
	const { state, events } = drive(
		[
			[T0 + 1_000, { type: 'act.sending', itemId: item.id, action: 'answer' }],
			[T0 + 1_100, { type: 'act.result', itemId: item.id, outcome: { status: 'sent' } }],
			[T0 + 2_000, poll(ask({ dialogs: [] }))],
		],
		seeded,
	)
	const done = only(state)
	assert.equal(done.state, 'resolved')
	assert.deepEqual(done.resolution, { at: T0 + 2_000, by: 'dock' })
	assert.equal(done.receipt?.status, 'confirmed')
	assert.equal(done.receipt?.action, 'answer')
	assert.deepEqual(
		events.map(event => [event.t, event.status ?? event.by]),
		[
			['act.outcome', 'confirmed'],
			['item.resolved', 'dock'],
		],
	)
})

test('sending is visible before the POST answers; the dialog closing mid-flight is not attributed yet', () => {
	const { state: seeded } = askOpen()
	const item = only(seeded)
	const sending = drive([[T0 + 1_000, { type: 'act.sending', itemId: item.id, action: 'answer' }]], seeded).state
	assert.equal(only(sending).state, 'sending')
	assert.equal(only(sending).receipt?.status, 'sending')
	// A tick lands while the POST is still out: dialog gone, but it may have been the terminal.
	const midFlight = drive([[T0 + 1_200, poll(ask({ dialogs: [] }))]], sending).state
	assert.equal(only(midFlight).state, 'sending')
	// The POST answered 2xx: the next poll (dialog still gone) is Jakub's answer.
	const after = drive(
		[
			[T0 + 1_300, { type: 'act.result', itemId: item.id, outcome: { status: 'sent' } }],
			[T0 + 2_800, poll(ask({ dialogs: [] }))],
		],
		midFlight,
	).state
	assert.equal(only(after).resolution?.by, 'dock')
})

test('sent but not observed for 10 s: unconfirmed (event once); still open later = reopened; a close still confirms', () => {
	const { state: seeded } = askOpen()
	const item = only(seeded)
	const { state, events } = drive(
		[
			[T0 + 1_000, { type: 'act.sending', itemId: item.id, action: 'answer' }],
			[T0 + 1_100, { type: 'act.result', itemId: item.id, outcome: { status: 'sent' } }],
			[T0 + 5_000, poll(ask())],
			[T0 + 1_100 + ACT_CONFIRM_MS, poll(ask())],
			[T0 + 20_000, poll(ask())],
		],
		seeded,
	)
	assert.equal(only(state).state, 'unconfirmed')
	assert.equal(only(state).receipt?.status, 'unconfirmed')
	assert.deepEqual(
		events.filter(event => event.t === 'act.outcome').map(event => event.status),
		['unconfirmed'],
	)
	// Not ackable while Okena still shows the dialog: the answer may never have landed.
	assert.equal(only(reduce(state, { type: 'ack', itemId: item.id }, T0 + 21_000).state).state, 'unconfirmed')
	// Still open ACT_CONFIRM_MS after going unconfirmed: it was not delivered; the item owes Jakub again.
	const reopened = drive([[T0 + 1_100 + 2 * ACT_CONFIRM_MS, poll(ask())]], state)
	assert.equal(only(reopened.state).state, 'open')
	assert.equal(only(reopened.state).receipt?.status, 'failed')
	assert.match(receiptView(only(reopened.state))?.text ?? '', /Not delivered/)
	assert.deepEqual(
		reopened.events.filter(event => event.t === 'act.outcome').map(event => event.status),
		['failed'],
	)
	// Once Okena restarted (its dialog ids died), Jakub may check the terminal and ack.
	const restarted = {
		...state,
		sessions: { [KEY]: { ...state.sessions[KEY], dialogIds: undefined } },
	} as AgentDockState
	const acked = reduce(restarted, { type: 'ack', itemId: item.id }, T0 + 21_000).state
	assert.equal(only(acked).resolution?.by, 'acked')
	// He dismissed it himself: it leaves the rail at once (no lingering receipt).
	assert.deepEqual(
		lingeringItems({ generatedAt: T0, source: acked.source, sessions: [], items: acked.items }, T0 + 21_000),
		[],
	)
	const closed = drive([[T0 + 22_000, poll(ask({ dialogs: [] }))]], state).state
	assert.equal(only(closed).resolution?.by, 'dock')
	const sendingState = drive([[T0 + 1_000, { type: 'act.sending', itemId: item.id, action: 'answer' }]], seeded).state
	assert.equal(only(reduce(sendingState, { type: 'ack', itemId: item.id }, T0 + 1_500).state).state, 'sending')
})

test('a refused act returns the item to open with its receipt; the close that follows is "outside"', () => {
	const { state: seeded } = askOpen()
	const item = only(seeded)
	const { state, events } = drive(
		[
			[T0 + 1_000, { type: 'act.sending', itemId: item.id, action: 'answer' }],
			[
				T0 + 1_100,
				{
					type: 'act.result',
					itemId: item.id,
					outcome: { status: 'refused', reason: 'gone', detail: 'already answered elsewhere' },
				},
			],
		],
		seeded,
	)
	assert.equal(only(state).state, 'open')
	assert.equal(only(state).receipt?.status, 'refused')
	assert.equal(only(state).receipt?.reason, 'gone')
	assert.deepEqual(
		events.map(event => [event.t, event.status, event.reason]),
		[['act.outcome', 'refused', 'gone']],
	)
	const closed = drive([[T0 + 2_000, poll(ask({ dialogs: [] }))]], state).state
	assert.equal(only(closed).resolution?.by, 'outside')
	assert.equal(only(closed).receipt?.status, 'refused')
	// The renderer keeps it on the rail a moment with the refusal.
	const snapshot = { generatedAt: T0 + 2_500, source: closed.source, sessions: [], items: closed.items }
	assert.equal(lingeringItems(snapshot, T0 + 2_500).length, 1)
	assert.equal(receiptView(only(closed))?.text, 'refused: already answered elsewhere')
	assert.equal(railItems(snapshot, T0 + 2_000 + RECEIPT_LINGER_MS).length, 0)
})

test('a failed act keeps the verbatim error, reopens the item, and a retry can send again', () => {
	const { state: seeded } = askOpen()
	const item = only(seeded)
	const detail = 'Okena POST /v1/claude/terminals/t/dialogs/d failed (500): bridge unavailable'
	const failed = drive(
		[
			[T0 + 1_000, { type: 'act.sending', itemId: item.id, action: 'answer' }],
			[T0 + 1_100, { type: 'act.result', itemId: item.id, outcome: { status: 'failed', detail } }],
		],
		seeded,
	).state
	assert.equal(only(failed).state, 'open')
	assert.equal(receiptView(only(failed))?.text, detail)
	assert.equal(receiptView(only(failed))?.tone, 'danger')
	const retry = drive([[T0 + 2_000, { type: 'act.sending', itemId: item.id, action: 'answer' }]], failed).state
	assert.equal(only(retry).state, 'sending')
	assert.equal(only(retry).receipt?.status, 'sending')
	assert.equal(only(retry).receipt?.detail, undefined)
})

test('transport timeout after sending is unconfirmed at once (it may have landed)', () => {
	const { state: seeded } = askOpen()
	const item = only(seeded)
	const { state } = drive(
		[
			[T0 + 1_000, { type: 'act.sending', itemId: item.id, action: 'answer' }],
			[T0 + 16_000, { type: 'act.result', itemId: item.id, outcome: { status: 'unconfirmed', detail: 'No answer' } }],
		],
		seeded,
	)
	assert.equal(only(state).state, 'unconfirmed')
	assert.equal(receiptView(only(state))?.text, 'sent, unconfirmed')
	assert.equal(receiptView(only(state))?.tone, 'warn')
})

/** An idle pane whose last assistant message became an unchecked turn item. */
function turnOpen() {
	return drive([
		[T0, poll(idle({ busy: true }), page([user('u0'), assistant('a0')], 100, true))],
		[T0 + 1_000, poll(idle({ busy: false }), page([assistant('a1', 'Deploy to stage?')], 200))],
		[T0 + 1_000 + TURN_IDLE_MS, poll(idle({ busy: false }))],
	])
}

test('dock reply: the user entry (even read while busy) resolves the turn by dock, not "replied"', () => {
	const { state: open } = turnOpen()
	const turn = only(open, 'turn')
	assert.equal(turn.state, 'open')
	const { state, events } = drive(
		[
			[T0 + 20_000, { type: 'act.sending', itemId: turn.id, action: 'prompt' }],
			[T0 + 20_500, { type: 'act.result', itemId: turn.id, outcome: { status: 'sent', delivery: 'pty' } }],
			[T0 + 21_000, poll(idle({ busy: true }), page([user('u-dock')], 300))],
		],
		open,
	)
	const done = only(state, 'turn')
	assert.equal(done.resolution?.by, 'dock')
	assert.equal(done.receipt?.delivery, 'pty')
	assert.ok(events.some(event => event.t === 'act.outcome' && event.status === 'confirmed'))
	assert.ok(!events.some(event => event.t === 'item.resolved' && event.by === 'replied'))
})

test('a reply read mid-flight is attributed once the POST answers (tail flag survives)', () => {
	const { state: open } = turnOpen()
	const turn = only(open, 'turn')
	const { state } = drive(
		[
			[T0 + 20_000, { type: 'act.sending', itemId: turn.id, action: 'prompt' }],
			[T0 + 20_100, poll(idle({ busy: true }), page([user('u-dock')], 300))],
		],
		open,
	)
	assert.equal(only(state, 'turn').state, 'sending')
	const after = drive(
		[
			[T0 + 20_500, { type: 'act.result', itemId: turn.id, outcome: { status: 'sent', delivery: 'pty' } }],
			[T0 + 21_500, poll(idle({ busy: true }))],
		],
		state,
	).state
	assert.equal(only(after, 'turn').resolution?.by, 'dock')
})

test('tools running again bump the turn rev (a stale popover act is refused by rev)', () => {
	const { state: open } = turnOpen()
	const turn = only(open, 'turn')
	const working = drive([[T0 + 30_000, poll(idle({ busy: true }))]], open).state
	assert.equal(only(working, 'turn').rev, turn.rev + 1)
	assert.ok(only(working, 'turn').fact.kind === 'turn')
	// Stays bumped once (not every busy tick).
	const still = drive([[T0 + 31_500, poll(idle({ busy: true }))]], working).state
	assert.equal(only(still, 'turn').rev, turn.rev + 1)
})

// ---------------------------------------------------------------------------
// Okena bodies (match ApiClaudeDecision / ApiClaudePromptRequest exactly)
// ---------------------------------------------------------------------------

test('answers map raw question text → label; multi-select joins ", "; Other replaces or joins', () => {
	const { state } = askOpen()
	const item = only(state)
	assert.deepEqual(dockActBody(item, ANSWER), {
		ok: true,
		body: {
			kind: 'decision',
			dialogId: DIALOG_ID,
			body: { decision: 'answer', answers: { 'Barva?': 'Blue', 'Velikost?': 'S' } },
		},
	})
	assert.deepEqual(
		dockActBody(item, { type: 'answer', picks: [{ options: [], other: '  Zelená ' }, { options: [1] }] }),
		{
			ok: true,
			body: {
				kind: 'decision',
				dialogId: DIALOG_ID,
				body: { decision: 'answer', answers: { 'Barva?': 'Zelená', 'Velikost?': 'M' } },
			},
		},
	)
	// Raw keys: Claude matches answers by its exact question text, even with characters the UI strips.
	const multi: DockItem = {
		...item,
		fact: {
			...(item.fact as Extract<DockItem['fact'], { kind: 'ask' }>),
			input: {
				questions: [
					{
						question: 'Which\u0007 ones?',
						multiSelect: true,
						options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
					},
				],
			},
		},
	}
	assert.deepEqual(dockActBody(multi, { type: 'answer', picks: [{ options: [2, 0], other: 'D' }] }), {
		ok: true,
		body: {
			kind: 'decision',
			dialogId: DIALOG_ID,
			body: { decision: 'answer', answers: { 'Which\u0007 ones?': 'C, A, D' } },
		},
	})
})

test('incomplete or impossible answers are refused without echoing them', () => {
	const item = only(askOpen().state)
	const cases: Array<[DockAction, RegExp]> = [
		[{ type: 'answer', picks: [{ options: [1] }] }, /every question/],
		[{ type: 'answer', picks: [{ options: [] }, { options: [0] }] }, /question 1/],
		[{ type: 'answer', picks: [{ options: [0, 1] }, { options: [0] }] }, /takes one answer/],
		[{ type: 'answer', picks: [{ options: [0], other: 'secret-token-123' }, { options: [0] }] }, /takes one answer/],
		[{ type: 'answer', picks: [{ options: [7] }, { options: [0] }] }, /unknown option/],
		[{ type: 'allow' }, /takes answers/],
		[{ type: 'prompt', text: 'hi' }, /not a reply/],
	]
	for (const [action, message] of cases) {
		const result = dockActBody(item, action)
		assert.equal(result.ok, false)
		if (result.ok) continue
		assert.equal(result.reason, 'invalid')
		assert.match(result.detail, message)
		assert.doesNotMatch(result.detail, /secret-token-123/)
	}
})

test('permission and plan decisions: allow once / always (only with suggestions) / deny with message', () => {
	const seeded = drive([[T0, poll(ask({ dialogs: [permissionDialog()] }))]]).state
	const permission = only(seeded)
	const decision = (action: DockAction) => {
		const result = dockActBody(permission, action)
		return result.ok && result.body.kind === 'decision' ? result.body.body : result
	}
	assert.deepEqual(decision({ type: 'allow' }), { decision: 'allow', always: false })
	assert.deepEqual(decision({ type: 'allow', always: true }), { decision: 'allow', always: true })
	assert.deepEqual(decision({ type: 'deny', message: '  use deploy:preview ', confirmed: true }), {
		decision: 'deny',
		message: 'use deploy:preview',
	})
	assert.deepEqual(decision({ type: 'deny', message: '   ' }), { decision: 'deny' })
	const bare = drive([[T0, poll(ask({ dialogs: [permissionDialog({ permission_suggestions: [] })] }))]]).state
	const noSuggestions = dockActBody(only(bare), { type: 'allow', always: true })
	assert.equal(noSuggestions.ok, false)
	const plan = drive([
		[T0, poll(ask({ dialogs: [permissionDialog({ tool_name: 'ExitPlanMode', tool_input: { plan: '1. x' } })] }))],
	]).state
	assert.deepEqual(dockActBody(only(plan), { type: 'allow' }), {
		ok: true,
		body: { kind: 'decision', dialogId: `${DIALOG_ID.split('-')[0]}-9`, body: { decision: 'allow', always: false } },
	})
	assert.equal(dockActBody(only(plan), { type: 'allow', always: true }).ok, false)
})

test('always allow is refused unless the dock could show every suggestion Okena would apply', () => {
	const withSuggestions = (suggestions: unknown[]) =>
		only(drive([[T0, poll(ask({ dialogs: [permissionDialog({ permission_suggestions: suggestions })] }))]]).state)
	const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow' }
	const reason = (result: unknown) => (result as { reason?: string; ok: boolean }).ok
	assert.equal(reason(dockActBody(withSuggestions([rule]), { type: 'allow', always: true })), true)
	// Hidden setMode: the button would read "Always allow Bash(ls)" but also switch modes.
	const mixed = withSuggestions([rule, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
	assert.equal(reason(dockActBody(mixed, { type: 'allow', always: true })), false)
	assert.equal(reason(dockActBody(mixed, { type: 'allow' })), true, 'allow once applies no suggestion')
	// More than the cap: the fact remembers it was cut, and the CAS compares the cut too.
	const many = withSuggestions(Array.from({ length: 9 }, () => rule))
	assert.equal(many.fact.kind === 'ask' && many.fact.suggestionsTruncated, true)
	assert.equal(reason(dockActBody(many, { type: 'allow', always: true })), false)
	const eight = Array.from({ length: 8 }, () => rule)
	const freshDialog = (suggestions: unknown[]) =>
		session(ask({ dialogs: [permissionDialog({ permission_suggestions: suggestions })] }))
	assert.deepEqual(askStillOpen(many, freshDialog(Array.from({ length: 9 }, () => rule))), { ok: true })
	assert.equal((askStillOpen(many, freshDialog(eight)) as { reason?: string }).reason, 'changed')
})

test('allow is refused when the dock could not show the whole tool input', () => {
	const withInput = (toolInput: unknown) =>
		only(drive([[T0, poll(ask({ dialogs: [permissionDialog({ tool_input: toolInput })] }))]]).state)
	const ok = (item: DockItem, action: DockAction) => dockActBody(item, action).ok
	assert.equal(ok(withInput({ command: 'ls', dangerouslyDisableSandbox: true }), { type: 'allow' }), true)
	for (const hidden of [
		{ command: `echo ${'a'.repeat(9_000)}; rm -rf ~` },
		{ command: 'git push\u202e' },
		{ command: 'cat x\n… (truncated)' },
	]) {
		const item = withInput(hidden)
		assert.equal(ok(item, { type: 'allow' }), false)
		assert.equal(ok(item, { type: 'allow', always: true }), false)
		assert.equal(ok(item, { type: 'deny' }), true, 'deny stays possible')
	}
})

test('free text to the agent needs the same risky-word confirmation everywhere', () => {
	const permission = only(drive([[T0, poll(ask({ dialogs: [permissionDialog()] }))]]).state)
	assert.equal(dockActBody(permission, { type: 'deny', message: 'just push to main and deploy' }).ok, false)
	assert.equal(dockActBody(permission, { type: 'deny', message: 'just push to main', confirmed: true }).ok, true)
	assert.equal(dockActBody(permission, { type: 'deny', message: 'use the preview' }).ok, true)
	const question = only(askOpen().state)
	const other = (text: string, confirmed?: boolean): DockAction => ({
		type: 'answer',
		picks: [{ options: [], other: text }, { options: [0] }],
		...(confirmed ? { confirmed } : {}),
	})
	assert.equal(dockActBody(question, other('merge it to prod')).ok, false)
	assert.equal(dockActBody(question, other('merge it to prod', true)).ok, true)
	assert.equal(dockActBody(question, other('zelená')).ok, true)
})

test('replies: trailing whitespace trimmed, blank refused, risky words need confirmed', () => {
	const turn = only(turnOpen().state, 'turn')
	assert.deepEqual(dockActBody(turn, { type: 'prompt', text: 'Ano, pokračuj.\n\n' }), {
		ok: true,
		body: { kind: 'prompt', body: { text: 'Ano, pokračuj.' } },
	})
	assert.equal(dockActBody(turn, { type: 'prompt', text: '  \n' }).ok, false)
	const risky = dockActBody(turn, { type: 'prompt', text: 'Secret je nastavený, deployni stage.' })
	assert.equal(risky.ok, false)
	assert.equal(dockActBody(turn, { type: 'prompt', text: 'git push it', confirmed: true }).ok, true)
	assert.equal(dockActBody(turn, { type: 'answer', picks: [] }).ok, false)
	// The renderer's copy of the risky pattern is the model's.
	assert.equal(RISKY_PROMPT.source, DOCK_RISKY_PROMPT.source)
	assert.equal(RISKY_PROMPT.flags, DOCK_RISKY_PROMPT.flags)
	assert.equal(riskyWord('Ship it to PROD now'), 'prod')
	assert.equal(riskyWord('Looks good'), null)
})

// ---------------------------------------------------------------------------
// CAS
// ---------------------------------------------------------------------------

const session = (body: Json) => {
	const parsed = parseOkenaClaudeSession(body)
	assert.ok(parsed.ok)
	return parsed.value
}

test('ask CAS: same dialog id + verbatim input + suggestions, else gone/changed', () => {
	const item = only(askOpen().state)
	assert.deepEqual(askStillOpen(item, session(ask())), { ok: true })
	// Key order does not matter; content does.
	const reordered = clone(DIALOG)
	reordered.tool_input = Object.fromEntries(Object.entries(reordered.tool_input as Json).reverse())
	assert.deepEqual(askStillOpen(item, session(ask({ dialogs: [reordered] }))), { ok: true })
	assert.equal((askStillOpen(item, session(ask({ dialogs: [] }))) as { reason?: string }).reason, 'gone')
	const changed = clone(DIALOG)
	;((changed.tool_input as Json).questions as Json[])[0] = { question: 'Jiná otázka?', options: [] }
	assert.equal((askStillOpen(item, session(ask({ dialogs: [changed] }))) as { reason?: string }).reason, 'changed')
	const otherSuggestions = { ...clone(DIALOG), permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] }
	assert.equal(
		(askStillOpen(item, session(ask({ dialogs: [otherSuggestions] }))) as { reason?: string }).reason,
		'changed',
	)
	assert.equal(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] }), stableJson({ a: [1, { c: 3, d: 2 }], b: 1 }))
})

test('turn CAS: idle, same session, last assistant unchanged, nobody replied', () => {
	const turn = only(turnOpen().state, 'turn')
	const tail = (entries: Json[]) => {
		const parsed = parseOkenaClaudeTranscriptPage(page(entries, 400, true))
		assert.ok(parsed.ok)
		return parsed.value
	}
	const fresh = session(idle({ busy: false }))
	assert.deepEqual(turnStillWaiting(turn, fresh, tail([user('u0'), assistant('a1')])), { ok: true })
	const reason = (check: unknown) => (check as { reason?: string }).reason
	assert.equal(reason(turnStillWaiting(turn, session(idle({ busy: true })), tail([assistant('a1')]))), 'busy')
	assert.equal(reason(turnStillWaiting(turn, session(idle({ busy: false, dialogs: [DIALOG] })), null)), 'busy')
	assert.equal(reason(turnStillWaiting(turn, fresh, tail([assistant('a1'), assistant('a2')]))), 'changed')
	assert.equal(reason(turnStillWaiting(turn, fresh, tail([assistant('a1'), user('u9')]))), 'gone')
	assert.equal(reason(turnStillWaiting(turn, session(idle({ busy: false, session_id: 'other' })), null)), 'gone')
	assert.equal(reason(turnStillWaiting(turn, fresh, null)), 'changed')
})

test('a reply Okena cannot type (409, no Claude detected in the pane) says to reply in the terminal', () => {
	// Live: native Claude Code runs as its version (`2.1.314`), so Okena's foreground probe misses it and
	// `POST …/prompt` answers 409 while the channel is off. Nothing was typed; the receipt must say what to do.
	const noSession = Object.assign(
		new Error('Okena POST /v1/claude/terminals/a6714847/prompt failed (409): No Claude session detected in this pane'),
		{ status: 409 },
	)
	const outcome = dockPostFailure(noSession, false)
	assert.equal(outcome.status, 'failed')
	const detail = (outcome as { detail: string }).detail
	assert.equal(detail, 'Okena refused the reply (409): No Claude session detected in this pane. Reply in the terminal.')
	assert.doesNotMatch(detail, /\/v1\/claude\/terminals/)
	// Busy (hooks detached) is also Okena saying "not now", not a transport fault.
	const busy = Object.assign(
		new Error(
			"Okena POST /v1/claude/terminals/t/prompt failed (409): Claude is busy and Okena's hooks are not attached; try again when it finishes",
		),
		{ status: 409 },
	)
	assert.deepEqual(dockPostFailure(busy, false), {
		status: 'failed',
		detail:
			"Okena refused the reply (409): Claude is busy and Okena's hooks are not attached; try again when it finishes",
	})
	// Dialog POSTs keep their verbatim detail.
	const dialogConflict = Object.assign(new Error('Okena POST /x failed (409): nope'), { status: 409 })
	assert.deepEqual(dockPostFailure(dialogConflict, true), {
		status: 'failed',
		detail: 'Okena POST /x failed (409): nope',
	})
})

test('POST failures: 404 on a dialog = answered elsewhere; timeout = unconfirmed; else verbatim failure', () => {
	const notFound = Object.assign(new Error('Okena POST /x failed (404): dialog is no longer open'), { status: 404 })
	assert.deepEqual(dockPostFailure(notFound, true), {
		status: 'refused',
		reason: 'gone',
		detail: 'Okena POST /x failed (404): dialog is no longer open',
	})
	assert.equal(dockPostFailure(notFound, false).status, 'failed')
	const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
	assert.equal(dockPostFailure(timeout, true).status, 'unconfirmed')
	const refused = Object.assign(new Error('connect ECONNREFUSED /tmp/okena.sock'), { code: 'ECONNREFUSED' })
	assert.deepEqual(dockPostFailure(refused, false), {
		status: 'failed',
		detail: 'connect ECONNREFUSED /tmp/okena.sock',
	})
	const fetchRefused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
	assert.equal(dockPostFailure(fetchRefused, true).status, 'failed')
	assert.equal(dockPostFailure(new Error('Okena not configured'), true).status, 'failed')
	assert.equal(dockPostFailure(Object.assign(new Error('failed (500): x'), { status: 500 }), true).status, 'failed')
	// After the request went out, anything without an Okena status may have landed: unconfirmed, never "failed".
	for (const error of [
		Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
		new Error('socket hang up'),
		new Error('Okena Unix-socket response aborted'),
		new Error('Okena POST /v1/claude/terminals/t/prompt returned invalid JSON'),
	])
		assert.equal(dockPostFailure(error, true).status, 'unconfirmed', error.message)
})

test('act requests are strictly validated (IPC input is untrusted)', () => {
	assert.ok(parseAgentDockActRequest({ itemId: 3, rev: 1, action: ANSWER }).ok)
	assert.ok(parseAgentDockActRequest({ itemId: 3, action: { type: 'prompt', text: 'ok', confirmed: true } }).ok)
	for (const bad of [
		null,
		{ itemId: 0, action: ANSWER },
		{ itemId: 3, action: { type: 'answer', picks: [] } },
		{ itemId: 3, action: { type: 'allow', always: 'yes' } },
		{ itemId: 3, action: { type: 'allow', extra: 1 } },
		{ itemId: 3, action: { type: 'shell', command: 'rm' } },
		{ itemId: 3, action: { type: 'prompt', text: 'x'.repeat(20_000) } },
		{ itemId: 3, action: ANSWER, sneaky: true },
	])
		assert.equal(parseAgentDockActRequest(bad).ok, false, JSON.stringify(bad)?.slice(0, 80))
})

test('receipt words: Sending… / ✓ answered / allowed / approved / denied', () => {
	const item = only(askOpen().state)
	const sending = reduce(askOpen().state, { type: 'act.sending', itemId: item.id, action: 'answer' }, T0 + 1).state
	assert.deepEqual(receiptView(only(sending)), { text: 'Sending…', tone: 'neutral', busy: true })
	const words = (tool: string, action: 'allow' | 'deny', always = false) =>
		receiptView({
			...item,
			fact: { ...(item.fact as Extract<DockItem['fact'], { kind: 'ask' }>), tool },
			state: 'resolved',
			resolution: { at: T0, by: 'dock' },
			receipt: { action, status: 'confirmed', at: T0, ...(always ? { always } : {}) },
		})?.text
	assert.equal(words('Bash', 'allow'), '✓ allowed')
	assert.equal(words('Bash', 'allow', true), '✓ always allowed')
	assert.equal(words('ExitPlanMode', 'allow'), '✓ approved')
	assert.equal(words('ExitPlanMode', 'deny'), '✓ sent back to planning')
	assert.equal(words('Bash', 'deny'), '✓ denied')
	assert.equal(KEY.startsWith(PROFILE), true)
})
