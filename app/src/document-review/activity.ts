// Document Review's send activity line from a bound caller's own session file (helm open spec D14, S12): a Claude
// Code transcript or a Codex rollout. Pure: the IO lives in activity-watcher.ts.
//
// Display only and never trusted. A line feeds at most the verb, the working flag, an output-token count and a
// "something new happened" counter the host may use to renew the completion deadline (capped). Nothing here
// confirms delivery, settles a request, authorises a reply or reaches the journal.
//
// Binding: nothing counts until a main-thread tool result written after the ack contains the exact delivered
// request id (the `helm edit` call's output, or the poll that returned it). That text is scanned in memory for the
// id only; no text, tool input or result is kept. Subagent, sidechain and other-session records never bind and
// never count. Unknown shapes, a version change or too many messages fail closed: the line falls back to elapsed
// time only, for this request, for good.

/** Clock skew allowed between the host's ack and the record that carries the id. */
export const BIND_SKEW_MS = 1000
/** A tool call with no newer record for this long may be a prompt in the terminal: stop claiming work. */
export const TOOL_SILENCE_MS = 30_000
/** Distinct Claude messages counted per request; more fails closed. */
export const MESSAGES_MAX = 4096
/** Tool calls waiting for their result at once; more fails closed. */
export const PENDING_TOOLS_MAX = 64
/** Claude Code's main-thread records that close a turn (written after a reply, an API error or an interrupt). */
const CLAUDE_TURN_END = new Set(['stop_hook_summary', 'turn_duration'])

export type ActivityProvider = 'claude' | 'codex'

export interface ActivityTrack {
	provider: ActivityProvider
	/** The provider session (Claude session id / Codex thread id) the caller hinted at connect. */
	session: string
	requestId: string
	/** Host clock at delivery confirmation (the ack). */
	ackAt: number
	failed: string | null
	bound: boolean
	/** Provider version seen at binding (Claude `version`, Codex `cli_version`); a change fails closed. */
	version: string | null
	working: boolean
	/** Generic verb of the running tool; null = a model request is in flight ("Thinking"). */
	verb: string | null
	/** Record time of the latest tool call that still waits for its result (or of a call with no id). */
	toolSince: number | null
	/** Ids of tool calls without a result yet: one result of parallel calls does not end the wait. */
	pending: string[]
	/** Bumped on every bound record that shows the caller still on this request. */
	serial: number
	/** Claude: output tokens per distinct message id. */
	messages: Map<string, number>
	/** Codex: `total_token_usage.output_tokens` before the first response after binding, and now. */
	baseline: number | null
	total: number | null
	/** Codex: binding seen, no model output since (a token_count now still belongs to the earlier response). */
	settlingBaseline: boolean
}

export function startTrack(
	provider: ActivityProvider,
	session: string,
	requestId: string,
	ackAt: number,
): ActivityTrack {
	return {
		provider,
		session,
		requestId,
		ackAt,
		failed: null,
		bound: false,
		version: null,
		working: false,
		verb: null,
		toolSince: null,
		pending: [],
		serial: 0,
		messages: new Map(),
		baseline: null,
		total: null,
		settlingBaseline: false,
	}
}

/** What the line may show now; null = elapsed only. */
export function trackView(
	track: ActivityTrack,
	now: number,
): { working: boolean; verb: string | null; outputTokens: number | null } | null {
	if (track.failed || !track.bound) return null
	const silent = track.toolSince !== null && now - track.toolSince >= TOOL_SILENCE_MS
	let outputTokens: number | null = null
	if (track.provider === 'claude') {
		outputTokens = 0
		for (const value of track.messages.values()) outputTokens += value
	} else if (track.baseline !== null && track.total !== null) outputTokens = Math.max(0, track.total - track.baseline)
	const working = track.working && !silent
	return { working, verb: working ? track.verb : null, outputTokens }
}

/** A generic word for a tool; never its input, and never an MCP server or tool name. */
export function toolVerb(name: string): string {
	if (/^(Read|NotebookRead|read_file|view_image|ImageView)$/.test(name)) return 'Reading'
	if (
		/^(Grep|Glob|LS|WebSearch|WebFetch|ToolSearch|tool_search|tool_search_call|web_search|web_search_call|grep_files|list_dir)$/.test(
			name,
		)
	)
		return 'Searching'
	if (/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/.test(name)) return 'Editing'
	if (
		/^(Bash|BashOutput|KillShell|PowerShell|exec|exec_command|write_stdin|shell|local_shell|local_shell_call|unified_exec|js)$/.test(
			name,
		)
	)
		return 'Running a command'
	return 'Working'
}

