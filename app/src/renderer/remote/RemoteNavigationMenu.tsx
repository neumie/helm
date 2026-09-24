import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef } from 'react'
import { GLYPH, IconBtn } from '../sidebar/ui.js'

export type RemoteDestination = 'sessions' | 'usage'

export function RemoteNavigationTrigger({ onOpen }: { onOpen: () => void }) {
	return (
		<IconBtn className="remote-navigation-trigger" label="Open navigation" onClick={onOpen}>
			{GLYPH.menu}
		</IconBtn>
	)
}

export function RemoteNavigationMenu({
	current,
	onClose,
	onSelect,
	conversationTitle,
	onModel,
}: {
	current: RemoteDestination
	onClose: () => void
	onSelect: (destination: RemoteDestination) => void
	conversationTitle?: string
	onModel?: () => void
}) {
	const menu = useRef<HTMLDialogElement>(null)
	const activeItem = useRef<HTMLButtonElement>(null)
	useLayoutEffect(() => {
		activeItem.current?.focus({ preventScroll: true })
	}, [])
	useEffect(() => {
		function onKeyDown(event: globalThis.KeyboardEvent) {
			if (event.key !== 'Escape' || event.defaultPrevented) return
			event.preventDefault()
			onClose()
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [onClose])
	function trapFocus(event: ReactKeyboardEvent<HTMLDialogElement>) {
		if (event.key !== 'Tab') return
		const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
		const first = buttons[0]
		const last = buttons.at(-1)
		if (!first || !last) return
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault()
			last.focus()
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault()
			first.focus()
		}
	}
	return (
		<div className="remote-navigation-scrim">
			<button type="button" className="remote-navigation-dismiss" aria-label="Close navigation" onClick={onClose} />
			<dialog
				ref={menu}
				open
				className="remote-navigation-menu"
				aria-modal="true"
				aria-label="Navigation"
				onKeyDown={trapFocus}
			>
				<header className="remote-navigation-menu-header">
					<h2>Helm</h2>
					<IconBtn label="Close navigation" onClick={onClose}>
						{GLYPH.close}
					</IconBtn>
				</header>
				{conversationTitle && onModel && (
					<div className="remote-navigation-conversation">
						<p className="remote-navigation-conversation-title" title={conversationTitle}>
							{conversationTitle}
						</p>
						<button type="button" className="remote-navigation-item" onClick={onModel}>
							Model
						</button>
					</div>
				)}
				<nav className="remote-navigation-items" aria-label="Remote sections">
					{(['sessions', 'usage'] as const).map(destination => (
						<button
							key={destination}
							ref={destination === current ? activeItem : undefined}
							type="button"
							className="remote-navigation-item"
							aria-current={destination === current ? 'page' : undefined}
							onClick={() => onSelect(destination)}
						>
							{destination === 'sessions' ? 'Sessions' : 'Usage'}
						</button>
					))}
				</nav>
			</dialog>
		</div>
	)
}
