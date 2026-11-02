// Agent dock contract: Okena Claude Remote wire schemas (zod, fail closed) plus
// the dock's own session/item/snapshot types. Pure: no IO, no Electron. Main
// (watcher), the renderer (`import type` only) and the CLI share this file.
//
// Items open and close only from observed Okena facts, Jakub's ack, or an
// answer Jakub sent from the dock that Okena then shows taking effect (slice 2).
// Never infer agent state from screen contents (AGENTS.md).

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Okena wire schemas (okena f67bbf7b: okena-core/src/{api,claude_remote}.rs).
// Objects are non-strict so additive server fields never break parsing; a
// missing or mistyped field the dock depends on fails the whole parse.
// ---------------------------------------------------------------------------

const u64 = z.number().int().nonnegative()

/** Layout tree is only walked for terminal ids; keep it opaque here. */
const okenaProjectSchema = z.object({
	id: z.string(),
	name: z.string(),
	path: z.string().optional(),
	layout: z.unknown().optional(),
	terminal_names: z.record(z.string(), z.string()).optional(),
	git_status: z.object({ branch: z.string().nullish() }).nullish(),
})

/** `GET /v1/state`, only the fields the dock reads. Empty maps are omitted by the server. */
export const okenaStateSchema = z.object({
	state_version: u64,
	claude_sessions: z.array(z.string()).default([]),
	claude_dialogs: z.record(z.string(), u64).default({}),
	projects: z.array(okenaProjectSchema).default([]),
})
export type OkenaState = z.infer<typeof okenaStateSchema>
export type OkenaProject = z.infer<typeof okenaProjectSchema>

export const okenaClaudeDialogSchema = z.object({
	/** Opaque `{hub prefix}-{n}`; the prefix is regenerated on every Okena hub start. */
	id: z.string().min(1),
	tool_name: z.string(),
	tool_input: z.unknown(),
	permission_suggestions: z.array(z.unknown()).default([]),
	created_at_ms: u64,
})
export type OkenaClaudeDialog = z.infer<typeof okenaClaudeDialogSchema>

export const okenaClaudePrLinkSchema = z.object({
	number: u64,
	url: z.string().url(),
	repository: z.string(),
	last_seen_at: z.string(),
})

/** `GET /v1/claude/terminals/{terminal_id}` (`ApiClaudeSession`). */
export const okenaClaudeSessionSchema = z.object({
	terminal_id: z.string().min(1),
	session_id: z.string().min(1).optional(),
	has_transcript: z.boolean(),
	hooks_attached: z.boolean(),
	channel_attached: z.boolean(),
	/** Missing means unknown, never idle. */
	busy: z.boolean().optional(),
	queued_prompts: u64,
	dialogs: z.array(okenaClaudeDialogSchema),
	running_subagents: z.array(z.object({ agent_id: z.string(), agent_type: z.string() })).default([]),
	pr_links: z.array(okenaClaudePrLinkSchema).default([]),
})
export type OkenaClaudeSession = z.infer<typeof okenaClaudeSessionSchema>

export const okenaClaudeEntrySchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('user'),
		uuid: z.string(),
		text: z.string(),
		origin: z.enum(['terminal', 'channel']),
	}),
	z.object({ kind: z.literal('assistant'), uuid: z.string(), text: z.string() }),
	z.object({
		kind: z.literal('tool_use'),
		uuid: z.string(),
		tool_use_id: z.string(),
		name: z.string(),
		summary: z.string(),
	}),
	z.object({
		kind: z.literal('tool_result'),
		uuid: z.string(),
		tool_use_id: z.string(),
		text: z.string(),
		is_error: z.boolean(),
	}),
])
export type OkenaClaudeEntry = z.infer<typeof okenaClaudeEntrySchema>

/** `GET /v1/claude/terminals/{id}/transcript?cursor=&session_id=`. */
export const okenaClaudeTranscriptPageSchema = z.object({
	session_id: z.string().min(1).optional(),
	entries: z.array(okenaClaudeEntrySchema),
	/** Byte offset to send back next time, with the same session_id. */
	cursor: u64,
	/** True: drop everything held for this terminal and start over from this page. */
	reset: z.boolean(),
})
export type OkenaClaudeTranscriptPage = z.infer<typeof okenaClaudeTranscriptPageSchema>

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, label: string, body: unknown): ParseResult<T> {
	const parsed = schema.safeParse(body)
	if (parsed.success) return { ok: true, value: parsed.data }
	const issue = parsed.error.issues[0]
	const where = issue?.path.length ? issue.path.join('.') : '(root)'
	return { ok: false, error: `invalid ${label}: ${where}: ${issue?.message ?? 'parse failed'}` }
}

