// The React form of Helm's icons (./icons.ts holds the geometry, sources and the DOM form).
import { type ReactElement, createElement } from 'react'
import { ICONS, type IconAttributes, type IconData } from './icons'

/** DOM attribute spelling → React prop: `class` → `className`, `stroke-width` → `strokeWidth`; aria-/data- stay. */
function reactProps(attributes: IconAttributes): Record<string, string> {
	const props: Record<string, string> = {}
	for (const [name, value] of Object.entries(attributes)) {
		const prop =
			name === 'class'
				? 'className'
				: name.startsWith('aria-') || name.startsWith('data-')
					? name
					: name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
		props[prop] = value
	}
	return props
}

/** The React element for an icon: the same `<svg>` the DOM form builds, attribute for attribute. */
export function iconElement(icon: IconData): ReactElement {
	return createElement(
		'svg',
		reactProps(icon.svg),
		...icon.shapes.map(shape => createElement(shape.tag, reactProps(shape.attributes))),
	)
}

export function Icon({ icon }: { icon: IconData }): ReactElement {
	return iconElement(icon)
}

// The sidebar's glyph table (Btn/IconBtn content across the sidebar, Document Review and Remote), re-exported
// from sidebar/ui.tsx. A plain mutable object on purpose: the D6 proposal stories swap its entries.
export const GLYPH = {
	plus: iconElement(ICONS.plus),
	menu: iconElement(ICONS.menu),
	back: iconElement(ICONS.back),
	chevronRight: iconElement(ICONS.chevronRight),
	chevronDown: iconElement(ICONS.chevronDown),
	ellipsis: iconElement(ICONS.ellipsis),
	external: iconElement(ICONS.external),
	copy: iconElement(ICONS.copy),
	check: iconElement(ICONS.check),
	agent: iconElement(ICONS.agent),
	manual: iconElement(ICONS.manual),
	play: iconElement(ICONS.play),
	queue: iconElement(ICONS.queue),
	retry: iconElement(ICONS.retry),
	stop: iconElement(ICONS.stop),
	pause: iconElement(ICONS.pause),
	return: iconElement(ICONS.return),
	plan: iconElement(ICONS.plan),
	archive: iconElement(ICONS.archive),
	calendar: iconElement(ICONS.calendar),
	group: iconElement(ICONS.group),
	settings: iconElement(ICONS.settings),
	close: iconElement(ICONS.close),
}
