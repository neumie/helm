// Pure agent-dock presentation helpers: snapshot → strip/panel facts. No DOM,
// no runtime import of the zod model (types only), so the renderer bundle stays
// zod-free. Agent text is untrusted: every string that reaches the DOM passes
// through plainAgentText and renders as React text, never markup.

import type { AgentDockSnapshot, DockItem, DockSession } from '../../agent-dock/model'

export type AgentDockPosition = 'top' | 'bottom'
export type AgingTone = 'none' | 'warn' | 'danger'
export type AgentIndicatorVariant = 'progress' | 'waiting' | 'attention'

/** Aging escalation (design §2): amber after 30 minutes, red after 2 hours. */
export const AGING_WARN_MS = 30 * 60_000
export const AGING_DANGER_MS = 2 * 60 * 60_000
/** A session whose last detail read lags the last good /v1/state by this much renders stale. */
export const SESSION_STALE_MS = 10_000
/** Bounds for agent text the dock renders (turn excerpts are already ≤2 KiB from the reducer). */
export const AGENT_TEXT_MAX = 2_048
export const TOOL_INPUT_TEXT_MAX = 4_096
export const PREVIEW_TEXT_MAX = 2_048

// C0/C1 controls except tab/newline, plus bidi overrides/isolates that could reorder rendered text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

/** Control-stripped, length-bounded plain text. Non-strings render as empty. */
export function plainAgentText(value: unknown, max = AGENT_TEXT_MAX): string {
	if (typeof value !== 'string') return ''
	const clean = value.replace(UNSAFE_TEXT, '')
	if (clean.length <= max) return clean
	let end = Math.max(0, max - 1)
	const code = clean.charCodeAt(end - 1)
	if (code >= 0xd800 && code <= 0xdbff) end -= 1
	return `${clean.slice(0, end)}…`
}

/** One-line variant for strip heads and row titles. */
export function plainAgentLine(value: unknown, max = 160): string {
	return plainAgentText(
		plainAgentText(value, max * 4)
			.replace(/\s+/g, ' ')
			.trim(),
		max,
	)
}

