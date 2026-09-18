import type { HistoryRequest, HistoryResult } from '../../../../src/remote/history-protocol.js'
import { historyEntryIdSchema } from '../../../../src/remote/history-protocol.js'
import { type RemoteTarget, sameRemoteTarget } from '../../../../src/remote/protocol.js'
import { historyAdmission } from './history-admission.js'
import {
	type LiveTranscript,
	RemoteTranscriptModel,
	type TranscriptSnapshot,
	type TranscriptViewport,
} from './transcript-model.js'
import { RemoteAccessError, RemoteHistoryError, type RemoteTransport } from './transport.js'

export interface TranscriptIdentity {
	target: RemoteTarget
	hostEpoch: string
}
export interface TranscriptControllerOptions {
	model?: RemoteTranscriptModel
	scheduler?: (task: () => void) => void
}
/** Controller for the inline transcript. History is admitted only by explicit loadEarlier. */
export class RemoteTranscriptController {
	private readonly model: RemoteTranscriptModel
	private readonly scheduler: (task: () => void) => void
	private readonly listeners = new Set<() => void>()
	private viewId = crypto.randomUUID()
	private sequence = 0
	private generation = 0
	private abort: AbortController | null = null
	private continuation: string | null = null
	private request: HistoryRequest | null = null
	private admitted = false
	private enabled = false
	private visible = true
	private disposed = false
	private autoFailures = 0
	private state: TranscriptSnapshot
	constructor(
		private readonly transport: RemoteTransport,
		private identity: TranscriptIdentity,
		options: TranscriptControllerOptions = {},
	) {
		this.model = options.model ?? new RemoteTranscriptModel()
		this.scheduler = options.scheduler ?? (task => queueMicrotask(task))
		this.state = this.model.snapshot()
	}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	private publish() {
		const next = this.model.snapshot()
		if (JSON.stringify(next) === JSON.stringify(this.state)) return
		this.state = next
		for (const listener of this.listeners) listener()
	}
	setAvailable(available: boolean) {
		if (this.disposed || this.enabled === available) return
		this.enabled = available
		if (!available) {
			this.cancel()
			this.close()
			this.model.clear()
			this.model.setStatus('idle', 'disconnected')
			this.publish()
		}
	}
	setVisible(visible: boolean) {
		if (this.visible === visible || this.disposed) return
		this.visible = visible
		if (!visible) this.cancel()
	}
	setIdentity(identity: TranscriptIdentity) {
		if (sameRemoteTarget(identity.target, this.identity.target) && identity.hostEpoch === this.identity.hostEpoch)
			return
		this.cancel()
		this.close()
		this.identity = identity
		this.viewId = crypto.randomUUID()
		this.sequence = 0
		this.model.clear()
		this.model.setStatus('idle', 'owner-changed')
		this.publish()
	}
	observeLive(live: LiveTranscript) {
		if (this.disposed) return
		if (this.model.observeLive(live)) this.publish()
	}
	viewport(viewport: TranscriptViewport) {
		if (this.model.setViewport(viewport)) this.publish()
	}
	/** The only operation that expands the logical transcript. Scrolling calls viewport(), never this method. */
	loadEarlier(anchor?: string) {
		if (!this.enabled || this.disposed || !this.visible || this.abort) return
		if (this.state.expanded && !this.state.older) return
		const valid = historyEntryIdSchema.safeParse(anchor)
		const action: HistoryRequest['action'] =
			this.state.expanded && this.state.older
				? { kind: 'page', cursor: this.state.older }
				: { kind: 'open', ...(valid.success ? { anchor: valid.data } : {}) }
		this.read(action, false)
	}
	continue() {
		if (this.continuation && !this.abort && this.visible)
			this.read({ kind: 'continue', cursor: this.continuation }, false)
	}
	retry() {
		if (this.request && !this.abort && this.visible) this.read(this.request.action, true)
	}
	cancel() {
		this.generation++
		this.abort?.abort()
		this.abort = null
		this.continuation = null
		this.model.setStatus('idle', 'cancelled')
		this.publish()
	}
	dispose() {
		if (this.disposed) return
		this.cancel()
		this.close()
		this.model.clear()
		this.listeners.clear()
		this.disposed = true
	}
	debug() {
		return this.model.debug(this.abort ? 1 : 0)
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
	private read(action: HistoryRequest['action'], exactRetry: boolean) {
		this.cancel()
		const localGeneration = this.generation
		const abort = new AbortController()
		this.abort = abort
		const request: HistoryRequest =
			exactRetry && this.request
				? this.request
				: { version: 1, ...this.identity, viewId: this.viewId, sequence: ++this.sequence, action }
		this.request = request
		this.model.setStatus('loading')
		this.publish()
		this.scheduler(() => void this.perform(request, abort, localGeneration))
	}
	private async perform(request: HistoryRequest, abort: AbortController, localGeneration: number) {
		try {
			if (!this.transport.history) throw new RemoteHistoryError(404, 'unsupported')
			const result = await historyAdmission(this.transport).read(request, abort.signal, () => {
				this.admitted = true
			})
			if (!this.valid(localGeneration, abort)) return
			if (
				result.viewId !== request.viewId ||
				result.sequence !== request.sequence ||
				result.hostEpoch !== request.hostEpoch ||
				!sameRemoteTarget(result.target, request.target) ||
				JSON.stringify(result.input) !== JSON.stringify(request.action)
			)
				throw new Error('history_identity')
			this.continuation = result.continuation
			if (result.state === 'page' && result.page) {
				this.model.prepend(result.page)
				this.autoFailures = 0
				this.model.setStatus('idle')
			} else if (result.state === 'progress' && result.continuation) this.model.setStatus('progress')
			else this.model.setStatus('error', result.state)
			this.publish()
		} catch (error) {
			if (!this.valid(localGeneration, abort)) return
			const denied = error instanceof RemoteAccessError && (error.status === 401 || error.status === 403)
			if (denied) {
				this.model.clear()
				this.close()
				this.model.setStatus('error', 'access-ended')
			} else {
				this.autoFailures++
				this.model.setStatus('error', error instanceof RemoteHistoryError ? error.reason : 'unavailable')
			}
			this.publish()
		} finally {
			if (this.abort === abort) this.abort = null
		}
	}
	private valid(generation: number, abort: AbortController) {
		return !this.disposed && this.enabled && this.visible && !abort.signal.aborted && generation === this.generation
	}
}
