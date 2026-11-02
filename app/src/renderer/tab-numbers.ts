import type { TabGroupSection } from './tab-groups'

/**
 * How ⌘1–⌘9 count strip tabs. Shared by the shortcut handler and the leading
 * number hints so the digit a tab shows is always the number that selects it.
 *
 * Only tabs visible in the strip are numbered, in visual order: a collapsed
 * group contributes nothing (its member buttons stay mounted but hidden), and
 * an expanded group's members are numbered like ordinary tabs.
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

/** Numbers the visible strip tabs in visual order, up to nine. */
export function tabNumberSlots(strip: readonly NumberableSection[]): TabNumberSlot[] {
	const slots: TabNumberSlot[] = []
	for (const section of strip) {
		if (section.collapsed && section.groupId !== null) continue
		for (const member of section.members) {
			if (slots.length === TAB_NUMBER_SLOT_COUNT) return slots
			slots.push({ number: slots.length + 1, tabId: member.id })
		}
	}
	return slots
}

/** The slot a 1-based shortcut number selects, or null when fewer tabs are visible. */
export function tabNumberSlot(slots: readonly TabNumberSlot[], number: number): TabNumberSlot | null {
	return slots.find(slot => slot.number === number) ?? null
}

export default { tabNumberSlots, tabNumberSlot, TAB_NUMBER_SLOT_COUNT }