/** Relative age per copy voice: "<1m", "12m", "2h14m", "3d". */
export function formatAge(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000)
	if (minutes < 1) return '<1m'
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`
	return `${Math.floor(hours / 24)}d`
}

/** Local wall-clock HH:MM (24h). */
export function formatClock(ms: number): string {
	const date = new Date(ms)
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function agingTone(ms: number): AgingTone {
	if (ms > AGING_DANGER_MS) return 'danger'
	if (ms > AGING_WARN_MS) return 'warn'
	return 'none'
}

/** When the item started owing Jakub: the dialog's own timestamp, else when the turn ended, else first observed. */
export function itemWaitingSince(item: DockItem): number {
	if (item.fact.kind === 'ask' && item.fact.createdAtMs > 0) return Math.min(item.fact.createdAtMs, item.openedAt)
	if (item.fact.kind === 'turn') return item.fact.endedAt
	return item.openedAt
}

/** Items that need Jakub, in the snapshot's order (open asks, orphaned, open turns). */
export function needsYouItems(snapshot: AgentDockSnapshot | null): DockItem[] {
	return snapshot?.items.filter(item => item.state !== 'resolved') ?? []
}

export function recentItems(snapshot: AgentDockSnapshot | null, limit: number): DockItem[] {
	return (snapshot?.items.filter(item => item.state === 'resolved') ?? []).slice(0, limit)
}

export function findSession(snapshot: AgentDockSnapshot | null, key: string): DockSession | undefined {
	return snapshot?.sessions.find(session => session.key === key)
}

export function sessionLabel(session: DockSession | undefined, key: string): string {
	if (!session) return `terminal ${plainAgentLine(key.slice(key.lastIndexOf(':') + 1), 8)}`
	const project = plainAgentLine(session.project, 48)
	const name = plainAgentLine(session.name, 64)
	return project ? `${project} / ${name}` : name
}

export interface AskOption {
	label: string
	description?: string
	preview?: string
}

export interface AskQuestion {
	header?: string
	question: string
	multiSelect: boolean
	options: AskOption[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** AskUserQuestion `tool_input.questions`, verbatim but bounded; null when the shape is not recognisable. */
export function askQuestions(input: unknown): AskQuestion[] | null {
	if (!isRecord(input) || !Array.isArray(input.questions)) return null
	const questions: AskQuestion[] = []
	for (const raw of input.questions.slice(0, 16)) {
		if (!isRecord(raw) || typeof raw.question !== 'string') return null
		const options: AskOption[] = []
		for (const option of Array.isArray(raw.options) ? raw.options.slice(0, 32) : []) {
			if (!isRecord(option) || typeof option.label !== 'string') continue
			options.push({
				label: plainAgentText(option.label, 512),
				...(typeof option.description === 'string'
					? { description: plainAgentText(option.description, AGENT_TEXT_MAX) }
					: {}),
				...(typeof option.preview === 'string' ? { preview: plainAgentText(option.preview, PREVIEW_TEXT_MAX) } : {}),
			})
		}
		questions.push({
			...(typeof raw.header === 'string' ? { header: plainAgentLine(raw.header, 64) } : {}),
			question: plainAgentText(raw.question, AGENT_TEXT_MAX),
			multiSelect: raw.multiSelect === true,
			options,
		})
	}
	return questions.length > 0 ? questions : null
}

/** ExitPlanMode plan text, when Okena included a plan file. */
export function planText(input: unknown): string | null {
	return isRecord(input) && typeof input.plan === 'string' ? plainAgentText(input.plan, TOOL_INPUT_TEXT_MAX) : null
}

/** Any other tool input as bounded pretty JSON, rendered verbatim in a monospace block. */
export function toolInputText(input: unknown, max = TOOL_INPUT_TEXT_MAX): string {
	let text: string
	try {
		text = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? '')
	} catch {
		text = ''
	}
	return plainAgentText(text, max)
}

/** One-line summary of what the item is about. */
export function itemHeadline(item: DockItem): string {
	if (item.fact.kind === 'turn') return plainAgentLine(item.fact.text) || 'Agent finished its turn'
	const { tool, input } = item.fact
	if (tool === 'AskUserQuestion') {
		const questions = askQuestions(input)
		if (!questions?.[0]) return 'Question'
		const more = questions.length > 1 ? ` (+${questions.length - 1})` : ''
		return `${plainAgentLine(questions[0].question)}${more}`
	}
	if (tool === 'ExitPlanMode') return 'Plan ready for approval'
	return `Allow ${plainAgentLine(tool, 64)}?`
}

export function resolutionLabel(item: DockItem): string {
	switch (item.resolution?.by) {
		case 'outside':
			return item.kind === 'ask' ? 'answered in terminal' : 'handled in terminal'
		case 'replied':
			return 'replied in terminal'
		case 'superseded':
			return 'superseded by a newer turn'
		case 'session_ended':
			return 'session ended'
		case 'acked':
			return 'acked'
		default:
			return 'resolved'
	}
}

/** Session chip indicator: busy → progress, open ask → waiting, unchecked turn → attention, else none. */
export function sessionIndicator(
	session: DockSession,
	items: readonly DockItem[],
): { variant: AgentIndicatorVariant; label: string } | null {
	const live = items.filter(item => item.session === session.key && item.state !== 'resolved')
	if (session.status === 'waiting' || live.some(item => item.kind === 'ask' && item.state === 'open'))
		return { variant: 'waiting', label: 'Waiting for your answer' }
	if (session.status === 'working') return { variant: 'progress', label: 'Working' }
	if (session.status === 'background') return { variant: 'progress', label: 'Subagents running in the background' }
	if (live.length > 0) return { variant: 'attention', label: 'Finished — unchecked' }
	return null
}

const staleAge = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : formatAge(ms))

/**
 * Listed agents the dock cannot see into (detail read failed or failed validation,
 * or `busy` missing). Their open dialogs are invisible, so their presence rules
 * out "Nothing needs you" (design §2/§4: never all-clear from missing data).
 */
export function unknownSessionCount(snapshot: AgentDockSnapshot | null): number {
	if (snapshot?.source.state !== 'ok') return 0
	return snapshot.sessions.filter(session => session.status === 'unknown').length
}

export const unknownAgentsText = (count: number): string => `State unknown for ${count} agent${count === 1 ? '' : 's'}`

export interface AgentDockHealth {
	tone: 'success' | 'danger' | 'neutral'
	text: string
}

export function dockHealth(snapshot: AgentDockSnapshot | null): AgentDockHealth {
	if (!snapshot || snapshot.source.state === 'pending') return { tone: 'neutral', text: 'Okena connecting…' }
	if (snapshot.source.state === 'down')
		return { tone: 'danger', text: `Okena unreachable since ${formatClock(snapshot.source.since)}` }
	return { tone: 'success', text: 'Okena' }
}

export interface AgentDockSummary {
	needCount: number
	/** Listed agents whose state could not be read (see unknownSessionCount). */
	unknownCount: number
	/** Text for the needs slot; never "all clear" unless Okena is reachable and every agent was read. */
	needsText: string
	needsTone: 'none' | 'warn'
	oldestText: string | null
	oldestTone: AgingTone
	indicator: { variant: AgentIndicatorVariant; label: string } | null
	head: string | null
	counts: string | null
	health: AgentDockHealth
}

export function dockSummary(snapshot: AgentDockSnapshot | null, now: number): AgentDockSummary {
	const needs = needsYouItems(snapshot)
	const health = dockHealth(snapshot)
	const source = snapshot?.source.state ?? 'pending'
	const oldestOf = (items: readonly DockItem[]) =>
		items.reduce<number | null>((min, item) => {
			const since = itemWaitingSince(item)
			return min === null || since < min ? since : min
		}, null)
	const oldest = oldestOf(needs)
	// Red means "an agent is stuck waiting on you": only blocking asks escalate past amber.
	const oldestAsk = oldestOf(needs.filter(item => item.kind === 'ask'))
	const askTone = oldestAsk === null ? 'none' : agingTone(now - oldestAsk)
	const turnTone = oldest === null ? 'none' : agingTone(now - oldest)
	const oldestTone: AgingTone =
		askTone === 'danger' ? 'danger' : askTone === 'warn' || turnTone !== 'none' ? 'warn' : 'none'
	const newest = needs.reduce<DockItem | null>((latest, item) => {
		if (!latest) return item
		const a = itemWaitingSince(item)
		const b = itemWaitingSince(latest)
		return a > b || (a === b && item.id > latest.id) ? item : latest
	}, null)
	const hasAsk = needs.some(item => item.kind === 'ask' && item.state === 'open')
	const working = snapshot?.sessions.filter(session => session.status === 'working').length ?? 0
	const background = snapshot?.sessions.filter(session => session.status === 'background').length ?? 0
	const counts = [working ? `${working} working` : '', background ? `${background} bg` : ''].filter(Boolean).join(' · ')
	const unknown = unknownSessionCount(snapshot)
	let needsText: string
	if (needs.length > 0)
		needsText = `${needs.length} need${needs.length === 1 ? 's' : ''} you${unknown > 0 ? ` · ${unknown} unknown` : ''}`
	else if (unknown > 0) needsText = unknownAgentsText(unknown)
	else if (source === 'ok') needsText = 'Nothing needs you'
	else if (source === 'down') needsText = 'State unknown'
	else needsText = 'Waiting for Okena'
	return {
		needCount: needs.length,
		unknownCount: unknown,
		needsText,
		needsTone: needs.length > 0 || unknown > 0 ? 'warn' : 'none',
		oldestText: oldest === null ? null : `oldest ${formatAge(now - oldest)}`,
		oldestTone,
		indicator: hasAsk
			? { variant: 'waiting', label: 'An agent is waiting for your answer' }
			: needs.length > 0
				? { variant: 'attention', label: 'Agent work is waiting to be checked' }
				: null,
		head: newest
			? `#${newest.id} ${sessionLabel(findSession(snapshot, newest.session), newest.session)}: ${itemHeadline(newest)}`
			: null,
		counts: counts || null,
		health,
	}
}

