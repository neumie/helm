// Helm Claude hub core: the pure state machine behind HelmClaudeHub. Input is
// structured Claude Code hook events from the top-level `claude` of a Helm
// terminal (the preload gates everything else), Helm's own terminal lifecycle,
// and transcript interrupt markers; output is Okena-Claude-Remote-shaped JSON so
// the existing OkenaClaudeSource/reducer/act.ts run over it unchanged.
// No IO, no clocks (callers pass `at`), no PTY output, no process liveness
// (AGENTS.md: structured signals only).
//
// Identity: a terminal is the token's (profileId, dtach session id). Its primary
// session is the (CLAUDE_PID, session_id) pair a SessionStart announced, or the
// first event after the hub (re)started. /clear keeps the pid and changes the
// session id (SessionEnd clear → SessionStart clear); --continue keeps the id
// under a new pid.
//
// Lifeline: the preload inside that claude process holds one token-authenticated
// connection (`attach`, pid) open for the process's whole life; the kernel closes
// it on any exit, kill -9 and crashes included (the fd is close-on-exec, so tool
// children never hold it). Its close ends the primary (a structured lifecycle
// signal, like Helm's own pty exit). A reply is typed only while the primary's
// lifeline is open. Ctrl-Z (suspend) sends nothing: documented gap.
//
// Busy: UserPromptSubmit / PreToolUse / PostToolUse(Failure) / PermissionRequest
// of a prompt that has not stopped → busy; Stop / StopFailure / SessionStart
// (except compact) / a transcript interrupt marker → idle; SessionEnd → unknown.
// Async hooks arrive out of order, so a prompt that already stopped never makes
// the terminal busy again, and a Stop for an older prompt never idles a newer one.
// Esc while Claude is still thinking leaves no structured trace: the terminal
// stays busy until the next event (documented gap; no silence heuristic).
//
// Dialogs: one per waiting PermissionRequest hook. The hub owns its lifetime:
// it answers it from the dock, or releases it with `{}` once the terminal
// decided (PostToolUse/PostToolUseFailure for the same prompt + tool + input;
// PreToolUse runs BEFORE the permission check, so it proves nothing), the prompt
// stopped, a new prompt started, the session ended or the terminal closed. A
// hook Claude SIGTERMs (terminal No/Esc) reports `cancelled`. Known gap: a
// terminal "Yes" neither SIGTERMs the hook nor writes the transcript until the
// tool finishes (verified on CC 2.1.316), so the dock ask stays open meanwhile.

import type { OkenaClaudeDecision } from '../agent-dock/act'
import { stableJson } from '../agent-dock/model'
import { planApproveMode } from '../agent-dock/review'
import { CANCELLED_OUTPUT, type HookDecisionResult, hookDecisionOutput } from './decision'

export interface TerminalRef {
	profileId: string
	terminalId: string
}

export const terminalKey = (ref: TerminalRef): string => `${ref.profileId}:${ref.terminalId}`

/** The waiting hook's connection: called once with the hook's stdout JSON. */
export interface PendingHook {
	respond(output: Readonly<Record<string, unknown>>): void
}

export class HubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

export const TRANSCRIPT_PAGE_MAX = 200
export const ENTRY_TEXT_MAX = 64 * 1024
const ENTRIES_MAX = 400
const FINISHED_PROMPTS_MAX = 64
const ENDED_SESSIONS_MAX = 32
export const EXCLUDED_SESSIONS_MAX = 64
const DIALOGS_MAX = 32
const SUBAGENTS_MAX = 64
const LIFELINES_MAX = 8
/** Event strings longer than this are cut by the hook client (hook-client.cjs EVENT_STRING_MAX). */
export const EVENT_STRING_MAX = 4096
/** A reply the hub typed blocks a second one until its UserPromptSubmit, at most this long. */
export const TYPING_GUARD_MS = 5_000
/** A transcript marker this much older than the active prompt's hook belongs to an earlier prompt. */
const MARKER_SLACK_MS = 250

interface Dialog {
	id: string
	toolName: string
	toolInput: unknown
	suggestions: unknown[]
	createdAtMs: number
	sessionId: string
	promptId?: string
	agentId?: string
	hook: PendingHook
}