export const parseOkenaState = (body: unknown): ParseResult<OkenaState> =>
	parseWith(okenaStateSchema, '/v1/state', body)
export const parseOkenaClaudeSession = (body: unknown): ParseResult<OkenaClaudeSession> =>
	parseWith(okenaClaudeSessionSchema, 'claude session', body)
export const parseOkenaClaudeTranscriptPage = (body: unknown): ParseResult<OkenaClaudeTranscriptPage> =>
	parseWith(okenaClaudeTranscriptPageSchema, 'claude transcript', body)

/** Terminals to fetch: the deduplicated, sorted union of `claude_sessions` and `claude_dialogs` keys (as `okena claude ls`). */
export function okenaClaudeCandidates(state: OkenaState): string[] {
	return [...new Set([...state.claude_sessions, ...Object.keys(state.claude_dialogs)])].sort()
}

function layoutHasTerminal(node: unknown, terminalId: string, depth = 0): boolean {
	if (!node || typeof node !== 'object' || depth > 64) return false
	const record = node as { terminal_id?: unknown; children?: unknown }
	if (record.terminal_id === terminalId) return true
	return (
		Array.isArray(record.children) && record.children.some(child => layoutHasTerminal(child, terminalId, depth + 1))
	)
}

/** Project owning a terminal: layout pane first, then `terminal_names` (hook/service terminals). */
export function okenaTerminalProject(state: OkenaState, terminalId: string): OkenaProject | undefined {
	return (
		state.projects.find(project => layoutHasTerminal(project.layout, terminalId)) ??
		state.projects.find(project => project.terminal_names?.[terminalId] !== undefined)
	)
}

/** Hub prefix of an Okena dialog id (`{prefix}-{n}`); the whole id when it has no counter. */
export function okenaDialogPrefix(dialogId: string): string {
	const dash = dialogId.lastIndexOf('-')
	return dash > 0 && /^\d+$/.test(dialogId.slice(dash + 1)) ? dialogId.slice(0, dash) : dialogId
}

// ---------------------------------------------------------------------------
// Dock domain
// ---------------------------------------------------------------------------

/** `${okenaProfile}:${terminalId}`: the pane, stable across claude restarts in it. */
export type SessionKey = string

export const sessionKey = (profile: string, terminalId: string): SessionKey => `${profile}:${terminalId}`

/**
 * Where a dock session is observed: Okena Claude Remote (`okena`) or Helm's own
 * Claude hub for Claude Code in Helm terminals (`helm`; profile `helm:<profileId>`,
 * so its keys are `helm:<profileId>:<dtach session id>`). Both speak the same
 * Okena-shaped wire; the reducer keeps epoch/seed/health per source.
 */
export type DockSourceId = 'okena' | 'helm'
export const DOCK_SOURCES: readonly DockSourceId[] = ['okena', 'helm']
/** Words for a source in dock/CLI text. */
export const DOCK_SOURCE_LABEL: Record<DockSourceId, string> = { okena: 'Okena', helm: 'Helm terminals' }

/**
 * working: busy. background: not busy but subagents still running. idle: not busy.
 * waiting: an Okena dialog is open. unknown: busy missing or detail unparseable/unfetched.
 * unreachable: Okena itself is down (frozen row).
 */
export type DockSessionStatus = 'working' | 'background' | 'idle' | 'waiting' | 'unknown' | 'unreachable'

export interface DockPrLink {
	number: number
	url: string
	repository: string
}

export interface DockSession {
	key: SessionKey
	/** Which source observes it (absent in snapshots from before Helm terminals were observed = okena). */
	source: DockSourceId
	profile: string
	terminalId: string
	/** For Okena `focus_terminal`; absent when the pane is not in any project layout. */
	projectId?: string
	project: string
	name: string
	/** Claude conversation id; a change resolves the old session's items `session_ended`. */
	sessionId?: string
	status: DockSessionStatus
	/** Last OBSERVED status transition (ms). Never extrapolated. */
	since: number
	/** Last successful detail fetch (ms); rows older than ~10 s render stale. */
	observedAt: number
	subagents: number
	queuedPrompts: number
	prLinks: DockPrLink[]
	hasTranscript: boolean
	hooksAttached: boolean
	channelAttached: boolean
}

