// Agent dock contract: Okena Claude Remote wire schemas (zod, fail closed) plus
// the dock's own session/item/snapshot types. Pure: no IO, no Electron. Main
// (watcher, sources, act) and the renderer (`import type` only) share this file;
// the CLI and the spool share only src/agent-dock/ (dock-vocabulary.ts, spool.ts).
//
// Items open and close only from observed Okena facts, Jakub's ack, or an
// answer Jakub sent from the dock that Okena then shows taking effect.
// Never infer agent state from screen contents (AGENTS.md).

import { z } from 'zod'
import type {
	DOCK_ACTION_KINDS,
	DOCK_ITEM_KINDS,
	DOCK_ITEM_STATES,
	DOCK_PROMPT_DELIVERIES,
	DOCK_RECEIPT_STATUSES,
	DOCK_REFUSAL_REASONS,
	DOCK_RESOLUTION_BY,
	DOCK_SESSION_STATUSES,
	DOCK_SOURCE_HEALTH_STATES,
	DockSourceId,
} from '../../../src/agent-dock/dock-vocabulary'
import type { ObservedBackgroundTasks } from './background-tasks'

export type { DockSourceId } from '../../../src/agent-dock/dock-vocabulary'

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
	/** Present when the project is a git worktree Okena made from another project (its repository). */
	worktree_info: z.object({ parent_project_id: z.string() }).nullish(),
	/**
	 * Agent status a pane reports about itself (OSC 7501 records, else OSC 9001; e.g. the okena-lifecycle Claude Code
	 * hooks): only `lifecycle` is read, as a push-coverage hint (OkenaClaudeSource.pushCovered).
	 * A change bumps state_version, so `/v1/stream` carries it. Optional and never fatal:
	 * malformed = absent (the dock then keeps polling).
	 */
	terminal_agent_status: z
		.record(z.string(), z.object({ lifecycle: z.string().max(32) }))
		.optional()
		.catch(undefined),
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

const okenaClaudePrLinkSchema = z.object({
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
	/**
	 * Helm's own hub only (Okena never sends it): background tasks the Stop hook listed as
	 * still running. Okena panes get theirs from the transcript file (ObservedClaudeTerminal.background).
	 */
	background_tasks: u64.optional(),
	/** Helm's hub only: how many of background_tasks are shells. */
	background_shells: u64.optional(),
	pr_links: z.array(okenaClaudePrLinkSchema).default([]),
})
export type OkenaClaudeSession = z.infer<typeof okenaClaudeSessionSchema>

export const okenaClaudeEntrySchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('user'),
		uuid: z.string(),
		/** When Claude recorded it (RFC 3339); absent from older Okena. */
		timestamp: z.string().nullish(),
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

/** Project whose layout shows a terminal as a pane: the only terminals Okena's `focus_terminal` can focus. */
export function okenaLayoutProject(state: OkenaState, terminalId: string): OkenaProject | undefined {
	return state.projects.find(project => layoutHasTerminal(project.layout, terminalId))
}

