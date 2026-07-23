import type { ReactNode } from 'react'

export function IconBtn({
	label,
	onClick,
	children,
	pressed,
	disabled,
	className,
}: {
	label: string
	onClick?: () => void
	children: ReactNode
	pressed?: boolean
	disabled?: boolean
	className?: string
}) {
	return (
		<button
			type="button"
			className={`icon-btn${className ? ` ${className}` : ''}`}
			aria-label={label}
			title={label}
			aria-pressed={pressed}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</button>
	)
}

/** Plain-DOM adapter for renderer surfaces that are intentionally outside
 * React. It preserves the same class and accessible-name contract as IconBtn. */
export function createIconButton({
	label,
	glyph,
	glyphClassName,
	className,
	onClick,
}: {
	label: string
	glyph: string
	glyphClassName?: string
	className?: string
	onClick?: () => void
}): HTMLButtonElement {
	const button = document.createElement('button')
	button.type = 'button'
	button.className = `icon-btn${className ? ` ${className}` : ''}`
	button.setAttribute('aria-label', label)
	button.title = label
	if (onClick) button.addEventListener('click', onClick)

	const glyphNode = document.createElement('span')
	glyphNode.className = `icon-btn-glyph${glyphClassName ? ` ${glyphClassName}` : ''}`
	glyphNode.setAttribute('aria-hidden', 'true')
	glyphNode.textContent = glyph
	button.append(glyphNode)
	return button
}
