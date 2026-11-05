// Agent dock: the main agent's recent tool calls, read from the session's own
// JSONL transcript (claude-transcript-tail.ts feeds it lines), and the one
// question they answer: was this Okena dialog already answered in the terminal?
// Pure: no IO, no clocks.
//
// Why: Okena registers a dialog per waiting `PermissionRequest` hook and drops
// it on a `PostToolUse` whose `tool_input` EQUALS the dialog's. Claude adds
// `answers` to an AskUserQuestion's input once it is answered (and ExitPlanMode's
// input differs from its permission input), so a question answered in the
// terminal never matches: Okena keeps listing it until the turn's `Stop`, while
// the agent works on (observed 2026-11-05, Okena 60c5f41b, CC 2.1.318).
//
// The proof is structural and narrow: the dialog's own call (same tool, same
// input, written before the dialog was raised, the latest such call) has a
// tool_result written after the dialog was raised. A tool call runs only once
// its permission is decided, so such a result means the dialog no longer waits.
// Anything less (no matching call, a call without a result, a result older than
// the dialog, an unreadable record) claims nothing and the dialog stays.

/** One main-thread tool call. `input` has its strings clipped to CALL_STRING_MAX. */
export interface ToolCall {
	id: string
	name: string
	input: unknown
	/** The tool_use record's timestamp (ms). */
	at: number
	/** The first tool_result record's timestamp for this call (ms). */
	resultAt?: number
}

export interface ToolCallState {
	/** Oldest first, at most TOOL_CALLS_MAX. */
	calls: ToolCall[]
}

/** What an Okena dialog says about its call (the `ApiClaudeDialog` fields used here). */
export interface DialogCall {
	tool_name: string
	tool_input?: unknown
	created_at_ms: number
}

export const TOOL_CALLS_MAX = 64
/**
 * Strings are compared on their first CALL_STRING_MAX code units: Okena cuts dialog strings over
 * 16 KiB (UTF-8) and marks the cut, so a longer prefix could differ for the same call.
 */
export const CALL_STRING_MAX = 1_024
/** A call whose clipped input serializes longer than this is kept without input (never matches). */
const CALL_INPUT_MAX = 64 * 1024
/** Lines longer than this are not parsed (no claim). */
const LINE_MAX = 4 * 1024 * 1024
/**
 * Claude writes the call's record before the hook raises its dialog; the two clocks are the same
 * machine's, this only absorbs the record timestamp's own rounding.
 */
export const CALL_BEFORE_DIALOG_SLACK_MS = 1_000
/** Dialogs only the main agent raises: a running subagent cannot have raised them. */
const MAIN_ONLY_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/

export const emptyToolCalls = (): ToolCallState => ({ calls: [] })

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function clip(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') return value.length > CALL_STRING_MAX ? value.slice(0, CALL_STRING_MAX) : value
	if (depth > 32) return null
	if (Array.isArray(value)) return value.map(entry => clip(entry, depth + 1))
	const fields = record(value)
	if (fields) return Object.fromEntries(Object.entries(fields).map(([key, entry]) => [key, clip(entry, depth + 1)]))
	return value
}

/** Key-order-independent JSON (model.ts `stableJson`, kept local so this module stays leaf). */
function stable(value: unknown, depth = 0): string {
	if (depth > 64) return '"…"'
	if (Array.isArray(value)) return `[${value.map(entry => stable(entry, depth + 1)).join(',')}]`
	const fields = record(value)
	if (fields)
		return `{${Object.keys(fields)
			.sort()
			.filter(key => fields[key] !== undefined)
			.map(key => `${JSON.stringify(key)}:${stable(fields[key], depth + 1)}`)
			.join(',')}}`
	return JSON.stringify(value) ?? 'null'
}

const timestampOf = (value: unknown): number | undefined => {
	const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
	return Number.isFinite(at) ? at : undefined
}