// ---------------------------------------------------------------------------
// Card rail (design §3.24): cards, density, popover placement.
// ---------------------------------------------------------------------------

/** Card urgency edge: amber ask, red ask past 2h, dashed amber orphan, blue unchecked turn. */
export type CardTone = 'ask' | 'ask-danger' | 'orphaned' | 'turn'

export function cardTone(item: DockItem, now: number): CardTone {
	if (item.state === 'orphaned') return 'orphaned'
	if (item.kind === 'turn') return 'turn'
	return agingTone(now - itemWaitingSince(item)) === 'danger' ? 'ask-danger' : 'ask'
}

/** Item age tone; unchecked turns cap at warn (only blocking asks go red), as on the strip. */
export function itemAgeTone(item: DockItem, now: number): AgingTone {
	const tone = agingTone(now - itemWaitingSince(item))
	return item.kind === 'turn' && tone === 'danger' ? 'warn' : tone
}

/** Short kind for cards and the popover head: Question / Plan / Permission / Turn ended / Orphaned …. */
export function cardKindLabel(item: DockItem): string {
	if (item.fact.kind === 'turn') return 'Turn ended'
	const base =
		item.fact.tool === 'AskUserQuestion' ? 'Question' : item.fact.tool === 'ExitPlanMode' ? 'Plan' : 'Permission'
	return item.state === 'orphaned' ? `Orphaned ${base.toLowerCase()}` : base
}

