// Story-only staged review fixture for the send receipt variants (spec D14). It wraps the display fixture the
// way canvas-fixtures.ts does and replays what the native host does after Send, with its measured timings
// (scratchpad timing run, 2026-11-09): the send IPC returns `pending` ~10 ms after the click, the waiting
// tool prints the feedback and acks ~1.5 ms later (`dispatched`), a Pi caller reports `working` when its
// follow-up turn starts, a `helm edit` caller never does, and the reply lands as a `complete` report. A
// missing ack turns `unknown` after the host's 10 s deadline. Every change reaches the window as a push.
import type { ReviewApi, ReviewMessage, ReviewReceipt, ReviewRequest, ReviewSession } from '../../document-review/types'
import { createReviewFixture } from '../document-review/fixtures'

export type ReceiptAgent = 'claude' | 'pi' | 'cli'
export type ReceiptOutcome = 'reply' | 'not-sent' | 'unconfirmed'
export type ReceiptHold = 'sending' | 'received' | 'working' | null

export interface StagedReviewOptions {
	agent: ReceiptAgent
	outcome: ReceiptOutcome
	/** Click → host answers (production median 10 ms). */
	sendMs: number
	/** Dispatch → the waiting tool acknowledges (production ~1.5 ms). */
	ackMs: number
	/** Ack → Pi reports working (Pi only; a `helm edit` caller never reports). */
	workMs: number
	/** Ack → the reply lands. */
	replyMs: number
	/** No ack → outcome unknown (production 10 000 ms). */
	unknownMs: number
	/** Freeze the flow at this phase for a still frame. */
	hold: ReceiptHold
}

export const REALISTIC: StagedReviewOptions = {
	agent: 'claude',
	outcome: 'reply',
	sendMs: 10,
	ackMs: 2,
	workMs: 900,
	replyMs: 7000,
	unknownMs: 10_000,
	hold: null,
}

const NAMES: Record<ReceiptAgent, string> = {
	claude: 'Claude Code · helm open spec',
	pi: 'Pi · helm open spec',
	cli: 'Document conversation',
}
const NOT_LISTENING = 'The agent is not listening. Ask it to run helm review wait; your feedback was not sent.'
const NO_ACK =
	'The caller did not confirm feedback delivery before its deadline. Inspect the original session; no feedback is replayed.'
const PARTIAL = 'Reading the section on dispatch guarantees. The owner check happens before'
const REPLY =
	'Yes. The window keeps the exact owner so a reply can only come from the conversation that opened the document. If another agent opens it, it gets its own window instead of taking this one over.'

export function createStagedReviewFixture(options: StagedReviewOptions) {
	const base = createReviewFixture('editorial')
	const listeners = new Set<() => void>()
	const timers = new Set<ReturnType<typeof setTimeout>>()
	const receipts = new Map<string, ReviewReceipt>()
	const overlay: Pick<ReviewSession, 'state' | 'listening' | 'busy' | 'error' | 'needsAcknowledgement'> & {
		messages: ReviewMessage[]
	} = { state: 'idle', listening: true, busy: false, error: null, needsAcknowledgement: false, messages: [] }
	let disposed = false
	const notify = () => {
		// The host coalesces every change into one 80 ms push.
		const timer = setTimeout(() => {
			timers.delete(timer)
			if (!disposed) for (const listener of listeners) listener()
		}, 80)
		timers.add(timer)
	}
	const later = (ms: number, run: () => void) => {
		if (!Number.isFinite(ms)) return
		const timer = setTimeout(() => {
			timers.delete(timer)
			if (!disposed) run()
		}, ms)
		timers.add(timer)
	}
	const message = (id: string, role: ReviewMessage['role'], text: string) => {
		const existing = overlay.messages.find(entry => entry.id === id)
		if (existing) existing.text = text
		else overlay.messages.push({ id, role, text })
	}
	const api: ReviewApi = {
		...base.api,
		load: async () => {
			const result = await base.api.load()
			if (!result.data) return result
			const session = result.data.sessions[0]
			if (session) {
				session.provider = options.agent
				session.name = NAMES[options.agent]
				session.capabilities.transport = options.agent === 'pi' ? 'in-process' : 'tool-return'
				Object.assign(session, structuredClone(overlay))
			}
			return result
		},
		send: async (request: ReviewRequest) => {
			if (!overlay.listening || overlay.busy) return { error: 'The document or conversation changed before sending.' }
			if (options.hold === 'sending') return new Promise(() => {})
			await new Promise(resolve => setTimeout(resolve, options.sendMs))
			if (disposed) return { error: 'This review is no longer current.' }
			if (options.outcome === 'not-sent') {
				// The real race: the agent stopped waiting between load and Send, so the host refuses before any
				// effect and the window then sees the agent as not listening.
				overlay.listening = false
				notify()
				return { error: NOT_LISTENING }
			}
			const receipt: ReviewReceipt = {
				id: request.id,
				outcome: 'pending',
				detail:
					'Feedback was offered to the caller; awaiting its delivery confirmation. This does not confirm an edit.',
			}
			receipts.set(request.id, receipt)
			overlay.state = 'waiting'
			overlay.busy = true
			overlay.listening = false
			overlay.messages.push({
				id: `${request.id}:user`,
				role: 'user',
				text: request.instruction,
				...(request.passage
					? { passageContext: { documentId: request.documentId, passage: structuredClone(request.passage) } }
					: {}),
			})
			notify()
			if (options.outcome === 'unconfirmed') {
				later(options.unknownMs, () => {
					receipts.set(request.id, { id: request.id, outcome: 'unknown', detail: NO_ACK })
					Object.assign(overlay, { state: 'error', busy: false, error: NO_ACK, needsAcknowledgement: true })
					notify()
				})
				return { data: receipt }
			}
			later(options.ackMs, () => {
				receipts.set(request.id, { ...receipt, outcome: 'dispatched' })
				notify()
				if (options.hold === 'received') return
				if (options.agent === 'pi')
					later(options.workMs, () => {
						overlay.state = 'working'
						message(`${request.id}:assistant`, 'assistant', PARTIAL)
						notify()
					})
				if (options.hold === 'working') return
				later(options.replyMs, () => {
					Object.assign(overlay, { state: 'idle', busy: false, listening: true })
					message(`${request.id}:assistant`, 'assistant', REPLY)
					notify()
				})
			})
			return { data: receipt }
		},
		receipt: async id => ({ data: receipts.get(id) ?? null }),
		acknowledge: async () => {
			if (overlay.busy) return { error: 'Wait for settlement.' }
			Object.assign(overlay, { state: 'idle', error: null, needsAcknowledgement: false, listening: true })
			notify()
			return { data: true }
		},
		onChanged: listener => {
			listeners.add(listener)
			const remove = base.api.onChanged(listener)
			return () => {
				listeners.delete(listener)
				remove()
			}
		},
	}
	return {
		api,
		dispose: () => {
			disposed = true
			for (const timer of timers) clearTimeout(timer)
			timers.clear()
			listeners.clear()
			base.dispose()
		},
	}
}