/** The agent-status lifecycle a pane reports (`working`, `blocked`, `done`, `idle`, `error`, …), if any. */
export function okenaAgentLifecycle(state: OkenaState, terminalId: string): string | undefined {
	for (const project of state.projects) {
		const status = project.terminal_agent_status?.[terminalId]
		if (status) return status.lifecycle
	}
	return undefined
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

// Word lists (sources, statuses, states, reasons, …) live in
// src/agent-dock/dock-vocabulary.ts, shared with the spool schemas and the renderer.

/** See DOCK_SESSION_STATUSES. */
export type DockSessionStatus = (typeof DOCK_SESSION_STATUSES)[number]

export interface DockPrLink {
	number: number
	url: string
	repository: string
}

export interface DockSession {
	key: SessionKey
	/** Which source observes it (Okena's Claude Remote, or Helm's own hub for Helm terminals). */
	source: DockSourceId
	profile: string
	terminalId: string
	/** For Okena `focus_terminal`; absent when the pane is not in any project layout. */
	projectId?: string
	project: string
	/**
	 * The repository's Okena project name when the pane's project is a worktree of it
	 * (`worktree_info.parent_project_id`; `project` is then the worktree, usually named after its branch).
	 * Absent otherwise: `project` is the repository itself.
	 */
	repo?: string
	/** Okena's name for the pane (its terminal name, else the project's branch, else `terminal <id>`). */
	name: string
	/** The project's git branch as Okena reports it (`fix/company-create-save-firm`); the dock's short agent names come from it. */
	branch?: string
	/** Claude conversation id; a change resolves the old session's items `session_ended`. */
	sessionId?: string
	status: DockSessionStatus
	/** Last OBSERVED status transition (ms). Never extrapolated. */
	since: number
	/** Last successful detail fetch (ms); rows older than ~10 s render stale. */
	observedAt: number
	subagents: number
	/** Background tasks the main agent started that have not ended (shells, workflows, monitors; not subagents). */
	backgroundTasks: number
	/** How many of `backgroundTasks` are shells (Bash `run_in_background`); 0 when the source cannot tell. */
	backgroundShells: number
	queuedPrompts: number
	prLinks: DockPrLink[]
	hasTranscript: boolean
	hooksAttached: boolean
	channelAttached: boolean
	/**
	 * The agent's last assistant message as the reducer last read it (transcript tail), as a
	 * bounded one-line excerpt. Absent until a transcript page showed one. Memory/IPC only:
	 * the spool keeps only `at`/`seen`, never the text.
	 */
	lastMessage?: DockLastMessage
	/**
	 * Jakub's last reply sent from the agent detail (no item: the agent owed him nothing), and how
	 * it went. Never carries the reply text. Memory/IPC only.
	 */
	reply?: DockSessionReply
}

export { DOCK_EXCERPT_MAX, DOCK_LIVE_MESSAGE_MAX } from '../../../src/agent-dock/dock-vocabulary'

export interface DockLastMessage {
	/** Transcript uuid of the assistant entry: the reply CAS checks the agent still stops at it. */
	uuid: string
	/** First non-empty line, control/bidi-stripped, at most DOCK_EXCERPT_MAX (dock-vocabulary.ts). */
	text: string
	/** When Helm first read this message (ms); transcripts carry no time of their own. */
	at: number
	/** Jakub has seen it: acked (its turn item), adopted at Helm's first look, or replied to from the dock. */
	seen: boolean
}

export interface DockSessionReply extends DockReceipt {
	/** The message Jakub replied to (its uuid), when he saw one. */
	assistantUuid?: string
	/**
	 * The transcript's last user entry when the reply was sent: a reply the source holds for after the
	 * agent's turn (`delivery` queued/channel) lands at the next user entry, not at the agent's next
	 * message (a working agent says new things before its turn ends).
	 */
	userBefore?: string
}

export type DockItemKind = (typeof DOCK_ITEM_KINDS)[number]
/** See DOCK_ITEM_STATES. */
export type DockItemState = (typeof DOCK_ITEM_STATES)[number]
/** See DOCK_RESOLUTION_BY. */
export type DockResolutionBy = (typeof DOCK_RESOLUTION_BY)[number]

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

export interface DockTurnFact {
	kind: 'turn'
	sessionId?: string
	assistantUuid: string
	/** Last assistant message, bounded to TURN_TEXT_MAX and control-stripped. Memory only, never persisted. */
	text: string
	endedAt: number
	/** Subagents or background tasks were still running when the turn ended (status `background`). */
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
	openedAt: number
	fact: DockItemFact
	state: DockItemState
	orphanedAt?: number
	resolution?: DockResolution
	/** The last dock answer for this item and how it went. Never carries answer text. */
	receipt?: DockReceipt
}

// ---------------------------------------------------------------------------
// Dock actions: Jakub answers from the dock. Main re-reads Okena (CAS)
// before every effect; answer text lives only in this request and the one
// Okena POST built from it, never in state, events or disk.
// ---------------------------------------------------------------------------

export type DockActionKind = (typeof DOCK_ACTION_KINDS)[number]

/** One AskUserQuestion answer, by position: picked option indexes (several only for multiSelect) and/or Other text. */
export interface DockAnswerPick {
	options: number[]
	other?: string
}

export type DockAction =
	/** AskUserQuestion: one pick per question, in tool_input order. Main maps them to Okena's `{question: label}`. */
	| { type: 'answer'; picks: DockAnswerPick[] }
	/** Permission allow / ExitPlanMode approve. `always` only when Claude sent permission_suggestions. */
	| { type: 'allow'; always?: boolean }
	/** Permission deny / ExitPlanMode keep planning; the message goes to the agent. */
	| { type: 'deny'; message?: string }
	/** Reply to a finished turn. */
	| { type: 'prompt'; text: string }

export interface AgentDockActRequest {
	itemId: number
	action: DockAction
}

/** See DOCK_REFUSAL_REASONS. */
export type DockRefusalReason = (typeof DOCK_REFUSAL_REASONS)[number]

export type OkenaPromptDelivery = (typeof DOCK_PROMPT_DELIVERIES)[number]

/** What one act did (main → reducer and → renderer). `detail` is verbatim Okena/transport text, never answer text. */
export type DockActOutcome =
	| {
			status: 'sent'
			delivery?: OkenaPromptDelivery
			/**
			 * A prompt only: the newest user entry of the transcript read just before it was sent (the
			 * baseline a held prompt lands after; the reducer's own tail may be stale while the agent works).
			 */
			userBefore?: string
	  }
	/** The request reached Okena but no answer came back (timeout/reset): it may have landed. */
	| { status: 'unconfirmed'; detail: string }
	| { status: 'refused'; reason: DockRefusalReason; detail: string }
	| { status: 'failed'; detail: string }

/**
 * `recorded`: main put the outcome on the item's receipt (or the session's reply), so the snapshot
 * shows it, and drops it once it no longer holds (a busy/untracked refusal, the agent seen idle
 * again); the renderer keeps its own copy only of outcomes main did not record (a precondition
 * refusal, or a result the reducer dropped because the item or session moved on meanwhile).
 */
export type AgentDockActResult =
	| { ok: true; outcome: DockActOutcome; recorded?: boolean }
	| { ok: false; outcome: DockActOutcome; recorded?: boolean }

export type DockReceiptStatus = (typeof DOCK_RECEIPT_STATUSES)[number]

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
	z.object({ type: z.literal('answer'), picks: z.array(dockAnswerPickSchema).min(1).max(16) }).strict(),
	z.object({ type: z.literal('allow'), always: z.boolean().optional() }).strict(),
	z.object({ type: z.literal('deny'), message: z.string().max(DOCK_MESSAGE_MAX).optional() }).strict(),
	z.object({ type: z.literal('prompt'), text: z.string().max(DOCK_PROMPT_MAX) }).strict(),
])

