import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Btn } from '../button'
import { GLYPH } from '../sidebar/ui'

export interface PassageChatAnchor {
	range: Range | null
	text: string
	opener: HTMLElement | null
}

/** Presentation only: the parent owns scope, drafts, lifecycle and every effect admission. */
export function PassageChat({
	anchor,
	owner,
	onClose,
	children,
}: {
	anchor: PassageChatAnchor
	owner: HTMLElement | null
	onClose: (restoreFocus: boolean) => void
	children: ReactNode
}) {
	const panel = useRef<HTMLDialogElement>(null)
	const hidingForCleanup = useRef(false)
	const cleanupFocus = useRef<{
		anchor: PassageChatAnchor
		owner: HTMLElement
		target: HTMLElement
		expected: Element | null
	} | null>(null)
	const close = useRef(onClose)
	close.current = onClose
	useLayoutEffect(() => {
		const element = panel.current
		const retained = cleanupFocus.current
		cleanupFocus.current = null
		if (!element || !owner?.isConnected) return
		const restoreOwnedFocus =
			retained?.anchor === anchor && retained.owner === owner && document.activeElement === retained.expected
		let disposed = false
		const position = () => {
			if (disposed) return false
			const range = anchor.range
			if (
				!owner.getClientRects().length ||
				(range &&
					(!range.startContainer.isConnected ||
						!range.endContainer.isConnected ||
						!owner.contains(range.startContainer) ||
						!owner.contains(range.endContainer) ||
						range.collapsed ||
						range.toString() !== anchor.text))
			) {
				close.current(false)
				return
			}
			const reading = owner.querySelector('.review-reading')?.getBoundingClientRect()
			const rects = range ? [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0) : []
			const target = rects.at(-1) ?? anchor.opener?.getBoundingClientRect()
			const bounds = owner.getBoundingClientRect()
			if (range && (!target || !reading || target.bottom <= reading.top || target.top >= reading.bottom)) {
				close.current(false)
				return
			}
			const width = Math.min(560, bounds.width - 32)
			const maximumHeight = Math.min(640, window.innerHeight - 96)
			element.style.width = `${width}px`
			element.style.maxHeight = `${maximumHeight}px`
			const height = Math.min(element.offsetHeight || maximumHeight, maximumHeight)
			const left = bounds.right - width - 16
			const below = (target?.bottom ?? bounds.top) + 8
			const preferred = below + height <= bounds.bottom - 16 ? below : (target?.top ?? bounds.top) - height - 8
			element.style.left = `${left}px`
			element.style.top = `${Math.max(64, Math.min(Math.max(bounds.top + 16, preferred), window.innerHeight - height - 16))}px`
			return true
		}
		if (!position()) return
		element.showPopover()
		if (
			position() &&
			restoreOwnedFocus &&
			retained.target.isConnected &&
			element.contains(retained.target) &&
			(document.activeElement === retained.expected || element.contains(document.activeElement))
		) {
			// Continue only focus already owned by this exact anchor/owner before
			// synchronous teardown. No mount/poll/timer may invent a focus request.
			retained.target.focus({ preventScroll: true })
		}
		const observer = new ResizeObserver(position)
		observer.observe(owner)
		observer.observe(element)
		const mutations = new MutationObserver(position)
		const reading = owner.querySelector('.review-reading')
		if (reading) mutations.observe(reading, { childList: true, subtree: true, characterData: true })
		const outside = (event: Event) => {
			if (!disposed && event.target instanceof Node && !element.contains(event.target)) close.current(false)
		}
		document.addEventListener('pointerdown', outside)
		document.addEventListener('focusin', outside)
		document.addEventListener('scroll', position, true)
		window.addEventListener('resize', position)
		return () => {
			disposed = true
			observer.disconnect()
			mutations.disconnect()
			document.removeEventListener('pointerdown', outside)
			document.removeEventListener('focusin', outside)
			document.removeEventListener('scroll', position, true)
			window.removeEventListener('resize', position)
			cleanupFocus.current = null
			if (element.matches(':popover-open')) {
				const focused = document.activeElement
				// hidePopover synchronously emits beforetoggle. Effect teardown
				// (including StrictMode replay) is not a user dismissal.
				hidingForCleanup.current = true
				try {
					element.hidePopover()
				} finally {
					hidingForCleanup.current = false
				}
				const expected = document.activeElement
				if (
					focused instanceof HTMLElement &&
					element.contains(focused) &&
					(expected === focused ||
						expected === document.body ||
						expected === document.documentElement ||
						expected === anchor.opener)
				) {
					cleanupFocus.current = { anchor, owner, target: focused, expected }
				}
			}
		}
	}, [anchor, owner])
	return (
		<dialog
			ref={panel}
			popover="manual"
			className="review-passage-bubble review-passage-editor"
			aria-label="Passage conversation"
			tabIndex={-1}
			onBeforeToggle={event => {
				if (event.newState === 'closed' && !hidingForCleanup.current) close.current(false)
			}}
			onPointerDown={event => event.stopPropagation()}
			onPointerUp={event => event.stopPropagation()}
			onKeyUp={event => event.stopPropagation()}
			onKeyDown={event => {
				event.stopPropagation()
				if (event.key === 'Escape') {
					event.preventDefault()
					close.current(true)
				}
			}}
		>
			<header className="review-passage-bubble-header">
				<h2>Passage conversation</h2>
				<Btn tone="ghost" sm ariaLabel="Close passage conversation" onClick={() => close.current(true)}>
					{GLYPH.close}
				</Btn>
			</header>
			{children}
		</dialog>
	)
}
