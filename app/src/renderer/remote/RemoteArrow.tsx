import { iconElement } from '../icons/Icon.js'
import { ICONS } from '../icons/icons.js'

// Heroicons v2.2.0 24px outline arrow-up/arrow-down, stroke 2 at 16px; geometry and source in the icon module (app/src/renderer/icons/).
export function RemoteArrow({ direction }: { direction: 'up' | 'down' }) {
	return iconElement(direction === 'up' ? ICONS.arrowUp : ICONS.arrowDown)
}
