// Agent dock acts (slice 2): pure validation, Okena request bodies and the
// compare-and-set checks main runs on a FRESH Okena read before every effect.
// No IO here; okena-claude-source.ts performs the reads/POSTs, reduce.ts owns
// the item lifecycle. Answer text only passes through: it is never returned in
// a refusal, logged, or kept.
//
// Okena wire (okena f67bbf7b):
//   POST /v1/claude/terminals/{terminal_id}/dialogs/{dialog_id}
//     body = ApiClaudeDecision, serde tag "decision", snake_case, deny_unknown_fields:
//       {"decision":"allow","always":bool} | {"decision":"deny","message"?:string}
//       | {"decision":"answer","answers":{"<question text>":"<label>[, <label>…]"}}
//     → 200 {} | 404 "dialog is no longer open" (text/plain)
//   POST /v1/claude/terminals/{terminal_id}/prompt  body {"text":string}
//     → 200 {"delivery":"channel"|"pty"|"queued"} | 400 empty/too long | 409 busy/no session
// (the same bodies `okena claude answer` / `okena claude prompt` send).

import {
	DOCK_RISKY_PROMPT,
	type DockActOutcome,
	type DockAction,
	type DockAskFact,
	type DockItem,
	type DockRefusalReason,
	type DockTurnFact,
	type OkenaClaudeEntry,
	type OkenaClaudeSession,
	type OkenaClaudeTranscriptPage,
	PERMISSION_SUGGESTIONS_MAX,
	stableJson,
} from './model'
import { alwaysAllowLabels, permissionReview } from './review'

/** `ApiClaudeDecision` as Okena deserializes it (no other fields: deny_unknown_fields). */
export type OkenaClaudeDecision =
	| { decision: 'allow'; always: boolean }
	| { decision: 'deny'; message?: string }
	| { decision: 'answer'; answers: Record<string, string> }

/** The effect to perform once the CAS read passed. */
export type DockActRequestBody =
	| { kind: 'decision'; dialogId: string; body: OkenaClaudeDecision }
	| { kind: 'prompt'; body: { text: string } }

export type DockCheck = { ok: true } | { ok: false; reason: DockRefusalReason; detail: string }

const refuse = (
	reason: DockRefusalReason,
	detail: string,
): { ok: false; reason: DockRefusalReason; detail: string } => ({
	ok: false,
	reason,
	detail,
})

