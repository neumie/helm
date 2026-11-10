// One header check in a short-lived worker: started for the read, terminated after the answer (or on abort).
import type { ImageType } from '../../../../src/document-review/formats'
import type { ImageHeader } from '../../../../src/document-review/image-header'
import type { ImageRequest, ImageResponse } from './image-protocol'
import { createImageWorker } from './image-worker-factory'

export type HeaderResult =
	| { ok: true; header: ImageHeader; bytes: ArrayBuffer }
	| { ok: false; error: string; bytes: ArrayBuffer | null }

export function checkImageHeader(
	name: string,
	type: ImageType,
	bytes: ArrayBuffer,
	signal: AbortSignal,
	worker: Worker = createImageWorker(),
): Promise<HeaderResult> {
	return new Promise(resolve => {
		const done = (result: HeaderResult) => {
			signal.removeEventListener('abort', abort)
			worker.terminate()
			resolve(result)
		}
		const abort = () => done({ ok: false, error: 'aborted', bytes: null })
		signal.addEventListener('abort', abort)
		worker.onmessage = (event: MessageEvent<ImageResponse>) => {
			const response = event.data
			done(
				response.type === 'header'
					? { ok: true, header: response.header, bytes: response.bytes }
					: { ok: false, error: response.error, bytes: response.bytes },
			)
		}
		worker.onerror = event => {
			event.preventDefault()
			done({ ok: false, error: `${name} can't be shown: the image header check stopped.`, bytes: null })
		}
		const request: ImageRequest = { id: 1, name, type, bytes }
		worker.postMessage(request, [bytes])
	})
}
