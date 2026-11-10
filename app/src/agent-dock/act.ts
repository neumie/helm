// Agent dock acts: pure validation, Okena request bodies and the
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

import { DOCK_SOURCE_TEXT, type DockSourceId } from '../../../src/agent-dock/dock-vocabulary'
import {
	type DockActOutcome,
	type DockAction,
	type DockAskFact,
	type DockItem,
	type DockRefusalReason,
	type DockTurnFact,
	type OkenaClaudeEntry,
	type OkenaClaudeSession,
	type OkenaClaudeTranscriptPage,
	stableJson,
} from './model'
import {
	PERMISSION_SUGGESTIONS_MAX,
	alwaysAllowLabels,
	alwaysAllowRulesOnly,
	permissionReview,
	planReview,
} from './review'

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
	source_down: DOCK_SOURCE_TEXT.okena.sourceDown,
	in_flight: 'another answer is still being sent',
	untracked: "can't tell whether the agent is free; reply in its terminal",
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

/**
 * Validates an action against the item's fact and builds the Okena body.
 * Pure; uses only the item's own (verbatim) fact and the `source` that will answer it.
 * Refusals never echo answer text.
 */
export function dockActBody(
	item: DockItem,
	action: DockAction,
	source: DockSourceId = 'okena',
): { ok: true; body: DockActRequestBody } | { ok: false; reason: DockRefusalReason; detail: string } {
	const fact = item.fact
	if (fact.kind === 'turn') {
		if (action.type !== 'prompt') return refuse('invalid', 'A finished turn takes a reply.')
		const text = promptText(action.text)
		if (text === null) return refuse('invalid', 'The reply is empty.')
		return { ok: true, body: { kind: 'prompt', body: { text } } }
	}
	if (action.type === 'prompt') return refuse('invalid', 'An open dialog takes an answer, not a reply.')
	const decision = askDecision(fact, action, source)
	if (!decision.ok) return decision
	return { ok: true, body: { kind: 'decision', dialogId: fact.dialogId, body: decision.body } }
}

