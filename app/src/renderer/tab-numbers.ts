import type { TabGroupSection } from './tab-groups'

/**
 * Which strip tabs the keyboard can reach. ⌘1–⌘9 and previous/next tab share
 * this one notion of visibility, and the leading number hints use the same
 * numbering, so the digit a tab shows is always the number that selects it.
 *
 * Only tabs visible in the strip count, in visual order: a collapsed group
 * contributes nothing (its member buttons stay mounted but hidden), and an
 * expanded group's members count like ordinary tabs.
 */

/** ⌘1–⌘9 address the first nine visible tabs; ⌘9 is the ninth tab, not the last. */
export const TAB_NUMBER_SLOT_COUNT = 9

export interface TabNumberSlot {
	/** 1-based shortcut number. */
	number: number
	/** The tab this number selects. */
	tabId: string
}

type NumberableSection = Pick<TabGroupSection, 'groupId' | 'collapsed'> & {
	members: readonly { id: string }[]
}

const sectionVisible = (section: NumberableSection) => !(section.collapsed && section.groupId !== null)

/** Every visible strip tab in visual order, without the nine-slot limit. */
function visibleStripTabIds(strip: readonly NumberableSection[]): string[] {
	return strip.filter(sectionVisible).flatMap(section => section.members.map(member => member.id))
}

/** Numbers the visible strip tabs in visual order, up to nine. */
export function tabNumberSlots(strip: readonly NumberableSection[]): TabNumberSlot[] {
	return visibleStripTabIds(strip)
		.slice(0, TAB_NUMBER_SLOT_COUNT)
		.map((tabId, index) => ({ number: index + 1, tabId }))
}

/** The slot a 1-based shortcut number selects, or null when fewer tabs are visible. */
export function tabNumberSlot(slots: readonly TabNumberSlot[], number: number): TabNumberSlot | null {
	return slots.find(slot => slot.number === number) ?? null
}

/**
 * The tab previous (-1) / next (+1) moves to: the nearest visible strip tab in
 * that direction, wrapping around. A tab hidden inside a collapsed folder is
 * skipped; when the active tab is itself hidden, the step starts from its place
 * in the full strip order. An active tab outside the strip (or none) moves to
 * the first (next) or last (previous) visible tab. Null when nothing is visible.
 * May return the active tab itself when it is the only visible one.
 */
export function adjacentVisibleTabId(
	strip: readonly NumberableSection[],
	activeTabId: string | null,
	direction: 1 | -1,
): string | null {
	const visible = new Set(visibleStripTabIds(strip))
	if (visible.size === 0) return null
	const order = strip.flatMap(section => section.members.map(member => member.id))
	const start = activeTabId === null ? -1 : order.indexOf(activeTabId)
	if (start < 0) {
		const ids = [...visible]
		return (direction > 0 ? ids[0] : ids[ids.length - 1]) ?? null
	}
	for (let step = 1; step <= order.length; step++) {
		const candidate = order[(((start + direction * step) % order.length) + order.length) % order.length]
		if (candidate !== undefined && visible.has(candidate)) return candidate
	}
	return null
}

export default { tabNumberSlots, tabNumberSlot, adjacentVisibleTabId, TAB_NUMBER_SLOT_COUNT }
