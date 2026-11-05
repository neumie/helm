// Pure agent-dock presentation helpers: snapshot → queue row/pane facts. No DOM,
// no runtime import of the zod model (types only), so the renderer bundle stays
// zod-free. Agent text is untrusted: every string that reaches the DOM passes
// through plainAgentText and renders as React text, never markup.

import type {
	AgentDockActResult,
	AgentDockSnapshot,
	AgentDockSourceHealth,
	DockActOutcome,
	DockAction,
	DockItem,
	DockReceipt,
	DockSession,
	DockSourceId,
} from '../../agent-dock/model'

import { DOCK_SOURCE_IDS, DOCK_SOURCE_TEXT } from '../../../../src/agent-dock/dock-vocabulary.js'
import { itemWaitingSince } from '../../agent-dock/item-order'
import { alwaysAllowLabels, alwaysAllowRulesOnly, planApproveMode } from '../../agent-dock/review'

export { itemWaitingSince } from '../../agent-dock/item-order'
export { alwaysAllowLabels, permissionReview, planReview } from '../../agent-dock/review'

export type AgentDockPosition = 'top' | 'bottom'
export type AgingTone = 'none' | 'warn' | 'danger'

/** Aging escalation (design §2): amber after 30 minutes, red after 2 hours. */
export const AGING_WARN_MS = 30 * 60_000
export const AGING_DANGER_MS = 2 * 60 * 60_000
/** A session whose last detail read lags the last good /v1/state by this much renders stale. */
const SESSION_STALE_MS = 10_000
/** Bounds for agent text the dock renders (turn excerpts are already ≤2 KiB from the reducer). */
const AGENT_TEXT_MAX = 2_048
const TOOL_INPUT_TEXT_MAX = 4_096
const PREVIEW_TEXT_MAX = 2_048

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
export function queueItems(snapshot: AgentDockSnapshot | null, now: number): DockItem[] {
	const lingering = lingeringItems(snapshot, now)
	return [...needsYouItems(snapshot), ...lingering.sort((a, b) => a.id - b.id)]
}

/** When the next lingering entry leaves the queue (ms), or null. */
export function nextLingerExpiry(snapshot: AgentDockSnapshot | null, now: number): number | null {
	const ends = lingeringItems(snapshot, now).map(item => (item.resolution?.at ?? now) + RECEIPT_LINGER_MS)
	return ends.length > 0 ? Math.min(...ends) : null
}

export type ReceiptTone = 'neutral' | 'warn' | 'success' | 'danger'

export interface ReceiptView {
	text: string
	tone: ReceiptTone
}

const REFUSED_GONE = 'refused: already answered elsewhere'

/**
 * Words for an act main refused or could not run, kept on the pane when main did not record them on
 * the item (bad request, IPC failure); null for any other outcome.
 */
export function actErrorText(outcome: DockActOutcome): string | null {
	if (outcome.status === 'refused')
		return outcome.reason === 'gone' ? REFUSED_GONE : `refused: ${plainAgentText(outcome.detail, 200)}`
	if (outcome.status === 'failed') return plainAgentText(outcome.detail, 300)
	return null
}

/** An act that threw before main answered (IPC failure), as the result main would have sent. */
export function failedActResult(error: unknown): AgentDockActResult {
	return { ok: false, outcome: { status: 'failed', detail: error instanceof Error ? error.message : String(error) } }
}

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
		return { text: doneText(item, receipt), tone: 'success' }
	if (receipt.status === 'refused')
		return {
			text: receipt.reason === 'gone' ? REFUSED_GONE : `refused: ${plainAgentLine(receipt.detail ?? '', 200)}`,
			tone: 'danger',
		}
	if (receipt.status === 'failed')
		return { text: plainAgentLine(receipt.detail ?? 'failed', 300) || 'failed', tone: 'danger' }
	if (item.state === 'resolved') return null
	if (item.state === 'sending') return { text: `Sending…${deliveryNote(receipt)}`, tone: 'neutral' }
	if (item.state === 'unconfirmed' || receipt.status === 'unconfirmed')
		return { text: `sent, unconfirmed${deliveryNote(receipt)}`, tone: 'warn' }
	return null
}

/**
 * The "Always allow" choice's labels for this ask, for a session of `source` (null or [] = no such
 * choice). Helm terminals take rule suggestions only (review.ts alwaysAllowRulesOnly); main refuses
 * the same (act.ts).
 */
