import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import type { ReviewAnnotation, ReviewDocument } from '../../document-review/types'
import { locatePassageDisplayRanges } from './passage-anchor'
import { validateDocumentPassage } from './passage-validation'

/** Passive saved paint. Never relocates across revisions or removes another owner's marks. */
export function SavedAnnotationHighlights({
	document,
	annotations,
	reading,
	visible,
}: {
	document: ReviewDocument
	annotations: ReviewAnnotation[]
	reading: RefObject<HTMLDivElement | null>
	visible: boolean
}) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: Document identity fences owned paint even when another document has identical text and revision.
	useLayoutEffect(() => {
		if (!visible || !CSS.highlights || typeof Highlight === 'undefined') return
		let retired = false
		let owner: HTMLDivElement | null = null
		let observer: MutationObserver | null = null
		let paint: Highlight | null = null
		const current = () => !retired && visible && !!owner?.isConnected && reading.current === owner
		const clear = () => {
			if (paint && CSS.highlights.get('helm-review-saved-annotations') === paint)
				CSS.highlights.delete('helm-review-saved-annotations')
			paint = null
		}
		const update = () => {
			if (!current() || !owner) return
			clear()
			const ranges: Range[] = []
			const groups = new Map<HTMLElement, string[]>()
			const blocks = [...owner.querySelectorAll<HTMLElement>('[data-source-start][data-source-end]')]
			for (const annotation of annotations) {
				if (annotation.resolved) continue
				try {
					validateDocumentPassage(document, annotation.passage)
				} catch {
					continue
				}
				const matches = blocks.filter(node =>
					document.format === 'jsx' && annotation.passage.kind === 'block'
						? node.dataset.canvasId === annotation.passage.canvasId &&
							Number(node.dataset.sourceStart) === annotation.passage.start &&
							Number(node.dataset.sourceEnd) === annotation.passage.end
						: Number(node.dataset.sourceStart) <= annotation.passage.start &&
							Number(node.dataset.sourceEnd) >= annotation.passage.end,
				)
				if (matches.length !== 1 || !matches[0]) continue
				const content = matches[0].querySelector<HTMLElement>('.review-block-text') ?? matches[0]
				const quotes = groups.get(content) ?? []
				quotes.push(annotation.passage.quote)
				groups.set(content, quotes)
			}
			for (const [content, quotes] of groups)
				for (const range of locatePassageDisplayRanges(content, quotes)) if (range) ranges.push(range)
			if (ranges.length) {
				paint = new Highlight(...ranges)
				CSS.highlights.set('helm-review-saved-annotations', paint)
			}
		}
		const install = () => {
			if (retired || !visible || !reading.current?.isConnected) return
			owner = reading.current
			if (!current()) return
			update()
			observer = new MutationObserver(update)
			observer.observe(owner, { subtree: true, childList: true, characterData: true })
		}
		if (reading.current) install()
		else queueMicrotask(install)
		return () => {
			retired = true
			observer?.disconnect()
			clear()
		}
	}, [document.id, document.revision, document.text, document.canvas, annotations, reading, visible])
	return null
}
