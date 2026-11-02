// Pure agent-dock presentation helpers: snapshot → strip/panel facts. No DOM,
// no runtime import of the zod model (types only), so the renderer bundle stays
// zod-free. Agent text is untrusted: every string that reaches the DOM passes
// through plainAgentText and renders as React text, never markup.

import type { AgentDockSnapshot, DockAction, DockItem, DockReceipt, DockSession } from '../../agent-dock/model'

export { alwaysAllowLabels, permissionReview, planReview } from '../../agent-dock/review'

export type AgentDockPosition = 'top' | 'bottom'
export type AgingTone = 'none' | 'warn' | 'danger'

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

/** An entry whose dock answer just landed (or was refused) stays this long, so its receipt can be read. */
export const RECEIPT_LINGER_MS = 6_000

/** Resolved items that carry a dock receipt and closed less than RECEIPT_LINGER_MS ago. */
export function lingeringItems(snapshot: AgentDockSnapshot | null, now: number): DockItem[] {
	return (
		snapshot?.items.filter(
			item =>
				item.state === 'resolved' &&
				item.resolution !== undefined &&
				// Jakub dismissed it himself (ack): no need to show it again.
				item.resolution.by !== 'acked' &&
				now - item.resolution.at < RECEIPT_LINGER_MS &&
				receiptView(item) !== null,
		) ?? []
	)
}

/** Entries in queue order: everything that needs Jakub, then answers still showing their receipt. */
export function railItems(snapshot: AgentDockSnapshot | null, now: number): DockItem[] {
	const lingering = lingeringItems(snapshot, now)
	return [...needsYouItems(snapshot), ...lingering.sort((a, b) => a.id - b.id)]
}

/** When the next lingering entry leaves the queue (ms), or null. */
export function nextLingerExpiry(snapshot: AgentDockSnapshot | null, now: number): number | null {
	const ends = lingeringItems(snapshot, now).map(item => (item.resolution?.at ?? now) + RECEIPT_LINGER_MS)
	return ends.length > 0 ? Math.min(...ends) : null
}

/** Mirrors model.ts DOCK_RISKY_PROMPT (the renderer may not value-import the zod model); a test keeps them equal. */
export const RISKY_PROMPT = /deploy|prod|secret|push|merge/i

/** The first risky word in a reply ("deploy"), or null. */
export function riskyWord(text: string): string | null {
	return RISKY_PROMPT.exec(text)?.[0]?.toLowerCase() ?? null
}

export type ReceiptTone = 'neutral' | 'warn' | 'success' | 'danger'

export interface ReceiptView {
	text: string
	tone: ReceiptTone
	/** Still in flight (Sending…). */
	busy: boolean
}

const REFUSED_GONE = 'refused: already answered elsewhere'

function doneText(item: DockItem, receipt: DockReceipt): string {
	const plan = item.fact.kind === 'ask' && item.fact.tool === 'ExitPlanMode'
	switch (receipt.action) {
		case 'allow':
			return plan ? '✓ approved' : receipt.always ? '✓ always allowed' : '✓ allowed'
		case 'deny':
			return plan ? '✓ sent back to planning' : '✓ denied'
		// A reply is not an answer; "sent" would read like "sent, unconfirmed".
		case 'prompt':
			return '✓ replied'
		default:
			return '✓ answered'
	}
}

const deliveryNote = (receipt: DockReceipt): string =>
	receipt.delivery === 'queued' ? ' (queued until the agent is free)' : ''

/**
 * The receipt line for an entry/pane, from main's snapshot only: Sending… →
 * ✓ answered (observed) / sent, unconfirmed (amber after 10 s) / refused / the
 * verbatim error. Null when Jakub has not answered this item from the dock.
 */