/** One JSONL line (any record type); returns the next state, `state` untouched. */
export function applyToolCallLine(state: ToolCallState, line: string): ToolCallState {
	if (line.length > LINE_MAX || line.startsWith('{"type":"api-request')) return state
	if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) return state
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch {
		return state
	}
	const entry = record(parsed)
	// Sidechain records belong to a subagent: its calls are not the main agent's.
	if (!entry || entry.isSidechain === true) return state
	const at = timestampOf(entry.timestamp)
	if (at === undefined) return state
	const content = record(entry.message)?.content
	if (!Array.isArray(content)) return state
	let calls = state.calls
	for (const raw of content) {
		const block = record(raw)
		if (!block) continue
		if (entry.type === 'assistant' && block.type === 'tool_use') {
			const id = typeof block.id === 'string' && TOOL_USE_ID.test(block.id) ? block.id : undefined
			if (!id || typeof block.name !== 'string' || calls.some(call => call.id === id)) continue
			const input = clip(block.input)
			const call: ToolCall = {
				id,
				name: block.name,
				input: stable(input).length <= CALL_INPUT_MAX ? input : undefined,
				at,
			}
			calls = [...calls, call].slice(-TOOL_CALLS_MAX)
		} else if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
			const id = block.tool_use_id
			const index = calls.findIndex(call => call.id === id && call.resultAt === undefined)
			if (index === -1) continue
			calls = calls.map((call, i) => (i === index ? { ...call, resultAt: at } : call))
		}
	}
	return calls === state.calls ? state : { calls }
}

/**
 * The same call: equal inputs, or one input is the other with fields added (Claude adds
 * AskUserQuestion `answers`; ExitPlanMode's model input lacks the plan its permission shows).
 */
function sameInput(callInput: unknown, dialogInput: unknown): boolean {
	if (callInput === undefined) return false
	const a = clip(callInput)
	const b = clip(dialogInput)
	if (stable(a) === stable(b)) return true
	const x = record(a)
	const y = record(b)
	if (!x || !y) return false
	const within = (small: Record<string, unknown>, big: Record<string, unknown>) =>
		Object.entries(small).every(([key, value]) => stable(big[key]) === stable(value))
	return within(x, y) || within(y, x)
}

/**
 * Whether the transcript proves this dialog answered: the latest call of the same tool with the
 * same input written before the dialog was raised has a tool_result written after it. A permission
 * dialog (any tool but AskUserQuestion/ExitPlanMode) while subagents run claims nothing: a subagent
 * may have raised it for a call identical to the main agent's (its own calls are not read here).
 */
export function dialogAnsweredInTranscript(
	dialog: DialogCall,
	calls: readonly ToolCall[],
	subagentsRunning: boolean,
): boolean {
	if (subagentsRunning && !MAIN_ONLY_TOOLS.has(dialog.tool_name)) return false
	let candidate: ToolCall | undefined
	for (const call of calls) {
		if (call.name !== dialog.tool_name || call.at > dialog.created_at_ms + CALL_BEFORE_DIALOG_SLACK_MS) continue
		if (!sameInput(call.input, dialog.tool_input)) continue
		if (!candidate || call.at >= candidate.at) candidate = call
	}
	return candidate?.resultAt !== undefined && candidate.resultAt >= dialog.created_at_ms
}

/** Observations cross a process boundary in tests and sources: an odd shape claims nothing. */
export function validToolCalls(value: unknown): value is ToolCall[] {
	return (
		Array.isArray(value) &&
		value.length <= TOOL_CALLS_MAX &&
		value.every(entry => {
			const call = record(entry)
			return (
				!!call &&
				typeof call.id === 'string' &&
				typeof call.name === 'string' &&
				typeof call.at === 'number' &&
				Number.isFinite(call.at) &&
				(call.resultAt === undefined || (typeof call.resultAt === 'number' && Number.isFinite(call.resultAt)))
			)
		})
	)
}
