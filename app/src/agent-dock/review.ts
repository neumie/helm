// Agent dock: what an Allow / Always allow from the dock would actually grant,
// and whether the dock can show ALL of it verbatim. Zod-free and DOM-free so
// main (act.ts refuses what the renderer could not show in full) and the
// renderer (presentation, AgentDockDetail) share one definition.
//
// Okena's Allow sends the dialog's full original `tool_input` back as
// `updatedInput`, and "Always allow" applies EVERY `permission_suggestions`
// entry (session-scoped). So the dock may offer either only when nothing that
// would be approved is cut, control-stripped or hidden.

/** At most this many suggestions are kept on a fact; more → no "Always allow". */
export const PERMISSION_SUGGESTIONS_MAX = 8
/** Okena's GET marks strings it cut at 16 KiB with this (hub.rs TRUNCATION_MARK, minus the newline). */
export const OKENA_TRUNCATION_MARK = '… (truncated)'
/** A permission command longer than this is not shown in full: review it in the terminal. */
export const REVIEW_COMMAND_MAX = 8_192
/** Every other tool_input field, as pretty JSON; longer → review in the terminal. */
export const REVIEW_FIELDS_MAX = 16_384
/** An ExitPlanMode plan longer than this is not shown in full: review it in the terminal. */
export const REVIEW_PLAN_MAX = 16_384
const RULE_TOOL_MAX = 64
const RULE_CONTENT_MAX = 240
const DIRECTORY_MAX = 512
const RULES_PER_SUGGESTION_MAX = 8

/** tool_input booleans that loosen safety: shown as warnings when true. */
export const RISKY_INPUT_FLAGS = ['dangerouslyDisableSandbox', 'run_in_background'] as const

// C0/C1 controls except tab/newline, plus bidi overrides/isolates and LRM/RLM.
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting controls is the point
const UNSAFE_CHAR = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Renders exactly as Claude sent it: no stripped characters, no Okena truncation, within `max`. */
export function showsVerbatim(text: string, max: number): boolean {
	return text.length <= max && !UNSAFE_CHAR.test(text) && !text.includes(OKENA_TRUNCATION_MARK)
}

/** Every string (keys too) in a JSON value renders verbatim. Depth-bounded; too deep = not showable. */
function allStringsVerbatim(value: unknown, depth = 0): boolean {
	if (depth > 32) return false
	if (typeof value === 'string') return showsVerbatim(value, Number.POSITIVE_INFINITY)
	if (Array.isArray(value)) return value.every(entry => allStringsVerbatim(entry, depth + 1))
	if (isRecord(value))
		return Object.entries(value).every(
			([key, entry]) => showsVerbatim(key, Number.POSITIVE_INFINITY) && allStringsVerbatim(entry, depth + 1),
		)
	return true
}

export interface PermissionReview {
	/** `tool_input.command` verbatim (the renderer still strips it for display when `complete` is false). */
	command: string | null
	/** `tool_input.description`: Claude's own words, shown as context (never executed). */
	description: string | null
	/** Every other field as pretty JSON, or null when there is none. */
	fields: string | null
	/** RISKY_INPUT_FLAGS set to true. */
	flags: string[]
	/** Everything Allow would approve renders verbatim and in full. */
	complete: boolean
}

/** What a permission Allow approves, split for display, and whether the dock can show all of it. */
export function permissionReview(input: unknown): PermissionReview {
	if (!isRecord(input)) {
		let fields: string | null
		try {
			fields = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? null)
		} catch {
			fields = null
		}
		return {
			command: null,
			description: null,
			fields,
			flags: [],
			complete: fields !== null && showsVerbatim(fields, REVIEW_FIELDS_MAX) && allStringsVerbatim(input),
		}
	}
	const command = typeof input.command === 'string' ? input.command : null
	const description = typeof input.description === 'string' ? input.description : null
	const rest: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(input)) {
		if ((key === 'command' && command !== null) || (key === 'description' && description !== null)) continue
		rest[key] = value
	}
	let fields: string | null = null
	let fieldsOk = true
	if (Object.keys(rest).length > 0) {
		try {
			fields = JSON.stringify(rest, null, 2) ?? null
		} catch {
			fields = null
		}
		fieldsOk = fields !== null && fields.length <= REVIEW_FIELDS_MAX
	}
	const flags = RISKY_INPUT_FLAGS.filter(flag => input[flag] === true)
	const complete = fieldsOk && (command === null || command.length <= REVIEW_COMMAND_MAX) && allStringsVerbatim(input)
	return { command, description, fields, flags, complete }
}

