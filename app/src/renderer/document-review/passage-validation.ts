import { validatePassage } from '../../document-review/request'
import type { ReviewDocument, ReviewPassage } from '../../document-review/types'
import { canvasSourceBlock } from './canvas-display'

/** Current native compiler metadata only; rendered bounds never grant passage authority. */
export function validateDocumentPassage(document: ReviewDocument, passage: ReviewPassage): void {
	validatePassage(document.text, document.revision, passage, document.canvas)
	if ((document.format === 'jsx' && passage.kind === 'block') || passage.canvasId !== undefined) {
		const block = passage.canvasId ? canvasSourceBlock(document.canvas, passage.canvasId, document.text.length) : null
		if (
			!document.canvas?.code ||
			document.canvas.error ||
			!block ||
			block.start !== passage.start ||
			block.end !== passage.end
		)
			throw new Error('This canvas passage is not a current unique compiler-attested block.')
	}
}
