// Pure agent-dock presentation helpers: snapshot → queue row/pane facts. No DOM,
// no runtime import of the zod model (types only), so the renderer bundle stays
// zod-free. Agent text is untrusted: every string that reaches the DOM passes
// through plainAgentText and renders as React text, never markup.

import type {
	AgentDockSnapshot,
	AgentDockSourceHealth,
	DockAction,
	DockItem,
	DockReceipt,
	DockSession,
	DockSourceId,
} from '../../agent-dock/model'

import { planApproveMode } from '../../agent-dock/review'

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

/** One-line variant for header context and row titles. */
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
 * What approving this plan from the dock also does, in words, or null (not a plan, or a source whose
 * answer cannot switch modes — Okena). The plan choice's description and the approved receipt's detail
 * (`✓ approved · accept edits on`) say it; the queue entry keeps its short receipt.
 */
export function planApproveModeText(item: DockItem, source: DockSourceId | undefined): string | null {
	if (item.fact.kind !== 'ask' || item.fact.tool !== 'ExitPlanMode') return null
	return planApproveMode(source ?? 'okena') === 'acceptEdits' ? 'accept edits on' : null
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

// ---------------------------------------------------------------------------
// Sources (Okena Claude Remote, Helm's own Claude hub for Helm terminals)
// ---------------------------------------------------------------------------

/** Words for a source (mirrors model.ts DOCK_SOURCE_LABEL; the renderer imports model types only). */
export const SOURCE_LABEL: Record<DockSourceId, string> = { okena: 'Okena', helm: 'Helm terminals' }
const SOURCE_ORDER: DockSourceId[] = ['okena', 'helm']

/** Sources in the snapshot with their health; an older snapshot without `sources` is Okena alone. */
/** Each source's own health in display order (an old single-source snapshot reads as Okena). */
export function snapshotSources(snapshot: AgentDockSnapshot): Array<[DockSourceId, AgentDockSourceHealth]> {
	const sources = snapshot.sources
	if (!sources || Object.keys(sources).length === 0) return [['okena', snapshot.source]]
	return SOURCE_ORDER.flatMap(id => {
		const health = sources[id]
		return health ? [[id, health] as [DockSourceId, AgentDockSourceHealth]] : []
	})
}

/** "Okena", "Helm terminals", "Okena and Helm terminals" for the sources in `state` (all sources when none is). */
export function sourceNames(snapshot: AgentDockSnapshot | null, state?: AgentDockSourceHealth['state']): string {
	const all = snapshot ? snapshotSources(snapshot) : []
	const names = all
		.filter(([, health]) => state === undefined || health.state === state)
		.map(([id]) => SOURCE_LABEL[id])
	const list = names.length > 0 ? names : all.length > 0 ? all.map(([id]) => SOURCE_LABEL[id]) : [SOURCE_LABEL.okena]
	return list.length === 1 ? (list[0] as string) : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** The Agents entry's words with no session listed ("…Okena's Claude Remote" when Okena is the only source). */
export function noSessionText(snapshot: AgentDockSnapshot | null): string {
	const names = sourceNames(snapshot)
	return names === 'Okena'
		? "No Claude session is connected to Okena's Claude Remote"
		: `No Claude session is connected to ${names}`
}

/** The health of the source that observes this item's session (answering is gated on it). */
/** True once at least one source has answered: the queue can show what it knows while another source connects. */
export function anySourceOk(snapshot: AgentDockSnapshot | null): boolean {
	return snapshot !== null && snapshotSources(snapshot).some(([, health]) => health.state === 'ok')
}

export function itemSourceHealth(item: DockItem, snapshot: AgentDockSnapshot | null): AgentDockSourceHealth | null {
	if (!snapshot) return null
	const source = findSession(snapshot, item.session)?.source ?? 'okena'
	return snapshot.sources?.[source] ?? (source === 'okena' ? snapshot.source : null)
}

/** Why the item cannot be answered here because its source is down, or null. */
export function sourceBlockedNote(item: DockItem, snapshot: AgentDockSnapshot | null): string | null {
	const health = itemSourceHealth(item, snapshot)
	if (!snapshot || health?.state === 'ok') return null
	const source = findSession(snapshot, item.session)?.source ?? 'okena'
	return `${SOURCE_LABEL[source]} unreachable: answer in the terminal`
}

/** Answer controls are live only for an open item while its source is reachable. */
export function canAnswer(item: DockItem, snapshot: AgentDockSnapshot | null): boolean {
	return item.state === 'open' && itemSourceHealth(item, snapshot)?.state === 'ok'
}

export function recentItems(snapshot: AgentDockSnapshot | null, limit: number): DockItem[] {
	return (snapshot?.items.filter(item => item.state === 'resolved') ?? []).slice(0, limit)
}

export function findSession(snapshot: AgentDockSnapshot | null, key: string): DockSession | undefined {
	return snapshot?.sessions.find(session => session.key === key)
}

// ---------------------------------------------------------------------------
// Agent names (design §3.24 "Names"): one short name per agent, used everywhere.
// ---------------------------------------------------------------------------

/** Conventional branch-type prefixes the short name drops (`fix/company-create-save-firm` → `company-create-save-firm`). */
const BRANCH_TYPE_PREFIX = /^(?:fix|feat|chore|refactor|docs|test|perf|build|ci|style|wip|hotfix|release)\//
/** Branches that say nothing about the work in them: the agent keeps its terminal name instead. */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk'])

/** A branch without its leading type prefix; '' when nothing identifying is left (no branch, a default branch, a bare prefix). */
export function branchShortName(branch: unknown): string {
	const line = plainAgentLine(branch, 120)
	if (DEFAULT_BRANCHES.has(line)) return ''
	return line.replace(BRANCH_TYPE_PREFIX, '')
}

const terminalName = (key: string): string => `terminal ${plainAgentLine(key.slice(key.lastIndexOf(':') + 1), 8)}`

/** The name before duplicates are numbered: the short branch, else Okena's pane name, else the terminal. */
function baseAgentName(session: DockSession): string {
	return branchShortName(session.branch) || plainAgentLine(session.name, 64) || terminalName(session.key)
}

/**
 * Short agent names by session key. Agents that would share a name (two sessions on one branch)
 * are numbered in a stable order (by session key): `company-create-save-firm`, `… #2`, `… #3`.
 */
export function agentNames(sessions: readonly DockSession[]): Map<string, string> {
	const names = new Map<string, string>()
	const seen = new Map<string, number>()
	const ordered = [...sessions].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
	for (const session of ordered) {
		const base = baseAgentName(session)
		const count = (seen.get(base) ?? 0) + 1
		seen.set(base, count)
		names.set(session.key, count === 1 ? base : `${base} #${count}`)
	}
	return names
}

export interface AgentWho {
	/** The short name (`company-create-save-firm #2`): queue, Agents table, labels, announcements. */
	name: string
	/** Okena's full pane name (often the task title); a tooltip and the pane's dim context line, never the queue. '' when it adds nothing. */
	title: string
	project: string
}

/** Who an item or agent is, by session key; an unknown key reads as its terminal. */
export function agentWho(snapshot: AgentDockSnapshot | null, key: string): AgentWho {
	const session = findSession(snapshot, key)
	if (!session) return { name: terminalName(key), title: '', project: '' }
	const name = agentNames(snapshot?.sessions ?? []).get(key) ?? baseAgentName(session)
	const full = plainAgentLine(session.name, 200)
	return { name, title: full && full !== name ? full : '', project: plainAgentLine(session.project, 48) }
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
	if (!snapshot || snapshot.source.state === 'pending')
		return { tone: 'neutral', text: `${sourceNames(snapshot, 'pending')} connecting…` }
	if (snapshot.source.state === 'down')
		return {
			tone: 'danger',
			text: `${sourceNames(snapshot, 'down')} unreachable since ${formatClock(snapshot.source.since)}`,
		}
	return {
		tone: 'success',
		text: snapshotSources(snapshot)
			.map(([id]) => SOURCE_LABEL[id])
			.join(' · '),
	}
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
	const unknown = unknownSessionCount(snapshot)
	let needsText: string
	if (needs.length > 0)
		needsText = `${needs.length} need${needs.length === 1 ? 's' : ''} you${unknown > 0 ? ` · ${unknown} unknown` : ''}`
	else if (unknown > 0) needsText = unknownAgentsText(unknown)
	else if (source === 'ok') needsText = 'Nothing needs you'
	else if (source === 'down') needsText = 'State unknown'
	else needsText = `Waiting for ${sourceNames(snapshot, 'pending')}`
	return {
		needCount: needs.length,
		unknownCount: unknown,
		needsText,
		needsTone: needs.length > 0 || unknown > 0 ? 'warn' : 'none',
		oldestText: oldest === null ? null : `oldest ${formatAge(now - oldest)}`,
		oldestTone,
		health,
	}
}

// ---------------------------------------------------------------------------
// Queue (design §3.24): entries, glyphs, density, stable order.
// ---------------------------------------------------------------------------

/**
 * Kind tone for the glyph: amber ask and orphan, blue unchecked turn, green answered from the dock,
 * quiet closed elsewhere. It never ages: how long it has waited is the age text's tone alone.
 */
export type CardTone = 'ask' | 'orphaned' | 'turn' | 'done' | 'closed'

/** Answered from the dock (the only resolution that earns the green ✓). */
const answeredHere = (item: DockItem): boolean => item.state === 'resolved' && item.resolution?.by === 'dock'

export function cardTone(item: DockItem): CardTone {
	if (item.state === 'resolved') return answeredHere(item) ? 'done' : 'closed'
	if (item.state === 'orphaned') return 'orphaned'
	return item.kind === 'turn' ? 'turn' : 'ask'
}

/** Item age tone; unchecked turns cap at warn (only blocking asks go red), as in the summary. An answer on its way or landed no longer ages. */
export function itemAgeTone(item: DockItem, now: number): AgingTone {
	if (item.state === 'resolved' || item.state === 'sending') return 'none'
	const tone = agingTone(now - itemWaitingSince(item))
	return item.kind === 'turn' && tone === 'danger' ? 'warn' : tone
}

/** Short kind for entries and the pane header: Question / Plan / Permission / Turn ended / Orphaned …. */
export function cardKindLabel(item: DockItem): string {
	if (item.fact.kind === 'turn') return 'Turn ended'
	const base =
		item.fact.tool === 'AskUserQuestion' ? 'Question' : item.fact.tool === 'ExitPlanMode' ? 'Plan' : 'Permission'
	return item.state === 'orphaned' ? `Orphaned ${base.toLowerCase()}` : base
}

/**
 * "asked 14:50" / "finished 14:50" (the header's tooltip) plus the wait in words (the header itself).
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

/** Room around an entry's text: 16px padding each side (the fill runs edge to edge). */
export const QUEUE_ENTRY_PAD = 32
/** The kind glyph's fixed box (`.agent-dock-glyph`): glyphs differ in width in the UI face. */
export const QUEUE_GLYPH = 12
/** Space after the glyph and after the name on an entry's line (`.agent-dock-entry-line` gap). */
export const QUEUE_LINE_GAP = 6
/** Everything in an entry besides its two texts (name, then wait or receipt). */
export const QUEUE_ENTRY_CHROME = QUEUE_ENTRY_PAD + QUEUE_GLYPH + 2 * QUEUE_LINE_GAP
/** Most cells a name gets in the queue; a longer one is shortened in the middle (`shortenName`). */
export const QUEUE_NAME_MAX = 28
/** Least cells names are shortened to, all alike, before single entries squeeze further. */
export const QUEUE_NAME_MIN = 16
/** Least cells a squeezed name keeps (the wait beside it stays whole) before any go behind "+N more". */
export const QUEUE_NAME_FLOOR = 4

/** Width in px of `text` set in the queue's own font (the renderer measures it in the DOM). */
export type TextWidth = (text: string) => number

/**
 * A name cut in the middle to `max` cells, keeping its start, its end and a twin's ` #N`
 * (`company-create-save-firm #2` → `company-create-…-firm #2`); unchanged when it fits. The kept end
 * is whole words (from a `-`, `_`, `/` or `.`) when one fits a third of the room.
 */
export function shortenName(name: string, max: number): string {
	const chars = [...name]
	if (chars.length <= max) return name
	const suffix = /\s#\d+$/.exec(name)?.[0] ?? ''
	const body = chars.slice(0, chars.length - suffix.length)
	const room = max - suffix.length - 1
	if (room < 4) return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
	const budget = Math.floor(room / 3)
	let tail = budget
	for (let at = body.length - 2; at >= body.length - budget - 1 && at > 0; at -= 1)
		if (/[-_/.]/.test(body[at] ?? '')) tail = body.length - at
	return `${body.slice(0, room - tail).join('')}…${body.slice(body.length - tail).join('')}${suffix}`
}

/** One queue entry's texts: the agent's short name and what follows it (the wait, or a receipt). */
export interface QueueEntryText {
	name: string
	tail: string
}

/**
 * Width of one entry with its name cut to `cap` cells: padding, glyph box, the name and its tail as
 * they really set (`measure`), rounded up to whole px so the text always fits and the selected fill
 * ends right after it.
 */
export const entryWidth = (entry: QueueEntryText, cap: number, measure: TextWidth): number =>
	Math.ceil(QUEUE_ENTRY_CHROME + measure(shortenName(entry.name, cap)) + measure(entry.tail))

/** Width of the "+N more" cell, sized for the longest count it could show so it never re-lays out the row. */
export const moreWidth = (count: number, measure: TextWidth): number =>
	Math.ceil(measure(`+${count} more`)) + QUEUE_ENTRY_PAD

export interface QueueSlot {
	/** Index into the entries. */
	index: number
	/** px (0 = not measured yet: the slot takes its natural width). */
	width: number
	/** The name as shown in this slot (`shortenName` of the whole one). */
	name: string
}

export interface QueueLayout {
	/** Entries in the row, in display order (queue order, except an open entry that had to move in). */
	slots: QueueSlot[]
	/** Entries behind the "+N more" cell, in queue order (empty: no cell). */
	hidden: number[]
	/** Width of the "+N more" cell, px. */
	more: number
}

/**
 * The one-row queue (never a second row, never a scroll), from real text widths. Names shorten first —
 * all alike, from QUEUE_NAME_MAX down to QUEUE_NAME_MIN cells, cut in the middle — then the widest
 * entry's name gives up a cell at a time down to QUEUE_NAME_FLOOR (its wait never cut), so every entry
 * shows when it can. Only past that do as many as fit show beside one "+N more" cell. The open entry
 * is always in the row: when it would be hidden it takes the last slot. Without a measure (not mounted
 * yet) or room, every entry shows at its natural width.
 */
export function queueLayout(
	entries: readonly QueueEntryText[],
	measure: TextWidth | null,
	room: number,
	open = -1,
): QueueLayout {
	const all = entries.map((_, index) => index)
	if (!measure || room <= 0)
		return { slots: all.map(index => ({ index, width: 0, name: entries[index]?.name ?? '' })), hidden: [], more: 0 }
	const nameAt = (index: number, cap: number) => shortenName(entries[index]?.name ?? '', cap)
	const widthAt = (index: number, cap: number) => entryWidth(entries[index] ?? { name: '', tail: '' }, cap, measure)
	const sized = (caps: readonly number[]) => all.map(index => widthAt(index, caps[index] ?? QUEUE_NAME_MAX))
	const span = (widths: readonly number[]) => widths.reduce((sum, width) => sum + width, 0)
	const row = (caps: readonly number[], widths: readonly number[]): QueueLayout => ({
		slots: all.map(index => ({ index, width: widths[index] ?? 0, name: nameAt(index, caps[index] ?? QUEUE_NAME_MAX) })),
		hidden: [],
		more: 0,
	})
	for (let cap = QUEUE_NAME_MAX; cap >= QUEUE_NAME_MIN; cap -= 1) {
		const caps = all.map(() => cap)
		const widths = sized(caps)
		if (span(widths) <= room) return row(caps, widths)
	}
	// Squeeze: the widest entry's name gives up a cell, again and again, none under QUEUE_NAME_FLOOR.
	const caps = all.map(index => Math.min(QUEUE_NAME_MIN, [...(entries[index]?.name ?? '')].length))
	const widths = sized(caps)
	while (span(widths) > room) {
		let widest = -1
		for (const index of all)
			if ((caps[index] ?? 0) > QUEUE_NAME_FLOOR && (widest < 0 || (widths[index] ?? 0) > (widths[widest] ?? 0)))
				widest = index
		if (widest < 0) break
		caps[widest] = (caps[widest] ?? QUEUE_NAME_FLOOR) - 1
		widths[widest] = widthAt(widest, caps[widest] ?? QUEUE_NAME_FLOOR)
	}
	if (span(widths) <= room) return row(caps, widths)
	const more = moreWidth(entries.length, measure)
	let cap = QUEUE_NAME_MIN
	let shownWidths = sized(all.map(() => cap))
	const fitting = (sizedWidths: readonly number[]) => {
		let count = 0
		while (count < sizedWidths.length && span(sizedWidths.slice(0, count + 1)) + more <= room) count += 1
		return count
	}
	const shown = fitting(shownWidths)
	// The names get back what room the entries beside "+N more" leave (the same count shows).
	for (let wider = QUEUE_NAME_MAX; wider > QUEUE_NAME_MIN; wider -= 1) {
		const widthsAt = sized(all.map(() => wider))
		if (fitting(widthsAt) < shown) continue
		cap = wider
		shownWidths = widthsAt
		break
	}
	let visible = all.slice(0, shown)
	if (open >= shown && open < entries.length) {
		// The open entry takes the last slot; drop more from the end until it fits.
		visible = [...visible.slice(0, Math.max(0, shown - 1)), open]
		while (visible.length > 1 && span(visible.map(index => shownWidths[index] ?? 0)) + more > room)
			visible = [...visible.slice(0, -2), open]
	}
	const inRow = new Set(visible)
	return {
		slots: visible.map(index => ({ index, width: shownWidths[index] ?? 0, name: nameAt(index, cap) })),
		hidden: all.filter(index => !inRow.has(index)),
		more,
	}
}

/** Facts for an agent row besides its status words: connection, subagents, queue, PRs, staleness. */
export function agentRowMeta(snapshot: AgentDockSnapshot, session: DockSession): string[] {
	const meta: string[] = []
	if (session.status !== 'unreachable' && session.status !== 'unknown' && !session.hooksAttached)
		meta.push('not connected')
	if (session.subagents > 0) meta.push(`${session.subagents} subagent${session.subagents === 1 ? '' : 's'}`)
	if (session.queuedPrompts > 0) meta.push(`queued ${session.queuedPrompts}`)
	for (const pr of session.prLinks.slice(0, 2)) meta.push(`PR #${pr.number}`)
	const lastGood = snapshot.sources?.[session.source ?? 'okena']?.lastObservedAt ?? snapshot.source.lastObservedAt
	if (lastGood !== null && session.status !== 'unreachable' && lastGood - session.observedAt > SESSION_STALE_MS)
		meta.push(`stale ${staleAge(lastGood - session.observedAt)}`)
	return meta
}