export interface PlanReview {
	/** `tool_input.plan` verbatim, or null when Claude sent no plan text. */
	plan: string | null
	/** Every other field as pretty JSON, or null when there is none. */
	fields: string | null
	/** The plan and everything else Approve would approve render verbatim and in full. */
	complete: boolean
}

/** What approving an ExitPlanMode dialog approves, and whether the dock can show all of it. */
export function planReview(input: unknown): PlanReview {
	if (!isRecord(input) || typeof input.plan !== 'string') return { plan: null, fields: null, complete: false }
	const plan = input.plan
	const rest: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(input)) if (key !== 'plan') rest[key] = value
	let fields: string | null = null
	let fieldsOk = true
	if (Object.keys(rest).length > 0) {
		try {
			fields = JSON.stringify(rest, null, 2) ?? null
		} catch {
			fields = null
		}
		fieldsOk = fields !== null && fields.length <= REVIEW_FIELDS_MAX
	}
	const complete = fieldsOk && showsVerbatim(plan, REVIEW_PLAN_MAX) && allStringsVerbatim(input)
	return { plan, fields, complete }
}

/**
 * "Always allow" wording for Claude's own `permission_suggestions`, or null when
 * the dock cannot show every entry it would apply: only allow `addRules`
 * (`Tool(rule)`) and `addDirectories` (the directory) are shown, so any other
 * entry (setMode, removeRules, replaceRules, deny/ask rules, …), a cut list, or
 * text that would not render verbatim means no "Always allow". [] = none sent.
 * `destination` is ignored on purpose: Okena rewrites every entry to
 * `"destination": "session"` before answering (okena-remote-server
 * claude_remote/decision.rs `session_scoped`), so "(this session)" is accurate.
 */
export function alwaysAllowLabels(suggestions: unknown, truncated = false): string[] | null {
	if (truncated || (suggestions !== undefined && !Array.isArray(suggestions))) return null
	const list = (suggestions as unknown[] | undefined) ?? []
	if (list.length > PERMISSION_SUGGESTIONS_MAX) return null
	const line = (text: unknown, max: number): text is string =>
		typeof text === 'string' && text !== '' && !/[\r\n]/.test(text) && showsVerbatim(text, max)
	const labels: string[] = []
	for (const suggestion of list) {
		if (!isRecord(suggestion)) return null
		if (suggestion.type === 'addRules' && suggestion.behavior === 'allow') {
			const rules = suggestion.rules
			if (!Array.isArray(rules) || rules.length === 0 || rules.length > RULES_PER_SUGGESTION_MAX) return null
			for (const rule of rules) {
				if (!isRecord(rule) || !line(rule.toolName, RULE_TOOL_MAX)) return null
				if (rule.ruleContent === undefined) labels.push(rule.toolName)
				else if (line(rule.ruleContent, RULE_CONTENT_MAX)) labels.push(`${rule.toolName}(${rule.ruleContent})`)
				else return null
			}
		} else if (suggestion.type === 'addDirectories') {
			const directories = suggestion.directories
			if (!Array.isArray(directories) || directories.length === 0 || directories.length > RULES_PER_SUGGESTION_MAX)
				return null
			for (const directory of directories) {
				if (!line(directory, DIRECTORY_MAX)) return null
				labels.push(directory)
			}
		} else return null
	}
	return [...new Set(labels)]
}