export function receiptView(item: DockItem): ReceiptView | null {
	const receipt = item.receipt
	if (!receipt) return null
	if (item.state === 'resolved' && item.resolution?.by === 'dock')
		return { text: doneText(item, receipt), tone: 'success', busy: false }
	if (receipt.status === 'refused')
		return {
			text: receipt.reason === 'gone' ? REFUSED_GONE : `refused: ${plainAgentLine(receipt.detail ?? '', 200)}`,
			tone: 'danger',
			busy: false,
		}
	if (receipt.status === 'failed')
		return { text: plainAgentLine(receipt.detail ?? 'failed', 300) || 'failed', tone: 'danger', busy: false }
	if (item.state === 'resolved') return null
	if (item.state === 'sending') return { text: `Sending…${deliveryNote(receipt)}`, tone: 'neutral', busy: true }
	if (item.state === 'unconfirmed' || receipt.status === 'unconfirmed')
		return { text: `sent, unconfirmed${deliveryNote(receipt)}`, tone: 'warn', busy: false }
	return null
}

/**
 * What Jakub sent, in words, for the pane's receipt (`✓ answered · Blue, M`, `✓ denied · use the
 * staging bucket`): the picked option labels and Other text, or the deny message. Null when the
 * act says nothing beyond its receipt (allow, approve, a reply that stays in its field).
 */
export function sentSummary(item: DockItem, action: DockAction): string | null {
	if (action.type === 'deny') return action.message ? plainAgentLine(action.message, 80) || null : null
	if (action.type !== 'answer' || item.fact.kind !== 'ask') return null
	const questions = askQuestions(item.fact.input) ?? []
	const parts = action.picks.flatMap((pick, at) => [
		...pick.options.flatMap(raw => {
			const option = questions[at]?.options.find(entry => entry.index === raw)
			return option ? [option.label] : []
		}),
		...(pick.other?.trim() ? [`“${pick.other.trim()}”`] : []),
	])
	return parts.length > 0 ? plainAgentLine(parts.join(', '), 80) || null : null
}

