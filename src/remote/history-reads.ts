import { randomUUID } from 'node:crypto'
import { historyBytes } from './history-projection.js'
import {
	HISTORY_DEADLINE_MS,
	HISTORY_PAGE_BYTES,
	HISTORY_RECORD_BYTES,
	HISTORY_RESULT_BYTES,
	type HistoryDescriptor,
	type HistoryRequest,
	type HistoryResult,
	historyDescriptorSchema,
	historyResultSchema,
} from './history-protocol.js'

export type HistoryReadFailure =
	| 'invalid_history'
	| 'stale_target'
	| 'disconnected'
	| 'unsupported'
	| 'unauthorized'
	| 'busy'
	| 'timeout'
	| 'cancelled'
export type HistoryReadReply = { result: HistoryResult } | { error: HistoryReadFailure }
interface Pending {
	descriptor: HistoryDescriptor
	device: string
	key: string
	valid: () => HistoryReadFailure | null
	settle: (reply: HistoryReadReply) => void
}
const targetKey = (request: Pick<HistoryRequest, 'hostEpoch' | 'target'>) =>
	JSON.stringify([request.hostEpoch, request.target])

/** Separate bounded read admission. Never owns command receipts or owner freshness. */
export class RemoteHistoryReads {
	private readonly pending = new Map<string, Pending>()
	constructor(private readonly now: () => number = Date.now) {}
	get size(): number {
		return this.pending.size
	}
	request(
		request: HistoryRequest,
		principalKey: string,
		device: string,
		valid: Pending['valid'],
		signal: AbortSignal,
	): Promise<HistoryReadReply> {
		const failure = valid()
		if (failure) return Promise.resolve({ error: failure })
		if (signal.aborted) return Promise.resolve({ error: 'cancelled' })
		const key = targetKey(request)
		if (this.pending.size >= 8 || [...this.pending.values()].some(p => p.key === key || p.device === device))
			return Promise.resolve({ error: 'busy' })
		const descriptor: HistoryDescriptor = {
			requestId: randomUUID(),
			request,
			principalKey,
			expiresAt: this.now() + HISTORY_DEADLINE_MS,
		}
		if (!historyDescriptorSchema.safeParse(descriptor).success) return Promise.resolve({ error: 'invalid_history' })
		return new Promise(resolve => {
			let settled = false
			const settle = (reply: HistoryReadReply) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				signal.removeEventListener('abort', abort)
				this.pending.delete(descriptor.requestId)
				resolve(reply)
			}
			const abort = () => settle({ error: 'cancelled' })
			const timer = setTimeout(() => settle({ error: 'timeout' }), HISTORY_DEADLINE_MS)
			timer.unref()
			this.pending.set(descriptor.requestId, { descriptor, device, key, valid, settle })
			signal.addEventListener('abort', abort, { once: true })
			if (signal.aborted) abort()
		})
	}
	deliver(request: Pick<HistoryRequest, 'hostEpoch' | 'target'>): HistoryDescriptor | undefined {
		const key = JSON.stringify([request.hostEpoch, request.target])
		for (const pending of this.pending.values()) {
			if (pending.key !== key) continue
			const failure = pending.valid() ?? (pending.descriptor.expiresAt <= this.now() ? 'timeout' : null)
			if (failure) {
				pending.settle({ error: failure })
				continue
			}
			return pending.descriptor
		}
		return undefined
	}
	complete(value: unknown): boolean {
		const parsed = historyResultSchema.safeParse(value)
		if (!parsed.success) return false
		const result = parsed.data
		const pending = this.pending.get(result.requestId)
		if (!pending) return false
		const request = pending.descriptor.request
		if (
			targetKey(request) !== targetKey(result) ||
			request.viewId !== result.viewId ||
			request.sequence !== result.sequence ||
			JSON.stringify(request.action) !== JSON.stringify(result.input)
		)
			return false
		if (
			historyBytes(result) > HISTORY_RESULT_BYTES ||
			(result.page &&
				(historyBytes(result.page.records) > HISTORY_PAGE_BYTES ||
					result.page.records.some(record => historyBytes(record) > HISTORY_RECORD_BYTES)))
		)
			return false
		const failure = pending.valid() ?? (pending.descriptor.expiresAt <= this.now() ? 'timeout' : null)
		pending.settle(failure ? { error: failure } : { result })
		return true
	}
	cancel(
		predicate: (request: HistoryRequest, device: string) => boolean,
		error: HistoryReadFailure = 'stale_target',
	): void {
		for (const pending of this.pending.values())
			if (predicate(pending.descriptor.request, pending.device)) pending.settle({ error })
	}
}