interface Primary {
	pid: number
	sessionId: string
	cwd?: string
	transcriptPath?: string
	since: number
	ended: boolean
}

interface Entry {
	seq: number
	kind: 'user' | 'assistant'
	uuid: string
	text: string
}

interface TerminalState {
	ref: TerminalRef
	primary?: Primary
	/** A top-level claude started here without hooks (the user's own --settings). */
	degraded?: { pid: number; reason: string; cwd?: string; at: number }
	busy?: boolean
	activePrompt?: { id?: string; at: number }
	finished: string[]
	endedSessions: string[]
	dialogs: Dialog[]
	subagents: Map<string, string>
	backgroundTasks: number
	entries: Entry[]
	nextSeq: number
	typingUntil?: number
	/** Open lifelines by claude pid (count: a reconnect may overlap the old close). */
	lifelines: Map<number, number>
	/** `helm dock watch` registered this session id before the hub knew the session. */
	pendingDispatcher?: string
}

export interface HubCoreOptions {
	/** Dialog id prefix, new per hub start (the reducer orphans asks across a prefix change). */
	prefix: string
	/** Sessions to hide entirely (the dispatcher's own). */
	excluded?: Iterable<string>
	onExcludedChange?(ids: string[]): void
	/** Display name of a Helm terminal (its tab name), if any. */
	terminalName?(ref: TerminalRef): string | undefined
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

function bounded(text: string, max = ENTRY_TEXT_MAX): string {
	if (text.length <= max) return text
	let end = max - 1
	const code = text.charCodeAt(end - 1)
	if (code >= 0xd800 && code <= 0xdbff) end -= 1
	return `${text.slice(0, end)}…`
}

/** Okena's dialog view bound: strings over 16 KiB (UTF-8) are cut and marked, so review.ts refuses Allow on them. */
export const DIALOG_STRING_MAX_BYTES = 16 * 1024
export const DIALOG_TRUNCATION_MARK = '\n… (truncated)'

/** `value` with every long string cut and marked (keys untouched), as Okena's GET shows dialogs. */
export function truncateLongStrings(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') {
		if (Buffer.byteLength(value) <= DIALOG_STRING_MAX_BYTES) return value
		let kept = Buffer.from(value).subarray(0, DIALOG_STRING_MAX_BYTES).toString('utf8')
		if (kept.endsWith('\uFFFD')) kept = kept.slice(0, -1)
		return `${kept}${DIALOG_TRUNCATION_MARK}`
	}
	if (depth > 64) return value
	if (Array.isArray(value)) return value.map(entry => truncateLongStrings(entry, depth + 1))
	if (isRecord(value))
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, truncateLongStrings(entry, depth + 1)]))
	return value
}

function pushBounded(list: string[], value: string, max: number): void {
	if (list.includes(value)) return
	list.push(value)
	if (list.length > max) list.splice(0, list.length - max)
}

/** `value` with every string over EVENT_STRING_MAX code units cut to it (idempotent; hook-client.cjs `clip`). */
export function clipStrings(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') return value.length > EVENT_STRING_MAX ? value.slice(0, EVENT_STRING_MAX) : value
	if (depth > 64) return value
	if (Array.isArray(value)) return value.map(entry => clipStrings(entry, depth + 1))
	if (isRecord(value))
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clipStrings(entry, depth + 1)]))
	return value
}

/**
 * Post-tool input for the same call: equal, or the request's input with fields added (AskUserQuestion
 * answers), or empty (ExitPlanMode). Compared clipped: the hook client sends event strings clipped.
 */
function sameCall(fullRequested: unknown, clippedRan: unknown): boolean {
	const requested = clipStrings(fullRequested)
	const ran = clipStrings(clippedRan)
	if (stableJson(requested) === stableJson(ran)) return true
	if (!isRecord(ran)) return false
	if (Object.keys(ran).length === 0) return true
	if (!isRecord(requested)) return false
	return Object.entries(requested).every(([key, value]) => stableJson(ran[key]) === stableJson(value))
}

export class ClaudeHubCore {
	private readonly terminals = new Map<string, TerminalState>()
	private readonly excluded: string[]
	private dialogCounter = 0
	private assistantCounter = 0
	/** Bumped on every visible change (Okena `state_version`). */
	stateVersion = 1