/** Answer controls are live only for an open item while Okena is reachable. */
export function canAnswer(item: DockItem, snapshot: AgentDockSnapshot | null): boolean {
	return item.state === 'open' && snapshot?.source.state === 'ok'
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
	/** Position in Claude's raw `options` (what main indexes); malformed options are skipped, so it may differ from the shown number. */
	index: number
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
		for (const [index, option] of (Array.isArray(raw.options) ? raw.options.slice(0, 32) : []).entries()) {
			// Main refuses these indexes too (no label to send): never offer them.
			if (!isRecord(option) || typeof option.label !== 'string' || option.label === '') continue
			options.push({
				index,
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
		const rest = questions.length - 1
		const more = rest > 0 ? ` · ${rest} more question${rest === 1 ? '' : 's'}` : ''
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
			return 'agent moved on'
		case 'session_ended':
			return 'session ended'
		case 'acked':
			return 'acked'
		case 'dock':
			return 'answered from the dock'
		default:
			return 'resolved'
	}
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
	/** The newest item, read like its entry: name (bright), project (dim), then the gist. */
	head: { name: string; project: string; gist: string } | null
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
		head: newest
			? { ...sessionWhere(findSession(snapshot, newest.session), newest.session), gist: cardGist(newest) }
			: null,
		counts: counts || null,
		health,
	}
}

// ---------------------------------------------------------------------------
// Queue (design §3.24): entries, glyphs, density, stable order.
// ---------------------------------------------------------------------------

/** Entry tone: amber ask, red ask past 2h, amber orphan, blue unchecked turn, green answered from the dock, quiet closed elsewhere. */
export type CardTone = 'ask' | 'ask-danger' | 'orphaned' | 'turn' | 'done' | 'closed'

/** Answered from the dock (the only resolution that earns the green ✓). */
const answeredHere = (item: DockItem): boolean => item.state === 'resolved' && item.resolution?.by === 'dock'

export function cardTone(item: DockItem, now: number): CardTone {
	if (item.state === 'resolved') return answeredHere(item) ? 'done' : 'closed'
	if (item.state === 'orphaned') return 'orphaned'
	if (item.kind === 'turn') return 'turn'
	return agingTone(now - itemWaitingSince(item)) === 'danger' ? 'ask-danger' : 'ask'
}

/** Item age tone; unchecked turns cap at warn (only blocking asks go red), as on the strip. An answer on its way or landed no longer ages. */
export function itemAgeTone(item: DockItem, now: number): AgingTone {
	if (item.state === 'resolved' || item.state === 'sending') return 'none'
	const tone = agingTone(now - itemWaitingSince(item))
	return item.kind === 'turn' && tone === 'danger' ? 'warn' : tone
}

/** Short kind for entries and the pane's titled rule: Question / Plan / Permission / Turn ended / Orphaned …. */
export function cardKindLabel(item: DockItem): string {
	if (item.fact.kind === 'turn') return 'Turn ended'
	const base =
		item.fact.tool === 'AskUserQuestion' ? 'Question' : item.fact.tool === 'ExitPlanMode' ? 'Plan' : 'Permission'
	return item.state === 'orphaned' ? `Orphaned ${base.toLowerCase()}` : base
}

/**
 * "asked 14:50" / "finished 14:50" plus the wait in words, for the pane's titled rule.
 * Once an answer is on its way or the item closed, the wait stops: "sending" /
 * "answered 16:41" (from the dock) / "closed 16:41" (anywhere else).
 */
export function itemTimeLine(item: DockItem, now: number): { stamp: string; waited: string } {
	const since = itemWaitingSince(item)
	const stamp = `${item.kind === 'turn' ? 'finished' : 'asked'} ${formatClock(since)}`
	if (item.state === 'sending') return { stamp, waited: 'sending' }
	if (item.state === 'resolved')
		return {
			stamp,
			waited: `${answeredHere(item) ? 'answered' : 'closed'} ${formatClock(item.resolution?.at ?? now)}`,
		}
	return { stamp, waited: `${item.kind === 'turn' ? 'idle' : 'waiting'} ${formatAge(now - since)}` }
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

/** Entry gist: the question, the plan's title, the command, or the turn's last paragraph. */
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

/** Project and agent name kept apart so entries can ellipsize the project before the name. */
export function sessionWhere(session: DockSession | undefined, key: string): { project: string; name: string } {
	if (!session) return { project: '', name: `terminal ${plainAgentLine(key.slice(key.lastIndexOf(':') + 1), 8)}` }
	return { project: plainAgentLine(session.project, 48), name: plainAgentLine(session.name, 64) }
}

/**
 * When the agent's current status began, for its age: a waiting agent counts from its
 * oldest open ask (the same clock as its queue entry), everything else from `since`.
 */
export function sessionSince(snapshot: AgentDockSnapshot | null, session: DockSession): number {
	if (session.status !== 'waiting') return session.since
	const asks = (snapshot?.items ?? []).filter(
		item => item.session === session.key && item.kind === 'ask' && item.state === 'open',
	)
	return asks.length > 0 ? Math.min(...asks.map(itemWaitingSince)) : session.since
}

/** Status words for an agent line: only what DockSession observed (status, since, subagents, queue). */
export function sessionStatusText(session: DockSession, now: number, since = session.since): string {
	const age = formatAge(now - since)
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

/** Agents for the Agents entry and pane: busy first, then waiting, idle, unknown; newest change first. */
export function orderedSessions(snapshot: AgentDockSnapshot | null): DockSession[] {
	return [...(snapshot?.sessions ?? [])].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.since - a.since,
	)
}

/** Kind glyph: what the agent wants, in one terminal character (all in Menlo; tone carries urgency). */
export function kindGlyph(item: DockItem): string {
	if (answeredHere(item)) return '✓'
	if (item.fact.kind === 'turn') return '↵'
	if (item.fact.tool === 'AskUserQuestion') return '?'
	if (item.fact.tool === 'ExitPlanMode') return '≡'
	return '$'
}

/** Agent status glyph for the Agents entry and pane (all in Menlo). */
export function statusGlyph(status: DockSession['status']): string {
	switch (status) {
		case 'working':
			return '✻'
		case 'background':
			return '◐'
		case 'waiting':
			return '?'
		case 'idle':
			return '·'
		case 'unknown':
			return '¿'
		default:
			return '▪'
	}
}

/**
 * Queue order while a pane is open: entries already shown keep their slot (an
 * answered item does not jump behind the open ones while its receipt shows), new
 * ones join at the end. An entry that left the queue meanwhile (its receipt's
 * linger ran out, it was answered in the terminal) stays in its slot from `held`
 * — the snapshot's items — until the pane closes, so nothing shifts and the open
 * pane never closes by itself; only what Jakub acked, or what the snapshot no
 * longer has at all, leaves. `order` null = the snapshot's own order.
 */
export function keepOrder(
	order: readonly number[] | null,
	items: readonly DockItem[],
	held: readonly DockItem[] = [],
): DockItem[] {
	if (!order) return [...items]
	const byId = new Map(items.map(item => [item.id, item]))
	const heldById = new Map(held.map(item => [item.id, item]))
	const kept = order.flatMap(id => {
		const item = byId.get(id) ?? heldById.get(id)
		return item && item.resolution?.by !== 'acked' ? [item] : []
	})
	const known = new Set(order)
	return [...kept, ...items.filter(item => !known.has(item.id))]
}

export type QueueDensity = 'full' | 'compact' | 'dense'
/** Where the Agents entry sits: a wide column beside the entries, a narrow one, or the grid's last cell. */
export type QueueAgentsSlot = 'side' | 'narrow' | 'cell'
/** Horizontal room around an entry's text: 12px padding each side, its 1px divider and 1px of slack. */
export const QUEUE_ENTRY_PAD = 26
/** The first entry lines its text up with the strip's 16px inset: 4px more on the left. */
export const QUEUE_FIRST_EXTRA = 4
/** Narrowest full entry: beside the wide Agents column the gist keeps a readable width. */
export const QUEUE_ENTRY_MIN = { side: 160, narrow: 112 } as const
/** Room the Agents column takes beside the entries. */
export const QUEUE_AGENTS_WIDTH = { side: 216, narrow: 96 } as const

export interface QueueLayout {
	density: QueueDensity
	columns: number
	agents: QueueAgentsSlot
}

/** Cells the wait takes in an entry's meta line ("2h16m"): a fixed budget so the layout never shifts as ages tick. */
export const QUEUE_AGE_CHARS = 5
/** Space around the wait in the meta line: the kind/age gap and the age's own left padding. */
export const QUEUE_META_GAP = 16

/** Cells an entry's meta line needs whole: the kind word and the wait. */
export const entryMetaChars = (item: DockItem): number => [...cardKindLabel(item)].length + QUEUE_AGE_CHARS

/**
 * Width an entry needs to show its agent name whole (kind glyph, a space, the name)
 * and its meta line whole (indent, kind, wait), plus padding.
 */
export const entryNameWidth = (nameChars: number, ch: number, metaChars = 0): number =>
	Math.max((nameChars + 2) * ch, metaChars > 0 ? (metaChars + 2) * ch + QUEUE_META_GAP : 0) + QUEUE_ENTRY_PAD

/**
 * Picks the queue form so every item stays in view (never paged or scrolled away)
 * and every agent name stays whole as long as possible: one row of full entries
 * (name / kind · project · age / gist) beside the wide Agents column, then beside
 * its narrow form; else two rows of compact entries (name / kind · age) with the
 * Agents entry as the last cell; else three rows of one-line chips, the only form
 * where a name may ellipsize. `nameChars` are the agent names' lengths in cells,
 * `metaChars` the meta lines' (kind + wait, see entryMetaChars) so the wait is never
 * pushed out of a full or compact entry, `ch` one monospace cell in px, `width` the
 * queue's content width.
 */
export function queueLayout(
	nameChars: readonly number[],
	width: number,
	ch: number,
	metaChars: readonly number[] = [],
): QueueLayout {
	const count = nameChars.length
	const needs = nameChars.map((chars, at) => entryNameWidth(chars, ch, metaChars[at] ?? 0))
	const widest = Math.max(0, ...needs)
	for (const agents of ['side', 'narrow'] as const) {
		const total =
			needs.reduce((sum, need) => sum + Math.max(need, QUEUE_ENTRY_MIN[agents]), 0) +
			(count > 0 ? QUEUE_FIRST_EXTRA : 0)
		if (total <= width - QUEUE_AGENTS_WIDTH[agents]) return { density: 'full', columns: Math.max(1, count), agents }
	}
	const two = Math.ceil((count + 1) / 2)
	if (widest + QUEUE_FIRST_EXTRA <= width / two) return { density: 'compact', columns: two, agents: 'cell' }
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
