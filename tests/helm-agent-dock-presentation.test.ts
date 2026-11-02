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
	agingTone,
	alwaysAllowLabels,
	askQuestions,
	permissionReview,
	planReview,
	cardGist,
	cardKindLabel,
	cardTone,
	dockSummary,
	itemAgeTone,
	itemTimeLine,
	entryWidth,
	keepOrder,
	kindGlyph,
	queueFit,
	QUEUE_ENTRY_MIN,
	QUEUE_ENTRY_PAD,
	QUEUE_GAP,
	QUEUE_NAME_MAX,
	agentNames,
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
	entryMetaChars,
	toolInputText,
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
	assert.equal(toolInputText({ command: 'ls' }), '{\n  "command": "ls"\n}')
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

test('summary never reads as all clear unless Okena is reachable', () => {
	const ok = dockSummary(snapshot({ state: 'ok', since: T, lastObservedAt: T }), T)
	assert.equal(ok.needsText, 'Nothing needs you')
	const down = dockSummary(snapshot({ state: 'down', since: T, lastObservedAt: T - 1_000 }), T)
	assert.equal(down.needsText, 'State unknown')
	assert.match(down.health.text, /^Okena unreachable since \d\d:\d\d$/)
	assert.equal(dockSummary(null, T).needsText, 'Waiting for Okena')
	assert.equal(dockSummary(null, T).health.text, 'Okena connecting…')
})

test('summary never reads as all clear while a listed agent is unreadable', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	const blind = dockSummary(snapshot(ok, [], [session({ status: 'unknown' }), session({ key: 'p:t2' })]), T)
	assert.equal(blind.needsText, 'State unknown for 1 agent')
	assert.equal(blind.needsTone, 'warn')
	assert.equal(blind.unknownCount, 1)
	const mixed = dockSummary(snapshot(ok, [turnItem()], [session({ status: 'unknown' })]), T)
	assert.equal(mixed.needsText, '1 needs you · 1 unknown')
})

test('strip aging: only blocking asks turn red; old unchecked turns cap at amber', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	const oldTurn = turnItem({ openedAt: T - 3 * 60 * 60_000 })
	if (oldTurn.fact.kind === 'turn') oldTurn.fact.endedAt = T - 3 * 60 * 60_000
	const turnsOnly = dockSummary(snapshot(ok, [oldTurn]), T)
	assert.equal(turnsOnly.oldestText, 'oldest 3h')
	assert.equal(turnsOnly.oldestTone, 'warn')
})

