import type { TabGroupSection } from './tab-groups'

/**
 * How ⌘1–⌘9 count strip tabs. Shared by the shortcut handler and the number
 * hints so the number a tab shows is always the number that selects it.
 *
 * - `all`: production today — a flat walk of every strip tab, so members of a
 *   collapsed group still take numbers while their buttons are hidden.
 * - `skip-collapsed`: only tabs visible in the strip are numbered; a collapsed
 *   group contributes nothing.
 * - `folder-slot`: a collapsed group is ONE number that selects its last-active
 *   member; members of expanded groups are numbered individually.
 */
export type TabNumberMode = 'all' | 'skip-collapsed' | 'folder-slot'

/**
 * Review-only number display variants. `none` is production today.
 * - `always`: a dim leading digit on every numbered tab.
 * - `hold`: leading badges only while the Primary modifier is held.
 * - `trailing`: a trailing ⌘N hint on hover and on the active tab.
 */
export type TabNumberHints = 'none' | 'always' | 'hold' | 'trailing'

/** Review-only mount seam; production omits it (`all` + `none`). */
export interface TabNumberReviewOptions {
	mode?: TabNumberMode
	hints?: TabNumberHints
	/** Pins the `hold` variant's held state (Storybook control). */
	held?: boolean
}

/** ⌘1–⌘9 address the first nine slots; ⌘9 is the ninth slot, not the last tab. */
export const TAB_NUMBER_SLOT_COUNT = 9

export interface TabNumberSlot {
	/** 1-based shortcut number. */
	number: number
	/** The tab this number selects. */
	tabId: string
	/** Set when the slot stands for a whole collapsed group (`folder-slot`). */
	groupId: string | null
}

type NumberableSection = Pick<TabGroupSection, 'groupId' | 'collapsed'> & {
	members: readonly { id: string; active: boolean }[]
}

/**
 * Numbers the strip in visual order. `lastActiveByGroup` remembers which member
 * a collapsed group's single slot should reopen; it falls back to the active
 * member, then the group's first member.
 */
export function tabNumberSlots(
	strip: readonly NumberableSection[],
	mode: TabNumberMode,
	lastActiveByGroup: ReadonlyMap<string, string> = new Map(),
): TabNumberSlot[] {
	const slots: TabNumberSlot[] = []
	const push = (tabId: string, groupId: string | null) => {
		if (slots.length < TAB_NUMBER_SLOT_COUNT) slots.push({ number: slots.length + 1, tabId, groupId })
	}
	for (const section of strip) {
		if (section.members.length === 0) continue
		const collapsedGroup = section.collapsed && section.groupId !== null
		if (!collapsedGroup || mode === 'all') {
			for (const member of section.members) push(member.id, null)
			continue
		}
		if (mode === 'skip-collapsed') continue
		const remembered = lastActiveByGroup.get(section.groupId as string)
		const target =
			section.members.find(member => member.id === remembered) ??
			section.members.find(member => member.active) ??
			section.members[0]
		if (target) push(target.id, section.groupId)
	}
	return slots
}

/** The slot a 1-based shortcut number selects, or null when nothing holds it. */
export function tabNumberSlot(slots: readonly TabNumberSlot[], number: number): TabNumberSlot | null {
	return slots.find(slot => slot.number === number) ?? null
}

/** Display lookup: individually numbered tabs and whole collapsed groups. */
export function tabNumberLabels(slots: readonly TabNumberSlot[]): {
	byTab: ReadonlyMap<string, number>
	byGroup: ReadonlyMap<string, number>
} {
	const byTab = new Map<string, number>()
	const byGroup = new Map<string, number>()
	for (const slot of slots) {
		if (slot.groupId === null) byTab.set(slot.tabId, slot.number)
		else byGroup.set(slot.groupId, slot.number)
	}
	return { byTab, byGroup }
}

export default { tabNumberSlots, tabNumberSlot, tabNumberLabels, TAB_NUMBER_SLOT_COUNT }
