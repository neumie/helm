import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import presentationModule from '../app/src/renderer/agent-dock/presentation.ts'

type PresentationModule = typeof import('../app/src/renderer/agent-dock/presentation.ts')
type AgentDockSnapshot = import('../app/src/agent-dock/model.ts').AgentDockSnapshot
type DockItem = import('../app/src/agent-dock/model.ts').DockItem
type DockSession = import('../app/src/agent-dock/model.ts').DockSession

const {
	AGING_DANGER_MS,
	AGING_WARN_MS,
	agentRowMeta,
	backgroundTasksText,
	agingTone,
	alwaysAllowChoice,
	alwaysAllowLabels,
	askQuestions,
	permissionReview,
	planReview,
	entryGist,
	itemKindLabel,
	entryTone,
	dockLabel,
	emptyQueueText,
	agentsEntryText,
	busyCount,
	actErrorText,
	failedActResult,
	itemAgeTone,
	itemTimeLine,
	entryWidth,
	keepOrder,
	kindGlyph,
	moreWidth,
	queueLayout,
	QUEUE_ENTRY_CHROME,
	QUEUE_ENTRY_PAD,
	QUEUE_NAME_FLOOR,
	QUEUE_NAME_MAX,
	QUEUE_NAME_MIN,
	shortenName,
	agentNames,
	agentRepoGroups,
	agentRows,
	agentWho,
	branchShortName,
	statusGlyph,
	sessionStatusText,
	formatAge,
	itemHeadline,
	plainAgentLine,
	plainAgentText,
	resolutionLabel,
	sentSummary,
	sessionSince,
	dockHealth,
	noSessionText,
	planApproveModeText,
	sourceBlockedNote,
	canAnswer,
	canAck,
	nextWaiting,
	agentStanding,
	agentPlace,
	agentRowLabel,
	agentStateGroups,
	agentsSummary,
	agentOverview,
	agentsLayout,
	otherAgentsLayout,
	sourceHealthViews,
	formatClock,
	agentReplyBlocked,
	excerptPlainLine,
	sessionReplyView,
	REPLY_RECEIPT_MS,
	PANE_MAX_HEIGHT,
	PANE_MAX_SHARE,
	PANE_MIN_HEIGHT,
	PANE_FLOOR,
	clampPaneHeight,
	paneFitHeight,
	paneMaxHeight,
	paneResizeBounds,
	storedPaneHeight,
} = presentationModule as PresentationModule

const SHOW_ASK = JSON.parse(
	readFileSync(new URL('./fixtures/okena-claude/show-ask.json', import.meta.url), 'utf8'),
) as { dialogs: Array<{ id: string; tool_input: unknown; created_at_ms: number }> }

const T = 1_793_364_800_000
const KEY = 'p1:t1'

function session(overrides: Partial<DockSession> = {}): DockSession {
	return {
		key: KEY,
		profile: 'p1',
		terminalId: 't1',
		project: 'helm',
		name: 'dock',
		status: 'idle',
		since: T,
		observedAt: T,
		subagents: 0,
		backgroundTasks: 0,
		backgroundShells: 0,
		queuedPrompts: 0,
		prLinks: [],
		hasTranscript: true,
		hooksAttached: true,
		channelAttached: false,
		...overrides,
	}
}

const askItem = (overrides: Partial<DockItem> = {}): DockItem => ({
	id: 7,
	key: `ask:${KEY}:d`,
	kind: 'ask',
	session: KEY,
	openedAt: T,
	state: 'open',
	fact: {
		kind: 'ask',
		dialogId: 'd',
		tool: 'AskUserQuestion',
		input: SHOW_ASK.dialogs[0]?.tool_input,
		createdAtMs: T - 60_000,
	},
	...overrides,
})

const turnItem = (overrides: Partial<DockItem> = {}): DockItem => ({
	id: 8,
	key: 'turn:s:u',
	kind: 'turn',
	session: KEY,
	openedAt: T,
	state: 'open',
	fact: { kind: 'turn', assistantUuid: 'u', text: 'PR ready?', endedAt: T - 5_000, hadBackground: false },
	...overrides,
})

function snapshot(
	source: AgentDockSnapshot['source'],
	items: DockItem[] = [],
	sessions: DockSession[] = [session()],
): AgentDockSnapshot {
	return { generatedAt: T, source, sessions, items }
}

test('agent text is control- and bidi-stripped, bounded, and never markup', () => {
	assert.equal(plainAgentText('a\u0007b\u001b[31mc\u202Ed\nkeep\ttabs'), 'ab[31mcd\nkeep\ttabs')
	assert.equal(plainAgentText({ html: '<b>' }), '')
	assert.equal(plainAgentText('x'.repeat(10), 5), 'xxxx…')
	assert.equal(plainAgentText(`${'x'.repeat(3)}😀tail`, 5), 'xxx…')
	assert.equal(plainAgentLine('  two\n\nlines  '), 'two lines')
})

test('ages and aging tones follow the 30 m / 2 h escalation', () => {
	assert.equal(formatAge(10_000), '<1m')
	assert.equal(formatAge(12 * 60_000), '12m')
	assert.equal(formatAge((2 * 60 + 14) * 60_000), '2h14m')
	assert.equal(formatAge(2 * 60 * 60_000), '2h')
	assert.equal(formatAge(50 * 60 * 60_000), '2d')
	assert.equal(agingTone(AGING_WARN_MS), 'none')
	assert.equal(agingTone(AGING_WARN_MS + 1), 'warn')
	assert.equal(agingTone(AGING_DANGER_MS + 1), 'danger')
})

test('recorded AskUserQuestion input renders every question and preview verbatim', () => {
	const questions = askQuestions(SHOW_ASK.dialogs[0]?.tool_input)
	assert.deepEqual(
		questions?.map(question => question.question),
		['Barva?', 'Velikost?'],
	)
	assert.equal(questions?.[0]?.header, 'Color')
	assert.equal(questions?.[0]?.options[1]?.preview, '▇▇ blue')
	assert.equal(askQuestions({ questions: [{ nope: true }] }), null)
	assert.equal(askQuestions('string'), null)
	assert.equal(itemHeadline(askItem()), 'Barva? · 1 more question')
	assert.equal(
		itemHeadline(askItem({ fact: { kind: 'ask', dialogId: 'd', tool: 'Bash', input: {}, createdAtMs: T } })),
		'Allow Bash?',
	)
})

test('the row label never reads as all clear unless Okena is reachable', () => {
	assert.equal(
		dockLabel(snapshot({ state: 'ok', since: T, lastObservedAt: T }), T),
		'Agent dock, Nothing needs you, Okena',
	)
	assert.match(
		dockLabel(snapshot({ state: 'down', since: T, lastObservedAt: T - 1_000 }), T),
		/^Agent dock, State unknown, Okena unreachable since \d\d:\d\d$/,
	)
	assert.equal(dockLabel(null, T), 'Agent dock, Waiting for Okena, Okena connecting…')
	assert.equal(dockHealth(null).text, 'Okena connecting…')
})

test('the row label never reads as all clear while a listed agent is unreadable', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	assert.equal(
		dockLabel(snapshot(ok, [], [session({ status: 'unknown' }), session({ key: 'p:t2' })]), T),
		'Agent dock, State unknown for 1 agent, Okena',
	)
	assert.match(
		dockLabel(snapshot(ok, [turnItem()], [session({ status: 'unknown' })]), T),
		/^Agent dock, 1 needs you · 1 unknown, oldest [^,]+, Okena$/,
	)
})