export const agentDockActRequestSchema = z
	.object({
		itemId: z.number().int().positive().safe(),
		action: dockActionSchema,
	})
	.strict()

/** Main-side validation of a renderer act request (IPC input is untrusted). */
export const parseAgentDockActRequest = (body: unknown): ParseResult<AgentDockActRequest> =>
	parseWith(agentDockActRequestSchema, 'act request', body)

/**
 * A reply to an agent that owes Jakub nothing (no open item), sent from the agent detail.
 * Main re-reads the pane (CAS): same Claude session, idle with no dialog, and its transcript
 * still ends at `assistantUuid` (the message Jakub read) with no user entry after it.
 */
export interface AgentDockPromptRequest {
	session: SessionKey
	/** The Claude conversation Jakub saw; a new one in the pane refuses. */
	sessionId?: string
	/** The last message Jakub saw; absent when he saw none. */
	assistantUuid?: string
	/**
	 * A working agent may take it: the source holds it and types it once the agent's turn ends
	 * (Signals hands a thread to an agent; the agent detail's Reply). A working agent's last message is
	 * not checked; one free now is, when `assistantUuid` says which message the reply answers. Still
	 * refused: a dialog open (typing would answer it), busy unknown, a new Claude session in the pane.
	 */
	queue?: true
	/**
	 * A hand-off, not a reply to what Jakub read (Signals `p` and ask answers): never checked against
	 * the last message, also when the agent is free. Goes with `queue`.
	 */
	handoff?: true
	text: string
}