/** Refusal words the renderer shows after "refused: ". */
export const REFUSAL_TEXT: Record<DockRefusalReason, string> = {
	gone: 'already answered elsewhere',
	changed: 'it changed since you looked; check it again',
	busy: 'the agent is working again; check it again',
	not_open: 'not open for an answer right now',
	unknown_item: 'this item is gone',
	invalid: 'the answer is incomplete',
	source_down: 'Okena is unreachable; answer in the terminal',
	in_flight: 'another answer is still being sent',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

interface RawQuestion {
	question: string
	multiSelect: boolean
	labels: string[]
}

/** The raw (unsanitized) AskUserQuestion questions: answer keys must be Claude's exact question text. */
function rawQuestions(input: unknown): RawQuestion[] | null {
	if (!isRecord(input) || !Array.isArray(input.questions)) return null
	const questions: RawQuestion[] = []
	for (const raw of input.questions) {
		if (!isRecord(raw) || typeof raw.question !== 'string') return null
		const labels: string[] = []
		for (const option of Array.isArray(raw.options) ? raw.options : [])
			labels.push(isRecord(option) && typeof option.label === 'string' ? option.label : '')
		questions.push({ question: raw.question, multiSelect: raw.multiSelect === true, labels })
	}
	return questions.length > 0 ? questions : null
}

const clean = (text: string | undefined): string => (text ?? '').trim()

const riskyDetail = (what: string): string => `This ${what} mentions deploy/prod/secret/push/merge; confirm it first.`

/**
 * Validates an action against the item's fact and builds the Okena body.
 * Pure; uses only the item's own (verbatim) fact. Refusals never echo answer text.
 */
export function dockActBody(
	item: DockItem,
	action: DockAction,
): { ok: true; body: DockActRequestBody } | { ok: false; reason: DockRefusalReason; detail: string } {
	const fact = item.fact
	if (fact.kind === 'turn') {
		if (action.type !== 'prompt') return refuse('invalid', 'A finished turn takes a reply.')
		const text = action.text.replace(/\s+$/u, '')
		if (!text.trim()) return refuse('invalid', 'The reply is empty.')
		if (DOCK_RISKY_PROMPT.test(text) && action.confirmed !== true) return refuse('invalid', riskyDetail('reply'))
		return { ok: true, body: { kind: 'prompt', body: { text } } }
	}
	if (action.type === 'prompt') return refuse('invalid', 'An open dialog takes an answer, not a reply.')
	const decision = askDecision(fact, action)
	if (!decision.ok) return decision
	return { ok: true, body: { kind: 'decision', dialogId: fact.dialogId, body: decision.body } }
}

function askDecision(
	fact: DockAskFact,
	action: Exclude<DockAction, { type: 'prompt' }>,
): { ok: true; body: OkenaClaudeDecision } | { ok: false; reason: DockRefusalReason; detail: string } {
	if (fact.tool === 'AskUserQuestion') {
		if (action.type !== 'answer') return refuse('invalid', 'This question takes answers.')
		const questions = rawQuestions(fact.input)
		if (!questions) return refuse('invalid', 'The question could not be read; answer in the terminal.')
		if (action.picks.length !== questions.length) return refuse('invalid', 'Answer every question first.')
		// A Map, then fromEntries: a question literally named "__proto__" stays an own key.
		const answers = new Map<string, string>()
		let riskyOther = false
		for (const [index, question] of questions.entries()) {
			const pick = action.picks[index]
			if (!pick) return refuse('invalid', 'Answer every question first.')
			const other = clean(pick.other)
			if (other && DOCK_RISKY_PROMPT.test(other)) riskyOther = true
			const options = [...new Set(pick.options)]
			if (options.length === 0 && !other) return refuse('invalid', `Answer question ${index + 1} first.`)
			if (!question.multiSelect && options.length + (other ? 1 : 0) > 1)
				return refuse('invalid', `Question ${index + 1} takes one answer.`)
			const labels: string[] = []
			for (const option of options) {
				const label = question.labels[option]
				if (label === undefined || label === '') return refuse('invalid', `Question ${index + 1}: unknown option.`)
				labels.push(label)
			}
			if (other) labels.push(other)
			if (answers.has(question.question))
				return refuse('invalid', 'Two questions share the same text; answer in the terminal.')
			// Okena: "Multi-select answers are comma-separated labels".
			answers.set(question.question, labels.join(', '))
		}
		if (riskyOther && action.confirmed !== true) return refuse('invalid', riskyDetail('answer'))
		return { ok: true, body: { decision: 'answer', answers: Object.fromEntries(answers) } }
	}
	if (action.type === 'answer') return refuse('invalid', 'This dialog takes allow or deny.')
	if (action.type === 'deny') {
		const message = clean(action.message)
		if (message && DOCK_RISKY_PROMPT.test(message) && action.confirmed !== true)
			return refuse('invalid', riskyDetail('message'))
		return { ok: true, body: message ? { decision: 'deny', message } : { decision: 'deny' } }
	}
	if (action.always === true) {
		if (fact.tool === 'ExitPlanMode') return refuse('invalid', 'A plan is approved once.')
		// Okena applies EVERY suggestion: refuse unless the dock could show each one verbatim.
		const labels = alwaysAllowLabels(fact.suggestions, fact.suggestionsTruncated === true)
		if (labels === null)
			return refuse('invalid', 'Claude suggested rules the dock cannot show; answer in the terminal.')
		if (labels.length === 0) return refuse('invalid', 'Claude suggested no rule to always allow.')
	}
	// Okena allows with the full original tool_input: refuse unless the dock showed all of it.
	if (fact.tool !== 'ExitPlanMode' && !permissionReview(fact.input).complete)
		return refuse('invalid', 'Too long or unusual to show in full; review it in the terminal.')
	return { ok: true, body: { decision: 'allow', always: action.always === true } }
}

/**
 * CAS for an ask: the fresh Okena session must still show the same dialog id
 * with the same tool, the same verbatim tool_input and the same suggestions.
 */
export function askStillOpen(item: DockItem, fresh: OkenaClaudeSession): DockCheck {
	if (item.fact.kind !== 'ask') return refuse('invalid', 'Not a dialog.')
	const fact = item.fact
	const dialog = fresh.dialogs.find(entry => entry.id === fact.dialogId)
	if (!dialog) return refuse('gone', REFUSAL_TEXT.gone)
	const suggestions = dialog.permission_suggestions.slice(0, PERMISSION_SUGGESTIONS_MAX)
	const truncated = dialog.permission_suggestions.length > PERMISSION_SUGGESTIONS_MAX
	if (
		dialog.tool_name !== fact.tool ||
		truncated !== (fact.suggestionsTruncated === true) ||
		stableJson(dialog.tool_input) !== stableJson(fact.input) ||
		stableJson(suggestions) !== stableJson(fact.suggestions ?? [])
	)
		return refuse('changed', REFUSAL_TEXT.changed)
	return { ok: true }
}

/**
 * CAS for a turn reply: same Claude session, idle with no dialog, and the
 * transcript's last assistant message is still this turn's with no user entry
 * after it. `page` is a fresh first (reset) page: Okena's transcript tail.
 */
export function turnStillWaiting(
	item: DockItem,
	fresh: OkenaClaudeSession,
	page: OkenaClaudeTranscriptPage | null,
): DockCheck {
	if (item.fact.kind !== 'turn') return refuse('invalid', 'Not a turn.')
	const fact: DockTurnFact = item.fact
	if (fact.sessionId && fresh.session_id && fact.sessionId !== fresh.session_id)
		return refuse('gone', 'A new Claude session started in this pane.')
	if (fresh.dialogs.length > 0) return refuse('busy', 'The agent opened a dialog; answer that first.')
	if (fresh.busy !== false) return refuse('busy', REFUSAL_TEXT.busy)
	if (!page) return refuse('changed', 'The transcript could not be read; check the terminal.')
	if (fact.sessionId && page.session_id && page.session_id !== fact.sessionId)
		return refuse('gone', 'A new Claude session started in this pane.')
	let last: OkenaClaudeEntry | undefined
	let userAfter = false
	for (const entry of page.entries) {
		if (entry.kind === 'assistant') {
			last = entry
			userAfter = false
		} else if (entry.kind === 'user') userAfter = true
	}
	if (!last) return refuse('changed', 'The turn is no longer in the transcript tail; check the terminal.')
	if (last.uuid !== fact.assistantUuid) return refuse('changed', 'The agent said something new; check it again.')
	if (userAfter) return refuse('gone', 'Someone already replied in the terminal.')
	return { ok: true }
}

/** Errors that prove the request never reached Okena (nothing to confirm). */
const NOT_SENT_CODES = new Set([
	'ECONNREFUSED',
	'ENOENT',
	'ENOTDIR',
	'EACCES',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EADDRNOTAVAIL',
])

function errorCode(error: unknown): string | undefined {
	const own = (error as { code?: unknown } | null)?.code
	if (typeof own === 'string') return own
	const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code
	return typeof cause === 'string' ? cause : undefined
}

/**
 * Okena POST error → outcome. A status means Okena answered with an error: a 404
 * on the dialog POST means it closed meanwhile (answered elsewhere), anything else
 * did nothing. A connection that never opened (or a client that is not configured)
 * sent nothing. Every other transport error (timeout, reset, hang-up, a bad body
 * after a 200) may have landed: unconfirmed, so the next poll can confirm it.
 */
export function dockPostFailure(error: unknown, dialog: boolean): DockActOutcome {
	const detail = errorDetail(error)
	const status = (error as { status?: unknown } | null)?.status
	if (typeof status === 'number') {
		if (dialog && status === 404) return { status: 'refused', reason: 'gone', detail }
		if (!dialog && status === 409) return { status: 'failed', detail: promptConflictDetail(detail) }
		return { status: 'failed', detail }
	}
	const code = errorCode(error)
	if ((code !== undefined && NOT_SENT_CODES.has(code)) || /^Okena not configured/.test(detail))
		return { status: 'failed', detail }
	return { status: 'unconfirmed', detail: `No answer from Okena: ${detail}` }
}

/**
 * A 409 on `POST …/prompt` is Okena refusing to type (nothing was sent). Drop the
 * route (terminal id noise) and keep Okena's reason verbatim. "No Claude session detected"
 * also happens when Okena's foreground probe misses a running native `claude`
 * (its process name is the version, e.g. `2.1.314`), so say where to reply instead.
 */
function promptConflictDetail(detail: string): string {
	const reason = /failed \(409\): (.*)$/.exec(detail)?.[1]?.trim() || detail
	if (!/No Claude session detected/i.test(reason)) return `Okena refused the reply (409): ${reason}`
	return `Okena refused the reply (409): ${reason}${/[.!?]$/.test(reason) ? '' : '.'} Reply in the terminal.`
}

export const errorDetail = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 300)
