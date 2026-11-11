import { createHash, randomUUID } from 'node:crypto'
import { refuse, restartingRefusal } from '../../../src/document-review/refusal'
import type { ArchiveSettlement } from './canvas-persistence'
import type { ReviewOwnerRecord } from './owner-store'
import type {
	CanvasReviewThread,
	ReviewFeedback,
	ReviewProvider,
	ReviewReadResult,
	ReviewReceipt,
	ReviewSession,
} from './types'

interface Waiter {
	documentId?: string
	/** The listening process's own nonce (`listener` feature); an offered feedback goes again only to it. */
	listener?: string
	finish(value: ReviewReadResult): void
	/** End the read with a definite refusal (Helm is restarting): nothing was handed over. */
	fail(error: Error): void
}
/** The journal thread a feedback opened, kept so a reply after a restart settles that same thread. */
export interface ArchiveReference {
	thread: CanvasReviewThread
	root: string
	file: string
}
export interface ArchiveHandle {
	id: string
	/** Resolves true once the settlement is in the document's journal. */
	settle(value: ArchiveSettlement): Promise<boolean>
	reference?: ArchiveReference
}
/** A journal settlement that was decided but not yet written: kept on disk so a crash cannot lose it. */
interface OutstandingSettlement {
	reference: ArchiveReference
	settlement: ArchiveSettlement
}
/**
 * Where caller state is kept across a Helm restart (S13). `save(id, null)` forgets the caller. A save resolves
 * once that state (or a newer one) is on disk; Helm hands a feedback to a listener only after its save resolved.
 */
export interface ReviewOwnerPersistence {
	profileId: string
	save(id: string, record: ReviewOwnerRecord | null): Promise<void>
}
interface Pending {
	feedback: ReviewFeedback
	/** Handed to a listener in THIS process (its answer may still be lost). */
	claimed: boolean
	/** Handed to a listener at some point, in this process or before a restart. */
	offered: boolean
	/** The listener nonce it was last handed to (null: a listener without one). */
	offeredTo: string | null
	/** On disk: a listener may receive it. Without persistence it is ready at once. */
	kept: boolean
	sentAt: number
	confirmed: boolean
	/** Host clock at delivery confirmation; the completion deadline never moves past it plus the cap. */
	confirmedAt: number
	/** Host clock the completion deadline currently ends at (0 before confirmation). */
	until: number
	sequence: number
	lastReport: string | null
	archive?: ArchiveHandle
	timer: ReturnType<typeof setTimeout> | null
}
/**
 * The provider's own session id a caller offered at connect (`session-hint`, S12). Host memory only, never on the
 * snapshot or the wire; display-only progress may read that session's file, nothing else uses it.
 */
export interface SessionHint {
	provider: 'claude' | 'codex'
	session: string
}
/** A confirmed, still pending request whose caller hinted its provider session (activity-watcher.ts reads it). */
export interface ActivityTarget {
	id: string
	owner: string
	requestId: string
	documentId: string
	workspace: string
	hint: SessionHint
	/** Host clock at the ack. */
	confirmedAt: number
}
export interface ReviewOwner {
	snapshot: ReviewSession
	workspace: string
	hint?: SessionHint
	admitting: boolean
	waiter: Waiter | null
	pending: Pending | null
	retired: boolean
	/** Windows this caller opened that are still open (or were, when Helm quit). */
	documents: Map<string, { root: string; file: string }>
	/** Restored documents not reopened yet: the caller's next read on one reopens it with the same id. */
	restorable: Set<string>
	/** The newest settled replies (request id + report hash): a resend after a restart is a no-op. */
	settled: { requestId: string; report: string }[]
	/** Journal settlements decided but not yet written (see OutstandingSettlement). */
	outstanding: OutstandingSettlement[]
	usedAt: number
	/** When `usedAt` was last written; it is refreshed on disk at most every few minutes. */
	keptUsedAt: number
}
/** How long a feedback nobody picks up stays waiting before it is called not delivered. */
const PICKUP_DEADLINE_MS = 15 * 60 * 1000

/** The strict v1 control-wire receipt: host timestamps are renderer-only display data and never reach a caller. */
export function wireReceipt(receipt: ReviewReceipt | null): ReviewReceipt | null {
	return receipt && { id: receipt.id, outcome: receipt.outcome, detail: receipt.detail }
}

