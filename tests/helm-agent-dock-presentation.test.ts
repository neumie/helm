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
	cardGist,
	cardKindLabel,
	cardTone,
	dockSummary,
	itemAgeTone,
	itemTimeLine,
	popoverPlacement,
	railLayout,
	sessionStatusText,
	formatAge,
	itemHeadline,
	plainAgentLine,
	plainAgentText,
	resolutionLabel,
	sessionIndicator,
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
	assert.equal(ok.indicator, null)
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
	assert.equal(summary.indicator?.variant, 'waiting')
	assert.equal(summary.head, '#8 helm / dock: PR ready?')
	const turnsOnly = dockSummary(snapshot({ state: 'ok', since: T, lastObservedAt: T }, [turnItem()]), T)
	assert.equal(turnsOnly.indicator?.variant, 'attention')
	assert.equal(turnsOnly.needsText, '1 needs you')
})

test('session indicators and row meta: busy, waiting, unchecked turn, stale', () => {
	assert.equal(sessionIndicator(session({ status: 'working' }), [])?.variant, 'progress')
	assert.equal(sessionIndicator(session({ status: 'waiting' }), [])?.variant, 'waiting')
	assert.equal(sessionIndicator(session(), [turnItem()])?.variant, 'attention')
	assert.equal(sessionIndicator(session(), []), null)
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
	assert.match(itemTimeLine(bash, T).stamp, /^Asked \d\d:\d\d$/)
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

test('rail layout never pages items away: full cards as long as possible, then compact, then the agents join the grid', () => {
	assert.deepEqual(railLayout(0, 300), { density: 'full', columns: 1, agents: 'side' })
	assert.deepEqual(railLayout(3, 1027), { density: 'full', columns: 3, agents: 'side' })
	// 1100px window (rail ≈ 727): three full cards with 2-line gists beside the narrow Agents block.
	assert.deepEqual(railLayout(3, 727), { density: 'full', columns: 3, agents: 'narrow' })
	// 1400px window (rail ≈ 1027): five items compact beside the Agents block.
	assert.deepEqual(railLayout(5, 1027), { density: 'compact', columns: 3, agents: 'side' })
	// 900px window (rail ≈ 527): five items + Agents in a 3×2 grid.
	assert.deepEqual(railLayout(5, 527), { density: 'compact', columns: 3, agents: 'cell' })
	assert.deepEqual(railLayout(12, 527), { density: 'dense', columns: 5, agents: 'cell' })
	// A lone card in a narrow pane keeps the full form beside the narrow block.
	assert.deepEqual(railLayout(1, 340), { density: 'full', columns: 1, agents: 'narrow' })
	// However many items: dense always gives every item (and Agents) a cell in three rows; CSS shrinks the
	// columns to the rail width instead of scrolling.
	for (const count of [11, 30, 80]) {
		const layout = railLayout(count, 300)
		assert.equal(layout.density, 'dense')
		assert.equal(layout.agents, 'cell')
		assert.ok(layout.columns * 3 >= count + 1)
	}
})

test('popover placement keeps the last terminal rows visible and caps its height', () => {
	const terminal = { top: 38, bottom: 766, screenTop: 50, screenBottom: 760, rowHeight: 18 }
	const dock = { top: 766, left: 341, width: 1059, height: 134 }
	const bottom = popoverPlacement({
		position: 'bottom',
		dock,
		anchor: { left: 357, width: 250 },
		terminal,
		viewportHeight: 900,
	})
	// Popover bottom edge (viewport y) = dock bottom - css bottom.
	const popoverBottom = dock.top + dock.height - (bottom.bottom ?? 0)
	assert.ok(popoverBottom <= terminal.screenBottom - 4 * terminal.rowHeight)
	// Snapped to the row grid: the row above the kept band is whole, never half covered.
	assert.equal((popoverBottom - terminal.screenTop) % terminal.rowHeight, 0)
	assert.equal(bottom.left, 16)
	assert.equal(bottom.width, 640)
	assert.ok(bottom.maxHeight <= 560 && bottom.maxHeight > 0)
	assert.ok(popoverBottom - bottom.maxHeight >= terminal.top)
	// Right-hand anchors clamp inside the dock.
	assert.equal(
		popoverPlacement({ position: 'bottom', dock, anchor: { left: 1300, width: 200 }, terminal, viewportHeight: 900 })
			.left,
		1059 - 16 - 640,
	)
	// Top dock: opens downward, below the rows next to it and above the input line.
	const topDock = { top: 38, left: 341, width: 1059, height: 134 }
	const topTerminal = { top: 172, bottom: 900, screenTop: 184, screenBottom: 894, rowHeight: 18 }
	const top = popoverPlacement({
		position: 'top',
		dock: topDock,
		anchor: { left: 357, width: 250 },
		terminal: topTerminal,
		viewportHeight: 900,
	})
	const popoverTop = topDock.top + (top.top ?? 0)
	assert.ok(popoverTop >= topTerminal.screenTop + 4 * topTerminal.rowHeight)
	assert.equal(popoverTop, topTerminal.screenTop + 5 * topTerminal.rowHeight)
	assert.equal((popoverTop + top.maxHeight - topTerminal.screenTop) % topTerminal.rowHeight, 0)
	assert.ok(popoverTop + top.maxHeight <= topTerminal.screenBottom - 4 * topTerminal.rowHeight)
	// No terminal metrics (component review): hug the dock.
	const bare = popoverPlacement({
		position: 'bottom',
		dock,
		anchor: { left: 357, width: 1 },
		terminal: null,
		viewportHeight: 900,
	})
	assert.equal(bare.bottom, dock.height + 8)
})

test('popover placement keeps a higher-up prompt row visible and never collapses to nothing', () => {
	const dock = { top: 766, left: 341, width: 1059, height: 134 }
	const terminal = { top: 38, bottom: 766, screenTop: 50, screenBottom: 752, rowHeight: 18 }
	const place = (cursorTop: number | null, metrics = terminal) =>
		popoverPlacement({
			position: 'bottom',
			dock,
			anchor: { left: 357, width: 250 },
			terminal: { ...metrics, cursorTop },
			viewportHeight: 900,
		})
	const band = (placement: ReturnType<typeof place>) => {
		const bottom = dock.top + dock.height - (placement.bottom ?? 0)
		return { top: bottom - placement.maxHeight, bottom }
	}
	// Prompt in the kept band (the usual case): unchanged.
	assert.deepEqual(place(terminal.screenBottom - terminal.rowHeight), place(null))
	// After `clear` the prompt sits on the first row: the popover opens below it, rows 0–2 stay visible.
	const cleared = band(place(terminal.screenTop))
	assert.ok(cleared.top >= terminal.screenTop + 2 * terminal.rowHeight)
	// A prompt mid-screen: the larger side wins and the cursor row ±1 is never covered.
	const mid = terminal.screenTop + 10 * terminal.rowHeight
	const midBand = band(place(mid))
	assert.ok(midBand.bottom <= mid - terminal.rowHeight || midBand.top >= mid + 2 * terminal.rowHeight)
	// A short terminal (large font, small window): at least the minimum height, still above the input line.
	const short = { top: 600, bottom: 766, screenTop: 606, screenBottom: 760, rowHeight: 22 }
	const squeezed = place(null, short)
	assert.ok(squeezed.maxHeight >= 120)
	assert.ok(band(squeezed).bottom <= short.screenBottom - 4 * short.rowHeight)
})
