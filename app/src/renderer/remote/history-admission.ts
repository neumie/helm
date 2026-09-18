import type { HistoryRequest, HistoryResult } from '../../../../src/remote/history-protocol.js'
import { RemoteHistoryError, type RemoteTransport } from './transport.js'

interface WaitingRead {
	request: HistoryRequest
	signal: AbortSignal
	admitted: () => void
	resolve: (result: HistoryResult) => void
	reject: (error: unknown) => void
	cancel: () => void
}
/** One transport/device lifetime: one active read, one cleanup, one cancellable successor.
 * No promise chain: superseded waiting reads are removed immediately, and only an
 * actually dispatched view may request cleanup. Different browser transports still
 * compete normally at the host admission boundary.
 */
class HistoryAdmission {
	private active = false
	private cleanup: HistoryRequest | null = null
	private waiting: WaitingRead | null = null
	constructor(private readonly transport: RemoteTransport) {}
	read(request: HistoryRequest, signal: AbortSignal, admitted: () => void): Promise<HistoryResult> {
		if (signal.aborted) return Promise.reject(signal.reason)
		// The workspace owns one selected reader. Never accumulate superseded selections.
		this.waiting?.cancel()
		return new Promise((resolve, reject) => {
			const waiting: WaitingRead = {
				request,
				signal,
				admitted,
				resolve,
				reject,
				cancel: () => {
					if (this.waiting === waiting) this.waiting = null
					signal.removeEventListener('abort', waiting.cancel)
					reject(signal.reason ?? new Error('History read superseded'))
				},
			}
			this.waiting = waiting
			signal.addEventListener('abort', waiting.cancel, { once: true })
			this.pump()
		})
	}
	close(request: HistoryRequest) {
		// Admission cannot dispatch a successor until this single cleanup has settled.
		// Thus there cannot be a second newly admitted view needing queued cleanup.
		if (this.cleanup) return
		this.cleanup = request
		this.pump()
	}
	private pump() {
		if (this.active) return
		const cleanup = this.cleanup
		const waiting = cleanup ? null : this.waiting
		if (!cleanup && !waiting) return
		this.cleanup = null
		if (waiting) {
			this.waiting = null
			waiting.signal.removeEventListener('abort', waiting.cancel)
			if (waiting.signal.aborted) {
				waiting.reject(waiting.signal.reason)
				this.pump()
				return
			}
		}
		this.active = true
		const run = async () => {
			try {
				if (!this.transport.history) throw new RemoteHistoryError(404, 'unsupported')
				waiting?.admitted()
				const result = await this.transport.history(
					cleanup ?? (waiting as WaitingRead).request,
					cleanup ? AbortSignal.timeout(4000) : (waiting as WaitingRead).signal,
				)
				waiting?.resolve(result)
			} catch (error) {
				waiting?.reject(error)
			} finally {
				this.active = false
				this.pump()
			}
		}
		void run()
	}
}
const admissions = new WeakMap<RemoteTransport, HistoryAdmission>()
export function historyAdmission(transport: RemoteTransport) {
	let admission = admissions.get(transport)
	if (!admission) {
		admission = new HistoryAdmission(transport)
		admissions.set(transport, admission)
	}
	return admission
}