export function alwaysAllowChoice(item: DockItem, source: DockSourceId | undefined): string[] | null {
	if (item.fact.kind !== 'ask') return null
	return alwaysAllowLabels(item.fact.suggestions, item.fact.suggestionsTruncated === true, {
		rulesOnly: alwaysAllowRulesOnly(source ?? 'okena'),
	})
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

/** Each source's own health in display order (an old single-source snapshot reads as Okena). */
export function snapshotSources(snapshot: AgentDockSnapshot): Array<[DockSourceId, AgentDockSourceHealth]> {
	const sources = snapshot.sources
	if (!sources || Object.keys(sources).length === 0) return [['okena', snapshot.source]]
	return DOCK_SOURCE_IDS.flatMap(id => {
		const health = sources[id]
		return health ? [[id, health] as [DockSourceId, AgentDockSourceHealth]] : []
	})
}

/** "Okena", "Helm terminals", "Okena and Helm terminals" for the sources in `state` (all sources when none is). */
export function sourceNames(snapshot: AgentDockSnapshot | null, state?: AgentDockSourceHealth['state']): string {
	const all = snapshot ? snapshotSources(snapshot) : []
	const names = all
		.filter(([, health]) => state === undefined || health.state === state)
		.map(([id]) => DOCK_SOURCE_TEXT[id].label)
	const list =
		names.length > 0
			? names
			: all.length > 0
				? all.map(([id]) => DOCK_SOURCE_TEXT[id].label)
				: [DOCK_SOURCE_TEXT.okena.label]
	return list.length === 1 ? (list[0] as string) : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/** The Agents entry's words with no session listed ("…Okena's Claude Remote" when Okena is the only source). */
export function noSessionText(snapshot: AgentDockSnapshot | null): string {
	const names = sourceNames(snapshot)
	return names === 'Okena'
		? "No Claude session is connected to Okena's Claude Remote"
		: `No Claude session is connected to ${names}`
}

/** True once at least one source has answered: the queue can show what it knows while another source connects. */
export function anySourceOk(snapshot: AgentDockSnapshot | null): boolean {
	return snapshot !== null && snapshotSources(snapshot).some(([, health]) => health.state === 'ok')
}

/** The health of the source that observes this item's session (answering is gated on it). */
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
	return `${DOCK_SOURCE_TEXT[source].label} unreachable: answer in the terminal`
}

/** Answer controls are live only for an open item while its source is reachable. */
export function canAnswer(item: DockItem, snapshot: AgentDockSnapshot | null): boolean {
	return item.state === 'open' && itemSourceHealth(item, snapshot)?.state === 'ok'
}

/**
 * Ack is offered for turns, orphaned and unconfirmed items; never for a resolved item or one being
 * sent, so an open or sending ask is never ackable (the Ack button and ⌘⌫ alike).
 */
export function canAck(item: DockItem): boolean {
	return (
		item.state !== 'resolved' &&
		item.state !== 'sending' &&
		(item.kind === 'turn' || item.state === 'orphaned' || item.state === 'unconfirmed')
	)
}

/**
 * The item to move on to after Jakub acked or answered `handled` from the pane: the first one
 * after it in queue order (wrapping round to the front) that still waits on him (`open`). `at` is
 * where `handled` sits in `items`, or sat before an ack removed it. Undefined when nothing waits.
 */
export function nextWaiting(items: readonly DockItem[], handled: number, at: number): DockItem | undefined {
	const count = items.length
	const start = Math.max(0, at)
	for (let step = 0; step < count; step++) {
		const item = items[(start + step) % count]
		if (item && item.id !== handled && item.state === 'open') return item
	}
	return undefined
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
/** A detached HEAD: Okena reports the commit hash as the "branch" (`d1aee9df`), which says nothing about the work either. */
const COMMIT_HASH = /^[0-9a-f]{7,40}$/i

/** Says nothing about the work: no branch, a default branch, or a detached HEAD's commit hash. */
const anonymousBranch = (line: string): boolean => line === '' || DEFAULT_BRANCHES.has(line) || COMMIT_HASH.test(line)

/** A branch without its leading type prefix; '' when nothing identifying is left (no branch, a default branch, a commit hash, a bare prefix). */
export function branchShortName(branch: unknown): string {
	const line = plainAgentLine(branch, 120)
	if (anonymousBranch(line)) return ''
	return line.replace(BRANCH_TYPE_PREFIX, '')
}

const terminalName = (key: string): string => `terminal ${plainAgentLine(key.slice(key.lastIndexOf(':') + 1), 8)}`

/**
 * The repository an agent works in: Okena's parent project of a worktree (`repo`, `JVS`), else the
 * pane's own project (a main checkout, `Psyon`). '' when the reducer could not place the pane.
 */
export function agentRepo(session: DockSession): string {
	const repo = plainAgentLine(session.repo || session.project, 48)
	return repo === 'unknown project' ? '' : repo
}

/**
 * Okena's pane name, unless it is only an anonymous branch: Okena names an unnamed pane after its
 * project's branch (`d1aee9df`, `main`), which says nothing about the work.
 */
function paneName(session: DockSession): string {
	const name = plainAgentLine(session.name, 64)
	return anonymousBranch(name) ? '' : name
}

/**
 * The name before duplicates are numbered: the short branch, else Okena's pane name, else the
 * repository (a main checkout on a default branch or a detached HEAD reads `Psyon`), else the terminal.
 */
function baseAgentName(session: DockSession): string {
	return branchShortName(session.branch) || paneName(session) || agentRepo(session) || terminalName(session.key)
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
	/** Okena's full pane name (often the task title); a tooltip and the item header's dim task title, never the queue. '' when it adds nothing. */
	title: string
	/** The repository (`agentRepo`: `JVS` for a JVS worktree, never the worktree's branch-named project). */
	project: string
}

/** Who an item or agent is, by session key; an unknown key reads as its terminal. */
export function agentWho(snapshot: AgentDockSnapshot | null, key: string): AgentWho {
	const session = findSession(snapshot, key)
	if (!session) return { name: terminalName(key), title: '', project: '' }
	const name = agentNames(snapshot?.sessions ?? []).get(key) ?? baseAgentName(session)
	const full = paneName(session) ? plainAgentLine(session.name, 200) : ''
	return { name, title: full && full !== name ? full : '', project: agentRepo(session) }
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
function planText(input: unknown): string | null {
	return isRecord(input) && typeof input.plan === 'string' ? plainAgentText(input.plan, TOOL_INPUT_TEXT_MAX) : null
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

const unknownAgentsText = (count: number): string => `State unknown for ${count} agent${count === 1 ? '' : 's'}`

export interface AgentDockHealth {
	tone: 'success' | 'danger' | 'neutral'
	text: string
}

/** One source's health for the Agents pane header: its name, the dot's tone, the state in words. */
export interface SourceHealthView {
	id: DockSourceId
	name: string
	state: AgentDockSourceHealth['state']
	tone: AgentDockHealth['tone']
	/** `Okena connected`, `Okena unreachable since 16:20`, `Helm terminals connecting…`. */
	words: string
}

/**
 * Each source's health on its own (`snapshot.sources`, in DOCK_SOURCE_IDS order). A source the dock
 * never observed (not configured, e.g. no Helm hub) is not listed: the snapshot knows nothing of it,
 * and saying "not configured" would be a claim it cannot back. Before any snapshot: Okena connecting.
 */
export function sourceHealthViews(snapshot: AgentDockSnapshot | null): SourceHealthView[] {
	const entries: Array<[DockSourceId, AgentDockSourceHealth]> = snapshot
		? snapshotSources(snapshot)
		: [['okena', { state: 'pending', since: 0, lastObservedAt: null }]]
	return entries.map(([id, health]) => {
		const name = DOCK_SOURCE_TEXT[id].label
		if (health.state === 'ok') return { id, name, state: health.state, tone: 'success', words: `${name} connected` }
		if (health.state === 'down')
			return {
				id,
				name,
				state: health.state,
				tone: 'danger',
				words: `${name} unreachable since ${formatClock(health.since)}`,
			}
		return { id, name, state: health.state, tone: 'neutral', words: `${name} connecting…` }
	})
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
			.map(([id]) => DOCK_SOURCE_TEXT[id].label)
			.join(' · '),
	}
}

/**
 * The queue row's accessible name: what needs Jakub, how long the oldest has waited and the sources'
 * health, in words (`Agent dock, 3 need you, oldest 2h16m, Okena`). Never "all clear" unless the
 * source is reachable and every listed agent was read.
 */
export function dockLabel(snapshot: AgentDockSnapshot | null, now: number): string {
	const needs = needsYouItems(snapshot)
	const source = snapshot?.source.state ?? 'pending'
	const oldest = needs.reduce<number | null>((min, item) => {
		const since = itemWaitingSince(item)
		return min === null || since < min ? since : min
	}, null)
	const unknown = unknownSessionCount(snapshot)
	let needsText: string
	if (needs.length > 0)
		needsText = `${needs.length} need${needs.length === 1 ? 's' : ''} you${unknown > 0 ? ` · ${unknown} unknown` : ''}`
	else if (unknown > 0) needsText = unknownAgentsText(unknown)
	else if (source === 'ok') needsText = 'Nothing needs you'
	else if (source === 'down') needsText = 'State unknown'
	else needsText = `Waiting for ${sourceNames(snapshot, 'pending')}`
	const oldestText = oldest === null ? '' : `, oldest ${formatAge(now - oldest)}`
	return `Agent dock, ${needsText}${oldestText}, ${dockHealth(snapshot).text}`
}

// ---------------------------------------------------------------------------
// Queue (design §3.24): entries, glyphs, density, stable order.
// ---------------------------------------------------------------------------

/**
 * Kind tone for the glyph: amber ask and orphan, blue unchecked turn, green answered from the dock,
 * quiet closed elsewhere. It never ages: how long it has waited is the age text's tone alone.
 */
export type EntryTone = 'ask' | 'orphaned' | 'turn' | 'done' | 'closed'

/** Answered from the dock (the only resolution that earns the green ✓). */
const answeredHere = (item: DockItem): boolean => item.state === 'resolved' && item.resolution?.by === 'dock'

export function entryTone(item: DockItem): EntryTone {
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
export function itemKindLabel(item: DockItem): string {
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
function commandOf(input: unknown): string | null {
	return isRecord(input) && typeof input.command === 'string' ? plainAgentText(input.command, 1_024) : null
}

/** The part of a turn that is about Jakub: its last paragraph (questions and handoffs land there). */
function turnGist(text: string): string {
	const paragraphs = plainAgentText(text)
		.split(/\n\s*\n/)
		.map(part => part.trim())
		.filter(Boolean)
	return plainAgentLine(paragraphs.at(-1) ?? text, 220)
}

/** Entry gist: the question, the plan's title, the command, or the turn's last paragraph. */
export function entryGist(item: DockItem): string {
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

/** Agents busy right now (working, or with background work only): the Agents pane counts them. */
export const busyCount = (sessions: readonly DockSession[]): number =>
	sessions.filter(session => session.status === 'working' || session.status === 'background').length

/** The Agents entry's states in the pane's order: busy first, then waiting on Jakub, idle, unknown, frozen. */
const AGENTS_ENTRY_STATES: ReadonlyArray<[DockSession['status'], string]> = [
	['working', 'working'],
	['background', 'in background'],
	['waiting', 'waiting on you'],
	['idle', 'idle'],
	['unknown', 'unknown'],
	['unreachable', 'frozen'],
]

export interface AgentsEntryText {
	total: number
	/** One status per agent in the given order: the bar's segments. */
	marks: DockSession['status'][]
	/** The states in words: `3 agents: 2 working, 1 idle. Show agents`. */
	label: string
	/** One line per agent: its name and status words. */
	title: string
}

/**
 * The Agents entry (`3 agents` and a bar, one segment per agent, toned by status): its data, and its
 * states in words for the label. Only what DockSession observed: never invented activity.
 */
export function agentsEntryText(
	snapshot: AgentDockSnapshot,
	sessions: readonly DockSession[],
	now: number,
): AgentsEntryText {
	const total = sessions.length
	if (total === 0) {
		const none = noSessionText(snapshot)
		return { total, marks: [], label: `${none}. Show agents`, title: none }
	}
	const marks = sessions.map(session => session.status)
	const states = AGENTS_ENTRY_STATES.flatMap(([status, words]) => {
		const count = marks.filter(mark => mark === status).length
		return count > 0 ? [`${count} ${words}`] : []
	})
	return {
		total,
		marks,
		label: `${total} agent${total === 1 ? '' : 's'}: ${states.join(', ')}. Show agents`,
		title: sessions
			.map(
				session =>
					`${agentWho(snapshot, session.key).name}: ${sessionStatusText(session, now, sessionSince(snapshot, session))}`,
			)
			.join('\n'),
	}
}

/**
 * The empty queue's one line: never "Nothing needs you" unless every source is reachable and every
 * listed agent was read.
 */
export function emptyQueueText(snapshot: AgentDockSnapshot): string {
	const source = snapshot.source.state
	if (source === 'pending') return `Waiting for ${sourceNames(snapshot, 'pending')}`
	if (source !== 'ok') {
		const down = sourceNames(snapshot, 'down')
		return `${down} ${down === 'Okena' ? 'is' : 'are'} unreachable, so open questions cannot be seen`
	}
	const unknown = unknownSessionCount(snapshot)
	if (unknown > 0)
		return `${unknownAgentsText(unknown)}: ${sourceNames(snapshot)} did not return readable detail, so their open questions cannot be seen`
	return 'Nothing needs you'
}

/** Status words for an agent line, as its word and its age ('' for `frozen` / `unknown`): only what DockSession observed. */
export function sessionStatusParts(
	session: DockSession,
	now: number,
	since = session.since,
): { word: string; age: string } {
	switch (session.status) {
		case 'working':
		case 'background':
		case 'waiting':
		case 'idle':
			return { word: session.status, age: formatAge(now - since) }
		case 'unreachable':
			return { word: 'frozen', age: '' }
		default:
			return { word: 'unknown', age: '' }
	}
}

/** Status words for an agent line: only what DockSession observed (status, since). */
export function sessionStatusText(session: DockSession, now: number, since = session.since): string {
	const { word, age } = sessionStatusParts(session, now, since)
	return age ? `${word} ${age}` : word
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

/** Kind glyph: what the agent wants, in one character (its tone carries the kind). */
export function kindGlyph(item: DockItem): string {
	if (answeredHere(item)) return '✓'
	if (item.fact.kind === 'turn') return '↵'
	if (item.fact.tool === 'AskUserQuestion') return '?'
	if (item.fact.tool === 'ExitPlanMode') return '≡'
	return '$'
}

/** Agent status glyph for the Agents pane table. */
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
 * Queue order while a pane is open: entries still in the queue keep their order (an answered
 * item does not jump behind the open ones while its receipt shows), new ones join at the end.
 * Whatever no longer needs Jakub leaves at once, pane or not (answered or replied in the
 * terminal, the agent moved on, a receipt whose linger ran out) — except the entry open in
 * the pane: it stays in its slot from `open` (its snapshot copy, which shows how it closed)
 * until Jakub steps to another entry or closes the pane, so the pane never closes by itself
 * under his reading. Acked items and ones the snapshot no longer has always leave.
 * `order` null = the snapshot's own order.
 */
export function keepOrder(order: readonly number[] | null, items: readonly DockItem[], open?: DockItem): DockItem[] {
	if (!order) return [...items]
	const byId = new Map(items.map(item => [item.id, item]))
	const kept = order.flatMap(id => {
		const item = byId.get(id) ?? (open?.id === id ? open : undefined)
		return item && item.resolution?.by !== 'acked' ? [item] : []
	})
	const known = new Set(order)
	return [...kept, ...items.filter(item => !known.has(item.id))]
}

/** Room around an entry's text: the row's `--dock-inset` (16px) each side (the fill runs edge to edge). */
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

/** Background tasks in the row's words: `1 shell` / `2 shells` when all are shells, else `N background task(s)`. */
export function backgroundTasksText(session: Pick<DockSession, 'backgroundTasks' | 'backgroundShells'>): string {
	const count = session.backgroundTasks
	if (!(count > 0)) return ''
	return session.backgroundShells === count
		? `${count} shell${count === 1 ? '' : 's'}`
		: `${count} background task${count === 1 ? '' : 's'}`
}

/** Facts for an agent row besides its status words: connection, subagents, background tasks, queue, PRs, staleness. */
export function agentRowMeta(snapshot: AgentDockSnapshot, session: DockSession): string[] {
	const meta: string[] = []
	if (session.status !== 'unreachable' && session.status !== 'unknown' && !session.hooksAttached)
		meta.push('not connected')
	if (session.subagents > 0) meta.push(`${session.subagents} subagent${session.subagents === 1 ? '' : 's'}`)
	const background = backgroundTasksText(session)
	if (background) meta.push(background)
	if (session.queuedPrompts > 0) meta.push(`queued ${session.queuedPrompts}`)
	for (const pr of session.prLinks.slice(0, 2)) meta.push(`PR #${pr.number}`)
	const lastGood = snapshot.sources?.[session.source]?.lastObservedAt ?? snapshot.source.lastObservedAt
	if (lastGood !== null && session.status !== 'unreachable' && lastGood - session.observedAt > SESSION_STALE_MS)
		meta.push(`stale ${staleAge(lastGood - session.observedAt)}`)
	return meta
}

// ---------------------------------------------------------------------------
// Agents overview (design §3.24 Agents): every agent's state relative to Jakub.
// ---------------------------------------------------------------------------

/**
 * Where an agent stands with Jakub, most urgent first: an open ask (question, permission, plan),
 * an unchecked turn (reply waiting), Jakub's answer on its way (sending), then working, background
 * (subagents only), read (idle, its last message seen: acked, adopted, or replied to), idle (its last
 * message not seen yet, or none read), unknown (unreadable, frozen, not connected).
 */
export const AGENT_STANDINGS = [
	'needs-you',
	'reply-waiting',
	'sending',
	'working',
	'background',
	'read',
	'idle',
	'unknown',
] as const
export type AgentStanding = (typeof AGENT_STANDINGS)[number]

/** Group headings when the overview groups by standing (`by-state`). */
export const STANDING_HEADINGS: Record<AgentStanding, string> = {
	'needs-you': 'Needs you',
	'reply-waiting': 'Reply waiting',
	sending: 'Sending',
	working: 'Working',
	background: 'Background',
	read: 'Read',
	idle: 'Idle',
	unknown: 'Unknown',
}

export interface AgentStandingView {
	standing: AgentStanding
	/** The state in the row's words: `question`, `reply waiting`, `sent, unconfirmed`, `working`, `read`, `frozen`. */
	word: string
	/** The same for screen readers, with what it means for Jakub (`needs you: question`). */
	label: string
	/** Where its age counts from; null = no age (unknown, frozen). */
	since: number | null
	/** Waiting on Jakub ages like its queue entry (--warn past 30m, --danger past 2h; turns cap at warn). */
	tone: AgingTone
	glyph: string
	/** The glyph's color, by the queue's kind tones (`ask`, `orphaned`, `turn`) or the agent's status. */
	glyphTone: string
	/** The live item opening this agent shows (its most urgent one); undefined when it owes Jakub nothing. */
	item?: DockItem
}

const askWord = (item: DockItem): string =>
	item.fact.kind === 'ask'
		? item.fact.tool === 'AskUserQuestion'
			? 'question'
			: item.fact.tool === 'ExitPlanMode'
				? 'plan'
				: 'permission'
		: 'reply waiting'

/** An agent's state relative to Jakub, from the snapshot only (its items, status, last message, reply). */
export function agentStanding(
	snapshot: AgentDockSnapshot | null,
	session: DockSession,
	now: number,
): AgentStandingView {
	const live = (snapshot?.items ?? []).filter(item => item.session === session.key && item.state !== 'resolved')
	const owed = live.filter(item => item.state === 'open' || item.state === 'orphaned')
	const ask = owed.find(item => item.kind === 'ask')
	if (ask) {
		const since = Math.min(...owed.filter(item => item.kind === 'ask').map(itemWaitingSince))
		const word = askWord(ask)
		return {
			standing: 'needs-you',
			word,
			label: `needs you: ${word}`,
			since,
			tone: agingTone(now - since),
			glyph: kindGlyph(ask),
			glyphTone: entryTone(ask),
			item: ask,
		}
	}
	const turn = owed.find(item => item.kind === 'turn')
	// Its background work (shells, subagents) still runs: it said it will report back, so it reads
	// background, not a reply waiting; opening it still shows that turn.
	if (turn && session.status === 'background')
		return {
			standing: 'background',
			word: 'background',
			label: 'background',
			since: session.since,
			tone: 'none',
			glyph: '◐',
			glyphTone: 'background',
			item: turn,
		}
	if (turn)
		return {
			standing: 'reply-waiting',
			word: 'reply waiting',
			label: 'reply waiting',
			since: itemWaitingSince(turn),
			tone: itemAgeTone(turn, now),
			glyph: kindGlyph(turn),
			glyphTone: entryTone(turn),
			item: turn,
		}
	const answering = live.find(item => item.state === 'sending' || item.state === 'unconfirmed')
	const reply = session.reply
	const replyLive = reply && (reply.status === 'sending' || reply.status === 'sent' || reply.status === 'unconfirmed')
	if (answering || replyLive) {
		const unconfirmed = answering ? answering.state === 'unconfirmed' : reply?.status === 'unconfirmed'
		const word = unconfirmed
			? 'sent, unconfirmed'
			: (answering?.receipt?.status ?? reply?.status) === 'sending'
				? 'sending'
				: 'sent'
		return {
			standing: 'sending',
			word,
			label: word,
			since: answering?.receipt?.at ?? reply?.at ?? session.since,
			tone: unconfirmed ? 'warn' : 'none',
			glyph: '↵',
			glyphTone: unconfirmed ? 'unconfirmed' : 'sending',
			...(answering ? { item: answering } : {}),
		}
	}
	const plain = (standing: AgentStanding, word: string, glyph: string, since: number | null = session.since) => ({
		standing,
		word,
		label: word,
		since,
		tone: 'none' as const,
		glyph,
		glyphTone: standing,
	})
	switch (session.status) {
		case 'working':
			return plain('working', 'working', '✻')
		case 'background':
			return plain('background', 'background', '◐')
		// A dialog Helm has no item for yet (the first look at a pane): it still asks.
		case 'waiting':
			return { ...plain('needs-you', 'waiting', '?'), label: 'needs you: waiting', glyphTone: 'ask' }
		case 'idle':
			return session.lastMessage?.seen ? plain('read', 'read', '✓') : plain('idle', 'idle', '·')
		case 'unreachable':
			return { ...plain('unknown', 'frozen', '▪', null), glyphTone: 'frozen' }
		default:
			return plain('unknown', session.hooksAttached ? 'unknown' : 'not connected', '¿', null)
	}
}

const SOURCE_PLACE: Record<DockSourceId, string> = { okena: 'Okena', helm: 'Helm terminal' }

/**
 * A message's first line as quiet plain text for a one-line excerpt: Claude writes Markdown, so a
 * leading heading, quote or list marker, emphasis and code marks and link targets are dropped.
 */
export function excerptPlainLine(text: unknown, max = 160): string {
	const line = plainAgentLine(text, max * 2)
		.replace(/^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\*\*|__|`/g, '')
	return plainAgentLine(line, max)
}

/**
 * Where the agent runs, beyond its name: a worktree (its name is the branch), else the checkout's
 * branch (`main`, `detached d1aee9df`, a feature branch), else Okena's pane name when the name is
 * not it already. '' when nothing adds to the name.
 */
export function agentPlace(session: DockSession, name: string): string {
	if (session.repo) return 'worktree'
	const branch = plainAgentLine(session.branch, 80)
	if (branch) return COMMIT_HASH.test(branch) ? `detached ${branch.slice(0, 8)}` : branch
	const pane = paneName(session)
	return pane && pane !== name ? plainAgentLine(pane, 64) : ''
}

/** One agent in the Agents overview. */
export interface AgentRow {
	key: string
	standing: AgentStanding
	/** The session status the reducer observed (working, idle, …): the glyph's pulse. */
	status: DockSession['status']
	glyph: string
	glyphTone: string
	/** The short name (`agentWho`). */
	name: string
	/** Okena's full pane name, for the tooltip; '' when it adds nothing. */
	title: string
	/** The repository (`agentRepo`), the row's project group; '' when unknown. */
	repo: string
	/** State words (`question`, `reply waiting`, `read`) and age (`12m`; '' when none). */
	word: string
	/** `word` for screen readers (`needs you: question`). */
	label: string
	age: string
	/** Waiting on Jakub: the aging tone of its queue entry; `none` otherwise. */
	tone: AgingTone
	/**
	 * One line about what the agent last said: the open ask's gist (the question, the command, the
	 * plan's title) while it asks, else the first line of its last assistant message. '' when none.
	 */
	excerpt: string
	/** Source, place (worktree / branch / pane), then `agentRowMeta`: subagents, background tasks, queued, PR #, not connected, stale. */
	where: string[]
	/** The live item opening this row shows; undefined: the agent detail. */
	itemId?: number
	/** When its current state began (sorting). */
	since: number
}

/** The Agents overview's rows, most urgent first (AGENT_STANDINGS), then the longest wait / newest change. */
export function agentRows(snapshot: AgentDockSnapshot | null, now: number): AgentRow[] {
	if (!snapshot) return []
	const names = agentNames(snapshot.sessions)
	const rank = (standing: AgentStanding) => AGENT_STANDINGS.indexOf(standing)
	return snapshot.sessions
		.map((session): AgentRow => {
			const who = agentWho(snapshot, session.key)
			const name = names.get(session.key) ?? who.name
			const view = agentStanding(snapshot, session, now)
			const place = agentPlace(session, name)
			const meta = agentRowMeta(snapshot, session).filter(part => part !== view.word)
			const excerpt =
				view.standing === 'needs-you' && view.item
					? entryGist(view.item)
					: excerptPlainLine(session.lastMessage?.text ?? '')
			return {
				key: session.key,
				standing: view.standing,
				status: session.status,
				glyph: view.glyph,
				glyphTone: view.glyphTone,
				name,
				title: who.title,
				repo: who.project,
				word: view.word,
				label: view.label,
				age: view.since === null ? '' : formatAge(now - view.since),
				tone: view.tone,
				excerpt,
				where: [SOURCE_PLACE[session.source] ?? 'Okena', ...(place ? [place] : []), ...meta],
				...(view.item ? { itemId: view.item.id } : {}),
				since: view.since ?? session.since,
			}
		})
		.sort((a, b) => {
			const byRank = rank(a.standing) - rank(b.standing)
			if (byRank !== 0) return byRank
			// Waiting on Jakub: the longest wait first. Everything else: the newest change first.
			const waiting = a.standing === 'needs-you' || a.standing === 'reply-waiting'
			return (waiting ? a.since - b.since : b.since - a.since) || a.name.localeCompare(b.name)
		})
}

/** A row's accessible name: who, the state in words and its age, then where (`crm-sync, needs you: question 12m, Okena, worktree`). */
export function agentRowLabel(row: AgentRow): string {
	return [row.name, `${row.label}${row.age ? ` ${row.age}` : ''}`, ...row.where].join(', ')
}

/** The overview grouped by standing (layout `by-state`): one group per standing present, most urgent first. */
export function agentStateGroups(
	rows: readonly AgentRow[],
): Array<{ standing: AgentStanding; heading: string; rows: AgentRow[] }> {
	return AGENT_STANDINGS.flatMap(standing => {
		const grouped = rows.filter(row => row.standing === standing)
		return grouped.length > 0 ? [{ standing, heading: STANDING_HEADINGS[standing], rows: grouped }] : []
	})
}

/** The Agents pane header's counts in words (`7 agents · 2 need you · 3 busy`). */
export function agentsSummary(rows: readonly AgentRow[]): string {
	const count = (standings: AgentStanding[]) => rows.filter(row => standings.includes(row.standing)).length
	const needs = count(['needs-you', 'reply-waiting'])
	const busy = count(['working', 'background', 'sending'])
	return [
		`${rows.length} agent${rows.length === 1 ? '' : 's'}`,
		...(needs > 0 ? [`${needs} need${needs === 1 ? 's' : ''} you`] : []),
		...(busy > 0 ? [`${busy} busy`] : []),
	].join(' · ')
}

/**
 * The Agents pane's groups: one per repository in the order its first agent shows (so the busiest
 * repository leads), each keeping the rows' order. Agents with no known repository share one ''
 * group, last.
 */
export function agentRepoGroups(rows: readonly AgentRow[]): Array<{ repo: string; rows: AgentRow[] }> {
	const groups = new Map<string, AgentRow[]>()
	for (const row of rows) groups.set(row.repo, [...(groups.get(row.repo) ?? []), row])
	const unplaced = groups.get('')
	groups.delete('')
	return [...groups, ...(unplaced ? [['', unplaced] as const] : [])].map(([repo, grouped]) => ({ repo, rows: grouped }))
}

/**
 * How the Agents pane groups its rows, Jakub's setting (a text switch in its header, `G`; kept in
 * renderer storage): `by-state` (default: grouped by where each agent stands with him, so what needs
 * him comes first; the project a dim column) or `by-project` (grouped by repository, the most urgent
 * agent leading). Both are one line per agent with the excerpt as a flexible column.
 */
export const AGENTS_LAYOUTS = ['by-state', 'by-project'] as const
export type AgentsLayout = (typeof AGENTS_LAYOUTS)[number]

/** The switch's words, in its order. */
export const AGENTS_LAYOUT_WORDS: Record<AgentsLayout, string> = { 'by-state': 'state', 'by-project': 'project' }

/** A grouping from untrusted input (stored setting), else the default `by-state`. */
export const agentsLayout = (value: unknown): AgentsLayout =>
	AGENTS_LAYOUTS.find(layout => layout === value) ?? 'by-state'

/** The other grouping (`G` toggles). */
export const otherAgentsLayout = (layout: AgentsLayout): AgentsLayout =>
	layout === 'by-state' ? 'by-project' : 'by-state'

/** The Agents pane's groups in display order: by project (most urgent agent first), or by standing. */
export function agentOverview(
	snapshot: AgentDockSnapshot | null,
	now: number,
	layout: AgentsLayout,
): Array<{ id: string; heading: string; rows: AgentRow[] }> {
	const rows = agentRows(snapshot, now)
	if (layout === 'by-state')
		return agentStateGroups(rows).map(group => ({
			id: `state:${group.standing}`,
			heading: group.heading,
			rows: group.rows,
		}))
	return agentRepoGroups(rows).map(group => ({
		id: `repo:${group.repo}`,
		heading: group.repo || 'No project',
		rows: group.rows,
	}))
}

/** How long a landed reply from the agent detail keeps its `✓ replied` receipt. */
export const REPLY_RECEIPT_MS = 60_000

/**
 * The receipt of Jakub's reply from the agent detail (`DockSession.reply`), like an item's: Sending…
 * → ✓ replied (observed) / sent, unconfirmed (amber after 10 s) / refused / the verbatim error. Null
 * with no reply, or once a landed one is older than REPLY_RECEIPT_MS.
 */
export function sessionReplyView(session: DockSession | undefined, now: number): ReceiptView | null {
	const reply = session?.reply
	if (!reply) return null
	switch (reply.status) {
		case 'sending':
		case 'sent':
			return { text: `Sending…${deliveryNote(reply)}`, tone: 'neutral' }
		case 'unconfirmed':
			return { text: `sent, unconfirmed${deliveryNote(reply)}`, tone: 'warn' }
		case 'confirmed':
			return now - reply.at < REPLY_RECEIPT_MS ? { text: '✓ replied', tone: 'success' } : null
		case 'refused':
			return {
				text:
					reply.reason === 'gone'
						? 'refused: already answered elsewhere'
						: `refused: ${plainAgentLine(reply.detail ?? '', 200)}`,
				tone: 'danger',
			}
		default:
			return { text: plainAgentLine(reply.detail ?? 'failed', 300) || 'failed', tone: 'danger' }
	}
}

/**
 * Why the agent detail cannot take a reply right now, or null when it can: the agent owes Jakub
 * an item (answer it there), a reply is still in flight, it works (its next stop is the time), is
 * unreadable, or its source is down. An unconfirmed reply does not block another.
 */
export function agentReplyBlocked(
	snapshot: AgentDockSnapshot | null,
	session: DockSession,
	standing: AgentStanding,
): string | null {
	const health = snapshot?.sources?.[session.source] ?? (session.source === 'okena' ? snapshot?.source : undefined)
	if (health?.state !== 'ok') return `${DOCK_SOURCE_TEXT[session.source].label} unreachable: reply in the terminal`
	switch (standing) {
		case 'read':
		case 'idle':
		case 'background':
			return null
		case 'needs-you':
		case 'reply-waiting':
			return 'Answer its open item first'
		case 'sending':
			// Unconfirmed never clears on its own while the agent stays put: Jakub may check the terminal
			// and reply again (the CAS refuses if the first reply did land).
			return session.reply?.status === 'unconfirmed' ? null : 'A reply is on its way'
		case 'working':
			return 'Working: reply once it stops'
		default:
			return 'State unknown: reply in the terminal'
	}
}

/**
 * Pane height (design §3.24): the shown content's natural height within [PANE_MIN_HEIGHT, the cap].
 * The cap is PANE_MAX_SHARE of `#right` (terminal row + dock), never below PANE_MAX_HEIGHT. The room
 * that leaves the terminal its rows (`paneRoom` in agent-dock-layout.ts) clamps only the height shown,
 * never the height kept, so a window grown back gives the pane its height again.
 */
export const PANE_MIN_HEIGHT = 216
export const PANE_MAX_HEIGHT = 480
export const PANE_MAX_SHARE = 0.6

/** Most px a pane may be opened (or grown) to in a `#right` of `right` px (the room clamps it on screen). */
export function paneMaxHeight(right: number): number {
	return Math.max(PANE_MAX_HEIGHT, Math.floor(right * PANE_MAX_SHARE))
}

/** The height a pane takes for content `natural` px tall under `max` (no room known: PANE_MAX_HEIGHT). */
export function paneFitHeight(natural: number, max: number = PANE_MAX_HEIGHT): number {
	return Math.min(max, Math.max(PANE_MIN_HEIGHT, Math.ceil(natural)))
}

/** However little room is left, the pane keeps its rule, a few body rows and its footer (shown height floor). */
export const PANE_FLOOR = 120

/**
 * The heights Jakub may drag the pane's terminal-side edge to: [PANE_MIN_HEIGHT, `room`] — the room that
 * keeps the terminal its rows, which may exceed the share cap the pane opens with. Keeping the rows wins
 * over the minimum (a short window); the floor still holds. No room known: up to PANE_MAX_HEIGHT.
 */
export function paneResizeBounds(room: number | null): { min: number; max: number } {
	const max = Math.max(PANE_FLOOR, Math.floor(room ?? PANE_MAX_HEIGHT))
	return { min: Math.min(PANE_MIN_HEIGHT, max), max }
}

/** `height` within `bounds`, in whole px. */
export function clampPaneHeight(height: number, bounds: { min: number; max: number }): number {
	return Math.min(bounds.max, Math.max(bounds.min, Math.round(height)))
}

/** Jakub's stored pane height, or null (automatic sizing) for anything absent or not a sane px value. */
export function storedPaneHeight(raw: string | null): number | null {
	if (raw === null || !/^\d{1,5}$/.test(raw.trim())) return null
	const height = Number(raw.trim())
	return height >= PANE_FLOOR && height <= 20_000 ? height : null
}
