import type { ReviewActivity, ReviewPassage, ReviewReceipt, ReviewSession } from '../../document-review/types'

/**
 * The send activity line (helm open spec D14, E5): what the review window says between Send and the reply.
 *
 * Phases come only from signals the window has. "received" is the host's `dispatched` receipt: the agent's waiting
 * tool has the feedback, never that a model read it or edited anything. "working" needs evidence: the caller's own
 * `working` report (Pi) or bound display-only activity from the host (`ReviewState.activity`, S12). Without either,
 * the line shows elapsed time only and never claims work.
 */
export type SendActivityPhase = 'sending' | 'received' | 'working' | 'replied' | 'not-sent' | 'unconfirmed'

/** The window's own record of its latest Send; replaced by the next Send. */
export interface LastSend {
	id: string
	scope: 'whole' | 'passage'
	/** The passage a passage-scoped send was about; null for the whole document. */
	passage: ReviewPassage | null
	/** Window clock at Send, used only until the host's `sentAt` arrives. */
	at: number
	/**
	 * Refused before any effect: the host's reason, and whether the text went back into its editor. `text` is that
	 * restored text (memory only), so the note leaves once it is edited; null when it went to recovery instead.
	 */
	failed: { reason: string; restored: boolean; text?: string | null } | null
	/**
	 * How the window saw it end once its operation cleared: `replied` only on a clean settle (no error, receipt not
	 * unknown), `unconfirmed` once it went uncertain, kept after acknowledgement. An assistant message alone never
	 * proves a reply: a working report with partial text creates it too.
	 */
	settled?: { outcome: 'replied' | 'unconfirmed'; at: number | null } | null
}

export interface SendActivity {
	id: string
	phase: SendActivityPhase
	scope: 'whole' | 'passage'
	passage: ReviewPassage | null
	/** Display name of the bound agent ("Claude Code", "Pi", "Agent"). */
	agent: string
	/** Why it was not sent. */
	reason: string | null
	/** The refused text went back into its editor. */
	restored: boolean
	/** Host clock when the feedback was handed over (window clock until the host says). */
	sentAt: number
	/** Host clock when the reply settled it; null while it runs or when the host did not say. */
	endedAt: number | null
	/** Generic verb while working ("Editing"; "Thinking" while a model request is in flight). */
	verb: string | null
	/** Output tokens since delivery, from bound activity only. */
	outputTokens: number | null
	/** The host bound display-only activity to this exact request. */
	bound: boolean
}

export function deriveSendActivity(input: {
	last: LastSend | null
	operation: { id: string; phase: 'sending' | 'running' | 'uncertain' } | null
	receipt: ReviewReceipt | null
	session: ReviewSession | null
	activity: ReviewActivity | null | undefined
	agent: string
}): SendActivity | null {
	const { last, operation, receipt, session } = input
	if (!last) return null
	const live = operation?.id === last.id ? operation : null
	const own = receipt?.id === last.id ? receipt : null
	const activity =
		input.activity && session && input.activity.sessionId === session.id && input.activity.requestId === last.id
			? input.activity
			: null
	const reply = session?.messages.find(message => message.id === `${last.id}:assistant`) ?? null
	let phase: SendActivityPhase | null
	let reason: string | null = null
	if (last.failed) {
		phase = 'not-sent'
		reason = last.failed.reason
	} else if (live?.phase === 'uncertain' || own?.outcome === 'unknown' || (live && session?.error))
		phase = 'unconfirmed'
	else if (live?.phase === 'sending') phase = 'sending'
	else if (live)
		phase =
			session?.state === 'working' || activity?.working
				? 'working'
				: own?.outcome === 'dispatched'
					? 'received'
					: 'sending'
	else phase = last.settled?.outcome === 'replied' && reply ? 'replied' : null
	if (!phase) return null
	const working = phase === 'working'
	return {
		id: last.id,
		phase,
		scope: last.scope,
		passage: last.passage,
		agent: input.agent,
		reason,
		restored: last.failed?.restored ?? false,
		sentAt: own?.sentAt ?? last.at,
		endedAt: phase === 'replied' ? (own?.settledAt ?? last.settled?.at ?? null) : null,
		verb: working ? (activity?.verb ?? 'Thinking') : null,
		outputTokens: phase === 'working' || phase === 'replied' ? (activity?.outputTokens ?? null) : null,
		bound: activity !== null,
	}
}

/** Claude Code's spelling: 12s, 2m 57s, 1h 4m. */
export function activityElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** 812, 16.3k, 1.2m; no trailing ".0". */
export function activityTokens(count: number): string {
	const scaled = (value: number, unit: string) => `${Number(value.toFixed(1))}${unit}`
	if (count < 1000) return `${count}`
	if (count < 999_950) return scaled(count / 1000, 'k')
	return scaled(count / 1_000_000, 'm')
}

/** The visible verb and the one screen-reader status; the status never contains the clock. */
export function activityWords(view: SendActivity): { verb: string; status: string } {
	const verb =
		view.phase === 'sending'
			? `Sending to ${view.agent}`
			: view.phase === 'received'
				? `With ${view.agent}`
				: view.phase === 'replied'
					? view.bound
						? 'Worked'
						: 'Replied'
					: (view.verb ?? 'Thinking')
	const status =
		view.phase === 'replied'
			? `${view.agent} replied`
			: view.phase === 'working'
				? `${view.agent}: ${verb}`
				: view.phase === 'not-sent'
					? 'Not sent'
					: view.phase === 'unconfirmed'
						? 'Not confirmed'
						: verb
	return { verb, status }
}
