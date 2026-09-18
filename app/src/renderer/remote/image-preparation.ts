import { inspectJpeg, inspectJpegForProcessed, inspectPng } from '../../../../src/remote/image-input-bytes.js'
import {
	IMAGE_PROCESSED_MAX_BYTES,
	IMAGE_PROCESSED_MAX_PIXELS,
	IMAGE_PROCESSED_MAX_SIDE,
	IMAGE_SOURCE_MAX_BYTES,
} from '../../../../src/remote/image-input-protocol.js'
import type { ImagePreparationReservation, ProcessedImageResource } from './image-draft.js'

export const IMAGE_FILE_DEADLINE_MS = 10_000
export const IMAGE_SELECTION_DEADLINE_MS = 30_000

interface DecodedImage {
	readonly width: number
	readonly height: number
	readonly source: CanvasImageSource
	close(): void
}

export interface ImagePreparationDependencies {
	now(): number
	decode(blob: Blob): Promise<DecodedImage>
	encode(source: CanvasImageSource, width: number, height: number, quality: number, signal: AbortSignal): Promise<Blob>
	digest(bytes: Uint8Array): Promise<string>
}

function abortError(reason?: unknown): Error {
	return reason instanceof Error ? reason : new DOMException('Image preparation cancelled', 'AbortError')
}

function throwIfEnded(signal: AbortSignal, deadline: number, now: () => number): void {
	if (signal.aborted) throw abortError(signal.reason)
	if (now() >= deadline) throw new Error('Image preparation timed out')
}

async function bounded<T>(
	work: Promise<T>,
	signal: AbortSignal,
	deadline: number,
	now: () => number,
	late?: (value: T) => void,
): Promise<T> {
	throwIfEnded(signal, deadline, now)
	let settled = false
	let accepted = false
	let timer: ReturnType<typeof setTimeout> | undefined
	let rejectAbort: (reason: unknown) => void = () => {}
	const cancelled = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const abort = () => rejectAbort(abortError(signal.reason))
	signal.addEventListener('abort', abort, { once: true })
	timer = setTimeout(() => rejectAbort(new Error('Image preparation timed out')), Math.max(0, deadline - now()))
	work
		.then(value => {
			queueMicrotask(() => {
				if (settled && !accepted) late?.(value)
			})
		})
		.catch(() => {})
	try {
		const value = await Promise.race([work, cancelled])
		throwIfEnded(signal, deadline, now)
		accepted = true
		return value
	} finally {
		settled = true
		if (timer) clearTimeout(timer)
		signal.removeEventListener('abort', abort)
	}
}

async function canvasEncode(
	source: CanvasImageSource,
	width: number,
	height: number,
	quality: number,
	_signal: AbortSignal,
): Promise<Blob> {
	const canvas = document.createElement('canvas')
	canvas.width = width
	canvas.height = height
	const context = canvas.getContext('2d', { alpha: false })
	if (!context) throw new Error('Image processing is unavailable')
	context.fillStyle = '#ffffff'
	context.fillRect(0, 0, width, height)
	context.drawImage(source, 0, 0, width, height)
	try {
		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))), 'image/jpeg', quality)
		})
	} finally {
		context.clearRect(0, 0, canvas.width, canvas.height)
		canvas.width = 1
		canvas.height = 1
	}
}

const browserDependencies: ImagePreparationDependencies = {
	now: () => Date.now(),
	decode: async blob => {
		const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
		return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() }
	},
	encode: canvasEncode,
	digest: async bytes => {
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
		return [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
	},
}

function fitDimensions(width: number, height: number, scale = 1): { width: number; height: number } {
	const sideScale = Math.min(1, IMAGE_PROCESSED_MAX_SIDE / width, IMAGE_PROCESSED_MAX_SIDE / height)
	const pixelScale = Math.min(1, Math.sqrt(IMAGE_PROCESSED_MAX_PIXELS / (width * height)))
	const factor = Math.min(sideScale, pixelScale) * scale
	return {
		width: Math.max(1, Math.floor(width * factor)),
		height: Math.max(1, Math.floor(height * factor)),
	}
}

