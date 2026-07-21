const ACTIVITY_DOT_IDS = [
	'top-left',
	'top-right',
	'middle-left',
	'middle-right',
	'bottom-left',
	'bottom-right',
] as const
export const ACTIVITY_INDICATOR_DOTS = ACTIVITY_DOT_IDS.length

export type ActivityIndicatorVariant = 'progress' | 'attention'

export interface ActivityIndicatorProps {
	/** Accessible state announced when the indicator becomes visible. */
	label?: string
	className?: string
	hidden?: boolean
	/** Progress chases clockwise; attention breathes as one completed matrix. */
	variant?: ActivityIndicatorVariant
}

function classes(className?: string): string {
	return `activity-indicator${className ? ` ${className}` : ''}`
}

/** Shared activity primitive for React surfaces. Accent marks active dots;
 * the tail settles to neutral and words remain assistive-only. */
export function ActivityIndicator({
	label = 'In progress',
	className,
	hidden,
	variant = 'progress',
}: ActivityIndicatorProps) {
	return (
		<output className={classes(className)} data-variant={variant} aria-live="polite" aria-label={label} hidden={hidden}>
			{ACTIVITY_DOT_IDS.map(position => (
				<span aria-hidden="true" className="activity-indicator-dot" key={position} />
			))}
		</output>
	)
}

/** Plain-DOM adapter for the terminal renderer, which predates the React
 * sidebar but must use the same component contract and styles. */
export function setActivityIndicatorState(
	indicator: HTMLOutputElement,
	variant: ActivityIndicatorVariant,
	label: string,
): void {
	indicator.dataset.variant = variant
	indicator.setAttribute('aria-label', label)
}

export function createActivityIndicator(
	label = 'In progress',
	variant: ActivityIndicatorVariant = 'progress',
): HTMLOutputElement {
	const indicator = document.createElement('output')
	indicator.className = 'activity-indicator'
	indicator.setAttribute('aria-live', 'polite')
	setActivityIndicatorState(indicator, variant, label)
	for (let index = 0; index < ACTIVITY_INDICATOR_DOTS; index += 1) {
		const dot = document.createElement('span')
		dot.className = 'activity-indicator-dot'
		dot.setAttribute('aria-hidden', 'true')
		indicator.append(dot)
	}
	return indicator
}

export default { ACTIVITY_INDICATOR_DOTS, ActivityIndicator, createActivityIndicator, setActivityIndicatorState }
