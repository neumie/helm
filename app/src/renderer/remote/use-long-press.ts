import type { MouseEvent, PointerEvent } from 'react'
import { useCallback, useEffect, useRef } from 'react'

const LONG_PRESS_MS = 500
/** A press that drifts this far is a scroll, not a hold. */
const MOVE_TOLERANCE_PX = 10

export type LongPressHandlers = {
	onPointerDown(event: PointerEvent<HTMLElement>): void
	onPointerMove(event: PointerEvent<HTMLElement>): void
	onPointerUp(): void
	onPointerCancel(): void
	onContextMenu(event: MouseEvent<HTMLElement>): void
	onClickCapture(event: MouseEvent<HTMLElement>): void
}

/**
 * Hold a row to reveal its actions. Touch uses a timed press; pointer devices and the
 * keyboard menu key both arrive as `contextmenu`, so one handler covers mouse, trackpad
 * and Shift+F10 without a second visible control.
 */
export function useLongPress(onLongPress: (key: string) => void): (key: string) => LongPressHandlers {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const origin = useRef<{ x: number; y: number } | null>(null)
	const fired = useRef(false)

	const cancel = useCallback(() => {
		if (timer.current !== null) clearTimeout(timer.current)
		timer.current = null
		origin.current = null
	}, [])
	useEffect(() => cancel, [cancel])

	return useCallback(
		(key: string) => ({
			onPointerDown(event) {
				// A mouse already has a context menu; only touch and pen need the hold.
				if (event.pointerType === 'mouse') return
				fired.current = false
				origin.current = { x: event.clientX, y: event.clientY }
				timer.current = setTimeout(() => {
					fired.current = true
					cancel()
					onLongPress(key)
				}, LONG_PRESS_MS)
			},
			onPointerMove(event) {
				const start = origin.current
				if (!start) return
				if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel()
			},
			onPointerUp: cancel,
			onPointerCancel: cancel,
			onContextMenu(event) {
				event.preventDefault()
				onLongPress(key)
			},
			onClickCapture(event) {
				// The click that follows a completed hold must not also open the conversation.
				if (!fired.current) return
				// The revealed menu is a child of the held element; its own clicks must land.
				if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
				fired.current = false
				event.preventDefault()
				event.stopPropagation()
			},
		}),
		[cancel, onLongPress],
	)
}