async function prepareOne(
	file: File,
	reservation: ImagePreparationReservation,
	selectionDeadline: number,
	deps: ImagePreparationDependencies,
): Promise<ProcessedImageResource> {
	const fileDeadline = Math.min(selectionDeadline, deps.now() + IMAGE_FILE_DEADLINE_MS)
	throwIfEnded(reservation.signal, fileDeadline, deps.now)
	if (file.type !== 'image/png' && file.type !== 'image/jpeg')
		throw new Error('Choose a PNG or JPEG image. HEIC, GIF, WebP and SVG are not supported.')
	if (file.size < 1 || file.size > IMAGE_SOURCE_MAX_BYTES) throw new Error('Image must be 12 MiB or smaller.')
	const sourceBytes = new Uint8Array(
		await bounded(
			reservation.runNative(() => file.arrayBuffer()),
			reservation.signal,
			fileDeadline,
			deps.now,
		),
	)
	throwIfEnded(reservation.signal, fileDeadline, deps.now)
	if (sourceBytes.byteLength !== file.size) throw new Error('Image changed while it was being read.')
	const sourceDimensions = file.type === 'image/png' ? inspectPng(sourceBytes) : inspectJpeg(sourceBytes)
	throwIfEnded(reservation.signal, fileDeadline, deps.now)
	let decoded: DecodedImage | undefined
	try {
		decoded = await bounded(
			reservation.runNative(() => deps.decode(file)),
			reservation.signal,
			fileDeadline,
			deps.now,
			late => late.close(),
		)
		throwIfEnded(reservation.signal, fileDeadline, deps.now)
		if (
			decoded.width < 1 ||
			decoded.height < 1 ||
			!(
				(decoded.width === sourceDimensions.width && decoded.height === sourceDimensions.height) ||
				(decoded.width === sourceDimensions.height && decoded.height === sourceDimensions.width)
			)
		)
			throw new Error('Decoded image dimensions do not match the validated source.')
		const decodedImage = decoded
		const attempts = [
			{ scale: 1, quality: 0.9 },
			{ scale: 1, quality: 0.82 },
			{ scale: 0.8, quality: 0.82 },
			{ scale: 0.64, quality: 0.82 },
		]
		for (const attempt of attempts) {
			throwIfEnded(reservation.signal, fileDeadline, deps.now)
			const size = fitDimensions(decodedImage.width, decodedImage.height, attempt.scale)
			const blob = await bounded(
				reservation.runNative(() =>
					deps.encode(decodedImage.source, size.width, size.height, attempt.quality, reservation.signal),
				),
				reservation.signal,
				fileDeadline,
				deps.now,
			)
			throwIfEnded(reservation.signal, fileDeadline, deps.now)
			if (blob.type !== 'image/jpeg') throw new Error('Browser returned an unsupported image format.')
			if (blob.size > IMAGE_PROCESSED_MAX_BYTES) continue
			const bytes = new Uint8Array(
				await bounded(
					reservation.runNative(() => blob.arrayBuffer()),
					reservation.signal,
					fileDeadline,
					deps.now,
				),
			)
			throwIfEnded(reservation.signal, fileDeadline, deps.now)
			const inspected = inspectJpegForProcessed(bytes)
			if (inspected.width !== size.width || inspected.height !== size.height)
				throw new Error('Processed image dimensions changed.')
			const sha256 = await bounded(
				reservation.runNative(() => deps.digest(bytes)),
				reservation.signal,
				fileDeadline,
				deps.now,
			)
			throwIfEnded(reservation.signal, fileDeadline, deps.now)
			return reservation.create(blob, { ...size, sha256 })
		}
		throw new Error('Image is still larger than 1.5 MiB after screenshot-quality processing.')
	} finally {
		decoded?.close()
		sourceBytes.fill(0)
	}
}

/** Sequential, all-or-nothing preparation. The caller publishes only the committed result. */
export async function prepareSelectedImages(
	files: readonly File[],
	reservation: ImagePreparationReservation,
	dependencies: ImagePreparationDependencies = browserDependencies,
): Promise<readonly ProcessedImageResource[]> {
	const selectionDeadline = dependencies.now() + IMAGE_SELECTION_DEADLINE_MS
	try {
		for (const file of files) await prepareOne(file, reservation, selectionDeadline, dependencies)
		throwIfEnded(reservation.signal, selectionDeadline, dependencies.now)
		return reservation.commit()
	} catch (error) {
		reservation.dispose()
		throw error
	}
}
