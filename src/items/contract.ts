import { PlanWorkspace } from '../plan/workspace.js'
import { emptyRunObservation } from './observation.js'
import type { RunObservation } from './observation.js'
import type { ItemRecord } from './schema.js'

export type DashboardTone = 'gray' | 'blue' | 'green' | 'amber' | 'red'
export type DashboardActionTone = 'primary' | 'muted' | 'danger'
export type DashboardActionId = 'approve' | 'reject' | 'start' | 'cancel' | 'retry'

export interface DashboardAction {
	id: DashboardActionId
	label: string
	tone: DashboardActionTone
}

export interface DashboardLink {
	label: string
	url: string | null
}

export interface DashboardCard {
	state: ItemRecord['status']
	statusLabel: string
	statusTone: DashboardTone
	pulse: boolean
}

export interface DashboardGroup {
	id: string
	label: string
	position: number
	size: number
	siblingIds: string[]
}

export interface DashboardForkContext {
	itemId: string
	branchName: string
	baseRef: string
}

export interface DashboardPlan {
	worktreePath: string
	branchName: string
	planDirName: string
	readmePath: string
}

export interface DashboardItem {
	id: string
	kind: ItemRecord['kind']
	status: ItemRecord['status']
	projectSlug: string
	title: string
	source: ItemRecord['source']
	baseRef: string
	spawner: string | null
	groupId: string | null
	group: DashboardGroup | null
	branchName: string | null
	forkContext: DashboardForkContext | null
	plan: DashboardPlan | null
	resultSummary: string | null
	solveInputSnapshot: string | null
	errorMessage: string | null
	errorPhase: string | null
	card: DashboardCard
	allowedActions: DashboardAction[]
	runObservation: RunObservation
	links: {
		source: DashboardLink | null
		branch: DashboardLink | null
		pr: DashboardLink | null
	}
	createdAt: string
	queuedAt: string | null
	startedAt: string | null
	completedAt: string | null
	updatedAt: string
}

const STATUS_TONE: Record<ItemRecord['status'], DashboardTone> = {
	unverified: 'amber',
	planned: 'gray',
	queued: 'gray',
	processing: 'blue',
	review: 'amber',
	completed: 'green',
	failed: 'red',
	cancelled: 'amber',
	skipped: 'gray',
}

const STATUS_LABEL: Record<ItemRecord['status'], string> = {
	unverified: 'Unverified',
	planned: 'Planned',
	queued: 'Queued',
	processing: 'Processing',
	review: 'Review',
	completed: 'Completed',
	failed: 'Failed',
	cancelled: 'Cancelled',
	skipped: 'Skipped',
}

const ACTIONS: Record<DashboardActionId, DashboardAction> = {
	approve: { id: 'approve', label: 'Approve', tone: 'primary' },
	reject: { id: 'reject', label: 'Reject', tone: 'danger' },
	start: { id: 'start', label: 'Start', tone: 'primary' },
	cancel: { id: 'cancel', label: 'Cancel', tone: 'danger' },
	retry: { id: 'retry', label: 'Retry', tone: 'primary' },
}

function actionsForStatus(status: ItemRecord['status']): DashboardAction[] {
	switch (status) {
		case 'unverified':
			return [ACTIONS.approve, ACTIONS.reject]
		case 'planned':
		case 'queued':
			return [ACTIONS.start, ACTIONS.cancel]
		case 'processing':
			return [ACTIONS.cancel]
		case 'review':
			return [ACTIONS.retry]
		case 'completed':
		case 'failed':
		case 'cancelled':
		case 'skipped':
			return [ACTIONS.retry]
	}
}

function formatPrLabel(url: string): string {
	const match = url.match(/\/pull\/(\d+)/)
	return match ? `PR #${match[1]}` : 'Pull Request'
}

function linksForItem(item: ItemRecord): DashboardItem['links'] {
	return {
		source: item.source
			? {
					label: item.source.externalId,
					url: item.source.url ?? null,
				}
			: null,
		branch: item.branchName
			? {
					// No standalone branch web URL (repo host unknown); the PR is the
					// branch's home on GitHub, so the branch label links there.
					label: item.branchName,
					url: item.prUrl,
				}
			: null,
		pr: item.prUrl
			? {
					label: formatPrLabel(item.prUrl),
					url: item.prUrl,
				}
			: null,
	}
}