export type DockItemKind = 'ask' | 'turn'
/**
 * open: owes Jakub. sending: Jakub answered from the dock; Helm is sending it or
 * waiting to see it land. unconfirmed: Okena took it but Helm has not seen the
 * dialog close / a user entry within ACT_CONFIRM_MS (amber; stays until observed
 * or acked). orphaned: sticky until transcript activity or ack.
 */
export type DockItemState = 'open' | 'sending' | 'unconfirmed' | 'orphaned' | 'resolved'
/** `dock`: Jakub's dock answer, observed taking effect. */
export type DockResolutionBy = 'outside' | 'replied' | 'superseded' | 'session_ended' | 'acked' | 'dock'

export interface DockAskFact {
	kind: 'ask'
	dialogId: string
	/** `AskUserQuestion` | `ExitPlanMode` | any other tool (allow/deny permission). */
	tool: string
	/** Verbatim Okena `tool_input` (strings > 16 KiB already cut by Okena). Untrusted; render as plain text. */
	input: unknown
	/**
	 * Claude's own `permission_suggestions` for this dialog (e.g. `{type: 'addRules', rules:
	 * [{toolName, ruleContent}], behavior: 'allow', destination}`), verbatim, at most
	 * PERMISSION_SUGGESTIONS_MAX. Present only when Okena sent some; the source of any
	 * "Always allow" wording. Memory only, never persisted.
	 */
	suggestions?: unknown[]
	/** Okena sent more than PERMISSION_SUGGESTIONS_MAX suggestions: "Always allow" is not offered. */
	suggestionsTruncated?: true
	createdAtMs: number
}

export { PERMISSION_SUGGESTIONS_MAX } from './review'

export interface DockTurnFact {
	kind: 'turn'
	sessionId?: string
	assistantUuid: string
	/** Last assistant message, bounded to TURN_TEXT_MAX and control-stripped. Memory only, never persisted. */
	text: string
	endedAt: number
	/** Subagents were still running when the turn ended. */
	hadBackground: boolean
}

export type DockItemFact = DockAskFact | DockTurnFact

export interface DockResolution {
	at: number
	by: DockResolutionBy
}

export interface DockItem {
	/** Monotonic, never reused while the persisted counter survives. Shown as `#id`. */
	id: number
	/** Dedupe: `ask:{sessionKey}:{dialogId}` | `turn:{sessionId|sessionKey}:{assistantUuid}`. */
	key: string
	kind: DockItemKind
	session: SessionKey
	/**
	 * Fact version for the act CAS; acts carry the rev they saw. Starts at 1 and nothing bumps it
	 * today: a turn whose agent moves on closes (`superseded`/`replied`) instead of changing in place.
	 */
	rev: number
	openedAt: number
	fact: DockItemFact
	state: DockItemState
	orphanedAt?: number
	resolution?: DockResolution
	/** The last dock answer for this item and how it went. Never carries answer text. */
	receipt?: DockReceipt
}

// ---------------------------------------------------------------------------
// Dock actions (slice 2): Jakub answers from a card. Main re-reads Okena (CAS)
// before every effect; answer text lives only in this request and the one
// Okena POST built from it, never in state, events or disk.
// ---------------------------------------------------------------------------

export type DockActionKind = 'answer' | 'allow' | 'deny' | 'prompt'

/** One AskUserQuestion answer, by position: picked option indexes (several only for multiSelect) and/or Other text. */
export interface DockAnswerPick {
	options: number[]
	other?: string
}