export function itemIndicator(item: DockItem): { variant: AgentIndicatorVariant; label: string } {
	if (item.kind === 'ask' && item.state === 'open') return { variant: 'waiting', label: 'Waiting for your answer' }
	return { variant: 'attention', label: 'Waiting to be checked' }
}

/** "Asked 14:50" / "Finished 14:50" plus the wait in words, for the popover head. */
export function itemTimeLine(item: DockItem, now: number): { stamp: string; waited: string } {
	const since = itemWaitingSince(item)
	return {
		stamp: `${item.kind === 'turn' ? 'Finished' : 'Asked'} ${formatClock(since)}`,
		waited: `${item.kind === 'turn' ? 'idle' : 'waiting'} ${formatAge(now - since)}`,
	}
}

/** A permission dialog's shell command, when its tool input carries one. */
export function commandOf(input: unknown): string | null {
	return isRecord(input) && typeof input.command === 'string' ? plainAgentText(input.command, 1_024) : null
}

/** The part of a turn that is about Jakub: its last paragraph (questions and handoffs land there). */
export function turnGist(text: string): string {
	const paragraphs = plainAgentText(text)
		.split(/\n\s*\n/)
		.map(part => part.trim())
		.filter(Boolean)
	return plainAgentLine(paragraphs.at(-1) ?? text, 220)
}

