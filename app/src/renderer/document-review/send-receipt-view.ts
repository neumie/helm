import type { ReactNode } from 'react'
import type { ReviewReceipt, ReviewSession } from '../../document-review/types'

/**
 * Opt-in send receipt seam for the review composer (helm open spec, decision D14). Story-only today:
 * `DocumentReview` renders nothing new unless a caller passes `sendReceipt` slots, and production never does.
 *
 * Phases come only from signals the window already has. "received" is the host's `dispatched` receipt, i.e.
 * the agent's waiting tool process has the feedback — never that a model read it or that an edit happened.
 * "working" is an explicit caller report (Pi today; `helm edit` callers never send one).
 */
export type SendReceiptPhase = 'sending' | 'received' | 'working' | 'replied' | 'not-sent' | 'unconfirmed'

export interface SendReceiptView {
	id: string
	phase: SendReceiptPhase
	scope: 'whole' | 'passage'
	/** What was sent, trimmed; empty for a screenshot-only send. */
	text: string
	/** Display name of the bound agent ("Claude Code", "Pi", "Agent"). */
	agent: string
	/** The caller reports progress (in-process Pi). A tool-return caller is silent until it replies. */
	reportsProgress: boolean
	/** Why it was not sent, or why the outcome is unknown. */
	reason: string | null
	/** The live "You" message for this send is already in the transcript. */
	echoed: boolean
	sentAt: number
	/** When this phase was first observed by the window. */
	phaseAt: number
}

export interface SendReceiptSlots {
	/** Companion header: a node replaces the status word while it is non-null. */
	header?: (view: SendReceiptView) => ReactNode
	/** Directly above the writing surface that sent it. */
	composer?: (view: SendReceiptView) => ReactNode
	/** After the newest message, in the conversation that holds the send. */
	transcript?: (view: SendReceiptView) => ReactNode
	/** Send button label for the scope that sent; null keeps "Send". */
	sendLabel?: (view: SendReceiptView) => ReactNode | null
	/** Hide today's plain "Waiting…"/"Working…" rows and the top banner for this send's refusal. */
	replacesToday?: boolean
}

export interface LastSend {
	id: string
	text: string
	scope: 'whole' | 'passage'
	at: number
	failed: string | null
}

export function deriveSendReceipt(input: {
	last: LastSend | null
	operation: { id: string; phase: 'sending' | 'running' | 'uncertain' } | null
	receipt: ReviewReceipt | null
	session: ReviewSession | null
	agent: string
	marks: Map<string, number>
	now: number
}): SendReceiptView | null {
	const { last, operation, receipt, session } = input
	if (!last) return null
	const live = operation?.id === last.id ? operation : null
	const own = receipt?.id === last.id ? receipt : null
	const messages = session?.messages ?? []
	const replied = messages.some(message => message.id === `${last.id}:assistant`)
	let phase: SendReceiptPhase | null
	let reason: string | null = null
	if (last.failed !== null) {
		phase = 'not-sent'
		reason = last.failed
	} else if (live?.phase === 'uncertain' || own?.outcome === 'unknown' || (live && session?.error)) {
		phase = 'unconfirmed'
		reason = own?.outcome === 'unknown' ? own.detail : (session?.error ?? null)
	} else if (live?.phase === 'sending') phase = 'sending'
	else if (live)
		phase = session?.state === 'working' ? 'working' : own?.outcome === 'dispatched' ? 'received' : 'sending'
	else phase = replied ? 'replied' : null
	if (!phase) return null
	const key = `${last.id}:${phase}`
	if (!input.marks.has(key)) input.marks.set(key, input.now)
	return {
		id: last.id,
		phase,
		scope: last.scope,
		text: last.text,
		agent: input.agent,
		reportsProgress: session?.capabilities.transport === 'in-process',
		reason,
		echoed: messages.some(message => message.id === `${last.id}:user`),
		sentAt: last.at,
		phaseAt: input.marks.get(key) ?? input.now,
	}
}
