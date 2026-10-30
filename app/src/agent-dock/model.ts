// Agent dock contract: Okena Claude Remote wire schemas (zod, fail closed) plus
// the dock's own session/item/snapshot types. Pure: no IO, no Electron. Main
// (watcher), the renderer (`import type` only) and the CLI share this file.
//
// Slice 1 is read-only: items open and close only from observed Okena facts or
// Jakub's ack. Never infer agent state from screen contents (AGENTS.md).

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
/** Read-only slice states. `orphaned` is sticky until transcript activity or ack. */
export type DockItemState = 'open' | 'orphaned' | 'resolved'
export type DockResolutionBy = 'outside' | 'replied' | 'superseded' | 'session_ended' | 'acked'

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
	createdAtMs: number
}

export const PERMISSION_SUGGESTIONS_MAX = 8

export interface DockTurnFact {
	kind: 'turn'
	sessionId?: string
	assistantUuid: string
	/** Last assistant message, bounded to TURN_TEXT_MAX and control-stripped. Memory only, never persisted. */
	text: string
	endedAt: number
	/** Subagents were still running when the turn ended. */
	hadBackground: boolean
	/** Tools ran again without a user entry; the turn stays open. */
	continuedAt?: number
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
	source: AgentDockSourceHealth
	sessions: DockSession[]
	/** Open asks oldest first, then orphaned, then open turns oldest first, then resolved newest first. */
	items: DockItem[]
}

/** Lines for the dispatcher event stream; the watcher assigns `seq`. */
export type AgentDockEvent =
	| { t: 'item.opened'; at: number; id: number; kind: DockItemKind; session: SessionKey; key: string }
	| { t: 'item.resolved'; at: number; id: number; by: DockResolutionBy }
	| { t: 'item.orphaned'; at: number; id: number }
	| { t: 'source.health'; at: number; state: 'ok' | 'down'; detail?: string }

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
	/** One tick: `/v1/state` plus details for (ideally all) okenaClaudeCandidates. */
	| { type: 'poll'; profile: string; state: OkenaFetch; terminals: ObservedClaudeTerminal[] }
	/** Jakub acked an item in the dock. */
	| { type: 'ack'; itemId: number }

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