test('summary counts needs and ages the oldest; the strip names no item', () => {
	const items = [askItem({ openedAt: T - 3 * 60 * 60_000 }), turnItem({ openedAt: T - 1_000 })]
	const summary = dockSummary(
		snapshot({ state: 'ok', since: T, lastObservedAt: T }, items, [session({ status: 'waiting' })]),
		T,
	)
	assert.equal(summary.needsText, '2 need you')
	assert.equal(summary.oldestText, 'oldest 3h')
	assert.equal(summary.oldestTone, 'danger')
	assert.ok(!('head' in summary))
	const turnsOnly = dockSummary(snapshot({ state: 'ok', since: T, lastObservedAt: T }, [turnItem()]), T)
	assert.equal(turnsOnly.needsText, '1 needs you')
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

test('card tone and age: red only for asks past 2h, dashed orphans, unchecked turns cap at amber', () => {
	const now = T + 3 * 60 * 60_000
	const oldAsk = askItem({ fact: { kind: 'ask', dialogId: 'd', tool: 'Bash', input: {}, createdAtMs: T } })
	assert.equal(cardTone(oldAsk, T + 60_000), 'ask')
	assert.equal(cardTone(oldAsk, now), 'ask-danger')
	assert.equal(cardTone(askItem({ state: 'orphaned' }), now), 'orphaned')
	const oldTurn = turnItem()
	assert.equal(cardTone(oldTurn, now), 'turn')
	assert.equal(itemAgeTone(oldTurn, now), 'warn')
	assert.equal(itemAgeTone(oldAsk, now), 'danger')
	assert.equal(cardKindLabel(askItem({ state: 'orphaned' })), 'Orphaned question')
	assert.equal(cardKindLabel(oldAsk), 'Permission')
	// Once answered (or on its way) the wait stops ageing: no red "waiting" next to a ✓.
	const answered = { ...oldAsk, state: 'resolved', resolution: { at: now, by: 'dock' } } as DockItem
	assert.equal(itemAgeTone(answered, now), 'none')
	assert.equal(itemAgeTone({ ...oldAsk, state: 'sending' } as DockItem, now), 'none')
	assert.match(itemTimeLine(answered, now).waited, /^answered \d\d:\d\d$/)
	assert.equal(itemTimeLine({ ...oldAsk, state: 'sending' } as DockItem, now).waited, 'sending')
	const elsewhere = { ...oldAsk, state: 'resolved', resolution: { at: now, by: 'outside' } } as DockItem
	assert.match(itemTimeLine(elsewhere, now).waited, /^closed \d\d:\d\d$/)
	assert.equal(cardTone(answered, now), 'done')
	assert.equal(cardTone(elsewhere, now), 'closed')
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
	assert.equal(cardGist(turn), 'Can you confirm the stage secret?')
	const plan = askItem({
		fact: {
			kind: 'ask',
			dialogId: 'd',
			tool: 'ExitPlanMode',
			input: { plan: '# Export ISDOC\n\n1. Map' },
			createdAtMs: T,
		},
	})
	assert.equal(cardGist(plan), 'Export ISDOC')
	const bash = askItem({
		fact: { kind: 'ask', dialogId: 'd', tool: 'Bash', input: { command: 'git push\u202e' }, createdAtMs: T },
	})
	assert.equal(cardGist(bash), 'Bash: git push')
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

test('the queue is one row: what fits shows, the rest sit behind one "+N more" cell', () => {
	const ch = 7.2
	// An entry is as wide as its name line (glyph, space, name) or its second line (indent, kind · wait).
	assert.equal(entryWidth(34, ch, 15), Math.ceil(36 * ch) + QUEUE_ENTRY_PAD)
	assert.equal(entryWidth(8, ch, 22), Math.max(QUEUE_ENTRY_MIN, Math.ceil(24 * ch) + QUEUE_ENTRY_PAD))
	// Short names never make slivers; very long ones stop growing (they ellipsize, the tooltip keeps them).
	assert.equal(entryWidth(1, ch), QUEUE_ENTRY_MIN)
	assert.equal(entryWidth(200, ch), entryWidth(QUEUE_NAME_MAX, ch))
	// Everything fits: no "+N more".
	assert.equal(queueFit([200, 200, 200], 600 + 2 * QUEUE_GAP, 80), 3)
	// One pixel short: as many as fit beside the "+N more" cell.
	assert.equal(queueFit([200, 200, 200], 600 + 2 * QUEUE_GAP - 1, 80), 2)
	assert.equal(queueFit([200, 200, 200], 200 + QUEUE_GAP + 80, 80), 1)
	// Order is kept: a narrow later entry never jumps ahead of a wide earlier one.
	assert.equal(queueFit([300, 100, 100], 250, 80), 0)
	assert.equal(queueFit([], 0, 80), 0)
	// Eight items at a 1100px window (≈ 900px of room): some show, the rest are counted.
	const widths = Array.from({ length: 8 }, () => entryWidth(28, ch, 19))
	const shown = queueFit(widths, 900, entryWidth(0, ch))
	assert.ok(shown > 0 && shown < 8)
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

test('kind and status glyphs are single terminal cells', () => {
	const ask = (tool: string) => ({ kind: 'ask', state: 'open', fact: { kind: 'ask', tool } }) as unknown as DockItem
	assert.equal(kindGlyph(ask('AskUserQuestion')), '?')
	assert.equal(kindGlyph(ask('ExitPlanMode')), '≡')
	assert.equal(kindGlyph(ask('Bash')), '$')
	assert.equal(kindGlyph({ kind: 'turn', state: 'open', fact: { kind: 'turn' } } as unknown as DockItem), '↵')
	assert.equal(kindGlyph({ ...ask('Bash'), state: 'resolved', resolution: { at: T, by: 'dock' } } as DockItem), '✓')
	// Closed elsewhere (a refused dock answer lingers too): no green ✓ beside a red refusal.
	assert.equal(kindGlyph({ ...ask('Bash'), state: 'resolved', resolution: { at: T, by: 'outside' } } as DockItem), '$')
	assert.equal(entryMetaChars({ ...ask('Bash'), kind: 'ask' } as DockItem), 'permission · '.length + 5)
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