const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const fail = (track: ActivityTrack, reason: string): ActivityTrack => ({ ...track, failed: reason, working: false })
/** The turn is over (reply, error, interrupt): not working until a newer record says so. */
const idle = (track: ActivityTrack): ActivityTrack => ({
	...track,
	working: false,
	verb: null,
	toolSince: null,
	pending: [],
	serial: track.serial + 1,
})
/** A tool came back: the wait ends only when no other call of the same response still waits. */
function returned(track: ActivityTrack, ids: string[]): ActivityTrack {
	const pending = track.pending.filter(id => !ids.includes(id))
	const waiting = pending.length > 0
	return {
		...track,
		working: true,
		pending,
		verb: waiting ? track.verb : null,
		toolSince: waiting ? track.toolSince : null,
		serial: track.serial + 1,
	}
}
/** A tool call: shown by its verb, counted for the 30 s silence rule until its result. */
function called(track: ActivityTrack, verb: string, at: number, id: unknown): ActivityTrack | null {
	const pending = typeof id === 'string' && id && !track.pending.includes(id) ? [...track.pending, id] : track.pending
	if (pending.length > PENDING_TOOLS_MAX) return null
	return { ...track, working: true, verb, toolSince: at, pending }
}
/** Before binding nothing is shown, so an odd older record is skipped; after it, the line fails closed. */
const odd = (track: ActivityTrack): ActivityTrack => (track.bound ? fail(track, 'unknown record shape') : track)

/** Text of a tool result/output, only to look for the request id; never kept. */
function resultContains(content: unknown, id: string, depth = 0): boolean {
	if (typeof content === 'string') return content.includes(id)
	if (depth > 3) return false
	if (Array.isArray(content)) return content.slice(0, 64).some(item => resultContains(item, id, depth + 1))
	const item = record(content)
	if (!item) return false
	return typeof item.text === 'string' ? item.text.includes(id) : resultContains(item.content, id, depth + 1)
}

function parse(line: string): Record<string, unknown> | null {
	try {
		return record(JSON.parse(line))
	} catch {
		return null
	}
}

const time = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : Number.NaN)

/** One Claude Code transcript line (2.1.x). */
export function applyClaudeLine(track: ActivityTrack, line: string): ActivityTrack {
	if (track.failed) return track
	const entry = parse(line)
	if (!entry || typeof entry.type !== 'string') return odd(track)
	// Subagents, sidechains and other sessions never bind or count.
	if (entry.isSidechain === true || (entry.sessionId !== undefined && entry.sessionId !== track.session)) return track
	if (typeof entry.agentId === 'string' && entry.agentId) return track
	const { type } = entry
	if (type !== 'user' && type !== 'assistant' && type !== 'api-request' && type !== 'system') return track
	if (type === 'system') {
		if (!track.bound || entry.isSidechain !== false || entry.sessionId !== track.session) return track
		return typeof entry.subtype === 'string' && CLAUDE_TURN_END.has(entry.subtype) ? idle(track) : track
	}
	const at = time(entry.timestamp)
	if (!Number.isFinite(at) || entry.sessionId !== track.session) return odd(track)
	if (track.bound && typeof entry.version === 'string' && track.version !== null && entry.version !== track.version)
		return fail(track, 'version changed')
	const message = record(entry.message)
	if (type !== 'api-request' && !message) return odd(track)
	const content = message?.content
	const toolResult = Array.isArray(content) && content.some(block => record(block)?.type === 'tool_result')
	if (!track.bound) {
		if (type !== 'user' || entry.isSidechain !== false || !toolResult || at < track.ackAt - BIND_SKEW_MS) return track
		const carries = (content as unknown[]).some(block => {
			const item = record(block)
			return item?.type === 'tool_result' && resultContains(item.content, track.requestId)
		})
		if (!carries) return track
		return {
			...track,
			bound: true,
			version: typeof entry.version === 'string' ? entry.version : null,
			working: true,
			verb: null,
			toolSince: null,
			serial: track.serial + 1,
		}
	}
	if (type === 'api-request') {
		if (entry.querySource !== 'repl_main_thread' && entry.querySource !== 'sdk') return track
		// A model request starts only once every tool of the last response came back.
		return { ...track, working: true, verb: null, toolSince: null, pending: [], serial: track.serial + 1 }
	}
	if (type === 'user') {
		// Local commands and compact summaries are not the agent working.
		if (entry.isSidechain !== false || entry.isMeta === true || entry.isCompactSummary === true) return track
		const blocks = Array.isArray(content) ? content.map(record) : []
		if (
			blocks.some(
				block =>
					block?.type === 'text' &&
					typeof block.text === 'string' &&
					block.text.startsWith('[Request interrupted by user'),
			)
		)
			return idle(track)
		if (toolResult)
			return returned(
				track,
				blocks.flatMap(block =>
					block?.type === 'tool_result' && typeof block.tool_use_id === 'string' ? [block.tool_use_id] : [],
				),
			)
		// A new prompt typed in the terminal.
		return { ...track, working: true, verb: null, toolSince: null, pending: [], serial: track.serial + 1 }
	}
	// assistant
	if (entry.isSidechain !== false || typeof message?.id !== 'string') return fail(track, 'unknown record shape')
	const messages = new Map(track.messages)
	const usage = record(message.usage)
	if (usage && typeof usage.output_tokens === 'number' && Number.isSafeInteger(usage.output_tokens)) {
		messages.set(message.id, Math.max(messages.get(message.id) ?? 0, Math.max(0, usage.output_tokens)))
		if (messages.size > MESSAGES_MAX) return fail(track, 'too many messages')
	}
	// Any stop other than for a tool ends the turn (end_turn; stop_sequence on Claude Code's synthetic API error).
	const stop = message.stop_reason
	if (stop !== undefined && stop !== null && stop !== 'tool_use') return idle({ ...track, messages })
	let next: ActivityTrack = { ...track, messages, working: true }
	if (Array.isArray(content))
		for (const block of content) {
			const item = record(block)
			if (item?.type !== 'tool_use' || typeof item.name !== 'string') continue
			const call = called(next, toolVerb(item.name), at, item.id)
			if (!call) return fail(track, 'too many tool calls')
			next = call
		}
	return { ...next, serial: track.serial + 1 }
}