test('the row label counts needs and ages the oldest; it names no item', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	const oldTurn = turnItem({ openedAt: T - 3 * 60 * 60_000 })
	if (oldTurn.fact.kind === 'turn') oldTurn.fact.endedAt = T - 3 * 60 * 60_000
	assert.equal(dockLabel(snapshot(ok, [oldTurn]), T), 'Agent dock, 1 needs you, oldest 3h, Okena')
	const items = [askItem({ openedAt: T - 3 * 60 * 60_000 }), turnItem({ openedAt: T - 1_000 })]
	assert.equal(
		dockLabel(snapshot(ok, items, [session({ status: 'waiting' })]), T),
		'Agent dock, 2 need you, oldest 3h, Okena',
	)
})

test('the empty queue never reads as all clear while a source is down or an agent is unreadable', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	assert.equal(emptyQueueText(snapshot(ok)), 'Nothing needs you')
	assert.equal(emptyQueueText(snapshot({ state: 'pending', since: T, lastObservedAt: null })), 'Waiting for Okena')
	assert.equal(
		emptyQueueText(snapshot({ state: 'down', since: T, lastObservedAt: T })),
		'Okena is unreachable, so open questions cannot be seen',
	)
	assert.equal(
		emptyQueueText({
			...snapshot({ state: 'down', since: T, lastObservedAt: T }),
			sources: {
				okena: { state: 'down', since: T, lastObservedAt: T },
				helm: { state: 'down', since: T, lastObservedAt: T },
			},
		}),
		'Okena and Helm terminals are unreachable, so open questions cannot be seen',
	)
	assert.equal(
		emptyQueueText(snapshot(ok, [], [session({ status: 'unknown' }), session({ key: 'p:t2' })])),
		'State unknown for 1 agent: Okena did not return readable detail, so their open questions cannot be seen',
	)
})

test('the Agents entry counts agents, one bar mark each, names the states in words and each agent in its tooltip', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	const sessions = [
		session({ status: 'working', since: T - 120_000 }),
		session({ key: 'p1:t2', terminalId: 't2', name: 'other', status: 'background', since: T - 60_000 }),
		session({ key: 'p1:t3', terminalId: 't3', name: 'idle one', status: 'idle', since: T - 60_000 }),
		session({ key: 'p1:t4', terminalId: 't4', name: 'lost', status: 'unknown' }),
	]
	const snap = snapshot(ok, [], sessions)
	assert.equal(busyCount(sessions), 2)
	assert.deepEqual(agentsEntryText(snap, sessions, T), {
		total: 4,
		marks: ['working', 'background', 'idle', 'unknown'],
		label: '4 agents: 1 working, 1 in background, 1 idle, 1 unknown. Show agents',
		title: 'dock: working 2m\nother: background 1m\nidle one: idle 1m\nlost: unknown',
	})
	// States in the pane's order, whatever the agents' order.
	const mixed = [
		session({ status: 'idle' }),
		session({ key: 'p1:t2', status: 'waiting' }),
		session({ key: 'p1:t3', status: 'unreachable' }),
	]
	assert.equal(
		agentsEntryText(snapshot(ok, [], mixed), mixed, T).label,
		'3 agents: 1 waiting on you, 1 idle, 1 frozen. Show agents',
	)
	const lone = [session({ status: 'idle' })]
	assert.deepEqual(agentsEntryText(snapshot(ok, [], lone), lone, T), {
		total: 1,
		marks: ['idle'],
		label: '1 agent: 1 idle. Show agents',
		title: 'dock: idle <1m',
	})
	assert.deepEqual(agentsEntryText(snapshot(ok, [], []), [], T), {
		total: 0,
		marks: [],
		label: "No Claude session is connected to Okena's Claude Remote. Show agents",
		title: "No Claude session is connected to Okena's Claude Remote",
	})
})

test('act errors kept on the pane: refusals and failures in words, bounded; nothing for the rest', () => {
	assert.equal(actErrorText({ status: 'refused', reason: 'gone', detail: 'x' }), 'refused: already answered elsewhere')
	assert.equal(actErrorText({ status: 'refused', reason: 'busy', detail: 'agent\u0007 busy' }), 'refused: agent busy')
	assert.equal(actErrorText({ status: 'failed', detail: 'x'.repeat(400) }), `${'x'.repeat(299)}…`)
	assert.equal(actErrorText({ status: 'sent' }), null)
	assert.equal(actErrorText({ status: 'unconfirmed', detail: 'timeout' }), null)
	assert.deepEqual(failedActResult(new Error('IPC closed')), {
		ok: false,
		outcome: { status: 'failed', detail: 'IPC closed' },
	})
	assert.deepEqual(failedActResult('nope'), { ok: false, outcome: { status: 'failed', detail: 'nope' } })
})

test('agent rows: a waiting agent ages from its oldest open ask (as its entry does); row meta, stale', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	const ask = askItem({ fact: { kind: 'ask', dialogId: 'd', tool: 'Bash', input: {}, createdAtMs: T - 60_000 } })
	const waiting = session({ status: 'waiting', since: T + 30_000 })
	assert.equal(sessionSince(snapshot(ok, [ask], [waiting]), waiting), T - 60_000)
	assert.equal(
		sessionStatusText(waiting, T + 60 * 60_000, sessionSince(snapshot(ok, [ask], [waiting]), waiting)),
		'waiting 1h1m',
	)
	assert.equal(sessionSince(snapshot(ok, [], [waiting]), waiting), T + 30_000)
	assert.equal(sessionSince(snapshot(ok, [ask], [session()]), session()), T)
	const snap = snapshot({ state: 'ok', since: T, lastObservedAt: T })
	assert.deepEqual(agentRowMeta(snap, session({ observedAt: T - 20_000 })), ['stale 20s'])
	assert.deepEqual(agentRowMeta(snap, session({ status: 'unreachable' })), [])
})

test('resolution labels say how the item closed', () => {
	assert.equal(
		resolutionLabel(askItem({ state: 'resolved', resolution: { at: T, by: 'outside' } })),
		'answered in terminal',
	)
	assert.equal(
		resolutionLabel(turnItem({ state: 'resolved', resolution: { at: T, by: 'replied' } })),
		'replied in terminal',
	)
	assert.equal(resolutionLabel(turnItem({ state: 'resolved', resolution: { at: T, by: 'acked' } })), 'acked')
})

test('card tone and age: the glyph keeps its kind tone, only the age turns red (asks past 2h), turns cap at amber', () => {
	const now = T + 3 * 60 * 60_000
	const oldAsk = askItem({ fact: { kind: 'ask', dialogId: 'd', tool: 'Bash', input: {}, createdAtMs: T } })
	assert.equal(entryTone(oldAsk), 'ask')
	assert.equal(entryTone(askItem({ state: 'orphaned' })), 'orphaned')
	const oldTurn = turnItem()
	assert.equal(entryTone(oldTurn), 'turn')
	assert.equal(itemAgeTone(oldTurn, now), 'warn')
	assert.equal(itemAgeTone(oldAsk, now), 'danger')
	assert.equal(itemKindLabel(askItem({ state: 'orphaned' })), 'Orphaned question')
	assert.equal(itemKindLabel(oldAsk), 'Permission')
	// Once answered (or on its way) the wait stops ageing: no red "waiting" next to a ✓.
	const answered = { ...oldAsk, state: 'resolved', resolution: { at: now, by: 'dock' } } as DockItem
	assert.equal(itemAgeTone(answered, now), 'none')
	assert.equal(itemAgeTone({ ...oldAsk, state: 'sending' } as DockItem, now), 'none')
	assert.match(itemTimeLine(answered, now).waited, /^answered \d\d:\d\d$/)
	assert.equal(itemTimeLine({ ...oldAsk, state: 'sending' } as DockItem, now).waited, 'sending')
	const elsewhere = { ...oldAsk, state: 'resolved', resolution: { at: now, by: 'outside' } } as DockItem
	assert.match(itemTimeLine(elsewhere, now).waited, /^closed \d\d:\d\d$/)
	assert.equal(entryTone(answered), 'done')
	assert.equal(entryTone(elsewhere), 'closed')
})

