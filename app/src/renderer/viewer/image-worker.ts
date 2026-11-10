// The picture view's header worker (docs/plans/helm-open/spec.md: image headers are parsed in dedicated workers).
// It reads width × height (and orientation) from the header and applies the 150 MP cap before Chromium decodes
// anything; the bytes travel in and back as a transferred buffer. Served as assets/image-worker.js with the viewer CSP.
import { ImageHeaderError, admitImageHeader } from '../../../../src/document-review/image-header'
import type { ImageRequest, ImageResponse } from './image-protocol'

const scope = self as unknown as {
	onmessage: ((event: MessageEvent<ImageRequest>) => void) | null
	postMessage(message: ImageResponse, transfer: Transferable[]): void
}
scope.onmessage = event => {
	const { id, name, type, bytes } = event.data
	try {
		const header = admitImageHeader(name, new Uint8Array(bytes), type)
		scope.postMessage({ id, type: 'header', header, bytes }, [bytes])
	} catch (error) {
		const message =
			error instanceof ImageHeaderError
				? error.message
				: `${name} can't be shown: ${(error instanceof Error ? error.message.split('\n')[0] : '') || 'its header could not be read'}.`
		scope.postMessage({ id, type: 'refused', error: message, bytes }, [bytes])
	}
}