	constructor(private readonly options: HubCoreOptions) {
		this.excluded = [...(options.excluded ?? [])].slice(-EXCLUDED_SESSIONS_MAX)
	}

	get prefix(): string {
		return this.options.prefix
	}

	// -------------------------------------------------------------------------
	// Inputs
	// -------------------------------------------------------------------------

	/** One async hook event (everything except PermissionRequest). */
	event(ref: TerminalRef, pid: number, at: number, input: unknown): void {
		if (!isRecord(input)) return
		const name = str(input.hook_event_name)
		const sessionId = str(input.session_id)
		if (!name || !sessionId) return
		// Claude's internal forks: a SubagentStop with an empty agent_type after almost every turn.
		if ((name === 'SubagentStop' || name === 'SubagentStart') && str(input.agent_type) === undefined) return
		const t = this.terminal(ref)
		if (name === 'SessionStart') {
			this.sessionStart(t, pid, sessionId, input, at)
			return
		}
		if (!this.accepts(t, pid, sessionId, at, input)) return
		const promptId = str(input.prompt_id)
		switch (name) {
			case 'UserPromptSubmit':
				this.userPrompt(t, promptId, typeof input.prompt === 'string' ? input.prompt : '', at)
				return
			case 'PreToolUse':
				this.working(t, promptId, at)
				return
			case 'PostToolUse':
			case 'PostToolUseFailure':
				this.releaseRan(t, promptId, str(input.tool_name), input.tool_input)
				this.working(t, promptId, at)
				return
			case 'Stop':
			case 'StopFailure':
				this.stop(t, name, promptId, input)
				return
			case 'SessionEnd':
				this.sessionEnd(t)
				return
			case 'SubagentStart': {
				const agentId = str(input.agent_id) ?? `agent-${t.subagents.size}`
				// Lost or out-of-order SubagentStops must not grow this without bound.
				if (!t.subagents.has(agentId) && t.subagents.size >= SUBAGENTS_MAX) return
				t.subagents.set(agentId, str(input.agent_type) ?? '')
				this.changed()
				return
			}
			case 'SubagentStop':
				if (t.subagents.delete(str(input.agent_id) ?? '')) this.changed()
				return
		}
	}

	/**
	 * A waiting PermissionRequest hook. Returns the dialog id, or null when the hook
	 * was answered `{}` at once (not this terminal's primary session, or hidden).
	 */
	permission(ref: TerminalRef, pid: number, at: number, input: unknown, hook: PendingHook): string | null {
		const leave = () => {
			hook.respond(CANCELLED_OUTPUT)
			return null
		}
		if (!isRecord(input)) return leave()
		const sessionId = str(input.session_id)
		const toolName = str(input.tool_name)
		if (!sessionId || !toolName) return leave()
		const t = this.terminal(ref)
		if (!this.accepts(t, pid, sessionId, at, input) || this.isExcluded(sessionId)) return leave()
		if (t.dialogs.length >= DIALOGS_MAX) return leave()
		const promptId = str(input.prompt_id)
		const dialog: Dialog = {
			id: `${this.options.prefix}-${++this.dialogCounter}`,
			toolName,
			toolInput: input.tool_input,
			suggestions: Array.isArray(input.permission_suggestions) ? [...input.permission_suggestions] : [],
			createdAtMs: at,
			sessionId,
			promptId,
			agentId: str(input.agent_id),
			hook,
		}
		t.dialogs.push(dialog)
		// A background subagent's dialog while the main agent idles does not make it busy.
		if (!this.isFinished(t, promptId)) this.markBusy(t, promptId, at)
		this.changed()
		return dialog.id
	}

	/** The waiting hook went away: Claude SIGTERMed it (terminal No/Esc) or its connection dropped. */
	hookGone(ref: TerminalRef, dialogId: string): void {
		const t = this.terminals.get(terminalKey(ref))
		if (!t) return
		const before = t.dialogs.length
		t.dialogs = t.dialogs.filter(dialog => dialog.id !== dialogId)
		if (t.dialogs.length !== before) this.changed()
	}