function askDecision(
	fact: DockAskFact,
	action: Exclude<DockAction, { type: 'prompt' }>,
	source: DockSourceId,
): { ok: true; body: OkenaClaudeDecision } | { ok: false; reason: DockRefusalReason; detail: string } {
	if (fact.tool === 'AskUserQuestion') {
		if (action.type !== 'answer') return refuse('invalid', 'This question takes answers.')
		const questions = rawQuestions(fact.input)
		if (!questions) return refuse('invalid', 'The question could not be read; answer in the terminal.')
		if (action.picks.length !== questions.length) return refuse('invalid', 'Answer every question first.')
		// A Map, then fromEntries: a question literally named "__proto__" stays an own key.
		const answers = new Map<string, string>()
		for (const [index, question] of questions.entries()) {
			const pick = action.picks[index]
			if (!pick) return refuse('invalid', 'Answer every question first.')
			const other = clean(pick.other)
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
		return { ok: true, body: { decision: 'answer', answers: Object.fromEntries(answers) } }
	}
	if (action.type === 'answer') return refuse('invalid', 'This dialog takes allow or deny.')
	if (action.type === 'deny') {
		const message = clean(action.message)
		return { ok: true, body: message ? { decision: 'deny', message } : { decision: 'deny' } }
	}
	if (action.always === true) {
		if (fact.tool === 'ExitPlanMode') return refuse('invalid', 'A plan is approved once.')
		// The source applies EVERY suggestion: refuse unless the dock could show each one verbatim
		// (and, for Helm's hub, unless each is a rule: it cannot apply addDirectories).
		const labels = alwaysAllowLabels(fact.suggestions, fact.suggestionsTruncated === true, {
			rulesOnly: alwaysAllowRulesOnly(source),
		})
		if (labels === null)
			return refuse('invalid', 'Claude suggested rules the dock cannot always allow; answer in the terminal.')
		if (labels.length === 0) return refuse('invalid', 'Claude suggested no rule to always allow.')
	}
	// Okena allows with the full original tool_input: refuse unless the dock showed all of it.
	const review = fact.tool === 'ExitPlanMode' ? planReview(fact.input) : permissionReview(fact.input)
	if (!review.complete) return refuse('invalid', 'Too long or unusual to show in full; review it in the terminal.')
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
	source: DockSourceId = 'okena',
): DockCheck {
	if (item.fact.kind !== 'turn') return refuse('invalid', 'Not a turn.')
	const fact: DockTurnFact = item.fact
	return sessionStillIdle({ sessionId: fact.sessionId, assistantUuid: fact.assistantUuid }, fresh, page, source)
}

/**
 * CAS for a reply to an agent (a turn's, or one from the agent detail with no item): the same
 * Claude session Jakub saw, idle with no dialog, and the transcript tail still ends at the
 * message he read (`assistantUuid`; with none, at no assistant message) with no user entry after it.
 * Busy unknown (`busy` missing: the source lost the pane's state, as Okena does for an idle agent
 * across a daemon restart) is never sent, and refused as `untracked`, not as "working again".
 */
export function sessionStillIdle(
	expect: { sessionId?: string; assistantUuid?: string },
	fresh: OkenaClaudeSession,
	page: OkenaClaudeTranscriptPage | null,
	source: DockSourceId = 'okena',
): DockCheck {
	if (expect.sessionId && fresh.session_id && expect.sessionId !== fresh.session_id)
		return refuse('gone', 'A new Claude session started in this pane.')
	if (fresh.dialogs.length > 0) return refuse('busy', 'The agent opened a dialog; answer that first.')
	if (fresh.busy === true) return refuse('busy', REFUSAL_TEXT.busy)
	if (fresh.busy !== false) return refuse('untracked', DOCK_SOURCE_TEXT[source].untracked)
	if (!page) return refuse('changed', 'The transcript could not be read; check the terminal.')
	if (expect.sessionId && page.session_id && page.session_id !== expect.sessionId)
		return refuse('gone', 'A new Claude session started in this pane.')
	let last: OkenaClaudeEntry | undefined
	let userAfter = false
	for (const entry of page.entries) {
		if (entry.kind === 'assistant') {
			last = entry
			userAfter = false
		} else if (entry.kind === 'user') userAfter = true
	}
	if (expect.assistantUuid === undefined) {
		if (last) return refuse('changed', 'The agent said something new; check it again.')
	} else {
		if (!last) return refuse('changed', 'The turn is no longer in the transcript tail; check the terminal.')
		if (last.uuid !== expect.assistantUuid) return refuse('changed', 'The agent said something new; check it again.')
	}
	if (userAfter) return refuse('gone', 'Someone already replied in the terminal.')
	return { ok: true }
}

/**
 * CAS for a new prompt (AgentDockPromptRequest.queue: Signals hands a thread to an agent): the
 * same Claude session, no dialog open (typing would answer it), and a known busy state. Working is
 * fine: the source holds the prompt until the turn ends (Okena's `queued`, Helm's hub queue), so
 * it never lands in a running turn. Not a reply to a message, so the transcript is not checked.
 */
export function sessionTakesPrompt(
	expect: { sessionId?: string },
	fresh: OkenaClaudeSession,
	source: DockSourceId = 'okena',
): DockCheck {
	if (expect.sessionId && fresh.session_id && expect.sessionId !== fresh.session_id)
		return refuse('gone', 'A new Claude session started in this pane.')
	if (fresh.dialogs.length > 0) return refuse('busy', 'The agent opened a dialog; answer that first.')
	if (fresh.busy !== true && fresh.busy !== false) return refuse('untracked', DOCK_SOURCE_TEXT[source].untracked)
	return { ok: true }
}

/** A reply's text as it is sent: trailing whitespace dropped; null when nothing is left. */
export function promptText(text: string): string | null {
	const trimmed = text.replace(/\s+$/u, '')
	return trimmed.trim() ? trimmed : null
}

/** Errors that prove the request never reached Okena (nothing to confirm). */
const NOT_SENT_CODES = new Set([
	/** OkenaClient OKENA_NOT_CONFIGURED: no profile/credentials, nothing was sent. */
	'OKENA_NOT_CONFIGURED',
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
export function dockPostFailure(
	error: unknown,
	dialog: boolean,
	source = DOCK_SOURCE_TEXT.okena.label,
): DockActOutcome {
	const detail = errorDetail(error)
	const status = (error as { status?: unknown } | null)?.status
	if (typeof status === 'number') {
		if (dialog && status === 404) return { status: 'refused', reason: 'gone', detail }
		if (!dialog && status === 409) return { status: 'failed', detail: promptConflictDetail(error, detail, source) }
		return { status: 'failed', detail }
	}
	const code = errorCode(error)
	if (code !== undefined && NOT_SENT_CODES.has(code)) return { status: 'failed', detail }
	return { status: 'unconfirmed', detail: `No answer from ${source}: ${detail}` }
}

/**
 * A 409 on `POST …/prompt` is Okena refusing to type (nothing was sent). Drop the
 * route (terminal id noise) and keep Okena's reason verbatim: both transports put it
 * on the error as `reason` (OkenaHttpError, Helm hub). "No Claude session detected"
 * also happens when Okena's foreground probe misses a running native `claude`
 * (its process name is the version, e.g. `2.1.314`), so say where to reply instead.
 */
function promptConflictDetail(error: unknown, detail: string, source: string): string {
	const own = (error as { reason?: unknown } | null)?.reason
	const reason = (typeof own === 'string' ? own.replace(/\s+/g, ' ').trim() : '') || detail
	if (!/No Claude session detected/i.test(reason)) return `${source} refused the reply (409): ${reason}`
	return `${source} refused the reply (409): ${reason}${/[.!?]$/.test(reason) ? '' : '.'} Reply in the terminal.`
}

export const errorDetail = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 300)
