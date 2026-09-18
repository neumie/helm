import type { ImageStoreBinding, RemoteImageReference } from './image-input-protocol.js'
import type { ImageReadLease, ImageReservation, RemoteImageStore } from './image-store.js'

const UPLOAD_BYTES = 1_572_864
const CHUNK = 64 * 1024
const UPLOAD_TTL = 6_000
const RESPONSE_TTL = 2_000
const DESCRIPTOR_BYTES = 4 * 1024

export class ImageResponseError extends Error {
	constructor(readonly status: 409 | 429) {
		super(status === 429 ? 'image_capacity' : 'image_unavailable')
	}
}

type Principal = string | undefined
interface ActiveUpload {
	binding: ImageStoreBinding
	principal: Principal
	controller: AbortController
	reservation?: ImageReservation
	reader?: ReadableStreamDefaultReader<Uint8Array>
	requestSignal?: AbortSignal
	onAbort?: () => void
	settled: boolean
}
export interface ImageBodyOutgoing {
	on(event: 'finish' | 'close' | 'error', listener: (...args: unknown[]) => void): void
	off?(event: 'finish' | 'close' | 'error', listener: (...args: unknown[]) => void): void
	destroy?(error?: Error): void
	destroyed?: boolean
	closed?: boolean
	writableFinished?: boolean
	writableEnded?: boolean
}
interface ResponseOwner {
	phase: 'setup' | 'published' | 'settled'
	binding?: ImageStoreBinding
	principal: Principal
	principalKnown: boolean
	controller: AbortController
	deadline: number
	requestSignal?: AbortSignal
	onAbort?: () => void
	valid?: () => boolean
	lease?: ImageReadLease
	commandId?: string
	bytes: number
	offset: number
	streamController?: ReadableStreamDefaultController<Uint8Array>
	outgoing?: ImageBodyOutgoing
	timer?: ReturnType<typeof setTimeout>
	onFinish?: (...args: unknown[]) => void
	onError?: (...args: unknown[]) => void
	teardownRequested: boolean
}

function sameBinding(a: ImageStoreBinding, b: ImageStoreBinding): boolean {
	return (
		a.hostEpoch === b.hostEpoch &&
		a.deviceId === b.deviceId &&
		a.grantRevision === b.grantRevision &&
		a.supportRevision === b.supportRevision &&
		a.target.sessionId === b.target.sessionId &&
		a.target.incarnation === b.target.incarnation &&
		a.target.scopeId === b.target.scopeId &&
		a.target.generation === b.target.generation
	)
}

export async function readImageDescriptor(
	request: Request,
	options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<{ value: unknown } | { error: 400 | 413 }> {
	if (!request.body || request.signal.aborted || options.signal?.aborted) return { error: 400 }
	const declared = request.headers.get('Content-Length')
	if (declared !== null && !/^[1-9]\d*$/.test(declared)) return { error: 400 }
	if (declared !== null && Number(declared) > DESCRIPTOR_BYTES) return { error: 413 }
	let stopTimer: ReturnType<typeof setTimeout> | undefined
	let stop: (() => void) | undefined
	const stopped = new Promise<{ stopped: true }>(resolve => {
		stop = () => resolve({ stopped: true })
		options.signal?.addEventListener('abort', stop, { once: true })
		request.signal.addEventListener('abort', stop, { once: true })
		if (options.deadline !== undefined) {
			const remaining = Math.max(0, options.deadline - Date.now())
			stopTimer = setTimeout(() => stop?.(), remaining)
			stopTimer.unref?.()
		}
	})
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		reader = request.body.getReader()
		for (;;) {
			const result = await Promise.race([reader.read(), stopped])
			if ('stopped' in result) return { error: 400 }
			if (result.done) break
			size += result.value.byteLength
			if (size > DESCRIPTOR_BYTES) return { error: 413 }
			chunks.push(result.value)
		}
		if (declared !== null && Number(declared) !== size) return { error: 400 }
		return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
	} catch {
		return { error: 400 }
	} finally {
		if (stopTimer) clearTimeout(stopTimer)
		if (stop) {
			options.signal?.removeEventListener('abort', stop)
			request.signal.removeEventListener('abort', stop)
		}
		reader?.releaseLock()
	}
}