test("card gist: the turn's last paragraph, the plan title, the command", () => {
	const turn = turnItem({
		fact: {
			kind: 'turn',
			assistantUuid: 'u',
			text: 'Done. Tests green.\n\nCan you confirm the stage secret?',
			endedAt: T,
			hadBackground: false,
		},
	})
	assert.equal(entryGist(turn), 'Can you confirm the stage secret?')
	const plan = askItem({
		fact: {
			kind: 'ask',
			dialogId: 'd',
			tool: 'ExitPlanMode',
			input: { plan: '# Export ISDOC\n\n1. Map' },
			createdAtMs: T,
		},
	})
	assert.equal(entryGist(plan), 'Export ISDOC')
	const bash = askItem({
		fact: { kind: 'ask', dialogId: 'd', tool: 'Bash', input: { command: 'git push\u202e' }, createdAtMs: T },
	})
	assert.equal(entryGist(bash), 'Bash: git push')
	assert.deepEqual(itemTimeLine(turn, T + 6 * 60_000).waited, 'idle 6m')
	assert.match(itemTimeLine(bash, T).stamp, /^asked \d\d:\d\d$/)
})

test('"Always allow" wording comes only from Claude\'s permission_suggestions, and only when every entry shows', () => {
	assert.deepEqual(alwaysAllowLabels(undefined), [])
	assert.deepEqual(alwaysAllowLabels([]), [])
	assert.deepEqual(
		alwaysAllowLabels([
			{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run deploy:stage' }], behavior: 'allow' },
			{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow' },
			{ type: 'addDirectories', directories: ['/tmp/out'] },
		]),
		['Bash(npm run deploy:stage)', 'WebFetch', '/tmp/out'],
	)
	// Okena applies EVERY suggestion: one the dock cannot word hides "Always allow" altogether.
	const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow' }
	for (const hidden of [
		{ type: 'setMode', mode: 'acceptEdits' },
		{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf' }], behavior: 'deny' },
		{ type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny' },
		{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push\u202e' }], behavior: 'allow' },
		{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(241) }], behavior: 'allow' },
		'garbage',
	])
		assert.equal(alwaysAllowLabels([rule, hidden]), null, JSON.stringify(hidden))
	assert.equal(alwaysAllowLabels(Array.from({ length: 9 }, () => rule)), null, 'more than the cap')
	assert.equal(alwaysAllowLabels([rule], true), null, 'Okena sent more than were kept')
})

test('"Always allow" for a Helm terminal takes rule suggestions only (its hub cannot apply addDirectories)', () => {
	const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow' }
	const dirs = { type: 'addDirectories', directories: ['/tmp/out'], destination: 'session' }
	assert.deepEqual(alwaysAllowLabels([rule], false, { rulesOnly: true }), ['Bash(ls)'])
	assert.equal(alwaysAllowLabels([dirs], false, { rulesOnly: true }), null)
	assert.equal(alwaysAllowLabels([rule, dirs], false, { rulesOnly: true }), null)
	const permission = (suggestions: unknown[]) =>
		askItem({
			fact: { kind: 'ask', dialogId: 'd', tool: 'Bash', input: { command: 'ls' }, suggestions, createdAtMs: T },
		})
	assert.equal(alwaysAllowChoice(permission([dirs]), 'helm'), null)
	assert.equal(alwaysAllowChoice(permission([rule, dirs]), 'helm'), null)
	assert.deepEqual(alwaysAllowChoice(permission([rule]), 'helm'), ['Bash(ls)'])
	// Okena applies addDirectories: unchanged there (and for a session without a source).
	assert.deepEqual(alwaysAllowChoice(permission([dirs]), 'okena'), ['/tmp/out'])
	assert.deepEqual(alwaysAllowChoice(permission([rule, dirs]), undefined), ['Bash(ls)', '/tmp/out'])
	assert.equal(alwaysAllowChoice(turnItem(), 'okena'), null)
})

test('permission review: every tool_input field shows; anything cut or stripped needs the terminal', () => {
	const plain = permissionReview({ command: 'ls -la', description: 'List' })
	assert.deepEqual(plain, { command: 'ls -la', description: 'List', fields: null, flags: [], complete: true })
	const sandbox = permissionReview({ command: 'curl x', dangerouslyDisableSandbox: true, timeout: 5 })
	assert.deepEqual(sandbox.flags, ['dangerouslyDisableSandbox'])
	assert.match(sandbox.fields ?? '', /"dangerouslyDisableSandbox": true/)
	assert.equal(sandbox.complete, true)
	assert.equal(permissionReview({ command: `echo ${'a'.repeat(9_000)}; rm -rf ~` }).complete, false)
	assert.equal(permissionReview({ command: 'git push\u202e' }).complete, false)
	assert.equal(permissionReview({ command: 'x\u001b[2K' }).complete, false)
	assert.equal(permissionReview({ content: 'head\n… (truncated)' }).complete, false)
	assert.equal(permissionReview({ file_path: '/a', content: 'b'.repeat(20_000) }).complete, false)
	const edit = permissionReview({ file_path: '/a', old_string: 'x', new_string: 'y' })
	assert.equal(edit.command, null)
	assert.match(edit.fields ?? '', /"new_string": "y"/)
	assert.equal(edit.complete, true)
})

test('AskUserQuestion options keep their raw index past malformed entries', () => {
	const questions = askQuestions({
		questions: [{ question: 'Q', options: ['bare', { label: 'A' }, { label: '' }, { label: 'B' }] }],
	})
	assert.deepEqual(
		questions?.[0]?.options.map(option => [option.index, option.label]),
		[
			[1, 'A'],
			[3, 'B'],
		],
	)
})

test('agent lines show only observed facts', () => {
	const busy = session({ status: 'background', since: T - 5 * 60_000, subagents: 3, queuedPrompts: 1 })
	assert.equal(sessionStatusText(busy, T), 'background 5m')
	assert.equal(sessionStatusText(session({ status: 'unreachable' }), T), 'frozen')
	assert.equal(sessionStatusText(session({ status: 'unknown' }), T), 'unknown')
	const snap = snapshot({ state: 'ok', since: T, lastObservedAt: T })
	assert.deepEqual(agentRowMeta(snap, busy), ['3 subagents', 'queued 1'])
	assert.deepEqual(agentRowMeta(snap, session({ hooksAttached: false })), ['not connected'])
})

test('background tasks read like subagents: "1 shell", "2 shells", else "N background tasks"', () => {
	const snap = snapshot({ state: 'ok', since: T, lastObservedAt: T })
	const shell = session({ status: 'background', since: T - 2 * 60_000, backgroundTasks: 1, backgroundShells: 1 })
	assert.equal(sessionStatusText(shell, T), 'background 2m')
	assert.deepEqual(agentRowMeta(snap, shell), ['1 shell'])
	assert.deepEqual(agentRowMeta(snap, session({ backgroundTasks: 2, backgroundShells: 2 })), ['2 shells'])
	assert.deepEqual(agentRowMeta(snap, session({ backgroundTasks: 2, backgroundShells: 1 })), ['2 background tasks'])
	// Helm's hub counts without kinds: never called shells.
	assert.deepEqual(agentRowMeta(snap, session({ backgroundTasks: 1, backgroundShells: 0 })), ['1 background task'])
	assert.deepEqual(
		agentRowMeta(snap, session({ subagents: 2, backgroundTasks: 1, backgroundShells: 1, queuedPrompts: 1 })),
		['2 subagents', '1 shell', 'queued 1'],
	)
	assert.equal(backgroundTasksText(session()), '')
	// A background shell makes the agent count as busy, like subagents.
	assert.equal(busyCount([shell, session()]), 1)
})

test("queue names shorten in the middle, keeping a twin's #N", () => {
	assert.equal(shortenName('crm', 28), 'crm')
	assert.equal(shortenName('company-create-save-firm #2', 28), 'company-create-save-firm #2')
	const twin = shortenName('company-create-save-firm #2', 20)
	assert.equal([...twin].length, 20)
	assert.equal(twin, 'company-cre…-firm #2')
	assert.equal(shortenName('company-create-save-firm #2', 24), 'company-create-…-firm #2')
	const long = shortenName('repeated-android-camera-permission', 16)
	assert.equal([...long].length, 16)
	assert.ok(long.startsWith('repeated-') && long.endsWith('ion') && long.includes('…'))
	// No room for a middle cut: the start and an ellipsis.
	assert.equal(shortenName('abcdefgh #12', 6), 'abcde…')
})

test('the queue is one row from real text widths: names shorten before anything hides, the open entry always shows', () => {
	// A proportional stand-in for the UI face: digits and wide letters differ from narrow ones.
	const measure = (text: string) =>
		[...text].reduce((sum, c) => sum + (/[0-9]/.test(c) ? 7 : /[mw#]/.test(c) ? 9 : /[il.\-…]/.test(c) ? 3 : 6), 0)
	const fullSpan = (slots: ReadonlyArray<{ width: number }>) => slots.reduce((sum, slot) => sum + slot.width, 0)
	// An entry is exactly its padding, glyph box and two gaps, then the name and its wait as they set:
	// nothing is budgeted after the wait, so the selected fill ends right after it.
	const firm = { name: 'company-create-save-firm', tail: '52m' }
	assert.equal(
		entryWidth(firm, QUEUE_NAME_MAX, measure),
		Math.ceil(QUEUE_ENTRY_CHROME + measure(firm.name) + measure('52m')),
	)
	assert.equal(entryWidth({ name: 'crm', tail: '1m' }, QUEUE_NAME_MAX, measure), QUEUE_ENTRY_CHROME + 21 + 16)
	// Fractions round up, never down (the text always fits its slot).
	assert.equal(
		entryWidth({ name: 'a', tail: 'b' }, QUEUE_NAME_MAX, () => 10.2),
		QUEUE_ENTRY_CHROME + 21,
	)
	// A cap shortens the name in the middle before it is measured.
	const turn = { name: 'repeated-android-camera-permission', tail: '1m' }
	assert.equal(
		entryWidth(turn, QUEUE_NAME_MIN, measure),
		Math.ceil(QUEUE_ENTRY_CHROME + measure(shortenName(turn.name, QUEUE_NAME_MIN)) + measure('1m')),
	)
	assert.equal(moreWidth(8, measure), Math.ceil(measure('+8 more')) + QUEUE_ENTRY_PAD)

	const real = [firm, { name: 'company-create-save-firm #2', tail: '12m' }, turn]
	// Everything fits: names up to QUEUE_NAME_MAX, each slot exactly its entry, no "+N more".
	const wide = queueLayout(real, measure, 2000)
	assert.deepEqual(
		wide.slots.map(slot => slot.index),
		[0, 1, 2],
	)
	assert.deepEqual(wide.hidden, [])
	assert.deepEqual(
		wide.slots.map(slot => slot.name),
		['company-create-save-firm', 'company-create-save-firm #2', shortenName(turn.name, QUEUE_NAME_MAX)],
	)
	assert.deepEqual(
		wide.slots.map(slot => slot.width),
		real.map(entry => entryWidth(entry, QUEUE_NAME_MAX, measure)),
	)
	// Tighter: the names shorten alike (never below QUEUE_NAME_MIN) before any entry hides.
	const minSpan = real.reduce((sum, entry) => sum + entryWidth(entry, QUEUE_NAME_MIN, measure), 0)
	const tight = queueLayout(real, measure, minSpan)
	assert.deepEqual(tight.hidden, [])
	assert.ok(tight.slots.every(slot => [...slot.name].length >= QUEUE_NAME_MIN))
	assert.ok(fullSpan(tight.slots) <= minSpan)
	for (const slot of tight.slots)
		assert.equal(slot.width, Math.ceil(QUEUE_ENTRY_CHROME + measure(slot.name) + measure(real[slot.index]?.tail ?? '')))
	// Still too wide: the widest names give up cells one at a time (waits whole), rather than "+1 more".
	const floors = real.map(entry => entryWidth(entry, QUEUE_NAME_FLOOR, measure))
	const floorSpan = floors.reduce((sum, width) => sum + width, 0)
	const squeezed = queueLayout(real, measure, floorSpan + 30)
	assert.deepEqual(squeezed.hidden, [])
	assert.equal(squeezed.slots.length, 3)
	assert.ok(fullSpan(squeezed.slots) <= floorSpan + 30)
	assert.ok(squeezed.slots.every(slot => [...slot.name].length >= QUEUE_NAME_FLOOR))
	// Evenly: no squeezed entry is more than one cell's worth wider than another's name allows.
	const widths = squeezed.slots.map(slot => slot.width)
	assert.ok(Math.max(...widths) - Math.min(...widths) < 40)
	// A short name is never cut to make room.
	const short = queueLayout([{ name: 'api', tail: '3m' }, ...real], measure, floorSpan + 60)
	assert.equal(short.slots[0]?.name, 'api')
	// Below every floor: "+N more".
	assert.ok(queueLayout(real, measure, floorSpan - 10).hidden.length > 0)
	// Eight items in about 600px: some show, the rest sit behind one "+N more" cell sized for the count.
	const eight = Array.from({ length: 8 }, (_, at) => ({ name: `feature-branch-number-${at}`, tail: `${at + 1}m` }))
	const row = queueLayout(eight, measure, 600)
	assert.ok(row.slots.length > 0 && row.slots.length < 8)
	assert.equal(row.slots.length + row.hidden.length, 8)
	assert.equal(row.more, moreWidth(8, measure))
	assert.ok(fullSpan(row.slots) + row.more <= 600)
	// Queue order is kept.
	assert.deepEqual(
		row.slots.map(slot => slot.index),
		row.slots.map((_, at) => at),
	)
	// An open entry that would hide takes the last slot instead; the one it replaced goes behind "+N more".
	const open = queueLayout(eight, measure, 600, 6)
	assert.equal(open.slots.at(-1)?.index, 6)
	assert.ok(!open.hidden.includes(6))
	assert.equal(open.slots.length + open.hidden.length, 8)
	assert.ok(open.hidden.includes(row.slots.length - 1))
	assert.ok(fullSpan(open.slots) + open.more <= 600)
	// Unmeasured (not mounted yet): everything, unsized, whole names.
	const unmeasured = queueLayout(eight, null, 600)
	assert.equal(unmeasured.slots.length, 8)
	assert.ok(unmeasured.slots.every((slot, at) => slot.width === 0 && slot.name === eight[at]?.name))
	assert.deepEqual(queueLayout([], measure, 600), { slots: [], hidden: [], more: 0 })
})

test('short agent names: the branch without its type prefix, numbered when two agents share it', () => {
	assert.equal(branchShortName('fix/repeated-android-camera-permission'), 'repeated-android-camera-permission')
	for (const prefix of [
		'feat',
		'chore',
		'refactor',
		'docs',
		'test',
		'perf',
		'build',
		'ci',
		'style',
		'wip',
		'hotfix',
		'release',
	])
		assert.equal(branchShortName(`${prefix}/x-y`), 'x-y')
	// Only the one leading type prefix goes; other slashes stay.
	assert.equal(branchShortName('fix/api/retry'), 'api/retry')
	assert.equal(branchShortName('jakub/fix-x'), 'jakub/fix-x')
	// Nothing identifying left: the caller falls back.
	assert.equal(branchShortName('fix/'), '')
	assert.equal(branchShortName('main'), '')
	assert.equal(branchShortName(undefined), '')
	// Untrusted: control/bidi-stripped like any agent text.
	assert.equal(branchShortName('fix/a\u202eb'), 'ab')

	const title = 'Při zakládání nové společnosti se neuloží firma (ClientCare #4182)'
	const one = session({ key: 'p:t1', name: title, branch: 'fix/company-create-save-firm' })
	const two = session({ key: 'p:t2', name: title, branch: 'fix/company-create-save-firm' })
	const camera = session({ key: 'p:t3', name: 'Android kamera', branch: 'fix/repeated-android-camera-permission' })
	const plain = session({ key: 'p:t4', name: 'ios-sync' })
	const onMain = session({ key: 'p:t5', name: 'release-notes', branch: 'main' })
	// Stable order (by session key), whatever order the snapshot lists them in.
	const names = agentNames([two, plain, camera, onMain, one])
	assert.equal(names.get('p:t1'), 'company-create-save-firm')
	assert.equal(names.get('p:t2'), 'company-create-save-firm #2')
	assert.equal(names.get('p:t3'), 'repeated-android-camera-permission')
	assert.equal(names.get('p:t4'), 'ios-sync')
	assert.equal(names.get('p:t5'), 'release-notes')
	const three = session({ key: 'p:t0', name: 'x', branch: 'feat/company-create-save-firm' })
	assert.equal(agentNames([one, two, three]).get('p:t2'), 'company-create-save-firm #3')

	// Who: the short name everywhere, the full pane name as the title (only when it says more).
	const snap = snapshot({ state: 'ok', since: T, lastObservedAt: T }, [], [one, two, plain])
	assert.deepEqual(agentWho(snap, 'p:t2'), { name: 'company-create-save-firm #2', title, project: 'helm' })
	assert.deepEqual(agentWho(snap, 'p:t4'), { name: 'ios-sync', title: '', project: 'helm' })
	assert.deepEqual(agentWho(snap, 'p:abcdef0123'), { name: 'terminal abcdef0…', title: '', project: '' })
})

test("a detached HEAD's commit hash is no name: the agent keeps its pane or repository name", () => {
	// 7–40 hex characters say nothing about the work, like a default branch.
	for (const hash of ['d1aee9df', 'D1AEE9D', 'a'.repeat(40), '3610328']) assert.equal(branchShortName(hash), '', hash)
	for (const branch of ['d1aee9', 'a'.repeat(41), 'd1aee9dg', 'fix/d1aee9df'])
		assert.notEqual(branchShortName(branch), '', branch)

	// Psyon's main checkout on a detached HEAD: Okena names the unnamed pane after the hash, so the
	// agent reads as its project, everywhere agentWho is used (queue, header, Agents pane, labels).
	const psyon = session({ key: 'p:t1', project: 'Psyon', name: 'd1aee9df', branch: 'd1aee9df', status: 'working' })
	// A named pane on a detached HEAD keeps its pane name.
	const named = session({ key: 'p:t2', project: 'Psyon', name: 'release-check', branch: '3610328' })
	// A JVS worktree: Okena's project is named after the branch; the repository is its parent project.
	const repair = session({
		key: 'p:t3',
		project: 'fix/repair-done-still-out-of-service',
		repo: 'JVS',
		name: '[Echo] Kubo, tady bude chybka.',
		branch: 'fix/repair-done-still-out-of-service',
	})
	const snap = snapshot({ state: 'ok', since: T, lastObservedAt: T }, [], [psyon, named, repair])
	assert.deepEqual(agentWho(snap, 'p:t1'), { name: 'Psyon', title: '', project: 'Psyon' })
	assert.deepEqual(agentWho(snap, 'p:t2'), { name: 'release-check', title: '', project: 'Psyon' })
	assert.deepEqual(agentWho(snap, 'p:t3'), {
		name: 'repair-done-still-out-of-service',
		title: '[Echo] Kubo, tady bude chybka.',
		project: 'JVS',
	})
	// The same name reaches the Agents entry's tooltip.
	assert.match(agentsEntryText(snap, [psyon], T + 4 * 60_000).title, /^Psyon: working 4m$/)

	// Agents pane rows carry the repository they group under; meta stays a list.
	const rows = agentRows(snap, T)
	assert.deepEqual(
		rows.map(row => [row.name, row.repo, row.word]),
		[
			['Psyon', 'Psyon', 'working'],
			['release-check', 'Psyon', 'idle'],
			['repair-done-still-out-of-service', 'JVS', 'idle'],
		],
	)
	const groupKeys = (list: typeof rows) =>
		agentRepoGroups(list).map(group => ({ repo: group.repo, keys: group.rows.map(row => row.key) }))
	assert.deepEqual(groupKeys(rows), [
		{ repo: 'Psyon', keys: ['p:t1', 'p:t2'] },
		{ repo: 'JVS', keys: ['p:t3'] },
	])
	// Groups follow their first agent; agents with no known repository come last, whatever their order.
	const unplaced = { ...rows[0], key: 'p:t0', repo: '' }
	assert.deepEqual(groupKeys([unplaced, rows[2], ...rows.slice(0, 2)]), [
		{ repo: 'JVS', keys: ['p:t3'] },
		{ repo: 'Psyon', keys: ['p:t1', 'p:t2'] },
		{ repo: '', keys: ['p:t0'] },
	])
})

test('an open pane keeps entries in their slots: answered items stay put, new ones join the end', () => {
	const item = (id: number, state: DockItem['state'] = 'open') => ({ id, state }) as DockItem
	const ids = (items: DockItem[]) => items.map(entry => entry.id)
	// The snapshot moves the answered #3 behind the open ones; the frozen order keeps it first.
	assert.deepEqual(ids(keepOrder([3, 5, 7], [item(5), item(7), item(3, 'resolved')])), [3, 5, 7])
	// New items append, gone ones leave.
	assert.deepEqual(ids(keepOrder([3, 5, 7], [item(5), item(9), item(3, 'resolved')])), [3, 5, 9])
	// An entry that left the queue meanwhile (its receipt stopped lingering, answered in the terminal)
	// keeps its slot from the snapshot until the pane closes; acked ones and ones the snapshot dropped leave.
	const done = (id: number, by: 'dock' | 'outside' | 'acked') =>
		({ id, state: 'resolved', resolution: { at: T, by } }) as DockItem
	assert.deepEqual(ids(keepOrder([3, 5, 7], [item(5), item(7)], [done(3, 'dock')])), [3, 5, 7])
	assert.deepEqual(ids(keepOrder([3, 5, 7], [item(3), item(7)], [done(5, 'outside')])), [3, 5, 7])
	assert.deepEqual(ids(keepOrder([3, 5, 7], [item(5), item(7)], [done(3, 'acked')])), [5, 7])
	assert.deepEqual(ids(keepOrder([3, 5, 7], [item(5)], [])), [5])
	// No pane: the snapshot's own order.
	assert.deepEqual(ids(keepOrder(null, [item(5), item(3)])), [5, 3])
})

test('Ack is offered for turns, orphaned and unconfirmed items; never for an open, sending or resolved one', () => {
	const item = (kind: DockItem['kind'], state: DockItem['state']) => ({ id: 1, kind, state }) as DockItem
	assert.equal(canAck(item('turn', 'open')), true)
	assert.equal(canAck(item('turn', 'unconfirmed')), true)
	assert.equal(canAck(item('ask', 'orphaned')), true)
	assert.equal(canAck(item('ask', 'unconfirmed')), true)
	assert.equal(canAck(item('ask', 'open')), false)
	assert.equal(canAck(item('ask', 'sending')), false)
	assert.equal(canAck(item('turn', 'sending')), false)
	assert.equal(canAck(item('turn', 'resolved')), false)
})

test('after an ack or answer the pane moves on to the next item still waiting, in queue order, wrapping', () => {
	const item = (id: number, state: DockItem['state'] = 'open') => ({ id, state }) as DockItem
	const queue = [item(3), item(5, 'resolved'), item(7), item(9, 'unconfirmed'), item(11)]
	// Answered #7 (still shown with its receipt): the next open one after it.
	assert.equal(nextWaiting(queue, 7, 2)?.id, 11)
	// Answered the last one: round to the front, skipping lingering and unconfirmed entries.
	assert.equal(nextWaiting(queue, 11, 4)?.id, 3)
	// Acked #7 left the queue: `at` is where it sat, so the entry now there comes first.
	const acked = queue.filter(entry => entry.id !== 7)
	assert.equal(nextWaiting(acked, 7, 2)?.id, 11)
	// The handled item itself never counts, even while its state still reads open.
	assert.equal(nextWaiting([item(3), item(5, 'resolved')], 3, 0), undefined)
	assert.equal(nextWaiting([], 3, 0), undefined)
})

test('kind and status glyphs are single terminal cells', () => {
	const ask = (tool: string) => ({ kind: 'ask', state: 'open', fact: { kind: 'ask', tool } }) as unknown as DockItem
	assert.equal(kindGlyph(ask('AskUserQuestion')), '?')
	assert.equal(kindGlyph(ask('ExitPlanMode')), '≡')
	assert.equal(kindGlyph(ask('Bash')), '$')
	assert.equal(kindGlyph({ kind: 'turn', state: 'open', fact: { kind: 'turn' } } as unknown as DockItem), '↵')
	assert.equal(kindGlyph({ ...ask('Bash'), state: 'resolved', resolution: { at: T, by: 'dock' } } as DockItem), '✓')
	// Closed elsewhere (a refused dock answer lingers too): no green ✓ beside a red refusal.
	assert.equal(kindGlyph({ ...ask('Bash'), state: 'resolved', resolution: { at: T, by: 'outside' } } as DockItem), '$')
	for (const status of ['working', 'background', 'waiting', 'idle', 'unknown', 'unreachable'] as const)
		assert.equal([...statusGlyph(status)].length, 1)
})

test('plan review: approve needs the whole plan and every other field shown verbatim', () => {
	assert.deepEqual(planReview({ plan: '1. a\n2. b' }), { plan: '1. a\n2. b', fields: null, complete: true })
	const extra = planReview({ plan: '1. a', allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] })
	assert.match(extra.fields ?? '', /"allowedPrompts"/)
	assert.equal(extra.complete, true)
	assert.equal(planReview({}).complete, false)
	assert.equal(planReview('1. a').complete, false)
	assert.equal(planReview({ plan: 'p'.repeat(16_385) }).complete, false)
	assert.equal(planReview({ plan: 'head\n… (truncated)' }).complete, false)
	assert.equal(planReview({ plan: 'ok', note: 'x\u001b[2K' }).complete, false)
})

test('sentSummary names what was sent: picked labels and Other text, or the deny message', () => {
	const item = askItem()
	assert.equal(sentSummary(item, { type: 'answer', picks: [{ options: [1] }, { options: [0] }] }), 'Blue, S')
	assert.equal(
		sentSummary(item, { type: 'answer', picks: [{ options: [], other: ' teal ' }, { options: [1] }] }),
		'“teal”, M',
	)
	assert.equal(sentSummary(item, { type: 'deny', message: 'use the staging bucket' }), 'use the staging bucket')
	assert.equal(sentSummary(item, { type: 'deny' }), null)
	assert.equal(sentSummary(item, { type: 'allow' }), null)
	assert.equal(sentSummary(item, { type: 'prompt', text: 'hi' }), null)
})

test('approving a plan says it switches to accept edits only for Helm terminals (Okena cannot carry setMode)', () => {
	const plan = askItem({
		fact: { kind: 'ask', dialogId: 'd', tool: 'ExitPlanMode', input: { plan: '1. x' }, createdAtMs: T },
	})
	assert.equal(planApproveModeText(plan, 'helm'), 'accept edits on')
	assert.equal(planApproveModeText(plan, 'okena'), null)
	assert.equal(planApproveModeText(plan, undefined), null)
	assert.equal(planApproveModeText(askItem(), 'helm'), null)
	assert.equal(planApproveModeText(turnItem(), 'helm'), null)
})

test('sources are words in the existing slots: health tooltip, down note, blocked answer, no-session label', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	const down = { state: 'down' as const, since: T, lastObservedAt: T - 60_000, detail: 'ECONNREFUSED' }
	const okenaOnly = snapshot(ok)
	assert.deepEqual(dockHealth(okenaOnly), { tone: 'success', text: 'Okena' })
	assert.equal(noSessionText(okenaOnly), "No Claude session is connected to Okena's Claude Remote")
	const both: AgentDockSnapshot = { ...snapshot(ok), sources: { okena: ok, helm: ok } }
	assert.deepEqual(dockHealth(both), { tone: 'success', text: 'Okena · Helm terminals' })
	assert.equal(noSessionText(both), 'No Claude session is connected to Okena and Helm terminals')
	// Helm's hub down while Okena answers: the Okena item stays answerable, the Helm one says why not.
	const helmSession = session({ key: 'p1:t2', terminalId: 't2', source: 'helm' })
	const okenaItem = askItem()
	const helmItem = askItem({ id: 9, key: 'ask:p1:t2:d', session: 'p1:t2' })
	const split: AgentDockSnapshot = {
		...snapshot(down, [okenaItem, helmItem], [session({ source: 'okena' }), helmSession]),
		sources: { okena: ok, helm: down },
	}
	assert.match(dockHealth(split).text, /^Helm terminals unreachable since /)
	assert.equal(canAnswer(okenaItem, split), true)
	assert.equal(sourceBlockedNote(okenaItem, split), null)
	assert.equal(canAnswer(helmItem, split), false)
	assert.equal(sourceBlockedNote(helmItem, split), 'Helm terminals unreachable: answer in the terminal')
})

test('the Agents pane header lists each observed source on its own: dot tone and state in words', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	const down = { state: 'down' as const, since: T, lastObservedAt: T - 60_000, detail: 'ECONNREFUSED' }
	const pending = { state: 'pending' as const, since: T, lastObservedAt: null }
	const view = (snap: AgentDockSnapshot | null) =>
		sourceHealthViews(snap).map(({ id, tone, words }) => [id, tone, words])
	// Before any snapshot: Okena connecting.
	assert.deepEqual(view(null), [['okena', 'neutral', 'Okena connecting…']])
	// Only observed sources show (no Helm hub: no Helm entry), in a fixed order.
	assert.deepEqual(view(snapshot(ok)), [['okena', 'success', 'Okena connected']])
	assert.deepEqual(view({ ...snapshot(down), sources: { helm: pending, okena: down } }), [
		['okena', 'danger', `Okena unreachable since ${formatClock(T)}`],
		['helm', 'neutral', 'Helm terminals connecting…'],
	])
	assert.deepEqual(view({ ...snapshot(ok), sources: { okena: ok, helm: ok } }), [
		['okena', 'success', 'Okena connected'],
		['helm', 'success', 'Helm terminals connected'],
	])
})

// ---------------------------------------------------------------------------
// Agents overview (design §3.24 Agents)
// ---------------------------------------------------------------------------

const OK = { state: 'ok' as const, since: T, lastObservedAt: T }
const message = (text: string, seen = false) => ({ uuid: 'm1', text, at: T - 1_000, seen })
const standingOf = (items: DockItem[], s: DockSession, now = T + 60_000) => {
	const view = agentStanding(snapshot(OK, items, [s]), s, now)
	return [view.standing, view.word, view.glyph] as const
}

test('agent standing: asks need you (question / permission / plan), an open turn is a reply waiting', () => {
	assert.deepEqual(standingOf([askItem()], session({ status: 'waiting' })), [
		'needs-you',
		'question',
		kindGlyph(askItem()),
	])
	const bash = askItem({ fact: { kind: 'ask', dialogId: 'd', tool: 'Bash', input: {}, createdAtMs: T - 60_000 } })
	assert.equal(standingOf([bash], session({ status: 'waiting' }))[1], 'permission')
	const plan = askItem({ fact: { kind: 'ask', dialogId: 'd', tool: 'ExitPlanMode', input: {}, createdAtMs: T } })
	assert.equal(standingOf([plan], session({ status: 'waiting' }))[1], 'plan')
	// An orphaned ask still needs him; an ask beats a turn on the same agent.
	assert.equal(standingOf([askItem({ state: 'orphaned' })], session())[0], 'needs-you')
	assert.deepEqual(standingOf([turnItem(), bash], session())[0], 'needs-you')
	assert.deepEqual(standingOf([turnItem()], session()), ['reply-waiting', 'reply waiting', kindGlyph(turnItem())])
	// Its background shell still runs ("I'll report back"): background, still opening that turn.
	assert.deepEqual(standingOf([turnItem()], session({ status: 'background' })), ['background', 'background', '◐'])
	assert.equal(
		agentStanding(snapshot(OK, [turnItem()], [session({ status: 'background' })]), session({ status: 'background' }), T)
			.item?.id,
		8,
	)
	// Ages and tones like the queue entry: asks from their oldest wait, turns cap at amber.
	const view = agentStanding(snapshot(OK, [askItem()], [session()]), session(), T + 3 * 60 * 60_000)
	assert.equal(view.since, T - 60_000)
	assert.equal(view.tone, 'danger')
	assert.equal(view.label, 'needs you: question')
	assert.equal(view.item?.id, 7)
	assert.equal(agentStanding(snapshot(OK, [turnItem()], [session()]), session(), T + 5 * 60 * 60_000).tone, 'warn')
	// Resolved items owe nothing.
	assert.equal(standingOf([turnItem({ state: 'resolved' })], session())[0], 'idle')
})

test('agent standing: sending / sent / unconfirmed from an item or a reply from the agent detail', () => {
	const receipt = (status: 'sending' | 'sent' | 'unconfirmed') => ({ action: 'reply' as const, status, at: T })
	assert.deepEqual(standingOf([turnItem({ state: 'sending', receipt: receipt('sending') })], session()), [
		'sending',
		'sending',
		'↵',
	])
	assert.equal(
		standingOf([turnItem({ state: 'unconfirmed', receipt: receipt('unconfirmed') })], session())[1],
		'sent, unconfirmed',
	)
	assert.equal(standingOf([], session({ reply: receipt('sending') }))[1], 'sending')
	assert.equal(standingOf([], session({ reply: receipt('sent') }))[1], 'sent')
	const unconfirmed = agentStanding(
		snapshot(OK, [], [session({ reply: receipt('unconfirmed') })]),
		session({ reply: receipt('unconfirmed') }),
		T,
	)
	assert.deepEqual([unconfirmed.word, unconfirmed.tone], ['sent, unconfirmed', 'warn'])
	// A landed or refused reply is history: the status speaks again.
	assert.equal(
		standingOf([], session({ status: 'working', reply: { action: 'reply', status: 'confirmed', at: T } }))[0],
		'working',
	)
})

test('agent standing: working, background, read (seen), idle (unseen), frozen, unknown, not connected', () => {
	assert.deepEqual(standingOf([], session({ status: 'working' })), ['working', 'working', '✻'])
	assert.deepEqual(standingOf([], session({ status: 'background' })), ['background', 'background', '◐'])
	assert.deepEqual(standingOf([], session({ status: 'waiting' })), ['needs-you', 'waiting', '?'])
	assert.deepEqual(standingOf([], session({ lastMessage: message('Done.', true) })), ['read', 'read', '✓'])
	assert.deepEqual(standingOf([], session({ lastMessage: message('Done.') })), ['idle', 'idle', '·'])
	assert.deepEqual(standingOf([], session()), ['idle', 'idle', '·'])
	assert.deepEqual(standingOf([], session({ status: 'unreachable' })), ['unknown', 'frozen', '▪'])
	assert.deepEqual(standingOf([], session({ status: 'unknown' })), ['unknown', 'unknown', '¿'])
	assert.deepEqual(standingOf([], session({ status: 'unknown', hooksAttached: false })), [
		'unknown',
		'not connected',
		'¿',
	])
	assert.equal(
		agentStanding(snapshot(OK, [], [session({ status: 'unreachable' })]), session({ status: 'unreachable' }), T).since,
		null,
	)
})

test('agent place: worktree, branch, detached hash, else a pane name that is not the agent name', () => {
	assert.equal(agentPlace(session({ repo: 'JVS', branch: 'feat/x' }), 'x'), 'worktree')
	assert.equal(agentPlace(session({ branch: 'main' }), 'helm'), 'main')
	assert.equal(agentPlace(session({ branch: 'd1aee9df12345678' }), 'helm'), 'detached d1aee9df')
	assert.equal(agentPlace(session({ name: 'Fix the login' }), 'helm'), 'Fix the login')
	assert.equal(agentPlace(session({ name: 'dock' }), 'dock'), '')
})

test('excerpts: the first line as quiet plain text, Markdown marks dropped, controls and bidi stripped, bounded', () => {
	assert.equal(
		excerptPlainLine('## **Done** — see [the PR](https://x/1) and `npm test`'),
		'Done — see the PR and npm test',
	)
	assert.equal(excerptPlainLine('- first item'), 'first item')
	assert.equal(excerptPlainLine('> quoted'), 'quoted')
	assert.equal(excerptPlainLine(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(7)}c`), 'abc')
	assert.equal(excerptPlainLine('x'.repeat(500), 40).length, 40)
	assert.equal(excerptPlainLine(undefined), '')
})

test('agent rows: needs you, reply waiting, sending, working, background, read, idle, unknown; longest wait first', () => {
	const at = (key: string, overrides: Partial<DockSession>) =>
		session({ key, terminalId: key.slice(3), name: key.slice(3), ...overrides })
	const sessions = [
		at('p1:read', { lastMessage: message('All tests pass.', true), since: T - 5_000 }),
		at('p1:idle', { lastMessage: message('**Shipped** it'), since: T - 4_000 }),
		at('p1:work', { status: 'working', since: T - 3_000, project: 'crm' }),
		at('p1:bg', { status: 'background', since: T - 2_000 }),
		at('p1:gone', { status: 'unreachable' }),
		at('p1:ask', { status: 'waiting' }),
		at('p1:ask2', { status: 'waiting' }),
		at('p1:turn', {}),
		at('p1:send', { reply: { action: 'reply', status: 'sending', at: T } }),
	]
	const items = [
		askItem({
			id: 1,
			session: 'p1:ask',
			fact: { kind: 'ask', dialogId: 'a', tool: 'Bash', input: { command: 'ls' }, createdAtMs: T - 1_000 },
		}),
		askItem({
			id: 2,
			session: 'p1:ask2',
			fact: { kind: 'ask', dialogId: 'b', tool: 'Bash', input: { command: 'pwd' }, createdAtMs: T - 9_000 },
		}),
		turnItem({ id: 3, session: 'p1:turn' }),
	]
	const snap = snapshot(OK, items, sessions)
	const rows = agentRows(snap, T + 60_000)
	assert.deepEqual(
		rows.map(row => row.name),
		['ask2', 'ask', 'turn', 'send', 'work', 'bg', 'read', 'idle', 'gone'],
	)
	const byName = new Map(rows.map(row => [row.name, row]))
	assert.equal(byName.get('ask')?.itemId, 1)
	assert.equal(byName.get('read')?.itemId, undefined)
	assert.equal(byName.get('read')?.excerpt, 'All tests pass.')
	assert.equal(byName.get('idle')?.excerpt, 'Shipped it')
	assert.equal(byName.get('ask')?.excerpt, entryGist(items[0] as DockItem))
	assert.deepEqual(byName.get('work')?.where, ['Okena'])
	assert.equal(agentRowLabel(byName.get('ask2') as never), 'ask2, needs you: permission 1m, Okena')
	assert.equal(agentsSummary(rows), '9 agents · 3 need you · 3 busy')
	assert.equal(agentsSummary(rows.slice(-1)), '1 agent')
	assert.deepEqual(
		agentStateGroups(rows).map(group => [group.heading, group.rows.length]),
		[
			['Needs you', 2],
			['Reply waiting', 1],
			['Sending', 1],
			['Working', 1],
			['Background', 1],
			['Read', 1],
			['Idle', 1],
			['Unknown', 1],
		],
	)
	// By project: groups in the order of their most urgent agent (helm's asks lead; crm only works).
	assert.deepEqual(
		agentOverview(snap, T + 60_000, 'by-project').map(group => [group.heading, group.rows.length]),
		[
			['helm', 8],
			['crm', 1],
		],
	)
	assert.equal(agentOverview(snap, T + 60_000, 'by-state')[0]?.id, 'state:needs-you')
	assert.deepEqual(agentOverview(null, T, 'by-project'), [])
	// Jakub's stored grouping: by project or by state; anything else (an old variant, junk) is by state.
	assert.equal(agentsLayout('by-project'), 'by-project')
	assert.equal(agentsLayout('two-lines'), 'by-state')
	assert.equal(agentsLayout(undefined), 'by-state')
	assert.equal(otherAgentsLayout('by-state'), 'by-project')
	assert.equal(otherAgentsLayout('by-project'), 'by-state')
})

test('agent detail reply: receipts like a turn reply; blocked while it owes, works or its source is down', () => {
	const reply = (status: 'sending' | 'sent' | 'unconfirmed' | 'confirmed' | 'refused' | 'failed', extra = {}) =>
		session({ reply: { action: 'reply', status, at: T, ...extra } })
	assert.equal(sessionReplyView(session(), T), null)
	assert.deepEqual(sessionReplyView(reply('sending'), T), { text: 'Sending…', tone: 'neutral' })
	assert.deepEqual(sessionReplyView(reply('sent', { delivery: 'queued' }), T), {
		text: 'Sending… (queued until the agent is free)',
		tone: 'neutral',
	})
	assert.deepEqual(sessionReplyView(reply('unconfirmed'), T), { text: 'sent, unconfirmed', tone: 'warn' })
	assert.deepEqual(sessionReplyView(reply('confirmed'), T + 1_000), { text: '✓ replied', tone: 'success' })
	assert.equal(sessionReplyView(reply('confirmed'), T + REPLY_RECEIPT_MS), null)
	assert.deepEqual(sessionReplyView(reply('refused', { reason: 'gone' }), T), {
		text: 'refused: already answered elsewhere',
		tone: 'danger',
	})
	assert.deepEqual(sessionReplyView(reply('refused', { reason: 'changed', detail: 'It moved on.' }), T), {
		text: 'refused: It moved on.',
		tone: 'danger',
	})
	assert.deepEqual(sessionReplyView(reply('failed', { detail: 'socket hang up' }), T), {
		text: 'socket hang up',
		tone: 'danger',
	})

	const snap = snapshot(OK)
	const okena = session({ source: 'okena' })
	for (const standing of ['read', 'idle', 'background'] as const)
		assert.equal(agentReplyBlocked(snap, okena, standing), null)
	assert.equal(agentReplyBlocked(snap, okena, 'reply-waiting'), 'Answer its open item first')
	assert.equal(agentReplyBlocked(snap, okena, 'working'), 'Working: reply once it stops')
	assert.equal(agentReplyBlocked(snap, okena, 'sending'), 'A reply is on its way')
	// An unconfirmed reply never clears while the agent stays put: it does not block another (the CAS guards it).
	const replied = (status: 'sent' | 'unconfirmed') =>
		session({ source: 'okena', reply: { action: 'reply', status, at: T } })
	assert.equal(agentReplyBlocked(snap, replied('unconfirmed'), 'sending'), null)
	assert.equal(agentReplyBlocked(snap, replied('sent'), 'sending'), 'A reply is on its way')
	assert.equal(agentReplyBlocked(snap, okena, 'unknown'), 'State unknown: reply in the terminal')
	assert.match(
		agentReplyBlocked(snapshot({ state: 'down', since: T, lastObservedAt: T, detail: 'x' } as never), okena, 'read') ??
			'',
		/unreachable: reply in the terminal$/,
	)
})

test('pane height: natural height within [216, cap]; the cap is 60% of #right, never under 480', () => {
	assert.equal(PANE_MIN_HEIGHT, 216)
	assert.equal(PANE_MAX_HEIGHT, 480)
	assert.equal(PANE_MAX_SHARE, 0.6)
	// 1400×900 (#right 862): the share wins over the old 480.
	assert.equal(paneMaxHeight(862), 517)
	// 1512×982 (#right 944).
	assert.equal(paneMaxHeight(944), 566)
	// 1400×700 (#right 662): 60% is 397, so 480 (the room that keeps 8 terminal rows clamps it on screen,
	// never the height kept, so a window grown back gives it back).
	assert.equal(paneMaxHeight(662), 480)
	// A long message opens at the cap; a short one stays at the minimum; no cap known: 480.
	assert.equal(paneFitHeight(713, 517), 517)
	assert.equal(paneFitHeight(150, 517), 216)
	assert.equal(paneFitHeight(300.2, 517), 301)
	assert.equal(paneFitHeight(713), 480)
})

test('pane resize: Jakub drags within [216, the room that keeps the terminal rows], past the share cap', () => {
	// 1400×900: the room (8 rows kept) is above the 517 share cap: a drag may go past it.
	assert.deepEqual(paneResizeBounds(640), { min: 216, max: 640 })
	assert.equal(clampPaneHeight(700, paneResizeBounds(640)), 640)
	assert.equal(clampPaneHeight(100, paneResizeBounds(640)), 216)
	assert.equal(clampPaneHeight(500.4, paneResizeBounds(640)), 500)
	// A short window: keeping the rows wins over the minimum, the floor still holds.
	assert.deepEqual(paneResizeBounds(180), { min: 180, max: 180 })
	assert.deepEqual(paneResizeBounds(40), { min: PANE_FLOOR, max: PANE_FLOOR })
	// No room known: the old 480.
	assert.deepEqual(paneResizeBounds(null), { min: 216, max: 480 })
})

test('stored pane height: whole px from the floor up, anything else is automatic sizing', () => {
	assert.equal(storedPaneHeight('500'), 500)
	assert.equal(storedPaneHeight(' 360 '), 360)
	assert.equal(storedPaneHeight(String(PANE_FLOOR)), PANE_FLOOR)
	for (const raw of [null, '', 'auto', '-400', '12.5', '1e3', '99', '90000', 'NaN'])
		assert.equal(storedPaneHeight(raw), null, String(raw))
})
