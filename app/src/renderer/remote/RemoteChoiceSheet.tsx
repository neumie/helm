import { useEffect, useRef } from 'react'

export interface ChoiceOption {
	id: string
	label: string
	meta?: string
	checked: boolean
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
}: {
	title: string
	options: readonly ChoiceOption[]
	/** Shown instead of the list when there is nothing to choose, never an empty sheet. */
	empty?: string
	onChoose(id: string): void
	onClose(): void
}) {
	const surface = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const focus = surface.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
		focus?.focus({ preventScroll: true })
		const key = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			// The conversation's own Escape handling must not also fire behind this.
			event.stopPropagation()
			onClose()
		}
		window.addEventListener('keydown', key, { capture: true })
		return () => window.removeEventListener('keydown', key, { capture: true })
	}, [onClose])

	return (
		<div className="remote-sheet-scrim">
			{/* A backdrop press dismisses, which is why it is a button and not a bare div. */}
			<button type="button" className="remote-sheet-dismiss" aria-label={`Close ${title}`} onClick={onClose} />
			<div className="remote-sheet" role="dialog" aria-modal="true" aria-label={title} ref={surface}>
				<h2 className="remote-sheet-title">{title}</h2>
				<div className="remote-sheet-options" role="radiogroup" aria-label={title}>
					{options.map(option => (
						<button
							key={option.id}
							type="button"
							role="radio"
							aria-checked={option.checked}
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
