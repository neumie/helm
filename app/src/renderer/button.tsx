import type { ReactNode, Ref } from 'react'
import './button.css'

export type ButtonTone = 'primary' | 'quiet' | 'danger' | 'ghost'

export function buttonClassName({
	tone = 'quiet',
	sm,
	block,
	className,
}: {
	tone?: ButtonTone
	sm?: boolean
	block?: boolean
	className?: string
} = {}): string {
	return `btn btn-${tone}${sm ? ' btn-sm' : ''}${block ? ' btn-block' : ''}${className ? ` ${className}` : ''}`
}

export function Btn({
	tone = 'quiet',
	sm,
	disabled,
	busy,
	onClick,
	children,
	block,
	className,
	ariaLabel,
	ariaExpanded,
	ariaControls,
	ariaCurrent,
	ariaDisabled,
	type = 'button',
	ref,
}: {
	tone?: ButtonTone
	sm?: boolean
	disabled?: boolean
	/** In-flight: keeps the label, appends an ellipsis, disables the control. */
	busy?: boolean
	onClick?: () => void
	children: ReactNode
	block?: boolean
	className?: string
	ariaLabel?: string
	ariaExpanded?: boolean
	ariaControls?: string
	ariaCurrent?: 'page'
	/** Marks a retained destination unavailable without removing its focus target. */
	ariaDisabled?: boolean
	type?: 'button' | 'submit' | 'reset'
	/** Destination for focus restoration after an async or disappearing action. */
	ref?: Ref<HTMLButtonElement>
}) {
	return (
		<button
			ref={ref}
			type={type}
			className={buttonClassName({ tone, sm, block, className })}
			disabled={disabled || busy}
			aria-label={ariaLabel}
			aria-expanded={ariaExpanded}
			aria-controls={ariaControls}
			aria-current={ariaCurrent}
			aria-disabled={ariaDisabled}
			onClick={event => {
				if (ariaDisabled) {
					event.preventDefault()
					return
				}
				onClick?.()
			}}
		>
			{children}
			{busy ? '…' : null}
		</button>
	)
}

/** Plain-DOM adapter for renderer surfaces that are intentionally outside
 * React. It preserves the same class, tone, size, and accessibility contract
 * as Btn. Placement classes may be supplied without redefining button chrome. */
export function createButton({
	label,
	tone = 'quiet',
	sm,
	disabled,
	block,
	className,
	ariaLabel,
	title,
	onClick,
}: {
	label: string
	tone?: ButtonTone
	sm?: boolean
	disabled?: boolean
	block?: boolean
	className?: string
	ariaLabel?: string
	title?: string
	onClick?: (event: MouseEvent) => void
}): HTMLButtonElement {
	const button = document.createElement('button')
	button.type = 'button'
	button.className = buttonClassName({ tone, sm, block, className })
	button.textContent = label
	button.disabled = disabled ?? false
	if (ariaLabel) button.setAttribute('aria-label', ariaLabel)
	if (title) button.title = title
	if (onClick) button.addEventListener('click', onClick)
	return button
}
