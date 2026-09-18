import { createHash, randomUUID } from 'node:crypto'
import { inspectJpegForProcessed } from './image-input-bytes.js'
import {
	IMAGE_HOST_MAX_BYTES,
	IMAGE_HOST_MAX_HANDLES,
	IMAGE_OWNER_MAX_BYTES,
	IMAGE_PRINCIPAL_MAX_BYTES,
	IMAGE_PROCESSED_MAX_BYTES,
	IMAGE_STAGING_TTL_MS,
	type ImageStoreBinding,
	type RemoteImageReference,
	remoteImageReferenceSchema,
	validImageReferenceSet,
} from './image-input-protocol.js'

const UPLOAD_TTL_MS = 6_000
const COMMAND_TTL_MS = 10_000
const READ_TTL_MS = 2_000
const CHUNK = 64 * 1024
interface Resource {
	// The ONLY retained reference to the backing allocation. Issued objects capture this record, not its buffer.
	buffer: Uint8Array | undefined
	readonly capacity: number
	readonly expectedBytes: number | undefined
	readonly binding: ImageStoreBinding
	used: number
	deadline: number
	phase: 'upload' | 'staged' | 'bound' | 'closed'
	reference?: Readonly<RemoteImageReference>
	commandId?: string
}
interface ReadState {
	resource: Resource | undefined
	offset: number
	deadline: number
	phase: 'reading' | 'complete' | 'closed'
}
export interface ImageReservation {
	append(chunk: Uint8Array): void
	commit(): RemoteImageReference
	cancel(): void
}
export interface ImageReadLease {
	nextChunk(): Uint8Array | null
	release(): void
}
export interface ImageStoreOptions {
	now?: () => number
	isBindingLive: (binding: ImageStoreBinding) => boolean
}
function freezeBinding(value: ImageStoreBinding): ImageStoreBinding {
	return Object.freeze({
		target: Object.freeze({
			sessionId: value.target.sessionId,
			incarnation: value.target.incarnation,
			scopeId: value.target.scopeId,
			generation: value.target.generation,
		}),
		hostEpoch: value.hostEpoch,
		deviceId: value.deviceId,
		grantRevision: value.grantRevision,
		supportRevision: value.supportRevision,
	})
}
function sameOwner(a: ImageStoreBinding, b: ImageStoreBinding): boolean {
	return (
		a.hostEpoch === b.hostEpoch &&
		a.target.sessionId === b.target.sessionId &&
		a.target.incarnation === b.target.incarnation &&
		a.target.scopeId === b.target.scopeId &&
		a.target.generation === b.target.generation
	)
}
function sameBinding(a: ImageStoreBinding, b: ImageStoreBinding): boolean {
	return (
		sameOwner(a, b) &&
		a.deviceId === b.deviceId &&
		a.grantRevision === b.grantRevision &&
		a.supportRevision === b.supportRevision
	)
}
function sameReference(a: Readonly<RemoteImageReference>, b: RemoteImageReference): boolean {
	return (
		a.handle === b.handle &&
		a.sha256 === b.sha256 &&
		a.bytes === b.bytes &&
		a.width === b.width &&
		a.height === b.height &&
		a.mimeType === b.mimeType
	)
}
/** Memory ownership, not an authorization substitute: Host supplies a captured binding and current liveness. */
export class RemoteImageStore {
	private readonly resources = new Set<Resource>()
	private readonly entries = new Map<string, Resource>()
	private readonly reads = new Set<ReadState>()
	private closed = false
	private checking = false
	private pruning = false
	private mutation = 0
	private timer?: ReturnType<typeof setTimeout>
	constructor(private readonly options: ImageStoreOptions) {}
	private now(): number {
		return this.options.now?.() ?? Date.now()
	}
	private live(binding: ImageStoreBinding): boolean {
		if (this.closed || this.checking) return false
		const version = this.mutation
		this.checking = true
		let result = false
		try {
			result = this.options.isBindingLive(binding) === true
		} catch {
			result = false
		} finally {
			this.checking = false
		}
		return result && !this.closed && version === this.mutation
	}
	private syncTimer(): void {
		if (this.closed || this.resources.size === 0) {
			if (this.timer !== undefined) clearTimeout(this.timer)
			this.timer = undefined
			return
		}
		if (this.timer !== undefined || this.pruning) return
		this.timer = setTimeout(() => {
			this.timer = undefined
			this.prune()
		}, 1000)
		this.timer.unref()
	}
	private closeRead(state: ReadState, phase: 'closed' | 'complete' = 'closed'): void {
		if (state.phase !== 'reading') return
		state.phase = phase
		state.resource = undefined
		this.reads.delete(state)
		this.mutation++
		this.syncTimer()
	}
	private retire(resource: Resource): void {
		if (resource.phase === 'closed') return
		resource.phase = 'closed'
		resource.buffer = undefined
		this.resources.delete(resource)
		if (resource.reference && this.entries.get(resource.reference.handle) === resource)
			this.entries.delete(resource.reference.handle)
		for (const read of this.reads) if (read.resource === resource) this.closeRead(read)
		this.mutation++
		this.syncTimer()
	}
	private prune(): void {
		if (this.closed || this.pruning || this.checking) return
		this.pruning = true
		try {
			for (const resource of [...this.resources]) {
				if (resource.phase === 'closed') continue
				if (this.now() >= resource.deadline || !this.live(resource.binding)) this.retire(resource)
			}
			for (const read of this.reads) if (this.now() >= read.deadline) this.closeRead(read)
		} finally {
			this.pruning = false
			this.syncTimer()
		}
	}
	private canAllocate(binding: ImageStoreBinding, size: number): boolean {
		let allocated = 0
		let ownerBytes = 0
		let ownerHandles = 0
		let principalBytes = 0
		let uploads = 0
		let principalUploads = 0
		for (const resource of this.resources) {
			allocated += resource.capacity
			if (sameOwner(resource.binding, binding)) {
				ownerBytes += resource.capacity
				ownerHandles++
			}
			if (resource.binding.deviceId === binding.deviceId) principalBytes += resource.capacity
			if (resource.phase === 'upload') {
				uploads++
				if (resource.binding.deviceId === binding.deviceId) principalUploads++
			}
		}
		return (
			this.resources.size < IMAGE_HOST_MAX_HANDLES &&
			ownerHandles < 8 &&
			allocated + size <= IMAGE_HOST_MAX_BYTES &&
			ownerBytes + size <= IMAGE_OWNER_MAX_BYTES &&
			principalBytes + size <= IMAGE_PRINCIPAL_MAX_BYTES &&
			uploads < 4 &&
			principalUploads < 2
		)
	}
	reserve(binding: ImageStoreBinding, expectedBytes?: number): ImageReservation {
		if (this.closed || this.checking) throw new Error('image_unavailable')
		this.prune()
		const frozen = freezeBinding(binding)
		const size = expectedBytes ?? IMAGE_PROCESSED_MAX_BYTES
		if (
			!Number.isSafeInteger(size) ||
			size < 1 ||
			size > IMAGE_PROCESSED_MAX_BYTES ||
			!this.live(frozen) ||
			this.closed ||
			!this.canAllocate(frozen, size)
		)
			throw new Error('image_capacity')
		const resource: Resource = {
			buffer: new Uint8Array(size),
			capacity: size,
			expectedBytes,
			binding: frozen,
			used: 0,
			deadline: this.now() + UPLOAD_TTL_MS,
			phase: 'upload',
		}
		this.resources.add(resource)
		this.mutation++
		this.syncTimer()
		return {
			append: chunk => this.append(resource, chunk),
			commit: () => this.commit(resource),
			cancel: () => {
				if (resource.phase === 'upload') this.retire(resource)
			},
		}
	}
	private usableUpload(resource: Resource): boolean {
		return (
			!this.checking &&
			resource.phase === 'upload' &&
			this.resources.has(resource) &&
			this.live(resource.binding) &&
			resource.phase === 'upload' &&
			this.resources.has(resource) &&
			resource.buffer !== undefined &&
			this.now() < resource.deadline
		)
	}
	private append(resource: Resource, chunk: Uint8Array): void {
		if (
			!this.usableUpload(resource) ||
			!resource.buffer ||
			!(chunk instanceof Uint8Array) ||
			chunk.byteLength > resource.capacity - resource.used
		) {
			if (resource.phase === 'upload') this.retire(resource)
			throw new Error('image_upload')
		}
		resource.buffer.set(chunk, resource.used)
		resource.used += chunk.byteLength
	}
	private commit(resource: Resource): RemoteImageReference {
		if (
			!this.usableUpload(resource) ||
			!resource.buffer ||
			resource.used === 0 ||
			(resource.expectedBytes !== undefined && resource.used !== resource.expectedBytes)
		) {
			if (resource.phase === 'upload') this.retire(resource)
			throw new Error('image_upload')
		}
		// Synchronous validation: no callbacks/awaits while this temporary view exists.
		let reference: RemoteImageReference
		try {
			const data = resource.buffer.subarray(0, resource.used)
			const dims = inspectJpegForProcessed(data)
			reference = {
				handle: randomUUID(),
				sha256: createHash('sha256').update(data).digest('hex'),
				mimeType: 'image/jpeg',
				bytes: resource.used,
				width: dims.width,
				height: dims.height,
			}
		} catch {
			this.retire(resource)
			throw new Error('image_invalid')
		}
		resource.reference = Object.freeze(reference)
		resource.phase = 'staged'
		resource.deadline = this.now() + IMAGE_STAGING_TTL_MS
		this.entries.set(reference.handle, resource)
		this.mutation++
		this.syncTimer()
		return { ...reference }
	}
	bind(
		refs: readonly RemoteImageReference[],
		binding: ImageStoreBinding,
		commandId: string,
		expiresAt: number,
	): boolean {
		if (this.closed || this.checking) return false
		this.prune()
		if (
			!validImageReferenceSet(refs) ||
			!Number.isFinite(expiresAt) ||
			!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(commandId)
		)
			return false
		const frozen = freezeBinding(binding)
		if (!this.live(frozen) || this.closed || expiresAt <= this.now() || expiresAt > this.now() + COMMAND_TTL_MS)
			return false
		const found: Resource[] = []
		for (const ref of refs) {
			const resource = this.entries.get(ref.handle)
			if (
				!resource ||
				resource.phase !== 'staged' ||
				!resource.reference ||
				!resource.buffer ||
				resource.deadline <= this.now() ||
				!sameBinding(resource.binding, frozen) ||
				!sameReference(resource.reference, ref)
			)
				return false
			found.push(resource)
		}
		// No callback between validation and the all-or-nothing mutation.
		for (const resource of found) {
			resource.phase = 'bound'
			resource.commandId = commandId
			resource.deadline = expiresAt
		}
		this.mutation++
		return true
	}
	openRead(ref: RemoteImageReference, binding: ImageStoreBinding, commandId: string): ImageReadLease | null {
		if (this.closed || this.checking) return null
		this.prune()
		const parsed = remoteImageReferenceSchema.safeParse(ref)
		if (!parsed.success) return null
		const frozen = freezeBinding(binding)
		if (!this.live(frozen) || this.closed) return null
		// Lookup AFTER the callback: it may have retired/replaced the captured entry.
		const resource = this.entries.get(parsed.data.handle)
		if (
			!resource ||
			resource.phase !== 'bound' ||
			!resource.reference ||
			!resource.buffer ||
			resource.commandId !== commandId ||
			resource.deadline <= this.now() ||
			!sameBinding(resource.binding, frozen) ||
			!sameReference(resource.reference, parsed.data)
		)
			return null
		let principalReads = 0
		for (const read of this.reads) if (read.resource?.binding.deviceId === frozen.deviceId) principalReads++
		if (this.reads.size >= 4 || principalReads >= 2) return null
		const state: ReadState = {
			resource,
			offset: 0,
			deadline: Math.min(resource.deadline, this.now() + READ_TTL_MS),
			phase: 'reading',
		}
		this.reads.add(state)
		this.mutation++
		return { nextChunk: () => this.nextChunk(state), release: () => this.closeRead(state) }
	}
	private nextChunk(state: ReadState): Uint8Array | null {
		if (state.phase === 'complete') return null
		if (state.phase === 'closed' || this.checking) throw new Error('image_read_closed')
		const resource = state.resource
		if (resource && (!this.live(resource.binding) || this.now() >= resource.deadline)) this.retire(resource)
		if (
			!resource ||
			state.phase !== 'reading' ||
			state.resource !== resource ||
			!resource.reference ||
			!resource.buffer ||
			this.entries.get(resource.reference.handle) !== resource ||
			resource.phase !== 'bound' ||
			this.now() >= resource.deadline ||
			this.now() >= state.deadline
		) {
			this.closeRead(state)
			throw new Error('image_read_closed')
		}
		if (state.offset === resource.used) {
			this.closeRead(state, 'complete')
			return null
		}
		const end = Math.min(state.offset + CHUNK, resource.used)
		// A small copy, never a slice that retains the entire backing allocation after retirement.
		const chunk = resource.buffer.slice(state.offset, end)
		state.offset = end
		return chunk
	}
	retireCommand(binding: ImageStoreBinding, commandId: string): void {
		const frozen = freezeBinding(binding)
		for (const resource of this.entries.values())
			if (resource.commandId === commandId && sameBinding(resource.binding, frozen)) this.retire(resource)
	}
	invalidate(predicate: (binding: ImageStoreBinding) => boolean): void {
		// Even a no-match invalidation fences a reentrant admission callback.
		this.mutation++
		for (const resource of [...this.resources]) {
			let invalid = true
			try {
				invalid = predicate(resource.binding)
			} catch {
				/* Fail closed for a faulty host guard. */
			}
			if (invalid) this.retire(resource)
		}
	}
	usage(): {
		allocatedBytes: number
		reservedBytes: number
		retainedBytes: number
		handles: number
		uploads: number
		reads: number
	} {
		let reservedBytes = 0
		let retainedBytes = 0
		let uploads = 0
		for (const resource of this.resources) {
			if (resource.phase === 'upload') {
				reservedBytes += resource.capacity
				uploads++
			} else retainedBytes += resource.capacity
		}
		return {
			allocatedBytes: reservedBytes + retainedBytes,
			reservedBytes,
			retainedBytes,
			handles: this.resources.size,
			uploads,
			reads: this.reads.size,
		}
	}
	dispose(): void {
		if (this.closed) return
		this.closed = true
		this.mutation++
		for (const resource of [...this.resources]) this.retire(resource)
		this.syncTimer()
	}
}
