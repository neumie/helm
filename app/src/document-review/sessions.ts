import { createHash, randomUUID } from 'node:crypto'
import type { ReviewFeedback, ReviewProvider, ReviewReceipt, ReviewSession } from './types'

interface Waiter {
	finish(value: ReviewFeedback | null): void
}
interface Pending {
	feedback: ReviewFeedback
	claimed: boolean
	confirmed: boolean
	sequence: number
	lastReport: string | null
	timer: ReturnType<typeof setTimeout>
}
export interface ReviewOwner {
	snapshot: ReviewSession
	workspace: string
	admitting: boolean
	waiter: Waiter | null
	pending: Pending | null
	retired: boolean
}

/** A bounded live mailbox. A caller owns its conversation; Helm owns no agent process. */
export class ReviewSessions {
	private readonly owners = new Map<string, ReviewOwner>()
	private readonly receipts = new Map<
		string,
		{ fingerprint: string; receipt: ReviewReceipt; owner: ReviewOwner; settled: string | null }
	>()
	constructor(
		private readonly changed: () => void,
		private readonly responseDeadlineMs = 15 * 60 * 1000,
		private readonly deliveryDeadlineMs = 10000,
	) {}
	connect(
		provider: ReviewProvider,
		workspace: string,
		name: string,
		transport: 'tool-return' | 'in-process',
	): ReviewSession {
		if (this.owners.size >= 32) {
			const retired = [...this.owners.values()].find(value => value.retired && !value.pending && !value.admitting)
			if (retired) this.owners.delete(retired.snapshot.id)
		}
		if (this.owners.size >= 32) throw new Error('Close an old connection before connecting another (32 per profile).')
		const snapshot: ReviewSession = {
			id: `review:${randomUUID()}`,
			owner: randomUUID(),
			provider,
			name,
			capabilities: {
				transport,
				continuation: 'live-session',
				readOnlyPolicy: 'session-owned',
				interactiveQuestions: true,
				interrupt: 'unsupported',
				providerAcknowledgement: false,
				minimumVersion: transport === 'in-process' ? '0.99.1' : null,
			},
			state: 'disconnected',
			listening: false,
			busy: false,
			needsAcknowledgement: false,
			messages: [],
			error: null,
			historyTruncated: false,
		}
		this.owners.set(snapshot.id, { snapshot, workspace, admitting: false, waiter: null, pending: null, retired: false })
		this.changed()
		return structuredClone(snapshot)
	}
	list(workspace: string): ReviewSession[] {
		return [...this.owners.values()]
			.filter(owner => owner.workspace === workspace)
			.map(owner => ({
				...structuredClone(owner.snapshot),
				busy: owner.admitting || owner.pending !== null,
				listening: !owner.retired && owner.waiter !== null,
			}))
	}
	get(id: string, ownerId: string): ReviewOwner {
		const owner = this.owners.get(id)
		if (!owner || owner.snapshot.owner !== ownerId || owner.retired)
			throw new Error('Connection is unavailable. Reconnect from the original agent; nothing was rerouted.')
		return owner
	}
	reserve(id: string, ownerId: string, workspace: string): ReviewOwner {
		const owner = this.get(id, ownerId)
		if (owner.workspace !== workspace) throw new Error('This connection belongs to another workspace.')
		if (owner.admitting || owner.pending) throw new Error('Wait for the current feedback to settle.')
		if (owner.snapshot.needsAcknowledgement) throw new Error('Check the uncertain feedback before sending again.')
		if (!owner.waiter)
			throw new Error('The agent is not listening. Ask it to run helm review wait; your feedback was not sent.')
		owner.admitting = true
		return owner
	}
	release(owner: ReviewOwner): void {
		owner.admitting = false
	}
	prior(id: string, fingerprint: string): ReviewReceipt | null {
		const prior = this.receipts.get(id)
		if (!prior) return null
		if (prior.fingerprint !== fingerprint) throw new Error('This feedback ID already belongs to a different request.')
		return { ...prior.receipt }
	}
	dispatch(owner: ReviewOwner, id: string, fingerprint: string, feedback: ReviewFeedback): ReviewReceipt {
		if (owner.retired || !owner.admitting || owner.pending || !owner.waiter)
			throw new Error('The listener disconnected before delivery. Your feedback was not sent.')
		if (this.receipts.size >= 256)
			throw new Error(
				'The feedback ledger is full. Check all outcomes before deliberately reopening Helm; nothing was sent.',
			)
		if (
			feedback.request.id !== id ||
			feedback.request.owner !== owner.snapshot.owner ||
			feedback.request.sessionId !== owner.snapshot.id
		)
			throw new Error('Feedback no longer belongs to this connection.')
		const receipt: ReviewReceipt = {
			id,
			outcome: 'pending',
			detail: 'Handing feedback to the connected caller. This does not confirm an edit.',
		}
		this.receipts.set(id, { fingerprint, receipt, owner, settled: null })
		owner.admitting = false
		owner.snapshot.state = 'waiting'
		owner.snapshot.error = null
		owner.snapshot.messages.push({ id: `${id}:user`, role: 'user', text: feedback.request.instruction })
		owner.pending = {
			feedback: structuredClone(feedback),
			claimed: false,
			confirmed: false,
			sequence: -1,
			lastReport: null,
			timer: setTimeout(
				() =>
					this.uncertain(
						owner,
						'The caller did not confirm feedback delivery before its deadline. Inspect the original session; no feedback is replayed.',
					),
				this.deliveryDeadlineMs,
			),
		}
		owner.pending.timer.unref()
		const waiter = owner.waiter
		owner.pending.claimed = true
		receipt.detail =
			'Feedback was offered to the caller; awaiting its delivery confirmation. This does not confirm an edit.'
		waiter.finish(structuredClone(feedback))
		this.bound(owner)
		this.changed()
		return { ...receipt }
	}
	next(id: string, ownerId: string, timeoutMs: number, signal: AbortSignal): Promise<ReviewFeedback | null> {
		const owner = this.get(id, ownerId)
		if (signal.aborted) return Promise.reject(new Error('Listening was cancelled.'))
		if (owner.waiter || owner.pending || owner.admitting || owner.snapshot.needsAcknowledgement)
			return Promise.reject(new Error('This connection already has a listener or unresolved feedback.'))
		return new Promise((resolve, reject) => {
			let done = false
			const finish = (value: ReviewFeedback | null, cancelled = false) => {
				if (done) return
				done = true
				clearTimeout(timer)
				signal.removeEventListener('abort', aborted)
				if (owner.waiter === waiter) owner.waiter = null
				if (!owner.pending) owner.snapshot.state = 'disconnected'
				this.changed()
				if (cancelled) reject(new Error('Listening was cancelled.'))
				else resolve(value)
			}
			const waiter: Waiter = { finish: value => finish(value) }
			const aborted = () => finish(null, true)
			const timer = setTimeout(() => finish(null), timeoutMs)
			owner.waiter = waiter
			owner.snapshot.state = 'idle'
			owner.snapshot.error = null
			signal.addEventListener('abort', aborted, { once: true })
			this.changed()
		})
	}
	confirm(id: string, ownerId: string, requestId: string): void {
		const owner = this.get(id, ownerId)
		const pending = owner.pending
		if (!pending || !pending.claimed || pending.feedback.request.id !== requestId)
			throw new Error('That feedback is not awaiting delivery confirmation.')
		if (pending.confirmed) return
		pending.confirmed = true
		clearTimeout(pending.timer)
		pending.timer = setTimeout(
			() =>
				this.uncertain(
					owner,
					'The caller did not report completion before its deadline. Inspect the original session; no feedback is replayed.',
				),
			this.responseDeadlineMs,
		)
		pending.timer.unref()
		const entry = this.receipts.get(requestId)
		if (entry)
			entry.receipt = {
				id: requestId,
				outcome: 'dispatched',
				detail: 'Dispatched to the existing caller. This does not prove provider acceptance or a file edit.',
			}
		this.changed()
	}
	report(
		id: string,
		ownerId: string,
		requestId: string,
		sequence: number,
		state: 'working' | 'complete' | 'error',
		text: string,
	): void {
		const owner = this.get(id, ownerId)
		const pending = owner.pending
		const report = createHash('sha256').update(JSON.stringify({ sequence, state, text })).digest('hex')
		const entry = this.receipts.get(requestId)
		if (entry?.owner === owner && entry.settled === report) return
		if (!pending || pending.feedback.request.id !== requestId || !pending.confirmed)
			throw new Error('Only confirmed, current feedback can receive a reply.')
		if (sequence < pending.sequence) return
		if (sequence === pending.sequence) {
			if (report !== pending.lastReport) throw new Error('A report sequence cannot change its contents.')
			return
		}
		pending.sequence = sequence
		pending.lastReport = report
		owner.snapshot.state = state === 'working' ? 'working' : state === 'error' ? 'error' : 'disconnected'
		if (text) {
			const messageId = `${requestId}:assistant`
			const message = owner.snapshot.messages.find(value => value.id === messageId)
			if (message) message.text = text
			else owner.snapshot.messages.push({ id: messageId, role: 'assistant', text })
		}
		if (state !== 'working') {
			clearTimeout(pending.timer)
			if (entry) entry.settled = report
			owner.pending = null
			owner.snapshot.error =
				state === 'error' ? 'The caller reported a failure. Inspect the document and original session.' : null
			if (state === 'error')
				owner.snapshot.messages.push({
					id: `${requestId}:error`,
					role: 'activity',
					text: 'The caller reported a failure. Inspect the document and original session.',
				})
		}
		this.bound(owner)
		this.changed()
	}
	receipt(id: string, sessionId?: string): ReviewReceipt | null {
		const entry = this.receipts.get(id)
		return entry && (!sessionId || entry.owner.snapshot.id === sessionId) ? { ...entry.receipt } : null
	}
	disconnect(id: string, ownerId: string): void {
		const owner = this.get(id, ownerId)
		owner.retired = true
		owner.waiter?.finish(null)
		if (owner.pending)
			this.uncertain(
				owner,
				'The connection closed with feedback outstanding. Inspect the original session; nothing will be replayed.',
			)
		owner.snapshot.state = 'disconnected'
		this.changed()
	}
	acknowledge(id: string, ownerId: string): void {
		const owner = this.owners.get(id)
		if (!owner || owner.snapshot.owner !== ownerId || owner.pending)
			throw new Error('Check the original owner after its active request settles.')
		owner.snapshot.needsAcknowledgement = false
		owner.snapshot.error = null
		this.changed()
	}
	interrupt(): boolean {
		throw new Error('Helm does not own this agent. Interrupt it in its original terminal.')
	}
	admittedCount(): number {
		return [...this.owners.values()].filter(owner => owner.pending || owner.admitting).length
	}
	isBusy(): boolean {
		return this.admittedCount() > 0
	}
	stopOwned(): void {
		for (const owner of this.owners.values())
			if (!owner.retired) this.disconnect(owner.snapshot.id, owner.snapshot.owner)
	}
	private uncertain(owner: ReviewOwner, message: string): void {
		const pending = owner.pending
		if (!pending) return
		clearTimeout(pending.timer)
		const entry = this.receipts.get(pending.feedback.request.id)
		if (entry) entry.receipt = { id: entry.receipt.id, outcome: 'unknown', detail: message }
		owner.pending = null
		owner.snapshot.needsAcknowledgement = true
		owner.snapshot.error = message
		owner.snapshot.state = 'error'
		this.changed()
	}
	private bound(owner: ReviewOwner): void {
		let units = owner.snapshot.messages.reduce((sum, value) => sum + value.text.length, 0)
		while (owner.snapshot.messages.length > 80 || units > 160000) {
			const removed = owner.snapshot.messages.shift()
			units -= removed?.text.length ?? 0
			owner.snapshot.historyTruncated = true
		}
	}
}
