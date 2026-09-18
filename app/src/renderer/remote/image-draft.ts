import { IMAGE_PROCESSED_MAX_BYTES } from '../../../../src/remote/image-input-protocol.js'

export const IMAGE_DRAFT_MAX_COUNT = 16
export const IMAGE_DRAFT_MAX_BYTES = 24 * 1024 * 1024

export interface ProcessedImageResource {
	readonly localId: string
	readonly blob: Blob
	readonly objectUrl: string
	readonly bytes: number
	readonly width: number
	readonly height: number
	readonly sha256: string
	readonly mimeType: 'image/jpeg'
	dispose(): void
}

export interface ImagePreparationReservation {
	readonly signal: AbortSignal
	/** Hold root admission/accounting until the underlying native promise actually settles. */
	runNative<T>(start: () => Promise<T>): Promise<T>
	create(blob: Blob, value: { width: number; height: number; sha256: string }): ProcessedImageResource
	commit(): readonly ProcessedImageResource[]
	dispose(): void
}

interface StagedResource extends ProcessedImageResource {
	commitOwnership(): void
}

/** Root-lifetime retained-resource accounting. Reservations include prospective processed allocation. */
export class ImageDraftResources {
	private retainedCount = 0
	private retainedBytes = 0
	private reservedCount = 0
	private reservedBytes = 0
	private active: ImagePreparationReservation | null = null
	private disposed = false

	constructor(
		private readonly createUrl: (blob: Blob) => string = blob => URL.createObjectURL(blob),
		private readonly revokeUrl: (url: string) => void = url => URL.revokeObjectURL(url),
	) {}

	reserve(count: number, outerSignal?: AbortSignal): ImagePreparationReservation | null {
		if (
			this.disposed ||
			this.active ||
			!Number.isInteger(count) ||
			count < 1 ||
			this.retainedCount + this.reservedCount + count > IMAGE_DRAFT_MAX_COUNT ||
			this.retainedBytes + this.reservedBytes + count * IMAGE_PROCESSED_MAX_BYTES > IMAGE_DRAFT_MAX_BYTES
		)
			return null
		const controller = new AbortController()
		const abort = () => controller.abort(outerSignal?.reason)
		if (outerSignal?.aborted) abort()
		else outerSignal?.addEventListener('abort', abort, { once: true })
		this.reservedCount += count
		this.reservedBytes += count * IMAGE_PROCESSED_MAX_BYTES
		let settled = false
		let committed = false
		let nativeWork = 0
		let finished = false
		const staged: StagedResource[] = []
		const finishReservation = () => {
			if (finished || !settled || nativeWork !== 0) return
			finished = true
			this.reservedCount -= count
			this.reservedBytes -= count * IMAGE_PROCESSED_MAX_BYTES
			if (this.active === reservation) this.active = null
			outerSignal?.removeEventListener('abort', abort)
		}
		const reservation: ImagePreparationReservation = {
			signal: controller.signal,
			runNative: <T>(start: () => Promise<T>): Promise<T> => {
				if (settled || controller.signal.aborted) return Promise.reject(new Error('Image preparation ended'))
				nativeWork++
				let work: Promise<T>
				try {
					work = start()
				} catch (error) {
					nativeWork--
					finishReservation()
					return Promise.reject(error)
				}
				return work.finally(() => {
					nativeWork--
					finishReservation()
				})
			},
			create: (blob, value) => {
				if (settled || controller.signal.aborted || blob.type !== 'image/jpeg' || blob.size > IMAGE_PROCESSED_MAX_BYTES)
					throw new Error('Image preparation ended')
				const objectUrl = this.createUrl(blob)
				let released = false
				let owned = false
				const resource: StagedResource = {
					localId: crypto.randomUUID(),
					blob,
					objectUrl,
					bytes: blob.size,
					width: value.width,
					height: value.height,
					sha256: value.sha256,
					mimeType: 'image/jpeg',
					commitOwnership: () => {
						if (released || owned) return
						owned = true
						this.retainedCount++
						this.retainedBytes += blob.size
					},
					dispose: () => {
						if (released) return
						released = true
						this.revokeUrl(objectUrl)
						if (owned) {
							this.retainedCount--
							this.retainedBytes -= blob.size
						}
					},
				}
				staged.push(resource)
				return resource
			},
			commit: () => {
				if (settled || controller.signal.aborted || staged.length !== count)
					throw new Error('Incomplete image selection')
				settled = true
				committed = true
				for (const resource of staged) resource.commitOwnership()
				finishReservation()
				return staged
			},
			dispose: () => {
				if (settled) return
				settled = true
				controller.abort()
				if (!committed) for (const resource of staged) resource.dispose()
				finishReservation()
			},
		}
		this.active = reservation
		return reservation
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.active?.dispose()
	}

	usage() {
		return {
			retainedCount: this.retainedCount,
			retainedBytes: this.retainedBytes,
			reservedCount: this.reservedCount,
			reservedBytes: this.reservedBytes,
		}
	}
}

export function disposeImageBundle(images: readonly ProcessedImageResource[]): void {
	for (const image of images) image.dispose()
}
