// What Helm's PermissionRequest hook prints for a dock decision. Semantics of
// Okena's decision.rs (MIT, contember/okena okena-remote-server
// claude_remote/decision.rs @ ef25cc81), tightened by the Claude Code 2.1.316
// spikes (golden JSON in tests/helm-claude-remote-decision.test.ts):
//   - allow always repeats the FULL original tool_input as `updatedInput`
//     (Claude drops an allow without it for ExitPlanMode / AskUserQuestion);
//   - an AskUserQuestion answer is the original input plus `answers` keyed by the
//     exact question text (multi-select labels already joined `, ` by act.ts);
//   - "always allow" is offered only when every Claude suggestion is an
//     `addRules` entry, each rewritten to `destination: "session"` (an applied
//     `addDirectories` did not stop the next prompt in the spike);
//   - a mode switch is a `setMode` entry in `updatedPermissions` (session); the
//     hub sends `acceptEdits` with every dock plan approval (review.ts planApproveMode).
// Pure: no IO. The dock body it takes is act.ts's `OkenaClaudeDecision`.

import type { OkenaClaudeDecision } from '../agent-dock/act'

export const DEFAULT_DENY_MESSAGE = 'Denied from the Helm agent dock'

export interface HookDialogFacts {
	toolName: string
	toolInput: unknown
	suggestions: readonly unknown[]
}

export type HookDecisionResult =
	| { ok: true; output: Record<string, unknown> }
	| { ok: false; status: number; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Hook output that leaves the dialog to the terminal. */
export const CANCELLED_OUTPUT: Readonly<Record<string, never>> = Object.freeze({})

/** Claude's `addRules` suggestions, scoped to this session. */
export function sessionRules(suggestions: readonly unknown[]): Record<string, unknown>[] {
	return suggestions
		.filter(isRecord)
		.flatMap(suggestion => (suggestion.type === 'addRules' ? [{ ...suggestion, destination: 'session' }] : []))
}

const wrap = (decision: Record<string, unknown>): Record<string, unknown> => ({
	hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
})

/**
 * The hook stdout JSON for `decision` on `dialog`, or a refusal (`status` 400 =
 * the dock asked for something this dialog cannot take). `mode` optionally switches
 * the session's permission mode with the allow (setMode, session scope).
 */
export function hookDecisionOutput(
	dialog: HookDialogFacts,
	decision: OkenaClaudeDecision,
	mode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
): HookDecisionResult {
	if (decision.decision === 'deny') {
		const message = decision.message?.trim() ? decision.message : DEFAULT_DENY_MESSAGE
		return { ok: true, output: wrap({ behavior: 'deny', message }) }
	}
	if (decision.decision === 'answer') {
		if (dialog.toolName !== 'AskUserQuestion' || !isRecord(dialog.toolInput))
			return { ok: false, status: 400, error: 'Only AskUserQuestion takes answers.' }
		// Claude validates updatedInput against the tool schema: the original questions stay.
		return {
			ok: true,
			output: wrap({ behavior: 'allow', updatedInput: { ...dialog.toolInput, answers: { ...decision.answers } } }),
		}
	}
	if (dialog.toolName === 'AskUserQuestion')
		return { ok: false, status: 400, error: 'A question takes answers, not allow.' }
	// The allow repeats tool_input as updatedInput: never replace input the dock could not show.
	if (!isRecord(dialog.toolInput))
		return { ok: false, status: 400, error: 'This request has no readable input; answer in the terminal.' }
	const permissions: Record<string, unknown>[] = []
	if (decision.always) {
		if (dialog.toolName === 'ExitPlanMode') return { ok: false, status: 400, error: 'A plan is approved once.' }
		const rules = sessionRules(dialog.suggestions)
		// What the dock showed is what gets applied: every suggestion must be an addRules entry.
		if (rules.length === 0 || rules.length !== dialog.suggestions.length)
			return { ok: false, status: 400, error: 'Always allow works only for rule suggestions; answer in the terminal.' }
		permissions.push(...rules)
	}
	if (mode) permissions.push({ type: 'setMode', mode, destination: 'session' })
	// tool_input is repeated verbatim: an allow without it is ignored for ExitPlanMode.
	return {
		ok: true,
		output: wrap({
			behavior: 'allow',
			updatedInput: dialog.toolInput,
			...(permissions.length > 0 ? { updatedPermissions: permissions } : {}),
		}),
	}
}
