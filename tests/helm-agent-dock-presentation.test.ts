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
	moreWidth,
	queueLayout,
	QUEUE_ENTRY_CHROME,
	QUEUE_ENTRY_PAD,
	QUEUE_NAME_FLOOR,
	QUEUE_NAME_MAX,
	QUEUE_NAME_MIN,
	shortenName,
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

test('summary aging: only blocking asks turn red; old unchecked turns cap at amber', () => {
	const ok = { state: 'ok' as const, since: T, lastObservedAt: T }
	const oldTurn = turnItem({ openedAt: T - 3 * 60 * 60_000 })
	if (oldTurn.fact.kind === 'turn') oldTurn.fact.endedAt = T - 3 * 60 * 60_000
	const turnsOnly = dockSummary(snapshot(ok, [oldTurn]), T)
	assert.equal(turnsOnly.oldestText, 'oldest 3h')
	assert.equal(turnsOnly.oldestTone, 'warn')
})

test('summary counts needs and ages the oldest; the summary names no item', () => {
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

test('card tone and age: the glyph keeps its kind tone, only the age turns red (asks past 2h), turns cap at amber', () => {
	const now = T + 3 * 60 * 60_000
	const oldAsk = askItem({ fact: { kind: 'ask', dialogId: 'd', tool: 'Bash', input: {}, createdAtMs: T } })
	assert.equal(cardTone(oldAsk), 'ask')
	assert.equal(cardTone(askItem({ state: 'orphaned' })), 'orphaned')
	const oldTurn = turnItem()
	assert.equal(cardTone(oldTurn), 'turn')
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
	assert.equal(cardTone(answered), 'done')
	assert.equal(cardTone(elsewhere), 'closed')
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
