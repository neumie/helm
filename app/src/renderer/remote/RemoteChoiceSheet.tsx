import { useLayoutEffect, useRef } from 'react'

export interface ChoiceOption {
	id: string
	label: string
	meta?: string
	/** Absent for an action: only a choice or a toggle reports state. */
	checked?: boolean
	/** A switch rather than one of several alternatives. */
	toggle?: boolean
	disabled?: boolean
}

/**
 * One decision at a time, on a surface big enough to read. The composer menu stays a
 * short list of what can be changed; this is where the actual choosing happens, so a
 * catalogue of thirty models never has to live inside a dropdown.
 */
export function RemoteChoiceSheet({
	title,
	options,
	empty,
	onChoose,
	onClose,
	onRestoreFocus,
}: {
	title: string
	options: readonly ChoiceOption[]
	/** Shown instead of the list when there is nothing to choose, never an empty sheet. */
	empty?: string
	onChoose(id: string): void
	onRestoreFocus(): void
	onClose(): void
}) {
	// A sheet of actions is a menu; a sheet of alternatives is a radio group. Deciding
	// by the entries keeps one surface without lying about its semantics.
	const choosing = options.some(option => option.checked !== undefined && !option.toggle)
	const surface = useRef<HTMLDivElement>(null)

	const scrim = useRef<HTMLDivElement>(null)
	const callbacks = useRef({ onClose, onRestoreFocus })
	callbacks.current = { onClose, onRestoreFocus }

	useLayoutEffect(() => {
		const root = scrim.current
		if (!root) return
		// The sheet is nested in the composer. Fence every sibling along its ancestor
		// path, not the ancestors themselves (which would also disable this sheet).
		const background = new Map<HTMLElement, boolean>()
		for (let node: HTMLElement | null = root; node?.parentElement; node = node.parentElement) {
			for (const sibling of node.parentElement.children) {
				if (sibling === node || !(sibling instanceof HTMLElement)) continue
				background.set(sibling, sibling.inert)
				sibling.inert = true
			}
		}
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault()
				event.stopImmediatePropagation()
				callbacks.current.onClose()
			} else if (event.key === 'Tab') {
				const buttons = [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
				const first = buttons[0]
				const last = buttons.at(-1)
				const active = document.activeElement
				const inside = buttons.some(button => button === active)
				if (event.shiftKey && (active === first || !inside)) {
					event.preventDefault()
					last?.focus()
				} else if (!event.shiftKey && (active === last || !inside)) {
					event.preventDefault()
					first?.focus()
				}
			}
		}
		window.addEventListener('keydown', key, true)
		return () => {
			const active = document.activeElement
			const owned = active === document.body || root.contains(active)
			window.removeEventListener('keydown', key, true)
			for (const [node, inert] of background) node.inert = inert
			if (owned) callbacks.current.onRestoreFocus()
		}
	}, [])
	// A deliberate More → Effort transition is a new decision; polling is not.
	// biome-ignore lint/correctness/useExhaustiveDependencies: title owns decision focus, not options/callback identity.
	useLayoutEffect(() => {
		const first = surface.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
		;(first ?? surface.current)?.focus({ preventScroll: true })
	}, [title])

	return (
		<div className="remote-sheet-scrim" ref={scrim}>
			{/* A backdrop press dismisses, which is why it is a button and not a bare div. */}
			<button type="button" className="remote-sheet-dismiss" aria-label={`Close ${title}`} onClick={onClose} />
			{/* biome-ignore lint/a11y/useSemanticElements: existing in-tree sheet owns focus containment and ancestor-sibling inertness explicitly. */}
			<div className="remote-sheet" role="dialog" aria-modal="true" aria-label={title} ref={surface} tabIndex={-1}>
				<h2 className="remote-sheet-title">{title}</h2>
				<div className="remote-sheet-options" role={choosing ? 'radiogroup' : 'menu'} aria-label={title}>
					{options.map(option => (
						<button
							key={option.id}
							type="button"
							role={option.toggle ? 'menuitemcheckbox' : choosing ? 'radio' : 'menuitem'}
							aria-checked={option.toggle || choosing ? option.checked === true : undefined}
							className="remote-sheet-option"
							disabled={option.disabled}
							onClick={() => onChoose(option.id)}
						>
							<span className="remote-sheet-option-label">{option.label}</span>
							{option.meta && <span className="remote-sheet-option-meta">{option.meta}</span>}
							{/* Hidden from the name: aria-checked already says this, and generated
							    content would otherwise read as part of the label. */}
							{option.checked && (
								<span className="remote-sheet-option-mark" aria-hidden="true">
									✓
								</span>
							)}
						</button>
					))}
					{options.length === 0 && <p className="remote-note">{empty ?? 'Nothing to choose here.'}</p>}
				</div>
			</div>
		</div>
	)
}