export type DockAction =
	/**
	 * AskUserQuestion: one pick per question, in tool_input order. Main maps them to Okena's `{question: label}`.
	 * `confirmed` is required when any Other text matches DOCK_RISKY_PROMPT.
	 */
	| { type: 'answer'; picks: DockAnswerPick[]; confirmed?: boolean }
	/** Permission allow / ExitPlanMode approve. `always` only when Claude sent permission_suggestions. */
	| { type: 'allow'; always?: boolean }
	/** Permission deny / ExitPlanMode keep planning; the message goes to the agent (`confirmed` as for prompts). */
	| { type: 'deny'; message?: string; confirmed?: boolean }
	/** Reply to a finished turn. `confirmed` is required when the text matches DOCK_RISKY_PROMPT. */
	| { type: 'prompt'; text: string; confirmed?: boolean }

export interface AgentDockActRequest {
	itemId: number
	/** The item rev the renderer showed; a different current rev refuses the act. */
	rev?: number
	action: DockAction
}

export type DockRefusalReason =
	/** The dialog/turn is no longer there: answered elsewhere. */
	| 'gone'
	/** The question, its options or the turn changed since it was shown. */
	| 'changed'
	/** The agent is working again; a reply would be queued behind work Jakub has not seen. */
	| 'busy'
	/** Not answerable from the dock now (sending, unconfirmed, orphaned, resolved). */
	| 'not_open'
	| 'unknown_item'
	| 'invalid'
	| 'source_down'
	| 'in_flight'

export type OkenaPromptDelivery = 'channel' | 'pty' | 'queued'

/** What one act did (main → reducer and → renderer). `detail` is verbatim Okena/transport text, never answer text. */
export type DockActOutcome =
	| { status: 'sent'; delivery?: OkenaPromptDelivery }
	/** The request reached Okena but no answer came back (timeout/reset): it may have landed. */
	| { status: 'unconfirmed'; detail: string }
	| { status: 'refused'; reason: DockRefusalReason; detail: string }
	| { status: 'failed'; detail: string }

export type AgentDockActResult = { ok: true; outcome: DockActOutcome } | { ok: false; outcome: DockActOutcome }

export type DockReceiptStatus = 'sending' | 'sent' | 'unconfirmed' | 'confirmed' | 'refused' | 'failed'

export interface DockReceipt {
	action: DockActionKind
	/** Allow for the rest of the session (Claude's own suggestions). */
	always?: boolean
	status: DockReceiptStatus
	/** Last status change (ms). */
	at: number
	/** When Okena accepted it (ms); unconfirmed after ACT_CONFIRM_MS without observation. */
	sentAt?: number
	delivery?: OkenaPromptDelivery
	reason?: DockRefusalReason
	/** Verbatim Okena/transport error or refusal words. Memory/IPC only, never on disk. */
	detail?: string
}

/** Okena accepted an answer but Helm has not observed it this long: unconfirmed (amber). */
export const ACT_CONFIRM_MS = 10_000
/** Free text to the agent (replies, deny messages, Other answers) that mentions these needs a second, explicit confirmation (renderer) and `confirmed` (main). */
export const DOCK_RISKY_PROMPT = /deploy|prod|secret|push|merge/i
/** Okena refuses prompts over 64 KiB (`MAX_PROMPT_BYTES`); Helm bounds by UTF-16 units under that. */
export const DOCK_PROMPT_MAX = 16_384
export const DOCK_MESSAGE_MAX = 4_096
export const DOCK_OTHER_MAX = 4_096

const dockAnswerPickSchema = z
	.object({
		options: z.array(z.number().int().nonnegative()).max(64),
		other: z.string().max(DOCK_OTHER_MAX).optional(),
	})
	.strict()

const dockActionSchema = z.discriminatedUnion('type', [
	z
		.object({
			type: z.literal('answer'),
			picks: z.array(dockAnswerPickSchema).min(1).max(16),
			confirmed: z.boolean().optional(),
		})
		.strict(),
	z.object({ type: z.literal('allow'), always: z.boolean().optional() }).strict(),
	z
		.object({
			type: z.literal('deny'),
			message: z.string().max(DOCK_MESSAGE_MAX).optional(),
			confirmed: z.boolean().optional(),
		})
		.strict(),
	z
		.object({ type: z.literal('prompt'), text: z.string().max(DOCK_PROMPT_MAX), confirmed: z.boolean().optional() })
		.strict(),
])

export const agentDockActRequestSchema = z
	.object({
		itemId: z.number().int().positive().safe(),
		rev: z.number().int().positive().safe().optional(),
		action: dockActionSchema,
	})
	.strict()

