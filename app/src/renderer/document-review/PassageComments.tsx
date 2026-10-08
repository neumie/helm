import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReviewApi } from '../../document-review/types'
import { Btn } from '../button'
import { GLYPH } from '../sidebar/ui'
import { locatePassageDisplayRanges } from './passage-anchor'
import type { PassageThread } from './passage-threads'

interface PassageAnchor {
	ids: string[]
	top: number
	ranges: Range[]
}

function sameAnchors(before: PassageAnchor[], after: PassageAnchor[]): boolean {
	return (
		before.length === after.length &&
		before.every((anchor, index) => {
			const next = after[index]
			return (
				next &&
				anchor.top === next.top &&
				anchor.ids.join(':') === next.ids.join(':') &&
				anchor.ranges.length === next.ranges.length &&
				anchor.ranges.every((range, n) => {
					const other = next.ranges[n]
					return (
						other &&
						range.startContainer === other.startContainer &&
						range.startOffset === other.startOffset &&
						range.endContainer === other.endContainer &&
						range.endOffset === other.endOffset
					)
				})
			)
		})
	)
}

/** One marker per actual passage line, not the top of a Markdown list/block. */
export function PassageComments({
	threads,
	api,
	providerName,
}: {
	threads: PassageThread[]
	api?: ReviewApi
	providerName: string
}) {
	const root = useRef<HTMLDivElement>(null)
	const [anchors, setAnchors] = useState<PassageAnchor[]>([])
	useLayoutEffect(() => {
		const block = root.current?.closest('.review-block')
		const content = block?.querySelector<HTMLElement>('.review-block-text')
		if (!block || !content) return
		let disposed = false
		const update = () => {
			if (disposed) return
			const origin = block.getBoundingClientRect()
			const ranges = locatePassageDisplayRanges(
				content,
				threads.map(thread => thread.quote),
			)
			const next: PassageAnchor[] = []
			for (const [index, range] of ranges.entries()) {
				const thread = threads[index]
				if (!range || !thread) continue
				const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
				const rect = rects.at(-1)
				if (!rect) continue
				const top = rect.top + rect.height / 2 - origin.top - 14
				// Quotes ending on the same line share one marker, without overlapping controls.
				const group = next.find(anchor => Math.abs(anchor.top - top) < 4)
				if (group) {
					group.ids.push(thread.id)
					group.ranges.push(range)
				} else next.push({ ids: [thread.id], top, ranges: [range] })
			}
			setAnchors(previous => (sameAnchors(previous, next) ? previous : next))
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(content)
		window.addEventListener('resize', update)
		void document.fonts.ready.then(update)
		return () => {
			disposed = true
			observer.disconnect()
			window.removeEventListener('resize', update)
		}
	}, [threads])
	return (
		<div ref={root} className="review-passage-comments">
			{anchors.map(anchor => (
				<PassageCommentBubble
					key={anchor.ids.join(':')}
					anchor={anchor}
					threads={threads.filter(thread => anchor.ids.includes(thread.id))}
					api={api}
					providerName={providerName}
				/>
			))}
		</div>
	)
}

/** Nonmodal read-only popover; its separate highlight never changes selection, scope or drafts. */
function PassageCommentBubble({
	anchor,
	threads,
	api,
	providerName,
}: {
	anchor: PassageAnchor
	threads: PassageThread[]
	api?: ReviewApi
	providerName: string
}) {
	const id = useId()
	const trigger = useRef<HTMLButtonElement>(null)
	const bubble = useRef<HTMLDialogElement>(null)
	const painted = useRef<Highlight | null>(null)
	const [open, setOpen] = useState(false)
	const clearPaint = useCallback(() => {
		if (painted.current && CSS.highlights?.get('helm-review-comment-passage') === painted.current)
			CSS.highlights.delete('helm-review-comment-passage')
		painted.current = null
	}, [])
	const paint = useCallback(() => {
		clearPaint()
		if (!CSS.highlights || typeof Highlight === 'undefined' || !bubble.current?.matches(':popover-open')) return
		const content = trigger.current?.closest('.review-block')?.querySelector('.review-block-text')
		if (
			!content ||
			anchor.ranges.some(range => !content.contains(range.startContainer) || !content.contains(range.endContainer))
		) {
			bubble.current.hidePopover()
			return
		}
		const highlight = new Highlight(...anchor.ranges)
		highlight.priority = 1
		CSS.highlights.set('helm-review-comment-passage', highlight)
		painted.current = highlight
	}, [anchor.ranges, clearPaint])
	const position = useCallback((): boolean => {
		const button = trigger.current
		const panel = bubble.current
		const reading = button?.closest('.review-reading')
		if (!button || !panel || !reading?.getClientRects().length) return false
		const rect = button.getBoundingClientRect()
		const owner = reading.getBoundingClientRect()
		if (rect.bottom <= owner.top || rect.top >= owner.bottom) return false
		const width = Math.min(320, owner.width - 32)
		const height = Math.min(320, owner.height - 32)
		panel.style.width = `${width}px`
		panel.style.maxHeight = `${height}px`
		const actualHeight = panel.matches(':popover-open') ? panel.getBoundingClientRect().height : height
		const left = Math.max(owner.left + 16, Math.min(rect.right - width, owner.right - width - 16))
		const below = rect.bottom + 8
		const preferred = below + actualHeight <= owner.bottom - 16 ? below : rect.top - actualHeight - 8
		const top = Math.max(owner.top + 16, Math.min(preferred, owner.bottom - actualHeight - 16))
		panel.style.left = `${left}px`
		panel.style.top = `${top}px`
		return true
	}, [])
	// Source/owner key unmounts this component. API replacement also retires an open bubble.
	useLayoutEffect(() => {
		if (api) bubble.current?.hidePopover()
		clearPaint()
		return clearPaint
	}, [api, clearPaint])
	useLayoutEffect(() => {
		if (bubble.current?.matches(':popover-open')) {
			if (!position()) bubble.current.hidePopover()
			else paint()
		}
	}, [paint, position])
	useEffect(() => {
		if (!open) return
		const update = () => {
			if (!position()) {
				bubble.current?.hidePopover()
				clearPaint()
			}
		}
		document.addEventListener('scroll', update, true)
		window.addEventListener('resize', update)
		const observer = new ResizeObserver(update)
		const reading = trigger.current?.closest('.review-reading')
		if (reading) observer.observe(reading)
		return () => {
			document.removeEventListener('scroll', update, true)
			window.removeEventListener('resize', update)
			observer.disconnect()
		}
	}, [open, position, clearPaint])
	const close = () => {
		bubble.current?.hidePopover()
		clearPaint()
		trigger.current?.focus()
	}
	return (
		<div className="review-passage-comment-anchor" style={{ top: anchor.top }}>
			<Btn
				ref={trigger}
				tone="ghost"
				className="review-passage-comment-trigger"
				ariaLabel={`Show passage conversation${threads.length > 1 ? ` (${threads.length} questions)` : ''}`}
				ariaExpanded={open}
				ariaControls={id}
				onClick={() => {
					const panel = bubble.current
					if (!panel) return
					if (panel.matches(':popover-open')) {
						panel.hidePopover()
						clearPaint()
					} else if (position()) {
						panel.showPopover()
						position()
						paint()
						panel.focus()
					}
				}}
			>
				<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
					<path
						fillRule="evenodd"
						d="M1 8.74c0 .983.713 1.825 1.69 1.943.764.092 1.534.164 2.31.216v2.351a.75.75 0 0 0 1.28.53l2.51-2.51c.182-.181.427-.286.684-.294a44.298 44.298 0 0 0 3.837-.293C14.287 10.565 15 9.723 15 8.74V4.26c0-.983-.713-1.825-1.69-1.943a44.447 44.447 0 0 0-10.62 0C1.712 2.435 1 3.277 1 4.26v4.482ZM5.5 6.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm2.5 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm3.5 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
						clipRule="evenodd"
					/>
				</svg>
			</Btn>
			<dialog
				ref={bubble}
				id={id}
				popover="auto"
				className="review-passage-bubble"
				aria-label="Passage conversation"
				tabIndex={-1}
				onToggle={event => {
					setOpen(event.newState === 'open')
					if (event.newState === 'closed') clearPaint()
				}}
				onPointerDown={event => event.stopPropagation()}
				onPointerUp={event => event.stopPropagation()}
				onKeyUp={event => event.stopPropagation()}
				onKeyDown={event => {
					event.stopPropagation()
					if (event.key === 'Escape') {
						event.preventDefault()
						close()
					}
				}}
			>
				<header className="review-passage-bubble-header">
					<h2>Passage conversation</h2>
					<Btn tone="ghost" sm ariaLabel="Close passage conversation" onClick={close}>
						{GLYPH.close}
					</Btn>
				</header>
				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded message scroll owner must support keyboard reading. */}
				<section className="review-passage-bubble-messages" aria-label="Passage messages" tabIndex={0}>
					{threads.map(thread => (
						<section key={thread.id} aria-label="Passage question">
							{thread.messages.map(message => (
								<article className={`review-message review-message-${message.role}`} key={message.id}>
									<h3>
										{message.role === 'user'
											? 'You'
											: message.role === 'assistant'
												? (thread.providerName ?? providerName)
												: 'Activity'}
									</h3>
									<div>{message.text}</div>
								</article>
							))}
						</section>
					))}
				</section>
			</dialog>
		</div>
	)
}
