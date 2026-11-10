import type { ImageType } from '../../../../src/document-review/formats'
import type { ImageHeader } from '../../../../src/document-review/image-header'

export interface ImageRequest {
	id: number
	name: string
	type: ImageType
	bytes: ArrayBuffer
}
export type ImageResponse =
	| { id: number; type: 'header'; header: ImageHeader; bytes: ArrayBuffer }
	| { id: number; type: 'refused'; error: string; bytes: ArrayBuffer }