/** A bounded live mailbox. A caller owns its conversation; Helm owns no agent process. */
export class ReviewSessions {
	private readonly owners = new Map<string, ReviewOwner>()
	private readonly receipts = new Map<
		string,
		{ fingerprint: string; receipt: ReviewReceipt; owner: ReviewOwner; settled: string | null }
	>()
	/** Helm is quitting: reads end with the restarting refusal, and nothing new is admitted or timed out. */
	private suspended = false
	/**
	 * `responseDeadlineMs` is the completion deadline after delivery or after the caller's latest `working` report;
	 * `responseCapMs` bounds every renewal from delivery, so a looping or forged report cannot hold a request open
	 * forever. Renewal never settles, revives or replays anything.
	 */
	constructor(
		private readonly changed: () => void,
		private readonly responseDeadlineMs = 15 * 60 * 1000,
		private readonly deliveryDeadlineMs = 10000,
		private readonly responseCapMs = Math.max(2 * 60 * 60 * 1000, responseDeadlineMs),
		private readonly persistence: ReviewOwnerPersistence | null = null,
		private readonly pickupDeadlineMs = PICKUP_DEADLINE_MS,
	) {}
	connect(
		provider: ReviewProvider,
		workspace: string,
		name: string,
		transport: 'tool-return' | 'in-process',
		hint?: SessionHint,
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
			state: 'idle',
			listening: false,
			busy: false,
			needsAcknowledgement: false,
			messages: [],
			error: null,
			historyTruncated: false,
		}
		const now = Date.now()
		const owner: ReviewOwner = {
			snapshot,
			workspace,
			...(hint && hint.provider === provider ? { hint: { ...hint } } : {}),
			admitting: false,
			waiter: null,
			pending: null,
			retired: false,
			documents: new Map(),
			restorable: new Set(),
			settled: [],
			outstanding: [],
			usedAt: now,
			keptUsedAt: now,
		}
		this.owners.set(snapshot.id, owner)
		void this.persist(owner).catch(() => {})
		this.changed()
		return structuredClone(snapshot)
	}
	/**
	 * Bring back a caller kept before a restart (S13): same id, owner and history; its unfinished feedback with it.
	 * A confirmed feedback gets a fresh completion deadline (never past its cap); an unconfirmed one waits for the
	 * caller's next read, which offers that same feedback again. `archive` re-adopts the feedback's journal thread.
	 */
	restore(
		record: ReviewOwnerRecord,
		archive?: (reference: ArchiveReference) => ArchiveHandle | undefined,
	): ReviewSession {
		if (this.owners.has(record.snapshot.id)) throw new Error('This caller is already connected.')
		if (this.owners.size >= 32) throw new Error('Close an old connection before connecting another (32 per profile).')
		const snapshot: ReviewSession = {
			...structuredClone(record.snapshot),
			state: 'idle',
			listening: false,
			busy: false,
		}
		const now = Date.now()
		const owner: ReviewOwner = {
			snapshot,
			workspace: record.workspace,
			...(record.hint && record.hint.provider === snapshot.provider ? { hint: { ...record.hint } } : {}),
			admitting: false,
			waiter: null,
			pending: null,
			retired: false,
			documents: new Map(record.documents.map(value => [value.documentId, { root: value.root, file: value.file }])),
			restorable: new Set(record.documents.map(value => value.documentId)),
			settled: record.settled.map(value => ({ ...value })),
			outstanding: record.outstanding.map(value => structuredClone(value)),
			usedAt: now,
			keptUsedAt: record.usedAt,
		}
		this.owners.set(snapshot.id, owner)
		// Settlements decided before the restart are written now (a thread already settled is left as it is).
		for (const entry of [...owner.outstanding]) {
			const handle = archive?.(entry.reference)
			if (!handle) continue
			void handle.settle(entry.settlement).then(written => {
				if (!written) return
				owner.outstanding = owner.outstanding.filter(value => value !== entry)
				void this.persist(owner).catch(() => {})
			})
		}
		const kept = record.pending
		if (kept) {
			const handle = kept.archive ? archive?.(kept.archive) : undefined
			const pending: Pending = {
				feedback: structuredClone(kept.feedback),
				claimed: false,
				offered: kept.offered,
				offeredTo: kept.offeredTo,
				kept: true,
				sentAt: kept.sentAt,
				confirmed: kept.confirmed,
				// Helm being down is not the caller being silent: the cap moves on by the time Helm was away.
				confirmedAt: kept.confirmed ? kept.confirmedAt + Math.max(0, now - record.usedAt) : 0,
				until: 0,
				sequence: kept.sequence,
				lastReport: kept.lastReport,
				...(handle ? { archive: handle } : {}),
				timer: null,
			}
			owner.pending = pending
			snapshot.state = kept.confirmed ? 'working' : 'waiting'
			const id = kept.feedback.request.id
			this.receipts.set(id, {
				fingerprint: `restored:${id}`,
				receipt: {
					id,
					outcome: kept.confirmed ? 'dispatched' : 'pending',
					detail: kept.confirmed
						? 'Dispatched to the existing caller before Helm restarted. This does not prove provider acceptance or a file edit.'
						: 'Kept across the Helm restart; it goes to the caller as soon as it listens again. This does not confirm an edit.',
					sentAt: kept.sentAt,
				},
				owner,
				settled: null,
			})
			if (kept.confirmed) this.armCompletion(owner, pending, now)
			else this.armPickup(owner, pending)
		}
		this.changed()
		return structuredClone(snapshot)
	}
	/** This caller had `documentId` open before the restart and has not reopened it yet: where it was. */
	restorableDocument(id: string, ownerId: string, documentId: string): { root: string; file: string } | null {
		const owner = this.get(id, ownerId)
		if (!owner.restorable.has(documentId)) return null
		return owner.documents.get(documentId) ?? null
	}
	/** A window this caller opened (or reopened after a restart): kept so a restart can bring it back. */
	track(id: string, ownerId: string, documentId: string, root: string, file: string): void {
		const owner = this.get(id, ownerId)
		owner.restorable.delete(documentId)
		const prior = owner.documents.get(documentId)
		if (prior?.root === root && prior.file === file) return
		owner.documents.set(documentId, { root, file })
		while (owner.documents.size > 8) {
			const oldest = owner.documents.keys().next().value as string
			owner.documents.delete(oldest)
			owner.restorable.delete(oldest)
		}
		void this.persist(owner).catch(() => {})
	}
	/** The caller is still here: refresh its last use on disk now and then, so a long-lived caller is not expired. */
	touch(id: string, ownerId: string): void {
		const owner = this.get(id, ownerId)
		owner.usedAt = Date.now()
		if (owner.usedAt - owner.keptUsedAt > 5 * 60 * 1000) void this.persist(owner).catch(() => {})
	}
	/** Resolves once this caller's current state is on disk (a no-op without persistence or for an unknown id). */
	flush(id: string): Promise<void> {
		const owner = this.owners.get(id)
		return owner ? this.persist(owner) : Promise.resolve()
	}
	private record(owner: ReviewOwner): ReviewOwnerRecord | null {
		if (owner.retired || !this.persistence) return null
		const pending = owner.pending
		return {
			version: 1,
			profileId: this.persistence.profileId,
			workspace: owner.workspace,
			usedAt: owner.usedAt,
			...(owner.hint ? { hint: { ...owner.hint } } : {}),
			snapshot: { ...structuredClone(owner.snapshot), listening: false, busy: false },
			documents: [...owner.documents.entries()].map(([documentId, value]) => ({ documentId, ...value })),
			pending: pending
				? {
						feedback: structuredClone(pending.feedback),
						offered: pending.offered,
						offeredTo: pending.offeredTo,
						confirmed: pending.confirmed,
						confirmedAt: pending.confirmedAt,
						sequence: pending.sequence,
						lastReport: pending.lastReport,
						sentAt: pending.sentAt,
						archive: pending.archive?.reference ? structuredClone(pending.archive.reference) : null,
					}
				: null,
			settled: owner.settled.map(value => ({ ...value })),
			outstanding: owner.outstanding.map(value => structuredClone(value)),
		}
	}
	/**
	 * Write a settlement to the document's journal. With persistence it is first kept on the caller's record, so a
	 * crash between the two writes is repaired at the next start (the journal skips a thread already settled).
	 */
	private settleArchive(owner: ReviewOwner, pending: Pending, settlement: ArchiveSettlement): void {
		const handle = pending.archive
		if (!handle) return
		const reference = handle.reference
		if (!this.persistence || !reference || owner.retired) {
			void handle.settle(settlement)
			return
		}
		const entry: OutstandingSettlement = { reference: structuredClone(reference), settlement: { ...settlement } }
		owner.outstanding = [...owner.outstanding, entry].slice(-8)
		const write = () =>
			handle.settle(settlement).then(written => {
				if (!written) return
				owner.outstanding = owner.outstanding.filter(value => value !== entry)
				void this.persist(owner).catch(() => {})
			})
		void this.persist(owner).then(write, write)
	}
	private persist(owner: ReviewOwner): Promise<void> {
		if (!this.persistence) return Promise.resolve()
		owner.keptUsedAt = owner.usedAt
		return this.persistence.save(owner.snapshot.id, this.record(owner))
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
	reserve(id: string, ownerId: string, workspace: string, documentId?: string): ReviewOwner {
		if (this.suspended)
			throw new Error('Helm is restarting. Your feedback was not sent; send it again after Helm starts.')
		const owner = this.get(id, ownerId)
		if (owner.workspace !== workspace) throw new Error('This connection belongs to another workspace.')
		if (owner.admitting || owner.pending) throw new Error('Wait for the current feedback to settle.')
		if (owner.snapshot.needsAcknowledgement) throw new Error('Check the uncertain feedback before sending again.')
		if (!owner.waiter)
			throw new Error('The agent is not listening. Ask it to run helm review wait; your feedback was not sent.')
		if (owner.waiter.documentId && owner.waiter.documentId !== documentId)
			throw new Error('The agent is listening to a different document. Your feedback was not sent.')
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
	dispatch(
		owner: ReviewOwner,
		id: string,
		fingerprint: string,
		feedback: ReviewFeedback,
		archive?: ArchiveHandle,
	): ReviewReceipt {
		if (owner.retired || !owner.admitting || owner.pending || !owner.waiter)
			throw new Error('The listener disconnected before delivery. Your feedback was not sent.')
		if (this.receipts.size >= 256)
			throw new Error(
				'The feedback ledger is full. Check all outcomes before deliberately reopening Helm; nothing was sent.',
			)
		if (
			feedback.request.id !== id ||
			feedback.request.owner !== owner.snapshot.owner ||
			feedback.request.sessionId !== owner.snapshot.id ||
			(owner.waiter.documentId !== undefined && owner.waiter.documentId !== feedback.request.documentId)
		)
			throw new Error('Feedback no longer belongs to this connection.')
		const sentAt = Date.now()
		const receipt: ReviewReceipt = {
			id,
			outcome: 'pending',
			detail: 'Handing feedback to the connected caller. This does not confirm an edit.',
			sentAt,
		}
		this.receipts.set(id, { fingerprint, receipt, owner, settled: null })
		owner.admitting = false
		owner.snapshot.state = 'waiting'
		owner.snapshot.error = null
		owner.snapshot.messages.push({
			id: `${id}:user`,
			role: 'user',
			...(archive ? { archiveThreadId: archive.id } : {}),
			text: feedback.request.instruction,
			at: sentAt,
			...(feedback.request.passage
				? {
						passageContext: {
							documentId: feedback.request.documentId,
							passage: structuredClone(feedback.request.passage),
						},
					}
				: {}),
		})
		const pending: Pending = {
			feedback: structuredClone(feedback),
			claimed: false,
			offered: false,
			offeredTo: null,
			kept: !this.persistence,
			sentAt,
			confirmed: false,
			confirmedAt: 0,
			until: 0,
			sequence: -1,
			lastReport: null,
			...(archive ? { archive } : {}),
			timer: null,
		}
		owner.pending = pending
		this.bound(owner)
		if (pending.kept) this.offer(owner, pending)
		else {
			// Durable before anyone can see it: the feedback goes to the listener only once it is on disk, so a
			// restart never loses what was handed over. A listener that ended meanwhile gets it on its next read.
			this.persist(owner).then(
				() => {
					if (owner.pending !== pending) return
					pending.kept = true
					if (owner.waiter && !owner.retired && !this.suspended) this.offer(owner, pending)
					else this.armPickup(owner, pending)
				},
				() =>
					this.notSent(owner, pending, 'Helm could not keep this feedback on disk, so it was not sent. Send it again.'),
			)
			receipt.detail = 'Saving the feedback, then handing it to the connected caller. This does not confirm an edit.'
		}
		this.changed()
		return { ...receipt }
	}
	/** Hand the pending feedback to the current listener; the caller must confirm it before the delivery deadline. */
	private offer(owner: ReviewOwner, pending: Pending): void {
		const waiter = owner.waiter
		if (!waiter || owner.pending !== pending) return
		this.clearTimer(pending)
		pending.claimed = true
		const firstOffer = !pending.offered
		pending.offered = true
		if (firstOffer) pending.offeredTo = waiter.listener ?? null
		pending.timer = setTimeout(
			() =>
				this.uncertain(
					owner,
					'The caller did not confirm feedback delivery before its deadline. Inspect the original session; no feedback is replayed.',
				),
			this.deliveryDeadlineMs,
		)
		pending.timer.unref()
		const entry = this.receipts.get(pending.feedback.request.id)
		if (entry && entry.receipt.outcome === 'pending')
			entry.receipt.detail =
				'Feedback was offered to the caller; awaiting its delivery confirmation. This does not confirm an edit.'
		const deliver = () => {
			if (owner.waiter === waiter && owner.pending === pending) waiter.finish(structuredClone(pending.feedback))
		}
		// `offered` must be on disk before the caller can see the feedback: after a restart an offered feedback
		// is uncertain, never "not sent".
		if (firstOffer && this.persistence)
			void this.persist(owner).then(deliver, () => {
				if (owner.pending !== pending || pending.confirmed) return
				pending.offered = false
				pending.offeredTo = null
				pending.claimed = false
				this.notSent(owner, pending, 'Helm could not keep this feedback on disk, so it was not sent. Send it again.')
			})
		else deliver()
		this.changed()
	}
	/** Unoffered feedback waits for a listener; nobody picking it up in time means it was not delivered. */
	private armPickup(owner: ReviewOwner, pending: Pending): void {
		if (owner.pending !== pending || pending.confirmed || this.suspended) return
		this.clearTimer(pending)
		pending.timer = setTimeout(() => {
			if (owner.pending !== pending || pending.claimed) return
			if (pending.offered)
				this.uncertain(
					owner,
					'The caller did not come back for this feedback after Helm restarted. Inspect the original session; nothing is replayed.',
				)
			else this.notSent(owner, pending, 'The caller did not listen again in time. Your feedback was not sent.')
		}, this.pickupDeadlineMs)
		pending.timer.unref()
	}
	/** A feedback no caller ever saw: known not delivered, so it may be sent again. */
	private notSent(owner: ReviewOwner, pending: Pending, detail: string): void {
		if (owner.pending !== pending || pending.offered) return
		this.clearTimer(pending)
		this.settleArchive(owner, pending, { state: 'rejected', detail })
		const entry = this.receipts.get(pending.feedback.request.id)
		if (entry)
			entry.receipt = {
				id: entry.receipt.id,
				outcome: 'rejected',
				detail,
				...(entry.receipt.sentAt === undefined ? {} : { sentAt: entry.receipt.sentAt }),
				settledAt: Date.now(),
			}
		owner.pending = null
		owner.snapshot.state = owner.retired ? 'disconnected' : 'idle'
		owner.snapshot.messages.push({
			id: `${pending.feedback.request.id}:error`,
			role: 'activity',
			text: detail,
			at: Date.now(),
		})
		this.bound(owner)
		void this.persist(owner).catch(() => {})
		this.changed()
	}
	private clearTimer(pending: Pending): void {
		if (pending.timer) clearTimeout(pending.timer)
		pending.timer = null
	}
	/** End only the idle read for this exact window; keep caller/reply authority alive. */
	closeDocument(documentId: string): void {
		// Windows closing because Helm quits come back after the restart: no read ends, nothing is forgotten.
		if (this.suspended) return
		for (const owner of this.owners.values()) {
			const waiter = owner.waiter
			if (waiter?.documentId === documentId) waiter.finish({ closed: true, documentId })
			// Jakub closed the window before its agent got the feedback: it was not sent, and is not kept waiting.
			const pending = owner.pending
			if (pending && !pending.offered && pending.feedback.request.documentId === documentId)
				this.notSent(
					owner,
					pending,
					'The document window closed before the agent received this feedback. It was not sent.',
				)
			if (owner.documents.delete(documentId)) {
				owner.restorable.delete(documentId)
				void this.persist(owner).catch(() => {})
			}
		}
	}
	/**
	 * A window closed because Helm quits (or a quit asked every window to close): its listener is told Helm is
	 * restarting, and the document stays this caller's, to come back on its next read, after the restart or at once.
	 */
	closeDocumentForRestart(documentId: string): void {
		for (const owner of this.owners.values()) {
			if (owner.waiter?.documentId === documentId) owner.waiter.fail(restartingRefusal())
			if (owner.documents.has(documentId) && !owner.restorable.has(documentId)) {
				owner.restorable.add(documentId)
				if (!this.suspended) void this.persist(owner).catch(() => {})
			}
		}
	}
	/** Restorable documents of this caller (windows it had open that are not open now). */
	restorableDocuments(id: string, ownerId: string): { documentId: string; root: string; file: string }[] {
		const owner = this.get(id, ownerId)
		return [...owner.restorable].flatMap(documentId => {
			const kept = owner.documents.get(documentId)
			return kept ? [{ documentId, ...kept }] : []
		})
	}
	next(
		id: string,
		ownerId: string,
		timeoutMs: number,
		signal: AbortSignal,
		documentId?: undefined,
		listener?: string,
	): Promise<ReviewFeedback | null>
	next(
		id: string,
		ownerId: string,
		timeoutMs: number,
		signal: AbortSignal,
		documentId: string,
		listener?: string,
	): Promise<ReviewReadResult>
	next(
		id: string,
		ownerId: string,
		timeoutMs: number,
		signal: AbortSignal,
		documentId?: string,
		listener?: string,
	): Promise<ReviewReadResult> {
		const owner = this.get(id, ownerId)
		if (this.suspended) return Promise.reject(restartingRefusal())
		if (signal.aborted) return Promise.reject(new Error('Listening was cancelled.'))
		const pending = owner.pending
		if (owner.waiter || owner.admitting || owner.snapshot.needsAcknowledgement)
			return Promise.reject(new Error('This connection already has a listener or unresolved feedback.'))
		// A feedback this caller has not confirmed yet is offered again (its answer was lost, or Helm restarted): one
		// no listener ever saw goes to any read of this caller; one already handed over goes only to the same
		// listening process (its nonce), never to another one, which may duplicate it. A confirmed one must be
		// answered first.
		let again = false
		if (pending) {
			if (pending.confirmed || (documentId !== undefined && pending.feedback.request.documentId !== documentId))
				return Promise.reject(new Error('This connection already has a listener or unresolved feedback.'))
			if (pending.offered && (!listener || pending.offeredTo !== listener)) {
				this.uncertain(
					owner,
					'This feedback was handed to an earlier listener that never confirmed it. Inspect the original session; nothing is replayed.',
				)
				// A definite answer for the agent: this read did nothing else, and the feedback is not coming again.
				return Promise.reject(
					refuse(
						'Feedback handed to an earlier listener was never confirmed; Helm marked it unknown and will not replay it. Check it in the document window.',
					),
				)
			}
			again = true
		}
		return new Promise((resolve, reject) => {
			let done = false
			const finish = (value: ReviewReadResult, failure?: Error) => {
				if (done) return
				done = true
				clearTimeout(timer)
				signal.removeEventListener('abort', aborted)
				if (owner.waiter === waiter) owner.waiter = null
				if (!owner.pending) owner.snapshot.state = owner.retired ? 'disconnected' : 'idle'
				// An offered feedback whose read ended without reaching the caller waits for the next read.
				else if (owner.pending.claimed && !owner.pending.confirmed && value === null) owner.pending.claimed = false
				this.changed()
				if (failure) reject(failure)
				else resolve(value)
			}
			const waiter: Waiter = {
				documentId,
				...(listener ? { listener } : {}),
				finish: value => finish(value),
				fail: error => finish(null, error),
			}
			const aborted = () => finish(null, new Error('Listening was cancelled.'))
			const timer = setTimeout(() => finish(null), timeoutMs)
			owner.waiter = waiter
			if (!owner.pending) owner.snapshot.state = 'idle'
			owner.snapshot.error = null
			signal.addEventListener('abort', aborted, { once: true })
			if (again && pending?.kept) this.offer(owner, pending)
			this.changed()
		})
	}
	confirm(id: string, ownerId: string, requestId: string): void {
		const owner = this.get(id, ownerId)
		const pending = owner.pending
		if (!pending || !pending.offered || pending.feedback.request.id !== requestId)
			throw new Error('That feedback is not awaiting delivery confirmation.')
		if (pending.confirmed) return
		pending.confirmed = true
		pending.claimed = true
		pending.confirmedAt = Date.now()
		this.armCompletion(owner, pending)
		const entry = this.receipts.get(requestId)
		if (entry)
			entry.receipt = {
				id: requestId,
				outcome: 'dispatched',
				detail: 'Dispatched to the existing caller. This does not prove provider acceptance or a file edit.',
				...(entry.receipt.sentAt === undefined ? {} : { sentAt: entry.receipt.sentAt }),
			}
		void this.persist(owner).catch(() => {})
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
		// The same reply again after a restart lost its answer: already settled, nothing changes.
		if (owner.settled.some(value => value.requestId === requestId && value.report === report)) return
		// A reply proves the caller has the feedback even when its confirmation was lost in a restart.
		if (pending && pending.feedback.request.id === requestId && pending.offered && !pending.confirmed)
			this.confirm(id, ownerId, requestId)
		if (!pending || pending.feedback.request.id !== requestId || !pending.confirmed)
			throw new Error('Only confirmed, current feedback can receive a reply.')
		if (sequence < pending.sequence) return
		if (sequence === pending.sequence) {
			if (report !== pending.lastReport) throw new Error('A report sequence cannot change its contents.')
			return
		}
		pending.sequence = sequence
		pending.lastReport = report
		owner.snapshot.state = state === 'working' ? 'working' : state === 'error' ? 'error' : 'idle'
		const at = Date.now()
		if (text) {
			const messageId = `${requestId}:assistant`
			const message = owner.snapshot.messages.find(value => value.id === messageId)
			if (message) message.text = text
			else
				owner.snapshot.messages.push({
					id: messageId,
					role: 'assistant',
					text,
					...(pending.archive ? { archiveThreadId: pending.archive.id } : {}),
					at,
				})
		}
		// A newer working report is the caller's own evidence that it is still on this request: renew the
		// completion deadline, never past the cap from delivery.
		if (state === 'working') this.armCompletion(owner, pending)
		if (state !== 'working') {
			this.settleArchive(owner, pending, { state, reply: text })
			this.clearTimer(pending)
			owner.settled = [...owner.settled.filter(value => value.requestId !== requestId), { requestId, report }].slice(-8)
			if (entry) {
				entry.settled = report
				entry.receipt = { ...entry.receipt, settledAt: at }
			}
			owner.pending = null
			owner.snapshot.error =
				state === 'error' ? 'The caller reported a failure. Inspect the document and original session.' : null
			if (state === 'error')
				owner.snapshot.messages.push({
					id: `${requestId}:error`,
					role: 'activity',
					text: 'The caller reported a failure. Inspect the document and original session.',
					at,
				})
		}
		this.bound(owner)
		void this.persist(owner).catch(() => {})
		this.changed()
	}
	/** Confirmed pending requests of hinted callers; display-only progress reads only these. */
	activityTargets(): ActivityTarget[] {
		const targets: ActivityTarget[] = []
		for (const owner of this.owners.values()) {
			const pending = owner.pending
			if (owner.retired || !owner.hint || !pending?.confirmed) continue
			targets.push({
				id: owner.snapshot.id,
				owner: owner.snapshot.owner,
				requestId: pending.feedback.request.id,
				documentId: pending.feedback.request.documentId,
				workspace: owner.workspace,
				hint: { ...owner.hint },
				confirmedAt: pending.confirmedAt,
			})
		}
		return targets
	}
	/** Whether this exact owner still exists and is not retired (frozen activity is dropped otherwise). */
	live(id: string, ownerId: string): boolean {
		const owner = this.owners.get(id)
		return Boolean(owner && owner.snapshot.owner === ownerId && !owner.retired)
	}
	/**
	 * Freshly observed bound activity (S12, display-only evidence) renews the completion deadline of this exact
	 * owner and still pending, confirmed request: min(observedAt + deadline, delivery + cap). It never confirms,
	 * settles, revives or replays anything; a request that is gone stays gone.
	 */
	renew(id: string, ownerId: string, requestId: string, observedAt = Date.now()): boolean {
		const owner = this.owners.get(id)
		const pending = owner?.pending
		if (!owner || owner.snapshot.owner !== ownerId || owner.retired || !pending?.confirmed) return false
		if (pending.feedback.request.id !== requestId) return false
		// Never shortens a deadline a newer report or observation already set.
		if (this.completionUntil(pending, observedAt) <= pending.until) return false
		this.armCompletion(owner, pending, observedAt)
		return true
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
		void this.persist(owner).catch(() => {})
		this.changed()
	}
	acknowledge(id: string, ownerId: string): void {
		const owner = this.owners.get(id)
		if (!owner || owner.snapshot.owner !== ownerId || owner.pending)
			throw new Error('Check the original owner after its active request settles.')
		owner.snapshot.needsAcknowledgement = false
		owner.snapshot.error = null
		void this.persist(owner).catch(() => {})
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
	/**
	 * Helm quits or restarts (S13): every caller is KEPT. Reads end with the restarting refusal (the caller sends
	 * the same read again once Helm is back), deadlines stop, nothing is settled or forgotten. Resolves once every
	 * caller's state is on disk; rejects when one could not be written.
	 */
	async suspend(): Promise<void> {
		this.suspended = true
		const now = Date.now()
		for (const owner of this.owners.values()) {
			if (owner.pending) this.clearTimer(owner.pending)
			owner.waiter?.fail(restartingRefusal())
			// The next start measures how long Helm was away from here.
			owner.usedAt = now
		}
		await Promise.all([...this.owners.values()].filter(owner => !owner.retired).map(owner => this.persist(owner)))
	}
	isSuspended(): boolean {
		return this.suspended
	}
	/** A quit was cancelled: callers work again and every deadline runs again from now. */
	resume(): void {
		if (!this.suspended) return
		this.suspended = false
		for (const owner of this.owners.values()) {
			const pending = owner.pending
			if (!pending) continue
			if (pending.confirmed) this.armCompletion(owner, pending)
			else this.armPickup(owner, pending)
		}
		this.changed()
	}
	private uncertain(owner: ReviewOwner, message: string): void {
		const pending = owner.pending
		if (!pending || this.suspended) return
		this.clearTimer(pending)
		this.settleArchive(owner, pending, { state: 'unknown', detail: message })
		const entry = this.receipts.get(pending.feedback.request.id)
		if (entry)
			entry.receipt = {
				id: entry.receipt.id,
				outcome: 'unknown',
				detail: message,
				...(entry.receipt.sentAt === undefined ? {} : { sentAt: entry.receipt.sentAt }),
				settledAt: Date.now(),
			}
		owner.pending = null
		owner.snapshot.needsAcknowledgement = true
		owner.snapshot.error = message
		owner.snapshot.state = 'error'
		void this.persist(owner).catch(() => {})
		this.changed()
	}
	/** (Re)arm the completion deadline: min(from + deadline, delivery + cap). Never revives a settled request. */
	private armCompletion(owner: ReviewOwner, pending: Pending, from = Date.now()): void {
		if (owner.pending !== pending || !pending.confirmed || this.suspended) return
		this.clearTimer(pending)
		const now = Date.now()
		const until = this.completionUntil(pending, from)
		pending.until = until
		const delay = Math.max(0, until - now)
		pending.timer = setTimeout(
			() =>
				this.uncertain(
					owner,
					'The caller did not report completion before its deadline. Inspect the original session; no feedback is replayed.',
				),
			delay,
		)
		pending.timer.unref()
	}
	private completionUntil(pending: Pending, from: number): number {
		return Math.min(Math.min(from, Date.now()) + this.responseDeadlineMs, pending.confirmedAt + this.responseCapMs)
	}
	private bound(owner: ReviewOwner): void {
		// Include source associations and JSON escaping in the existing payload budget.
		const bytes = (message: ReviewSession['messages'][number]) => Buffer.byteLength(JSON.stringify(message))
		let units = owner.snapshot.messages.reduce((sum, value) => sum + bytes(value), 0)
		while (owner.snapshot.messages.length > 80 || units > 160000) {
			const removed = owner.snapshot.messages.shift()
			units -= removed ? bytes(removed) : 0
			owner.snapshot.historyTruncated = true
		}
	}
}