/** Two-line card gist: the question, the plan's title, the command, or the turn's last paragraph. */
export function cardGist(item: DockItem): string {
	if (item.fact.kind === 'turn') return turnGist(item.fact.text) || 'Agent finished its turn'
	const { tool, input } = item.fact
	if (tool === 'ExitPlanMode') {
		const first = (planText(input) ?? '').split('\n').find(line => line.trim())
		return first ? plainAgentLine(first.replace(/^#+\s*/, ''), 160) : 'Plan ready for approval'
	}
	if (tool === 'AskUserQuestion') return itemHeadline(item)
	const command = commandOf(input)
	return command ? `${plainAgentLine(tool, 32)}: ${plainAgentLine(command, 160)}` : itemHeadline(item)
}

/** Project and agent name kept apart so cards can ellipsize the project before the name. */
export function sessionWhere(session: DockSession | undefined, key: string): { project: string; name: string } {
	if (!session) return { project: '', name: `terminal ${plainAgentLine(key.slice(key.lastIndexOf(':') + 1), 8)}` }
	return { project: plainAgentLine(session.project, 48), name: plainAgentLine(session.name, 64) }
}

/**
 * "Always allow" wording, sourced only from Claude's own `permission_suggestions`
 * (allow `addRules` → `Tool(rule)`, `addDirectories` → the directory). Empty when
 * Claude suggested nothing renderable: the dock then offers no such option.
 */
export function alwaysAllowLabels(suggestions: unknown): string[] {
	if (!Array.isArray(suggestions)) return []
	const labels: string[] = []
	for (const suggestion of suggestions.slice(0, 8)) {
		if (!isRecord(suggestion)) continue
		if (suggestion.type === 'addRules' && suggestion.behavior === 'allow' && Array.isArray(suggestion.rules)) {
			for (const rule of suggestion.rules.slice(0, 8)) {
				if (!isRecord(rule) || typeof rule.toolName !== 'string') continue
				const tool = plainAgentLine(rule.toolName, 64)
				const content = typeof rule.ruleContent === 'string' ? plainAgentLine(rule.ruleContent, 160) : ''
				if (tool) labels.push(content ? `${tool}(${content})` : tool)
			}
		} else if (suggestion.type === 'addDirectories' && Array.isArray(suggestion.directories)) {
			for (const directory of suggestion.directories.slice(0, 8))
				if (typeof directory === 'string' && directory) labels.push(plainAgentLine(directory, 160))
		}
	}
	return [...new Set(labels)]
}

/** Status words for an agent line: only what DockSession observed (status, since, subagents, queue). */
export function sessionStatusText(session: DockSession, now: number): string {
	const age = formatAge(now - session.since)
	switch (session.status) {
		case 'working':
			return `working ${age}`
		case 'background':
			return `background ${age}`
		case 'waiting':
			return `waiting ${age}`
		case 'idle':
			return `idle ${age}`
		case 'unreachable':
			return 'frozen'
		default:
			return 'unknown'
	}
}

const STATUS_ORDER: Record<DockSession['status'], number> = {
	working: 0,
	background: 1,
	waiting: 2,
	idle: 3,
	unknown: 4,
	unreachable: 5,
}

/** Agents for the rail block and its popover: busy first, then waiting, idle, unknown; newest change first. */
export function orderedSessions(snapshot: AgentDockSnapshot | null): DockSession[] {
	return [...(snapshot?.sessions ?? [])].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.since - a.since,
	)
}

export type RailDensity = 'full' | 'compact' | 'dense'
/** Where the Agents button sits: a 232px block beside the cards, a 140px block, or the grid's last cell. */
export type RailAgentsSlot = 'side' | 'narrow' | 'cell'
/** Gap between cards and between compact rows (§2.3). */
export const RAIL_GAP = 8
/** Narrowest card per density (compact beside the Agents block needs room for a whole agent name). */
export const RAIL_CARD_MIN = { full: 176, compactSide: 160, compact: 120 } as const
/** Room the Agents block takes beside the cards: its width (12px inset + hairline included) plus the 12px rail gap. */
export const RAIL_AGENTS_ROOM = { side: 244, narrow: 152 } as const

export interface RailLayout {
	density: RailDensity
	columns: number
	agents: RailAgentsSlot
}

/**
 * Picks the card form so every item that needs Jakub stays in view (never paged
 * or scrolled away), keeping full cards (legible names, 2-line gist) as long as
 * possible: one row of full cards beside the Agents block, then beside its narrow
 * form; else two rows of compact cards beside it (wide, then narrow); else two
 * rows with the Agents button as the last cell; else three rows of dense chips
 * that shrink to fit. `width` is the rail's content width.
 */
export function railLayout(count: number, width: number): RailLayout {
	const fits = (columns: number, min: number, room: number) => columns * min + (columns - 1) * RAIL_GAP <= room
	const columns = Math.max(1, count)
	for (const agents of ['side', 'narrow'] as const)
		if (fits(count, RAIL_CARD_MIN.full, width - RAIL_AGENTS_ROOM[agents])) return { density: 'full', columns, agents }
	const two = Math.ceil(count / 2)
	for (const agents of ['side', 'narrow'] as const)
		if (fits(two, RAIL_CARD_MIN.compactSide, width - RAIL_AGENTS_ROOM[agents]))
			return { density: 'compact', columns: two, agents }
	const twoWithAgents = Math.ceil((count + 1) / 2)
	if (fits(twoWithAgents, RAIL_CARD_MIN.compact, width))
		return { density: 'compact', columns: twoWithAgents, agents: 'cell' }
	// Dense chips never overflow: columns shrink (name, then age give way) instead of scrolling.
	return { density: 'dense', columns: Math.ceil((count + 1) / 3), agents: 'cell' }
}

/** Facts for an agent row besides its status words: connection, subagents, queue, PRs, staleness. */
export function agentRowMeta(snapshot: AgentDockSnapshot, session: DockSession): string[] {
	const meta: string[] = []
	if (session.status !== 'unreachable' && session.status !== 'unknown' && !session.hooksAttached)
		meta.push('not connected')
	if (session.subagents > 0) meta.push(`${session.subagents} subagent${session.subagents === 1 ? '' : 's'}`)
	if (session.queuedPrompts > 0) meta.push(`queued ${session.queuedPrompts}`)
	for (const pr of session.prLinks.slice(0, 2)) meta.push(`PR #${pr.number}`)
	const lastGood = snapshot.source.lastObservedAt
	if (lastGood !== null && session.status !== 'unreachable' && lastGood - session.observedAt > SESSION_STALE_MS)
		meta.push(`stale ${staleAge(lastGood - session.observedAt)}`)
	return meta
}

export interface PopoverRect {
	top: number
	left: number
	width: number
	height: number
}

export interface TerminalMetrics {
	/** Viewport y of the terminal pane's top/bottom edges. */
	top: number
	bottom: number
	/** Viewport y where xterm's rows start/end (inside the well padding). */
	screenTop: number
	screenBottom: number
	/** One xterm row in px. */
	rowHeight: number
	/** Viewport y of the top of the row holding xterm's drawn cursor (the live prompt), if any. */
	cursorTop?: number | null
}

/** Terminal rows the popover always leaves visible next to the dock and at the input line. */
export const POPOVER_KEEP_ROWS = 4
export const POPOVER_MAX_WIDTH = 640
export const POPOVER_MAX_HEIGHT = 560
/** Head + footer + a little body: below this the popover may cover more (never the input line). */
export const POPOVER_MIN_HEIGHT = 120
const POPOVER_GAP = 8
const POPOVER_INSET = 16

export interface PopoverPlacement {
	/** Dock-relative CSS: `bottom` for a bottom dock (opens upward), `top` for a top dock. */
	left: number
	width: number
	top?: number
	bottom?: number
	maxHeight: number
	/** xterm row height when measured: the popover rounds its height up to whole rows so its free edge lands on the grid too. */
	rowHeight: number | null
}

interface Band {
	top: number
	bottom: number
}

const bandHeight = (band: Band): number => band.bottom - band.top

/**
 * Where the detail popover goes, in the dock's coordinate space. It floats over the
 * terminal but never covers the last POPOVER_KEEP_ROWS rows (the input line), the
 * cursor's row ±1 when the prompt sits higher up (after `clear`, a mid-screen TUI)
 * and, on a top dock, the rows next to the dock. Its edges snap to xterm's row grid
 * so no row is half hidden; its height is capped and the content scrolls inside.
 * When fewer than POPOVER_MIN_HEIGHT px are left it first gives up the cursor band,
 * then the rows next to a top dock / the space above the terminal, never the input
 * line. Without terminal metrics it hugs the dock.
 */
export function popoverPlacement({
	position,
	dock,
	anchor,
	terminal,
	viewportHeight,
}: {
	position: AgentDockPosition
	dock: PopoverRect
	anchor: { left: number; width: number }
	terminal: TerminalMetrics | null
	viewportHeight: number
}): PopoverPlacement {
	const width = Math.max(0, Math.min(POPOVER_MAX_WIDTH, dock.width - POPOVER_INSET * 2))
	const left = Math.max(POPOVER_INSET, Math.min(anchor.left - dock.left, dock.width - POPOVER_INSET - width))
	const dockBottom = dock.top + dock.height
	let band: Band
	if (!terminal)
		band =
			position === 'bottom'
				? { top: POPOVER_GAP, bottom: dock.top - POPOVER_GAP }
				: { top: dockBottom + POPOVER_GAP, bottom: viewportHeight - POPOVER_GAP }
	else {
		const row = Math.max(1, terminal.rowHeight)
		const origin = terminal.screenTop
		// Row boundaries at or above / at or below y (the gap lands inside a row that then stays whole).
		const snapUp = (y: number) => origin + Math.floor((y - origin) / row + 1e-6) * row
		const snapDown = (y: number) => origin + Math.ceil((y - origin) / row - 1e-6) * row
		const keep = POPOVER_KEEP_ROWS * row
		const input = snapUp(Math.min(terminal.screenBottom, terminal.bottom) - keep - POPOVER_GAP)
		const nearDock =
			position === 'top' ? snapDown(Math.max(terminal.screenTop, terminal.top) + keep + POPOVER_GAP) : null
		const base: Band = {
			top: nearDock ?? snapDown(terminal.top + POPOVER_GAP),
			bottom: position === 'bottom' ? Math.min(input, dock.top - POPOVER_GAP) : input,
		}
		band = base
		const cursor = terminal.cursorTop
		if (typeof cursor === 'number' && cursor - row < base.bottom && cursor + 2 * row > base.top) {
			const above = { top: base.top, bottom: Math.min(base.bottom, snapUp(cursor - row - POPOVER_GAP)) }
			const below = { top: Math.max(base.top, snapDown(cursor + 2 * row + POPOVER_GAP)), bottom: base.bottom }
			const best = bandHeight(above) >= bandHeight(below) ? above : below
			if (bandHeight(best) >= POPOVER_MIN_HEIGHT) band = best
		}
		if (bandHeight(band) < POPOVER_MIN_HEIGHT) {
			const need = Math.ceil(POPOVER_MIN_HEIGHT / row) * row
			band = {
				top:
					position === 'bottom'
						? Math.max(POPOVER_GAP, Math.min(base.top, base.bottom - need))
						: Math.max(dockBottom + POPOVER_GAP, Math.min(base.top, base.bottom - need)),
				bottom: base.bottom,
			}
		}
	}
	const capped = Math.max(0, Math.min(POPOVER_MAX_HEIGHT, bandHeight(band)))
	const rowHeight = terminal ? Math.max(1, terminal.rowHeight) : null
	// Whole rows only, so a capped popover's far edge also sits on a row boundary.
	const maxHeight = rowHeight ? Math.floor(capped / rowHeight + 1e-6) * rowHeight : capped
	return position === 'bottom'
		? { left, width, bottom: dockBottom - band.bottom, maxHeight, rowHeight }
		: { left, width, top: band.top - dock.top, maxHeight, rowHeight }
}
