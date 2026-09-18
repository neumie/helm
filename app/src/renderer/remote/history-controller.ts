import type { HistoryPage, HistoryRequest } from '../../../../src/remote/history-protocol.js'
import { historyEntryIdSchema } from '../../../../src/remote/history-protocol.js'
import { sameRemoteTarget } from '../../../../src/remote/protocol.js'
import { historyAdmission } from './history-admission.js'
import { RemoteAccessError, RemoteHistoryError, type RemoteTransport } from './transport.js'

export interface HistoryAnchor {
	id: string
	offset: number
	range: string
}
interface CachedPage {
	position: number
	page: HistoryPage
	anchor?: HistoryAnchor
}
export interface HistoryReadingState {
	current: CachedPage | null
	phase: 'idle' | 'loading' | 'progress' | 'error'
	issue: string | null
	examined: number
	browsing: boolean
}
/** A view-local reader, never a command queue or an index of previously visited ranges. */
export class RemoteHistoryController {
	private pages: CachedPage[] = []
	private bookmark: { position: number; anchor: HistoryAnchor } | null = null
	private viewId = crypto.randomUUID()
	private sequence = 0
	private generation = 0
	private abort: AbortController | null = null
	private enabled = false
	private disposed = false
	private lastRequest: HistoryRequest | null = null
	private destination = 0
	private continuation: string | null = null
	private admitted = false
	private listeners = new Set<() => void>()
	private state: HistoryReadingState = { current: null, phase: 'idle', issue: null, examined: 0, browsing: false }
	constructor(
		private transport: RemoteTransport,
		private identity: Pick<HistoryRequest, 'hostEpoch' | 'target'>,
	) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private publish(next: Partial<HistoryReadingState>) {
		this.state = { ...this.state, ...next }
		for (const listener of this.listeners) listener()
	}
	setAvailable(enabled: boolean) {
		if (this.enabled === enabled || this.disposed) return
		this.enabled = enabled
		if (!enabled) {
			const denied = this.state.issue === 'access-ended'
			this.close()
			this.reset()
			this.publish({ issue: denied ? 'access-ended' : 'disconnected' })
		}
	}
	private stop() {
		this.generation++
		this.abort?.abort()
		this.abort = null
		this.continuation = null
	}
	private reset() {
		this.stop()
		this.pages = []
		this.bookmark = null
		this.lastRequest = null
		this.viewId = crypto.randomUUID()
		this.sequence = 0
		this.publish({ current: null, phase: 'idle', issue: null, examined: 0, browsing: false })
	}
	latest = () => {
		this.close()
		this.reset()
	}
	cancel = () => {
		this.stop()
		this.publish({ phase: 'idle', issue: 'cancelled' })
	}
	open = (anchor?: string) => {
		if (!this.enabled || this.disposed || this.state.phase === 'loading') return
		this.close()
		this.reset()
		const canonical = historyEntryIdSchema.safeParse(anchor)
		void this.request({ kind: 'open', ...(canonical.success ? { anchor: canonical.data } : {}) }, 0)
	}
	move = (direction: 'older' | 'newer') => {
		const current = this.state.current
		if (!current || this.state.phase === 'loading') return
		const cursor = current.page[direction]
		if (!cursor) return
		const position = current.position + (direction === 'older' ? -1 : 1)
		const cached = this.pages.find(value => value.position === position)
		const saved = this.bookmark?.position === position ? this.bookmark.anchor : undefined
		// Even cached navigation revalidates the lease and current read authority.
		void this.request(
			cached || saved
				? { kind: 'page', cursor: cached?.page.reread ?? saved?.range ?? cursor }
				: { kind: direction === 'older' ? 'page' : 'newer', cursor },
			position,
			saved,
		)
	}
	continue = () => {
		if (this.continuation) void this.request({ kind: 'continue', cursor: this.continuation }, this.destination)
	}
	retry = () => {
		if (this.lastRequest) void this.request(this.lastRequest.action, this.destination, undefined, this.lastRequest)
	}
	reread = () => {
		const current = this.state.current
		if (current) void this.request({ kind: 'page', cursor: current.page.reread }, current.position)
	}
	forgetAnchor() {
		if (this.state.current) this.state.current.anchor = undefined
	}
	remember(anchor: HistoryAnchor) {
		const current = this.state.current
		if (!current || current.page.reread !== anchor.range || !historyEntryIdSchema.safeParse(anchor.id).success) return
		current.anchor = anchor
	}
	private close() {
		if (!this.admitted) return
		this.admitted = false
		historyAdmission(this.transport).close({
			version: 1,
			...this.identity,
			viewId: this.viewId,
			sequence: ++this.sequence,
			action: { kind: 'close' },
		})
	}
	dispose() {
		this.close()
		this.stop()
		this.pages = []
		this.bookmark = null
		this.listeners.clear()
		this.disposed = true
		this.state = { current: null, phase: 'idle', issue: null, examined: 0, browsing: false }
	}
	debug() {
		return { pages: this.pages.length, records: this.pages.reduce((n, value) => n + value.page.records.length, 0) }
	}
	private async request(
		action: HistoryRequest['action'],
		position: number,
		anchor?: HistoryAnchor,
		retry?: HistoryRequest,
	) {
		if (!this.enabled || this.disposed || this.state.phase === 'loading') return
		this.stop()
		const generation = this.generation
		const abort = new AbortController()
		this.abort = abort
		this.destination = position
		const request: HistoryRequest = retry ?? {
			version: 1,
			...this.identity,
			viewId: this.viewId,
			sequence: ++this.sequence,
			action,
		}
		this.lastRequest = request
		this.publish({ phase: 'loading', issue: null, browsing: true })
		try {
			if (!this.transport.history) throw new RemoteHistoryError(404, 'unsupported')
			const result = await historyAdmission(this.transport).read(request, abort.signal, () => {
				this.admitted = true
			})
			if (this.disposed || abort.signal.aborted || this.generation !== generation || !this.enabled) return
			if (
				result.viewId !== request.viewId ||
				result.sequence !== request.sequence ||
				result.hostEpoch !== request.hostEpoch ||
				!sameRemoteTarget(result.target, request.target) ||
				JSON.stringify(result.input) !== JSON.stringify(action)
			)
				throw new Error('History identity mismatch')
			this.continuation = result.continuation
			if (result.state === 'page' && result.page) {
				const old = this.pages.find(value => value.page.reread === result.page?.reread)
				const current: CachedPage = { position, page: result.page, anchor: anchor ?? old?.anchor }
				const pages = [
					...this.pages.filter(value => value.position !== position && value.page.reread !== current.page.reread),
					current,
				]
				const evicted = pages.length > 3 ? pages[0] : undefined
				if (!this.bookmark && evicted?.anchor) this.bookmark = { position: evicted.position, anchor: evicted.anchor }
				this.pages = pages.slice(-3)
				this.publish({ current, phase: 'idle', issue: null, examined: result.examined })
			} else if (result.state === 'progress' && result.continuation)
				this.publish({ phase: 'progress', examined: result.examined })
			else {
				if (result.state === 'expired' || result.state === 'stale') {
					this.pages = []
					this.bookmark = null
				}
				this.publish({ phase: 'error', issue: result.state, ...(result.state === 'stale' ? { current: null } : {}) })
			}
		} catch (error) {
			if (this.disposed || abort.signal.aborted || this.generation !== generation) return
			const denied = error instanceof RemoteAccessError && [401, 403].includes(error.status)
			if (denied) {
				this.pages = []
				this.bookmark = null
			}
			this.publish({
				phase: 'error',
				issue: denied ? 'access-ended' : error instanceof RemoteHistoryError ? error.reason : 'unavailable',
				...(denied ? { current: null } : {}),
			})
		} finally {
			if (this.abort === abort) this.abort = null
		}
	}
}