	/** The preload saw this terminal's interactive claude start without hooks (user --settings). */
	degraded(ref: TerminalRef, pid: number, reason: string, cwd: string | undefined, at: number): void {
		const t = this.terminal(ref)
		// The token is in the agent's tool env: a tool child cannot knock out a primary whose claude still runs.
		const primary = t.primary
		if (primary && !primary.ended && primary.pid !== pid && this.hasLifeline(t, primary.pid)) return
		this.releaseAll(t)
		t.primary = undefined
		t.degraded = { pid, reason: reason.slice(0, 64), cwd, at }
		this.resetSession(t)
		t.busy = undefined
		this.changed()
	}

	/** The preload of claude `pid` in this terminal opened its lifeline. */
	attached(ref: TerminalRef, pid: number): void {
		const t = this.terminal(ref)
		if (!t.lifelines.has(pid) && t.lifelines.size >= LIFELINES_MAX) return
		t.lifelines.set(pid, (t.lifelines.get(pid) ?? 0) + 1)
	}

	/** That lifeline closed: claude `pid` exited (any way), or its connection dropped. */
	detached(ref: TerminalRef, pid: number): void {
		const t = this.terminals.get(terminalKey(ref))
		const count = t?.lifelines.get(pid)
		if (!t || count === undefined) return
		if (count > 1) {
			t.lifelines.set(pid, count - 1)
			return
		}
		t.lifelines.delete(pid)
		if (t.primary && !t.primary.ended && t.primary.pid === pid) this.sessionEnd(t)
	}

	/** Helm quits: forget everything WITHOUT answering waiting hooks (they reconnect to the next hub). */
	shutdown(): void {
		for (const t of this.terminals.values()) t.dialogs = []
		this.terminals.clear()
		this.changed()
	}

	/** Helm's own terminal lifecycle: the dtach session is gone (structured, not inferred). */
	terminalClosed(ref: TerminalRef): void {
		const t = this.terminals.get(terminalKey(ref))
		if (!t) return
		this.releaseAll(t)
		this.terminals.delete(terminalKey(ref))
		this.changed()
	}

	/** A transcript `[Request interrupted by user…]` marker (structured: Claude wrote it). */
	interrupted(ref: TerminalRef, sessionId: string, markerAt: number): void {
		const t = this.terminals.get(terminalKey(ref))
		if (!t?.primary || t.primary.ended || t.primary.sessionId !== sessionId || t.busy !== true) return
		const active = t.activePrompt
		if (!active || markerAt + MARKER_SLACK_MS < active.at) return
		if (active.id) pushBounded(t.finished, active.id, FINISHED_PROMPTS_MAX)
		this.releaseWhere(t, dialog => !dialog.agentId && dialog.promptId === active.id)
		t.busy = false
		t.activePrompt = undefined
		this.changed()
	}

	/**
	 * `helm dock watch` (in this token's terminal) registered its Claude session as the dispatcher.
	 * Only this terminal's own primary can be hidden this way; before the hub knows the session,
	 * the id waits for it.
	 */
	registerDispatcher(ref: TerminalRef, sessionId: string): void {
		const t = this.terminal(ref)
		const primary = t.primary
		if (primary && !primary.ended) {
			if (primary.sessionId === sessionId) this.exclude(sessionId)
			return
		}
		t.pendingDispatcher = sessionId
	}

	/** Hide a session entirely (the dispatcher's own; persisted ids are loaded through here). */
	exclude(sessionId: string): void {
		if (this.excluded.includes(sessionId)) return
		pushBounded(this.excluded, sessionId, EXCLUDED_SESSIONS_MAX)
		for (const t of this.terminals.values())
			if (t.primary?.sessionId === sessionId) this.releaseWhere(t, dialog => dialog.sessionId === sessionId)
		this.options.onExcludedChange?.([...this.excluded])
		this.changed()
	}

	isExcluded(sessionId: string | undefined): boolean {
		return sessionId !== undefined && this.excluded.includes(sessionId)
	}

	excludedSessions(): string[] {
		return [...this.excluded]
	}

