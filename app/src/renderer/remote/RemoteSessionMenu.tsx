import { useEffect, useRef } from 'react'

/**
 * The actions for one session row, revealed by holding it. Only the pin toggle lives
 * here today; the menu owns dismissal and keyboard focus so the row keeps its single
 * tap target.
 */
export function RemoteSessionMenu({
	title,
	favorite,
	canEdit,
	busy,
	onToggle,
	onClose,
}: {
	title: string
	favorite: boolean
	canEdit: boolean
	busy: boolean
	onToggle(): void
	onClose(): void
}) {
	const surface = useRef<HTMLDivElement>(null)

	useEffect(() => {
		surface.current?.querySelector('button')?.focus({ preventScroll: true })
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose()
		}
		const outside = (event: Event) => {
			if (event.target instanceof Node && !surface.current?.contains(event.target)) onClose()
		}
		document.addEventListener('keydown', key)
		document.addEventListener('pointerdown', outside, true)
		return () => {
			document.removeEventListener('keydown', key)
			document.removeEventListener('pointerdown', outside, true)
		}
	}, [onClose])

	return (
		<div className="remote-row-menu" role="menu" aria-label={`${title} actions`} ref={surface}>
			<button
				type="button"
				role="menuitem"
				className="remote-row-menu-item"
				disabled={!canEdit || busy}
				onClick={onToggle}
			>
				{favorite ? 'Unpin from top' : 'Pin to top'}
			</button>
			{!canEdit && <p className="remote-row-menu-note">This device can read this conversation but not change it.</p>}
		</div>
	)
}