const CODEX_CALLS = new Set([
	'function_call',
	'custom_tool_call',
	'local_shell_call',
	'web_search_call',
	'tool_search_call',
])
const CODEX_OUTPUTS = new Set([
	'function_call_output',
	'custom_tool_call_output',
	'local_shell_call_output',
	'tool_search_output',
])

/** One Codex rollout line (0.160.x). The file itself is already proven to be the thread's own rollout. */
export function applyCodexLine(track: ActivityTrack, line: string): ActivityTrack {
	if (track.failed) return track
	const entry = parse(line)
	if (!entry || typeof entry.type !== 'string') return odd(track)
	const payload = record(entry.payload)
	if (entry.type === 'session_meta') {
		if (!payload || payload.id !== track.session || typeof payload.cli_version !== 'string')
			return fail(track, 'not this thread')
		if (track.version !== null && payload.cli_version !== track.version) return fail(track, 'version changed')
		return { ...track, version: payload.cli_version }
	}
	if (entry.type !== 'response_item' && entry.type !== 'event_msg') return track
	if (!payload || typeof payload.type !== 'string') return odd(track)
	const at = time(entry.timestamp)
	if (!Number.isFinite(at)) return odd(track)
	const kind = payload.type
	if (entry.type === 'event_msg' && kind === 'token_count') {
		const info = record(payload.info)
		const total = record(info?.total_token_usage)?.output_tokens
		if (info === null) return track
		if (typeof total !== 'number' || !Number.isSafeInteger(total)) return odd(track)
		if (!track.bound || track.settlingBaseline) return { ...track, baseline: total, total }
		return { ...track, total }
	}
	if (!track.bound) {
		if (entry.type !== 'response_item' || !CODEX_OUTPUTS.has(kind) || at < track.ackAt - BIND_SKEW_MS) return track
		if (!resultContains(payload.output, track.requestId)) return track
		if (track.version === null) return fail(track, 'not this thread')
		return {
			...track,
			bound: true,
			working: true,
			verb: null,
			toolSince: null,
			settlingBaseline: true,
			serial: track.serial + 1,
		}
	}
	const step = (next: Partial<ActivityTrack>): ActivityTrack => ({ ...track, ...next, serial: track.serial + 1 })
	if (entry.type === 'event_msg') {
		if (kind === 'task_started') return step({ working: true, verb: null, toolSince: null })
		if (kind === 'task_complete' || kind === 'turn_aborted') return idle(track)
		return track
	}
	if (CODEX_CALLS.has(kind)) {
		const name = typeof payload.name === 'string' ? payload.name : kind
		const call = called(track, toolVerb(name), at, payload.call_id)
		if (!call) return fail(track, 'too many tool calls')
		return { ...call, settlingBaseline: false, serial: track.serial + 1 }
	}
	if (CODEX_OUTPUTS.has(kind)) return returned(track, typeof payload.call_id === 'string' ? [payload.call_id] : [])
	// The model answers only after every call of its last response came back.
	if (kind === 'reasoning' || (kind === 'message' && payload.role === 'assistant'))
		return step({ working: true, verb: null, toolSince: null, pending: [], settlingBaseline: false })
	if (kind === 'message' && payload.role === 'user')
		return step({ working: true, verb: null, toolSince: null, pending: [] })
	return track
}

export const applyLine = (track: ActivityTrack, line: string): ActivityTrack =>
	track.provider === 'claude' ? applyClaudeLine(track, line) : applyCodexLine(track, line)