	/** Jakub's dock answer: encode it and hand it to the waiting hook. */
	decide(ref: TerminalRef, dialogId: string, decision: OkenaClaudeDecision): void {
		const t = this.visibleTerminal(ref)
		const dialog = t.dialogs.find(entry => entry.id === dialogId)
		if (!dialog) throw new HubError(404, 'dialog is no longer open')
		// Approving a plan from the dock also leaves plan mode for accept edits (review.ts planApproveMode).
		const mode =
			dialog.toolName === 'ExitPlanMode' && decision.decision === 'allow' && !decision.always
				? (planApproveMode('helm') ?? undefined)
				: undefined
		const result: HookDecisionResult = hookDecisionOutput(
			{ toolName: dialog.toolName, toolInput: dialog.toolInput, suggestions: dialog.suggestions },
			decision,
			mode,
		)
		if (!result.ok) throw new HubError(result.status, result.error)
		t.dialogs = t.dialogs.filter(entry => entry !== dialog)
		dialog.hook.respond(result.output)
		this.changed()
	}

	/** Whether a reply may be typed into this terminal now; throws a 409 HubError otherwise. */
	checkPrompt(ref: TerminalRef, now: number): void {
		const t = this.visibleTerminal(ref)
		if (!t.primary || t.primary.ended) throw new HubError(409, 'No Claude session with hooks in this terminal.')
		// Without claude's own open connection the pty may hold a bare shell: never type into it.
		if (!this.hasLifeline(t, t.primary.pid))
			throw new HubError(409, 'The Claude session is not connected to Helm; reply in the terminal.')
		if (t.dialogs.length > 0) throw new HubError(409, 'The agent has an open dialog; answer that first.')
		if (t.busy !== false) throw new HubError(409, 'The agent is not idle; reply when it stops.')
		if (t.typingUntil !== undefined && now < t.typingUntil) throw new HubError(409, 'A reply is still being typed.')
	}

	/** The hub typed a reply: block another until its UserPromptSubmit (or TYPING_GUARD_MS). */
	typed(ref: TerminalRef, now: number): void {
		const t = this.terminals.get(terminalKey(ref))
		if (t) t.typingUntil = now + TYPING_GUARD_MS
	}

	// -------------------------------------------------------------------------
	// Views (Okena Claude Remote shapes; see app/src/agent-dock/model.ts)
	// -------------------------------------------------------------------------

	/** Transcript paths of busy primaries (the hub tails them for interrupt markers). */
	busyTranscripts(): Array<{ ref: TerminalRef; sessionId: string; path: string }> {
		const out: Array<{ ref: TerminalRef; sessionId: string; path: string }> = []
		for (const t of this.terminals.values()) {
			const primary = t.primary
			if (primary && !primary.ended && t.busy === true && primary.transcriptPath)
				out.push({ ref: t.ref, sessionId: primary.sessionId, path: primary.transcriptPath })
		}
		return out
	}

	/** Working directories of the sessions `stateJson(profileId)` lists (the hub reads their git branches). */
	projectCwds(profileId: string): string[] {
		const cwds = new Set<string>()
		for (const t of this.terminals.values()) {
			if (t.ref.profileId !== profileId || !this.listed(t)) continue
			const cwd = t.primary?.cwd ?? t.degraded?.cwd
			if (cwd) cwds.add(cwd)
		}
		return [...cwds]
	}

	/** Okena's state view; `branchOf` fills each cwd project's `git_status.branch` (the dock's short agent names). */
	stateJson(profileId: string, branchOf?: (cwd: string) => string | undefined): Record<string, unknown> {
		const sessions: string[] = []
		const dialogs: Record<string, number> = {}
		const projects = new Map<
			string,
			{
				id: string
				name: string
				path?: string
				terminal_names: Record<string, string>
				/** Flat pane list in Okena's layout shape: the dock finds a terminal's project by it (named or not). */
				layout: { type: 'tabs'; children: Array<{ type: 'terminal'; terminal_id: string }> }
				git_status?: { branch: string }
			}
		>()
		for (const t of this.terminals.values()) {
			if (t.ref.profileId !== profileId || !this.listed(t)) continue
			const id = t.ref.terminalId
			sessions.push(id)
			if (t.dialogs.length > 0) dialogs[id] = t.dialogs.length
			const cwd = t.primary?.cwd ?? t.degraded?.cwd
			const projectId = cwd ? `cwd:${cwd}` : 'helm'
			const branch = cwd ? branchOf?.(cwd) : undefined
			const project = projects.get(projectId) ?? {
				id: projectId,
				name: cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : 'Helm',
				...(cwd ? { path: cwd } : {}),
				terminal_names: {},
				layout: { type: 'tabs', children: [] },
				...(branch ? { git_status: { branch } } : {}),
			}
			project.layout.children.push({ type: 'terminal', terminal_id: id })
			const name = this.options.terminalName?.(t.ref)
			if (name) project.terminal_names[id] = name
			projects.set(projectId, project)
		}
		return {
			state_version: this.stateVersion,
			claude_sessions: sessions.sort(),
			claude_dialogs: dialogs,
			projects: [...projects.values()],
		}
	}

