import { existsSync } from 'node:fs'
import { computePlanDirName, slugify } from '../util/slug.js'
import type { ItemRecord } from './schema.js'

export interface ItemWorkspaceIdentity {
	baseRef: string
	planDirName: string
	branchName: string
	/** Set only if the recorded worktree still exists on disk. */
	existingWorktreePath: string | undefined
}

function createdAtDate(item: ItemRecord): Date {
	const date = new Date(item.createdAt)
	return Number.isNaN(date.getTime()) ? new Date() : date
}

/** Deterministic 8-char disambiguator derived from the Item id. */
export function itemSuffix(item: ItemRecord): string {
	return slugify(item.id, 8) || 'item'
}

/**
 * Plan-dir name for a model-derived slug, keeping the existing default shape
 * (`<date>-<slug>-<suffix>`) so plan dirs stay date-sortable and unique. Only the
 * slug source changes (AI summary instead of the title). Lives here so all Item
 * identity construction stays in one module.
 */
export function derivedItemPlanDirName(item: ItemRecord, slug: string): string {
	return `${computePlanDirName(slug, createdAtDate(item))}-${itemSuffix(item)}`
}

/**
 * Resolve an Item row to its workspace identity. Defaults derive from Item
 * title/id/createdAt and never from legacy Task fields or mutable project config.
 */
export function resolveItemWorkspace(item: ItemRecord): ItemWorkspaceIdentity {
	const suffix = itemSuffix(item)
	return {
		baseRef: item.baseRef,
		planDirName: item.planDirName ?? `${computePlanDirName(item.title, createdAtDate(item))}-${suffix}`,
		branchName: item.branchName ?? `helm/item/${slugify(item.title) || 'item'}-${suffix}`,
		existingWorktreePath: item.worktreePath && existsSync(item.worktreePath) ? item.worktreePath : undefined,
	}
}