function forkContextForItem(item: ItemRecord): DashboardForkContext | null {
	return item.branchName
		? {
				itemId: item.id,
				branchName: item.branchName,
				// A fork bases the new Item on THIS Item's branch, so the fork's
				// baseRef is this branch (intentional — not item.baseRef).
				baseRef: item.branchName,
			}
		: null
}

function planForItem(item: ItemRecord): DashboardPlan | null {
	if (!item.worktreePath || !item.branchName || !item.planDirName) return null
	const workspace = new PlanWorkspace(item.worktreePath, item.planDirName)
	return {
		worktreePath: item.worktreePath,
		branchName: item.branchName,
		planDirName: item.planDirName,
		readmePath: workspace.readmePath,
	}
}

function groupForItem(item: ItemRecord, siblings: ItemRecord[] | undefined): DashboardGroup | null {
	if (!item.groupId || !siblings || siblings.length < 2) return null
	const ordered = siblings.filter(sibling => sibling.groupId === item.groupId)
	if (ordered.length < 2) return null
	const siblingIds = ordered.map(sibling => sibling.id)
	const index = siblingIds.indexOf(item.id)
	if (index === -1) return null
	return {
		id: item.groupId,
		label: `Group ${index + 1}/${siblingIds.length}`,
		position: index + 1,
		size: siblingIds.length,
		siblingIds,
	}
}

export function toDashboardItem(
	item: ItemRecord,
	runObservation: RunObservation = emptyRunObservation(item),
	group: DashboardGroup | null = null,
): DashboardItem {
	return {
		id: item.id,
		kind: item.kind,
		status: item.status,
		projectSlug: item.projectSlug,
		title: item.title,
		source: item.source,
		baseRef: item.baseRef,
		spawner: item.spawner,
		groupId: item.groupId,
		group,
		branchName: item.branchName,
		forkContext: forkContextForItem(item),
		plan: planForItem(item),
		resultSummary: item.resultSummary,
		solveInputSnapshot: item.solveInputSnapshot,
		errorMessage: item.errorMessage,
		errorPhase: item.errorPhase,
		card: {
			state: item.status,
			statusLabel: STATUS_LABEL[item.status],
			statusTone: STATUS_TONE[item.status],
			pulse: item.status === 'processing',
		},
		allowedActions: actionsForStatus(item.status),
		runObservation,
		links: linksForItem(item),
		createdAt: item.createdAt,
		queuedAt: item.queuedAt,
		startedAt: item.startedAt,
		completedAt: item.completedAt,
		updatedAt: item.updatedAt,
	}
}

export function toDashboardItemWithSiblings(
	item: ItemRecord,
	siblings: ItemRecord[],
	runObservation: RunObservation = emptyRunObservation(item),
): DashboardItem {
	return toDashboardItem(item, runObservation, groupForItem(item, siblings))
}

export function toDashboardItems(
	items: ItemRecord[],
	runObservationFor: (item: ItemRecord) => RunObservation = emptyRunObservation,
): DashboardItem[] {
	const groups = new Map<string, ItemRecord[]>()
	for (const item of items) {
		if (!item.groupId) continue
		const siblings = groups.get(item.groupId) ?? []
		siblings.push(item)
		groups.set(item.groupId, siblings)
	}

	const emittedGroups = new Set<string>()
	const ordered: ItemRecord[] = []
	for (const item of items) {
		const siblings = item.groupId ? groups.get(item.groupId) : undefined
		if (!item.groupId || !siblings || siblings.length < 2) {
			ordered.push(item)
			continue
		}
		if (emittedGroups.has(item.groupId)) continue
		ordered.push(...siblings)
		emittedGroups.add(item.groupId)
	}

	return ordered.map(item => {
		const siblings = item.groupId ? groups.get(item.groupId) : undefined
		return toDashboardItem(item, runObservationFor(item), groupForItem(item, siblings))
	})
}