	session(ref: TerminalRef): Record<string, unknown> {
		const t = this.visibleTerminal(ref)
		const primary = t.primary && !t.primary.ended ? t.primary : undefined
		const running = [...t.subagents.entries()].map(([agent_id, agent_type]) => ({ agent_id, agent_type }))
		for (let index = 0; index < t.backgroundTasks; index++)
			running.push({ agent_id: `background-${index + 1}`, agent_type: 'background task' })
		return {
			terminal_id: ref.terminalId,
			...(primary ? { session_id: primary.sessionId } : {}),
			has_transcript: primary !== undefined,
			hooks_attached: primary !== undefined,
			channel_attached: false,
			...(primary && t.busy !== undefined ? { busy: t.busy } : {}),
			queued_prompts: 0,
			dialogs: t.dialogs.map(dialog => ({
				id: dialog.id,
				tool_name: dialog.toolName,
				tool_input: truncateLongStrings(dialog.toolInput),
				permission_suggestions: truncateLongStrings(dialog.suggestions),
				created_at_ms: dialog.createdAtMs,
			})),
			running_subagents: primary ? running : [],
			pr_links: [],
		}
	}

	/** Hub-built transcript from structured hook text: UserPromptSubmit prompts and Stop's last_assistant_message. */
	transcript(ref: TerminalRef, query: { cursor?: number; sessionId?: string }): Record<string, unknown> {
		const t = this.visibleTerminal(ref)
		const primary = t.primary
		if (!primary || primary.ended) throw new HubError(404, 'No Claude session with hooks in this terminal.')
		const first = t.entries[0]?.seq ?? t.nextSeq
		const continuation =
			query.cursor !== undefined &&
			query.sessionId === primary.sessionId &&
			query.cursor >= first &&
			query.cursor <= t.nextSeq
		const entries = continuation
			? t.entries.filter(entry => entry.seq >= (query.cursor as number))
			: t.entries.slice(-TRANSCRIPT_PAGE_MAX)
		return {
			session_id: primary.sessionId,
			entries: entries.map(entry =>
				entry.kind === 'user'
					? { kind: 'user', uuid: entry.uuid, text: entry.text, origin: 'terminal' }
					: { kind: 'assistant', uuid: entry.uuid, text: entry.text },
			),
			cursor: t.nextSeq,
			reset: !continuation,
		}
	}