export const agentDockPromptRequestSchema = z
	.object({
		session: z.string().min(1).max(512),
		sessionId: z.string().min(1).max(512).optional(),
		assistantUuid: z.string().min(1).max(512).optional(),
		queue: z.literal(true).optional(),
		handoff: z.literal(true).optional(),
		text: z.string().max(DOCK_PROMPT_MAX),
	})
	.strict()

export const parseAgentDockPromptRequest = (body: unknown): ParseResult<AgentDockPromptRequest> =>
	parseWith(agentDockPromptRequestSchema, 'prompt request', body)

/** The agent's last message, read live through its source for the agent detail (`helm dock show` does the same). */
export type AgentDockMessageResult =
	| {
			ok: true
			/** Absent when the transcript has no assistant entry yet. */
			message?: { uuid: string; text: string }
			sessionId?: string
	  }
	| { ok: false; detail: string }

/**
 * "Show terminal" from the dock (agent-dock:reveal, Okena panes only; Helm terminals are shown by the
 * window itself). `activated`: Helm also brought the Okena app to the front (best effort, macOS);
 * `note`: when it did not, what to say instead of the plain "could not bring Okena to the front"
 * (how to allow a blocked permission, once per run).
 */
export type AgentDockRevealResult = { ok: true; activated: boolean; note?: string } | { ok: false; detail: string }

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

export type AgentDockSourceState = (typeof DOCK_SOURCE_HEALTH_STATES)[number]

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
	/** An orphaned ask's dialog is listed again: it owes Jakub again. */
	| { t: 'item.reopened'; at: number; id: number }
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
	/** Background tasks from the session's own transcript file (Okena panes); absent = unknown, no claim. */
	background?: ObservedBackgroundTasks
}

export type AgentDockObservation =
	/**
	 * One tick of one source: `/v1/state` plus details for (ideally all) okenaClaudeCandidates.
	 * `readFrom`: when the tick's reads began (the watcher stamps it). A dock answer refused after
	 * that (a tick in flight while Jakub sent) was checked against newer data than this poll's, so
	 * this poll never drops that refusal as no longer holding.
	 */
	| {
			type: 'poll'
			source: DockSourceId
			profile: string
			state: OkenaFetch
			terminals: ObservedClaudeTerminal[]
			readFrom?: number
	  }
	/** Jakub acked an item in the dock. */
	| { type: 'ack'; itemId: number }
	/** Jakub answered from the dock; main is about to run the CAS read and the Okena POST. */
	| { type: 'act.sending'; itemId: number; action: DockActionKind; always?: boolean }
	/** How that act went. */
	| { type: 'act.result'; itemId: number; outcome: DockActOutcome }
	/** Jakub replied from the agent detail (no item); main is about to run the CAS read and the POST. */
	/** `text`: the reply's words, so the reducer knows its transcript entry (memory only; never spooled). */
	| { type: 'prompt.sending'; session: SessionKey; assistantUuid?: string; text?: string }
	/** How that reply went. */
	| { type: 'prompt.result'; session: SessionKey; outcome: DockActOutcome }

// ---------------------------------------------------------------------------
// Persistence (`<userData>/agent-dock/state.json`): counter + seen uuids (the
// watcher adds its event seq and the resolved-item ledger).
// Turn text and dialog input are never written to disk; see spool.ts for what
// snapshot.json and events.ndjson hold.
// ---------------------------------------------------------------------------

export const agentDockPersistedSchema = z.object({
	version: z.literal(1),
	nextItemId: z.number().int().positive(),
	seen: z.record(z.string(), z.string()),
})
export type AgentDockPersisted = z.infer<typeof agentDockPersistedSchema>
