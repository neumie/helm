import { z } from 'zod'
import type { RemoteTarget } from './protocol.js'

export const IMAGE_INPUT_HEADER = 'X-Helm-Image-Input'
export const IMAGE_INPUT_VERSION = 1
export const IMAGE_MAX_COUNT = 4
export const IMAGE_SOURCE_MAX_BYTES = 12 * 1024 * 1024
export const IMAGE_SOURCE_MAX_SIDE = 8192
export const IMAGE_SOURCE_MAX_PIXELS = 16_000_000
export const IMAGE_PROCESSED_MAX_SIDE = 2560
export const IMAGE_PROCESSED_MAX_PIXELS = 4_000_000
export const IMAGE_PROCESSED_MAX_BYTES = 1_572_864
export const IMAGE_SUBMISSION_MAX_BYTES = IMAGE_PROCESSED_MAX_BYTES * IMAGE_MAX_COUNT
export const IMAGE_OWNER_MAX_BYTES = 8 * 1024 * 1024
export const IMAGE_PRINCIPAL_MAX_BYTES = 12 * 1024 * 1024
export const IMAGE_HOST_MAX_BYTES = 64 * 1024 * 1024
export const IMAGE_HOST_MAX_HANDLES = 128
export const IMAGE_STAGING_TTL_MS = 60_000

export const imageMimeTypeSchema = z.literal('image/jpeg')
export type ImageMimeType = z.infer<typeof imageMimeTypeSchema>

export const remoteImageReferenceSchema = z
	.object({
		handle: z.string().uuid(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		mimeType: imageMimeTypeSchema,
		bytes: z.number().int().positive().max(IMAGE_PROCESSED_MAX_BYTES),
		width: z.number().int().positive().max(IMAGE_PROCESSED_MAX_SIDE),
		height: z.number().int().positive().max(IMAGE_PROCESSED_MAX_SIDE),
	})
	.strict()
	.refine(image => image.width * image.height <= IMAGE_PROCESSED_MAX_PIXELS, 'image_dimensions')
export type RemoteImageReference = z.infer<typeof remoteImageReferenceSchema>

export const imageInputCapabilitiesSchema = z
	.object({
		version: z.literal(IMAGE_INPUT_VERSION),
		available: z.boolean(),
	})
	.strict()
export type ImageInputCapabilities = z.infer<typeof imageInputCapabilitiesSchema>

export interface ImageStoreBinding {
	readonly target: RemoteTarget
	readonly hostEpoch: string
	readonly deviceId?: string
	readonly grantRevision?: number
	readonly supportRevision: symbol
}

export function validImageReferenceSet(images: readonly RemoteImageReference[]): boolean {
	if (images.length < 1 || images.length > IMAGE_MAX_COUNT) return false
	const handles = new Set<string>()
	let bytes = 0
	for (const image of images) {
		if (!remoteImageReferenceSchema.safeParse(image).success || handles.has(image.handle)) return false
		handles.add(image.handle)
		bytes += image.bytes
	}
	return bytes <= IMAGE_SUBMISSION_MAX_BYTES
}

export const imageUploadEnvelopeSchema = z
	.object({
		protocol: z.literal(IMAGE_INPUT_VERSION),
		hostEpoch: z.string().uuid(),
		image: remoteImageReferenceSchema,
	})
	.strict()
export type ImageUploadEnvelope = z.infer<typeof imageUploadEnvelopeSchema>
