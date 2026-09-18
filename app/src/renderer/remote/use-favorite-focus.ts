import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

interface FocusOwner {
	button: HTMLButtonElement
	clear(): void
}
/** Preserve keyboard ownership through disable/reorder, without stealing newer pointer or focus intent. */
export function useFavoriteFocus(pending: string | null) {
	const owner = useRef<FocusOwner | null>(null)
	useEffect(() => () => owner.current?.clear(), [])
	useLayoutEffect(() => {
		if (pending !== null) return
		const saved = owner.current
		if (!saved) return
		saved.clear()
		if (saved.button.isConnected && !saved.button.disabled && document.activeElement === document.body)
			saved.button.focus({ preventScroll: true })
	}, [pending])
	return useCallback((button: HTMLButtonElement | null) => {
		owner.current?.clear()
		if (!button || document.activeElement !== button) return
		const pointer = (event: Event) => {
			if (event.target instanceof Node && !button.contains(event.target)) saved.clear()
		}
		const focus = (event: Event) => {
			if (event.target !== document.body) pointer(event)
		}
		const saved: FocusOwner = {
			button,
			clear: () => {
				document.removeEventListener('pointerdown', pointer, true)
				document.removeEventListener('focusin', focus, true)
				if (owner.current === saved) owner.current = null
			},
		}
		owner.current = saved
		document.addEventListener('pointerdown', pointer, true)
		document.addEventListener('focusin', focus, true)
	}, [])
}
