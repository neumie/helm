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
	entryNameWidth,
	keepOrder,
	kindGlyph,
	queueLayout,
	statusGlyph,
	sessionStatusText,
	formatAge,
	itemHeadline,
	plainAgentLine,
	plainAgentText,
	resolutionLabel,
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
	assert.equal(itemHeadline(askItem()), 'Barva? (+1)')
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

test('summary counts needs, ages the oldest, and heads with the newest item', () => {
	const items = [askItem({ openedAt: T - 3 * 60 * 60_000 }), turnItem({ openedAt: T - 1_000 })]
	const summary = dockSummary(
		snapshot({ state: 'ok', since: T, lastObservedAt: T }, items, [session({ status: 'waiting' })]),
		T,
	)
	assert.equal(summary.needsText, '2 need you')
	assert.equal(summary.oldestText, 'oldest 3h')
	assert.equal(summary.oldestTone, 'danger')
	assert.equal(summary.head, '#8 helm / dock: PR ready?')
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

test('queue layout keeps every name and wait whole as long as possible, never pages items away', () => {
	const ch = 7.2
	// Busy (3 items: question, permission, turn) at a 1100px window (queue ≈ 759): one row beside the wide Agents column.
	assert.deepEqual(queueLayout([10, 16, 11], 759, ch, [13, 15, 15]), { density: 'full', columns: 3, agents: 'side' })
	// Crowded (5 items) at 1400 (≈ 1059): one row of full entries beside the wide column.
	const crowded = [10, 16, 15, 11, 8]
	const crowdedMeta = [13, 15, 9, 15, 15]
	assert.deepEqual(queueLayout(crowded, 1059, ch, crowdedMeta), { density: 'full', columns: 5, agents: 'side' })
	// Names alone would squeeze five into one row at 1100 (≈ 759) …
	assert.deepEqual(queueLayout(crowded, 759, ch), { density: 'full', columns: 5, agents: 'narrow' })
	// … but "Turn ended" + the wait would not fit beside "ios-sync": two rows rather than a hidden wait.
	assert.deepEqual(queueLayout(crowded, 759, ch, crowdedMeta), { density: 'compact', columns: 3, agents: 'cell' })
	// An entry is as wide as its name or its meta line (indent, kind, wait), whichever is wider.
	const nameOnly = entryNameWidth(8, ch)
	assert.ok(entryNameWidth(8, ch, 15) > nameOnly)
	assert.equal(entryNameWidth(16, ch, 9), (16 + 2) * ch + 26)
	// 900px window (≈ 559): two rows, the Agents entry as the last cell, every name and wait still whole.
	const compact = queueLayout(crowded, 559, ch, crowdedMeta)
	assert.deepEqual(compact, { density: 'compact', columns: 3, agents: 'cell' })
	for (const [at, name] of crowded.entries())
		assert.ok(entryNameWidth(name, ch, crowdedMeta[at]) <= 559 / compact.columns)
	// Nothing to show: the empty note beside the wide column.
	assert.deepEqual(queueLayout([], 300, ch), { density: 'full', columns: 1, agents: 'side' })
	// However many items: dense gives every item (and Agents) a cell in three rows.
	for (const count of [11, 30, 80]) {
		const layout = queueLayout(
			Array.from({ length: count }, () => 12),
			300,
			ch,
		)
		assert.equal(layout.density, 'dense')
		assert.equal(layout.agents, 'cell')
		assert.ok(layout.columns * 3 >= count + 1)
	}
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
	assert.equal(entryMetaChars({ ...ask('Bash'), kind: 'ask' } as DockItem), 'Permission'.length + 5)
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