/** Main-side validation of a renderer act request (IPC input is untrusted). */
export const parseAgentDockActRequest = (body: unknown): ParseResult<AgentDockActRequest> =>
	parseWith(agentDockActRequestSchema, 'act request', body)

/** Deterministic JSON (sorted object keys) for comparing Okena dialog inputs across reads. */
export function stableJson(value: unknown, depth = 0): string {
	if (depth > 64) return '"…"'
	if (Array.isArray(value)) return `[${value.map(entry => stableJson(entry, depth + 1)).join(',')}]`
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record)
			.sort()
			.filter(key => record[key] !== undefined)
			.map(key => `${JSON.stringify(key)}:${stableJson(record[key], depth + 1)}`)
			.join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

export type AgentDockSourceState = 'pending' | 'ok' | 'down'

/** Okena reachability. `pending` = never polled yet; the UI must not show "all clear" for it. */
export interface AgentDockSourceHealth {
	state: AgentDockSourceState
	/** When the current state began (ms). */
	since: number
	/** Last successful `/v1/state` (ms), null before the first one. */
	lastObservedAt: number | null
	/** Short verbatim reason while down. */
	detail?: string
}

/** Pushed main → renderer on every change (channel AGENT_DOCK_IPC.snapshot). */
export interface AgentDockSnapshot {
	generatedAt: number
	/**
	 * All sources together: down if any is down, else pending if any is pending, else ok.
	 * Kept for whole-dock text ("never all clear from missing data"); answering is gated
	 * per source (`sources[session.source]`).
	 */
	source: AgentDockSourceHealth
	/** Each observed source's own health. */
	sources: Partial<Record<DockSourceId, AgentDockSourceHealth>>
	sessions: DockSession[]
	/** Open asks oldest first, then orphaned, then open turns oldest first, then resolved newest first. */
	items: DockItem[]
}

/** Lines for the dispatcher event stream; the watcher assigns `seq`. */
export type AgentDockEvent =
	| { t: 'item.opened'; at: number; id: number; kind: DockItemKind; session: SessionKey; key: string }
	| { t: 'item.resolved'; at: number; id: number; by: DockResolutionBy }
	| { t: 'item.orphaned'; at: number; id: number }
	| { t: 'source.health'; at: number; state: 'ok' | 'down'; source?: DockSourceId; detail?: string }
	/** A dock answer's end state. Never carries answer text or Okena error text (disk). */
	| {
			t: 'act.outcome'
			at: number
			id: number
			action: DockActionKind
			status: 'confirmed' | 'unconfirmed' | 'refused' | 'failed'
			reason?: DockRefusalReason
	  }

// ---------------------------------------------------------------------------
// Reducer input
// ---------------------------------------------------------------------------

/** One HTTP read: the raw JSON body, or a verbatim transport error. The reducer validates. */
export type OkenaFetch = { ok: true; body: unknown } | { ok: false; error: string }

export interface ObservedClaudeTerminal {
	terminalId: string
	/** `GET /v1/claude/terminals/{id}`. */
	detail: OkenaFetch
	/** Present only when the source fetched the transcript this tick (see agentDockTranscriptRequest). */
	transcript?: OkenaFetch
}

export type AgentDockObservation =
	/** One tick of one source: `/v1/state` plus details for (ideally all) okenaClaudeCandidates. Absent source = okena. */
	| { type: 'poll'; source?: DockSourceId; profile: string; state: OkenaFetch; terminals: ObservedClaudeTerminal[] }
	/** Jakub acked an item in the dock. */
	| { type: 'ack'; itemId: number }
	/** Jakub answered from the dock; main is about to run the CAS read and the Okena POST. */
	| { type: 'act.sending'; itemId: number; action: DockActionKind; always?: boolean }
	/** How that act went. */
	| { type: 'act.result'; itemId: number; outcome: DockActOutcome }

// ---------------------------------------------------------------------------
// Persistence (`<userData>/agent-dock/state.json`): counter + seen uuids only.
// Items, turn text and dialog input are never written to disk in slice 1.
// ---------------------------------------------------------------------------

export const agentDockPersistedSchema = z.object({
	version: z.literal(1),
	nextItemId: z.number().int().positive(),
	seen: z.record(z.string(), z.string()),
})
export type AgentDockPersisted = z.infer<typeof agentDockPersistedSchema>
