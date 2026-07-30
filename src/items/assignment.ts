import type { ItemRecord } from './schema.js'

export const UNTITLED_ITEM_TITLE = 'Untitled item'

export type AssignedItem = ItemRecord & { projectSlug: string; baseRef: string }

/** Project and BaseRef are one atomic seam: neither may be inferred at run time. */
export function isItemAssigned(item: ItemRecord): item is AssignedItem {
	return item.projectSlug !== null && item.baseRef !== null
}

export function requireItemAssignment(item: ItemRecord): asserts item is AssignedItem {
	if (!isItemAssigned(item)) throw new Error('Assign a project before starting this Item')
}

/** Assignment is a one-way draft transition; changing an established workspace
 * identity would orphan branches, plans, or provider provenance. */
export function canAssignItem(item: ItemRecord): boolean {
	return (
		!isItemAssigned(item) &&
		item.kind === 'solve' &&
		item.payload.kind === 'solve' &&
		item.source === null &&
		item.capturedContext === null &&
		item.groupId === null &&
		item.status === 'ready' &&
		item.workMode === null &&
		item.worktreePath === null &&
		item.branchName === null &&
		item.planDirName === null &&
		item.plannedAt === null
	)
}
