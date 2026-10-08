import { randomUUID } from 'node:crypto'
import type { CanvasReviewEntry, CanvasReviewThread } from './types'

export type ArchiveSettlement = {
	state: 'complete' | 'error' | 'unknown' | 'rejected'
	reply?: string
	detail?: string
}

/** Shared by every open or closed file; reserve before the question's first await. */
export class ReviewArchiveCapacity {
	private count = 0
	reserve(): () => void {
		if (this.count >= 8) throw new Error('Eight review saves are outstanding. Wait or recover an unsaved reply.')
		this.count++
		let released = false
		return () => {
			if (released) return
			released = true
			this.count--
		}
	}
}
interface PendingArchive {
	thread: CanvasReviewThread
	settlement: ArchiveSettlement | null
	active: Promise<void> | null
	failureId: string | null
	appendFinal: (start: CanvasReviewThread, entry: CanvasReviewEntry) => Promise<void>
	release(): void
}

/** Display evidence only: retrying a write never calls the original caller. */
export class ReviewArchivePersistence {
	private readonly pending = new Map<string, PendingArchive>()
	private retrying = false
	constructor(
		private readonly changed: () => void,
		private readonly capacity = new ReviewArchiveCapacity(),
	) {}
	error(): string | null {
		return this.failureId() ? 'Review content was not saved. Retry review save; feedback will not be sent again.' : null
	}
	failureId(): string | null {
		return [...this.pending.values()].find(value => value.failureId)?.failureId ?? null
	}
	/** Waiting for the original caller is not dirty data or an in-flight file operation. */
	guarded(): boolean {
		return this.retrying || !!this.failureId() || [...this.pending.values()].some(value => value.active !== null)
	}
	discard(id: string): void {
		const entry = [...this.pending.entries()].find(([, value]) => value.failureId === id)
		if (!entry || entry[1].active || this.retrying)
			throw new Error('That unsaved reply is no longer available to discard.')
		this.remove(entry[1])
		this.changed()
	}
	unresolved(): boolean {
		return this.pending.size > 0
	}
	private remove(value: PendingArchive): void {
		this.pending.delete(value.thread.id)
		value.release()
	}
	private writeFinal(value: PendingArchive): Promise<void> {
		if (value.active) return value.active
		const settlement = value.settlement
		if (!settlement) return Promise.resolve()
		value.active = Promise.resolve()
			.then(() =>
				value.appendFinal(value.thread, {
					version: 1,
					type: 'settle',
					id: value.thread.id,
					...settlement,
				}),
			)
			.then(() => this.remove(value))
			.catch(() => {
				value.failureId ??= randomUUID()
			})
			.finally(() => {
				value.active = null
				this.changed()
			})
		return value.active
	}
	async begin(
		thread: Omit<CanvasReviewThread, 'id' | 'state'>,
		appendQuestion: (entry: CanvasReviewEntry) => Promise<void>,
		appendFinal: (start: CanvasReviewThread, entry: CanvasReviewEntry) => Promise<void> = (_start, entry) =>
			appendQuestion(entry),
	): Promise<{ id: string; settle: (value: ArchiveSettlement) => void }> {
		if (this.failureId() || this.retrying)
			throw new Error('Review content still needs saving. Retry review save before sending again.')
		const release = this.capacity.reserve()
		const value: PendingArchive = {
			thread: { ...structuredClone(thread), id: randomUUID(), state: 'unconfirmed' },
			settlement: null,
			active: null,
			appendFinal,
			failureId: null,
			release,
		}
		this.pending.set(value.thread.id, value)
		value.active = Promise.resolve().then(() => appendQuestion({ version: 1, type: 'thread', thread: value.thread }))
		try {
			await value.active
		} catch (error) {
			this.remove(value)
			throw error
		} finally {
			value.active = null
			this.changed()
		}
		return this.settlementHandle(value)
	}
	/** This closure retains only the accepted final writer, not the question's renderer event. */
	private settlementHandle(value: PendingArchive): { id: string; settle: (value: ArchiveSettlement) => void } {
		return {
			id: value.thread.id,
			settle: settlement => {
				if (value.settlement) return
				value.settlement = { ...settlement }
				void this.writeFinal(value)
			},
		}
	}

	async retry(): Promise<void> {
		if (this.retrying) throw new Error('A review save retry is already in progress.')
		this.retrying = true
		try {
			for (const value of this.pending.values()) {
				if (value.active) await value.active
				if (!this.pending.has(value.thread.id) || !value.settlement) continue
				await this.writeFinal(value)
				if (this.pending.has(value.thread.id) && value.failureId) throw new Error(this.error() ?? 'Review save failed.')
			}
		} finally {
			this.retrying = false
			this.changed()
		}
	}
	/** Called after mailbox retirement; never retries an uncertain failed write. */
	async drain(): Promise<void> {
		await Promise.all([...this.pending.values()].flatMap(value => (value.active ? [value.active] : [])))
		if (this.failureId()) throw new Error(this.error() ?? 'Review save failed.')
	}
}