	terminalRefs(): TerminalRef[] {
		return [...this.terminals.values()].map(t => t.ref)
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	private changed(): void {
		this.stateVersion += 1
	}

	private terminal(ref: TerminalRef): TerminalState {
		const key = terminalKey(ref)
		let t = this.terminals.get(key)
		if (!t) {
			t = {
				ref: { ...ref },
				finished: [],
				endedSessions: [],
				dialogs: [],
				subagents: new Map(),
				backgroundTasks: 0,
				entries: [],
				nextSeq: 1,
				lifelines: new Map(),
			}
			this.terminals.set(key, t)
		}
		return t
	}

	private listed(t: TerminalState): boolean {
		if (t.primary && !t.primary.ended) return !this.isExcluded(t.primary.sessionId)
		return t.primary === undefined && t.degraded !== undefined
	}

	/** A terminal the dock may see (404 otherwise, like Okena for an unknown pane). */
	private visibleTerminal(ref: TerminalRef): TerminalState {
		const t = this.terminals.get(terminalKey(ref))
		if (!t || !this.listed(t)) throw new HubError(404, 'No Claude session in this Helm terminal.')
		return t
	}

	/**
	 * Fencing for every event but SessionStart: only the primary (pid, session) counts.
	 * With no live primary (hub restarted mid-session, or a SessionStart lost), the first
	 * event of a session that has not ended here adopts it.
	 */
	private accepts(
		t: TerminalState,
		pid: number,
		sessionId: string,
		at: number,
		input: Record<string, unknown>,
	): boolean {
		const primary = t.primary
		const cwd = str(input.cwd)
		const transcriptPath = str(input.transcript_path)
		if (primary && !primary.ended) {
			if (primary.pid !== pid || primary.sessionId !== sessionId) return false
			// Adopted without SessionStart (hub restarted): every hook payload carries both.
			if ((cwd && !primary.cwd) || (transcriptPath && !primary.transcriptPath)) {
				primary.cwd ??= cwd
				primary.transcriptPath ??= transcriptPath
				this.changed()
			}
			return true
		}
		if (t.endedSessions.includes(sessionId)) return false
		this.adopt(t, { pid, sessionId, cwd, transcriptPath, since: at, ended: false })
		return true
	}

	private adopt(t: TerminalState, primary: Primary): void {
		this.releaseAll(t)
		t.primary = primary
		t.degraded = undefined
		this.resetSession(t)
		if (t.pendingDispatcher === primary.sessionId) this.exclude(primary.sessionId)
		t.pendingDispatcher = undefined
		this.changed()
	}

	private hasLifeline(t: TerminalState, pid: number): boolean {
		return (t.lifelines.get(pid) ?? 0) > 0
	}

	private resetSession(t: TerminalState): void {
		t.busy = undefined
		t.activePrompt = undefined
		t.finished = []
		t.subagents.clear()
		t.backgroundTasks = 0
		t.entries = []
		t.typingUntil = undefined
	}

	private sessionStart(
		t: TerminalState,
		pid: number,
		sessionId: string,
		input: Record<string, unknown>,
		at: number,
	): void {
		const source = str(input.source)
		const cwd = str(input.cwd)
		const transcriptPath = str(input.transcript_path)
		const current = t.primary
		if (current && !current.ended && current.pid === pid && current.sessionId === sessionId) {
			if (cwd) current.cwd = cwd
			if (transcriptPath) current.transcriptPath = transcriptPath
			if (source !== 'compact') this.idle(t)
			this.changed()
			return
		}
		// /clear, /resume, … keep the claude process: the dispatcher stays hidden under its new session id.
		const dispatcher = current !== undefined && current.pid === pid && this.isExcluded(current.sessionId)
		if (current && current.sessionId !== sessionId) pushBounded(t.endedSessions, current.sessionId, ENDED_SESSIONS_MAX)
		t.endedSessions = t.endedSessions.filter(id => id !== sessionId)
		this.adopt(t, { pid, sessionId, cwd, transcriptPath, since: at, ended: false })
		if (dispatcher) this.exclude(sessionId)
		t.busy = source === 'compact'
	}

	private sessionEnd(t: TerminalState): void {
		const primary = t.primary
		if (!primary) return
		primary.ended = true
		pushBounded(t.endedSessions, primary.sessionId, ENDED_SESSIONS_MAX)
		this.releaseAll(t)
		t.busy = undefined
		t.activePrompt = undefined
		t.subagents.clear()
		t.backgroundTasks = 0
		this.changed()
	}

	private isFinished(t: TerminalState, promptId: string | undefined): boolean {
		return promptId !== undefined && t.finished.includes(promptId)
	}

	private markBusy(t: TerminalState, promptId: string | undefined, at: number): void {
		if (t.busy !== true || !t.activePrompt) t.activePrompt = { id: promptId, at }
		t.busy = true
	}

	private idle(t: TerminalState): void {
		t.busy = false
		t.activePrompt = undefined
	}

	private userPrompt(t: TerminalState, promptId: string | undefined, prompt: string, at: number): void {
		t.typingUntil = undefined
		// A background subagent's completion is delivered as a prompt; it is not a reply.
		if (!prompt.trimStart().startsWith('<task-notification>')) this.userEntry(t, promptId, prompt)
		// Async hooks: this prompt's Stop may already have arrived. Then it is not busy again.
		if (this.isFinished(t, promptId)) {
			this.changed()
			return
		}
		// A new prompt: the terminal moved past every main-agent dialog of earlier prompts (only
		// dialogs older than it: a very late UserPromptSubmit must not release a newer prompt's).
		this.releaseWhere(t, dialog => !dialog.agentId && dialog.promptId !== promptId && dialog.createdAtMs < at)
		t.busy = true
		t.activePrompt = { id: promptId, at }
		this.changed()
	}

	/**
	 * The prompt's user entry, once. When its assistant entry is already there (Stop arrived first),
	 * the user entry goes before it and every entry is renumbered, so readers get a reset page in
	 * the right order instead of a "reply" after the answer.
	 */
	private userEntry(t: TerminalState, promptId: string | undefined, prompt: string): void {
		const uuid = `user-${promptId ?? `${t.nextSeq}`}`
		if (t.entries.some(entry => entry.uuid === uuid)) return
		const answer = promptId
			? t.entries.findIndex(
					entry =>
						entry.kind === 'assistant' &&
						(entry.uuid === `assistant-${promptId}` || entry.uuid.startsWith(`assistant-${promptId}-`)),
				)
			: -1
		if (answer === -1) {
			this.pushEntry(t, 'user', uuid, prompt)
			return
		}
		const user: Entry = { seq: 0, kind: 'user', uuid, text: bounded(prompt) }
		const ordered = [...t.entries.slice(0, answer), user, ...t.entries.slice(answer)]
		t.entries = ordered.map(entry => ({ ...entry, seq: t.nextSeq++ })).slice(-ENTRIES_MAX)
	}

	private working(t: TerminalState, promptId: string | undefined, at: number): void {
		if (this.isFinished(t, promptId)) return
		const wasBusy = t.busy === true
		this.markBusy(t, promptId, at)
		if (!wasBusy) this.changed()
	}

	private stop(
		t: TerminalState,
		name: 'Stop' | 'StopFailure',
		promptId: string | undefined,
		input: Record<string, unknown>,
	): void {
		if (promptId) pushBounded(t.finished, promptId, FINISHED_PROMPTS_MAX)
		this.releaseWhere(t, dialog => !dialog.agentId && (promptId === undefined || dialog.promptId === promptId))
		const active = t.activePrompt
		const newer =
			active?.id !== undefined && promptId !== undefined && active.id !== promptId && !this.isFinished(t, active.id)
		if (!newer) this.idle(t)
		t.backgroundTasks = Array.isArray(input.background_tasks) ? Math.min(input.background_tasks.length, 32) : 0
		const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''
		const text =
			name === 'StopFailure'
				? `API error: ${message || str(input.error) || 'unknown'}`.trim()
				: message.trim()
					? message
					: ''
		if (text) {
			const base = `assistant-${promptId ?? 'turn'}`
			const uuid = t.entries.some(entry => entry.uuid === base) ? `${base}-${++this.assistantCounter}` : base
			this.pushEntry(t, 'assistant', uuid, text)
		}
		this.changed()
	}

	private pushEntry(t: TerminalState, kind: Entry['kind'], uuid: string, text: string): void {
		t.entries.push({ seq: t.nextSeq++, kind, uuid, text: bounded(text) })
		if (t.entries.length > ENTRIES_MAX) t.entries.splice(0, t.entries.length - ENTRIES_MAX)
	}

	/** The terminal answered: the PostToolUse(Failure) of the dialog's call releases its hook. */
	private releaseRan(
		t: TerminalState,
		promptId: string | undefined,
		toolName: string | undefined,
		toolInput: unknown,
	): void {
		if (!toolName) return
		const match = t.dialogs.find(
			dialog => dialog.toolName === toolName && dialog.promptId === promptId && sameCall(dialog.toolInput, toolInput),
		)
		if (match) this.releaseWhere(t, dialog => dialog === match)
	}

	private releaseWhere(t: TerminalState, predicate: (dialog: Dialog) => boolean): void {
		const released = t.dialogs.filter(predicate)
		if (released.length === 0) return
		t.dialogs = t.dialogs.filter(dialog => !released.includes(dialog))
		for (const dialog of released) dialog.hook.respond(CANCELLED_OUTPUT)
		this.changed()
	}

	private releaseAll(t: TerminalState): void {
		this.releaseWhere(t, () => true)
	}
}