/** Host-local bounded owner for uploads and outgoing private image responses. */
export class RemoteImageBody {
	private readonly uploads = new Set<ActiveUpload>()
	// A slot survives setup, lease opening and Web EOF until its transport settles.
	private readonly responses = new Set<ResponseOwner>()
	private disposed = false

	constructor(
		private readonly store: RemoteImageStore,
		private readonly now: () => number = Date.now,
	) {}

	beginSetup(binding: ImageStoreBinding, options: { deadline?: number; signal?: AbortSignal } = {}): ResponseOwner {
		if (this.disposed || options.signal?.aborted) throw new ImageResponseError(409)
		if (this.responses.size >= 4) throw new ImageResponseError(429)
		const owner: ResponseOwner = {
			phase: 'setup',
			binding: Object.freeze({ ...binding, target: Object.freeze({ ...binding.target }) }),
			principal: undefined,
			principalKnown: false,
			controller: new AbortController(),
			deadline: Math.min(options.deadline ?? Number.POSITIVE_INFINITY, this.now() + RESPONSE_TTL),
			requestSignal: options.signal,
			offset: 0,
			bytes: 0,
			teardownRequested: false,
		}
		this.responses.add(owner)
		owner.onAbort = () => this.cancelResponse(owner)
		options.signal?.addEventListener('abort', owner.onAbort, { once: true })
		this.armDeadline(owner)
		return owner
	}
	finishSetup(owner: ResponseOwner): void {
		// Cancelled setup stays counted until its admitted body awaiter reaches here.
		if (owner.phase === 'setup') this.finishResponse(owner)
	}
	private armDeadline(owner: ResponseOwner): void {
		if (owner.timer) clearTimeout(owner.timer)
		owner.timer = setTimeout(() => this.cancelResponse(owner), Math.max(0, owner.deadline - this.now()))
		owner.timer.unref?.()
	}
	async upload(request: Request, binding: ImageStoreBinding, principal: Principal): Promise<RemoteImageReference> {
		if (this.disposed || request.signal.aborted) throw new Error('image_unavailable')
		if (this.uploads.size >= 4 || [...this.uploads].filter(item => item.principal === principal).length >= 2)
			throw new Error('image_capacity')
		const controller = new AbortController()
		const active: ActiveUpload = { binding, principal, controller, requestSignal: request.signal, settled: false }
		active.onAbort = () => controller.abort()
		request.signal.addEventListener('abort', active.onAbort, { once: true })
		this.uploads.add(active)
		const declared = request.headers.get('Content-Length')
		let expected: number | undefined
		if (declared !== null) {
			if (!/^[1-9]\d*$/.test(declared)) throw this.finishUpload(active, 'image_length')
			expected = Number(declared)
			if (!Number.isSafeInteger(expected) || expected > UPLOAD_BYTES)
				throw this.finishUpload(active, expected > UPLOAD_BYTES ? 'image_oversize' : 'image_length')
		}
		let rejectAbort: ((error: Error) => void) | undefined
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject
		})
		const abortWait = () => rejectAbort?.(new Error('image_timeout'))
		controller.signal.addEventListener('abort', abortWait, { once: true })
		const timer = setTimeout(() => controller.abort(), UPLOAD_TTL)
		timer.unref?.()
		try {
			active.reservation = this.store.reserve(binding, expected)
			if (!request.body) throw new Error('image_upload')
			const reader = request.body.getReader()
			active.reader = reader
			let size = 0
			for (;;) {
				const result = await Promise.race([reader.read(), aborted])
				if (controller.signal.aborted || request.signal.aborted) throw new Error('image_timeout')
				if (result.done) break
				size += result.value.byteLength
				if (size > UPLOAD_BYTES) throw new Error('image_oversize')
				if (expected !== undefined && size > expected) throw new Error('image_length')
				active.reservation.append(result.value)
			}
			if (expected !== undefined && size !== expected) throw new Error('image_length')
			if (request.signal.aborted || controller.signal.aborted) throw new Error('image_timeout')
			return active.reservation.commit()
		} finally {
			clearTimeout(timer)
			controller.signal.removeEventListener('abort', abortWait)
			active.reader?.releaseLock()
			active.reader = undefined
			this.finishUpload(active)
		}
	}

	private finishUpload(active: ActiveUpload, reason?: string): Error {
		if (!active.settled) {
			active.settled = true
			active.reservation?.cancel()
			active.reservation = undefined
			if (active.onAbort) active.requestSignal?.removeEventListener('abort', active.onAbort)
			active.onAbort = undefined
			active.requestSignal = undefined
			active.reader = undefined
			this.uploads.delete(active)
		}
		return new Error(reason ?? 'image_upload')
	}

	response(
		ref: RemoteImageReference,
		binding: ImageStoreBinding,
		principal: Principal,
		commandId: string,
		contentLength: number,
		expiresAt: number,
		valid: () => boolean,
		outgoing?: ImageBodyOutgoing,
		setup?: ResponseOwner,
	): Response {
		const owner = setup ?? this.beginSetup(binding)
		try {
			if (owner.phase !== 'setup' || !this.current(owner)) throw new ImageResponseError(409)
			if (
				[...this.responses].filter(item => item !== owner && item.principalKnown && item.principal === principal)
					.length >= 2
			)
				throw new ImageResponseError(429)
			owner.principal = principal
			owner.principalKnown = true
			owner.binding = Object.freeze({ ...binding, target: Object.freeze({ ...binding.target }) })
			owner.commandId = commandId
			owner.bytes = ref.bytes
			owner.valid = valid
			owner.deadline = Math.min(owner.deadline, expiresAt)
			this.armDeadline(owner)
			if (contentLength !== ref.bytes || !this.current(owner)) throw new ImageResponseError(409)
			const lease = this.store.openRead(ref, owner.binding, commandId)
			if (!lease) throw new ImageResponseError(409)
			// openRead invokes the Host's liveness callback; it may reenter disposal.
			if (!this.current(owner)) {
				lease.release()
				throw new ImageResponseError(409)
			}
			owner.lease = lease
			if (outgoing?.closed || outgoing?.destroyed || outgoing?.writableFinished || outgoing?.writableEnded)
				throw new ImageResponseError(409)
			owner.outgoing = outgoing
			owner.onFinish = () => {
				if (owner.phase === 'published') this.finishResponse(owner)
				else this.cancelResponse(owner)
			}
			owner.onError = () => this.cancelResponse(owner)
			outgoing?.on('finish', owner.onFinish)
			outgoing?.on('close', owner.onFinish)
			outgoing?.on('error', owner.onError)
			if (!this.current(owner) || outgoing?.closed || outgoing?.destroyed) throw new ImageResponseError(409)
			owner.phase = 'published'
			return this.publishedResponse(owner)
		} catch (error) {
			this.cancelResponse(owner)
			if (!setup) this.finishSetup(owner)
			throw error
		}
	}

	private current(owner: ResponseOwner): boolean {
		const live = () =>
			!this.disposed &&
			this.responses.has(owner) &&
			owner.phase !== 'settled' &&
			!owner.controller.signal.aborted &&
			this.now() < owner.deadline
		if (!live()) return false
		try {
			const valid = owner.valid
			return (!valid || valid()) && live()
		} catch {
			return false
		}
	}

	private publishedResponse(owner: ResponseOwner): Response {
		// Retained stream functions capture only this cleared-at-settlement record,
		// not a separate binding, reference, lease or Host validity closure.
		const stream = new ReadableStream<Uint8Array>(
			{
				start: controller => {
					owner.streamController = controller
				},
				pull: () => this.pullResponse(owner),
				cancel: () => {
					owner.streamController = undefined
					this.cancelResponse(owner)
				},
			},
			{ highWaterMark: 0 },
		)
		return new Response(stream, {
			status: 200,
			headers: {
				'Content-Type': 'image/jpeg',
				'Content-Length': String(owner.bytes),
				'Cache-Control': 'no-store',
				'X-Helm-Image-Input': '1',
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; sandbox",
			},
		})
	}

	private pullResponse(owner: ResponseOwner): void {
		try {
			if (!this.current(owner)) throw new ImageResponseError(409)
			const lease = owner.lease
			if (!lease) throw new ImageResponseError(409)
			const chunk = lease.nextChunk()
			if (
				!this.current(owner) ||
				owner.lease !== lease ||
				!owner.streamController ||
				!chunk ||
				chunk.byteLength === 0 ||
				chunk.byteLength > CHUNK ||
				owner.offset + chunk.byteLength > owner.bytes
			)
				throw new ImageResponseError(409)
			owner.offset += chunk.byteLength
			owner.streamController.enqueue(chunk)
			if (owner.offset === owner.bytes) {
				owner.streamController.close()
				owner.streamController = undefined
				this.releaseLease(owner)
				if (!owner.outgoing) this.finishResponse(owner)
			}
		} catch {
			this.cancelResponse(owner)
		}
	}

	private releaseLease(owner: ResponseOwner): void {
		const lease = owner.lease
		owner.lease = undefined
		lease?.release()
	}

	private errorWeb(owner: ResponseOwner): void {
		const controller = owner.streamController
		owner.streamController = undefined
		controller?.error(new Error('image_read_closed'))
	}

	private cancelResponse(owner: ResponseOwner): void {
		if (owner.phase === 'settled') return
		owner.controller.abort()
		this.releaseLease(owner)
		// Unpublished setup must flush its handled JSON rejection before the
		// adapter drains incoming; cancellation never destroys that outgoing.
		if (owner.phase === 'setup') return
		this.errorWeb(owner)
		if (!owner.outgoing) this.finishResponse(owner)
		else if (!owner.teardownRequested) {
			owner.teardownRequested = true
			owner.outgoing.destroy?.(new Error('image_read_closed'))
		}
		// Even destroyed=true is only a request. Keep the slot until finish/close.
	}

	private finishResponse(owner: ResponseOwner): void {
		if (owner.phase === 'settled') return
		owner.phase = 'settled'
		this.responses.delete(owner)
		if (owner.timer) clearTimeout(owner.timer)
		owner.timer = undefined
		if (owner.onAbort) owner.requestSignal?.removeEventListener('abort', owner.onAbort)
		owner.requestSignal = undefined
		owner.onAbort = undefined
		if (owner.onFinish && owner.onError) {
			owner.outgoing?.off?.('finish', owner.onFinish)
			owner.outgoing?.off?.('close', owner.onFinish)
			owner.outgoing?.off?.('error', owner.onError)
		}
		owner.onFinish = undefined
		owner.onError = undefined
		owner.outgoing = undefined
		owner.binding = undefined
		owner.valid = undefined
		owner.commandId = undefined
		owner.principal = undefined
		owner.principalKnown = false
		this.errorWeb(owner)
		this.releaseLease(owner)
	}

	invalidate(predicate: (binding: ImageStoreBinding) => boolean): void {
		for (const upload of [...this.uploads]) {
			if (!predicate(upload.binding)) continue
			upload.controller.abort()
			upload.reservation?.cancel()
		}
		for (const response of [...this.responses]) {
			if (response.binding && predicate(response.binding)) this.cancelResponse(response)
		}
	}
	invalidateExact(binding: ImageStoreBinding): void {
		this.invalidate(candidate => sameBinding(candidate, binding))
	}
	invalidateCommand(binding: ImageStoreBinding, commandId: string): void {
		for (const response of [...this.responses])
			if (response.binding && sameBinding(response.binding, binding) && response.commandId === commandId)
				this.cancelResponse(response)
	}
	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		for (const upload of [...this.uploads]) {
			upload.controller.abort()
			upload.reservation?.cancel()
		}
		for (const response of [...this.responses]) this.cancelResponse(response)
	}
}
