/** Insertion slot before/after a hovered tab, split at its horizontal midpoint. */
export function tabDropInsertionIndex(
	targetIndex: number,
	pointerX: number,
	targetLeft: number,
	targetWidth: number,
): number {
	return targetIndex + (pointerX >= targetLeft + targetWidth / 2 ? 1 : 0)
}

export interface HorizontalRect {
	left: number
	width: number
}

export interface Rect extends HorizontalRect {
	top: number
	height: number
}

export function dragThresholdExceeded(startX: number, startY: number, pointerX: number, pointerY: number): boolean {
	return Math.hypot(pointerX - startX, pointerY - startY) >= 5
}

export function pointInExpandedRect(pointerX: number, pointerY: number, rect: Rect, expansion = 0): boolean {
	return (
		pointerX >= rect.left - expansion &&
		pointerX <= rect.left + rect.width + expansion &&
		pointerY >= rect.top - expansion &&
		pointerY <= rect.top + rect.height + expansion
	)
}

/** Resolve against every tab midpoint, including leading/trailing strip gutters. */
export function stripDropInsertionIndex(pointerX: number, tabs: readonly HorizontalRect[]): number {
	const index = tabs.findIndex(tab => pointerX < tab.left + tab.width / 2)
	return index === -1 ? tabs.length : index
}

const AUTO_SCROLL_EDGE_PX = 28
const AUTO_SCROLL_STEP_PX = 12

/** Direction/speed for drag-edge auto-scroll. Zero means no scroll this tick. */
export function tabStripAutoScrollDelta(
	pointerX: number,
	strip: HorizontalRect,
	scrollLeft: number,
	scrollWidth: number,
	clientWidth: number,
): number {
	if (pointerX <= strip.left + AUTO_SCROLL_EDGE_PX && scrollLeft > 0) return -AUTO_SCROLL_STEP_PX
	const maxScroll = Math.max(0, scrollWidth - clientWidth)
	if (pointerX >= strip.left + strip.width - AUTO_SCROLL_EDGE_PX && scrollLeft < maxScroll) return AUTO_SCROLL_STEP_PX
	return 0
}

/**
 * Resolve a peer-relative group slot back into the flat renderer order. The
 * moving item is excluded while choosing anchors, so this works both within a
 * group and when crossing group boundaries. `fallbackInsertionIndex` is used
 * when the destination currently has no members (notably ungrouping into an
 * otherwise fully-grouped strip).
 */
export function groupDropInsertionIndex<T extends { groupId: string | null }>(
	items: readonly T[],
	moving: T,
	targetGroupId: string | null,
	peerInsertionIndex: number,
	fallbackInsertionIndex: number,
): number {
	const peers = items.filter(item => item !== moving && item.groupId === targetGroupId)
	if (peers.length === 0) return Math.max(0, Math.min(items.length, Math.floor(fallbackInsertionIndex)))
	const slot = Math.max(0, Math.min(peers.length, Math.floor(peerInsertionIndex)))
	const anchor = peers[slot]
	if (anchor) return items.indexOf(anchor)
	return items.indexOf(peers[peers.length - 1] as T) + 1
}

/** Insert one contiguous block between visual strip units. Inputs stay untouched. */
export function insertBlockAtUnitIndex<T>(
	units: readonly (readonly T[])[],
	block: readonly T[],
	unitIndex: number,
): T[] {
	const slot = Math.max(0, Math.min(units.length, Math.floor(unitIndex)))
	return [...units.slice(0, slot).flat(), ...block, ...units.slice(slot).flat()]
}

/** Move one existing item into a pre-removal insertion slot. Input stays untouched. */
export function moveToInsertionIndex<T>(items: readonly T[], moving: T, insertionIndex: number): T[] {
	const from = items.indexOf(moving)
	if (from === -1) return [...items]
	let to = Math.max(0, Math.min(items.length, Math.floor(insertionIndex)))
	if (from < to) to -= 1
	if (from === to) return [...items]

	const next = [...items]
	next.splice(from, 1)
	next.splice(to, 0, moving)
	return next
}

export default {
	dragThresholdExceeded,
	groupDropInsertionIndex,
	insertBlockAtUnitIndex,
	moveToInsertionIndex,
	pointInExpandedRect,
	stripDropInsertionIndex,
	tabDropInsertionIndex,
	tabStripAutoScrollDelta,
}
