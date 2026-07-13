import { PlanWorkspace } from '../plan/workspace.js'
import type { TaskContext } from '../providers/provider.js'
import type { SolverWorkspace } from '../solver/workspace.js'
import { emptyRunObservation } from './observation.js'
import type { RunObservation } from './observation.js'
import type { ItemRecord } from './schema.js'

export type DashboardTone = 'gray' | 'blue' | 'green' | 'amber' | 'red'
export type DashboardActionTone = 'primary' | 'muted' | 'danger'
export type DashboardActionId = 'approve' | 'reject' | 'start' | 'cancel' | 'retry' | 'reopen'

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
	/** Short AI-derived label; null until named. Clients show `displayName ?? title`. */
	displayName: string | null
	/** Pre-solve intent triage (advisory); null until assessed. */
	assessment: ItemRecord['assessment']
	source: ItemRecord['source']
	/** True for ingested (captured-context) Items — e.g. an email filed via /api/items/ingest. */
	captured: boolean
	/**
	 * True when the "create a task in the source system from this captured Item"
	 * action applies (captured, not yet linked to the active provider, and the
	 * provider supports task creation). Populated by single-Item routes — list
	 * rows leave it undefined (the button lives in the detail pane).
	 */
	canCreateSourceTask?: boolean
	baseRef: string
	spawner: string | null
	groupId: string | null
	group: DashboardGroup | null
	branchName: string | null
	forkContext: DashboardForkContext | null
	plan: DashboardPlan | null
	resultSummary: string | null
	solveInputSnapshot: string | null
	/** Per-item execution workspace override (`null` = follow `config.solver.workspace`). Solve only. */
	solverWorkspace: SolverWorkspace | null
	errorMessage: string | null
	errorPhase: string | null
	runOutcome: ItemRecord['runOutcome']
	deployState: ItemRecord['deployState']
	// The live source-task content (description/metadata/comments). Populated only
	// by the single-Item detail route (a provider fetch); undefined in list rows.
	sourceTask?: TaskContext | null
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
	plannedAt: string | null
	updatedAt: string
}

const STATUS_TONE: Record<ItemRecord['status'], DashboardTone> = {
	triage: 'amber',
	ready: 'gray',
	running: 'blue',
	review: 'amber',
	done: 'green',
	failed: 'red',
	cancelled: 'amber',
}

const STATUS_LABEL: Record<ItemRecord['status'], string> = {
	triage: 'Triage',
	ready: 'Ready',
	running: 'Running',
	review: 'Review',
	done: 'Done',
	failed: 'Failed',
	cancelled: 'Cancelled',
}

const ACTIONS: Record<DashboardActionId, DashboardAction> = {
	approve: { id: 'approve', label: 'Approve', tone: 'primary' },
	reject: { id: 'reject', label: 'Reject', tone: 'danger' },
	start: { id: 'start', label: 'Start', tone: 'primary' },
	cancel: { id: 'cancel', label: 'Cancel', tone: 'danger' },
	retry: { id: 'retry', label: 'Retry', tone: 'primary' },
	reopen: { id: 'reopen', label: 'To review', tone: 'primary' },
}

function actionsForStatus(
	status: ItemRecord['status'],
	kind: ItemRecord['kind'],
	hasSource: boolean,
): DashboardAction[] {
	switch (status) {
		case 'triage':
			// Source tasks are an untrusted inbox → approve/reject (the go/no-go gate).
			// Source-less plan-first Items are deliberately created → start/cancel.
			return hasSource ? [ACTIONS.approve, ACTIONS.reject] : [ACTIONS.start, ACTIONS.cancel]
		case 'ready':
			return [ACTIONS.start, ACTIONS.cancel]
		case 'running':
			return [ACTIONS.cancel]
		case 'review':
			return [ACTIONS.retry]
		case 'done':
		case 'cancelled':
			return [ACTIONS.retry]
		case 'failed':
			// `reopen` is the manual override for a false failure (solve only):
			// "the work is fine — move it to review" without re-running.
			return kind === 'solve' ? [ACTIONS.retry, ACTIONS.reopen] : [ACTIONS.retry]
	}
}

/**
 * Whether the "create source task" action applies. Route-layer helper: needs
 * provider facts (name + createTask capability) the contract itself doesn't have.
 */
export function canCreateSourceTask(item: ItemRecord, provider: { name: string; createTask?: unknown }): boolean {
	return (
		item.kind === 'solve' &&
		item.capturedContext != null &&
		item.source?.provider !== provider.name &&
		typeof provider.createTask === 'function'
	)
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
		displayName: item.displayName,
		assessment: item.assessment,
		source: item.source,
		captured: item.capturedContext != null,
		baseRef: item.baseRef,
		spawner: item.spawner,
		groupId: item.groupId,
		group,
		branchName: item.branchName,
		forkContext: forkContextForItem(item),
		plan: planForItem(item),
		resultSummary: item.resultSummary,
		solveInputSnapshot: item.solveInputSnapshot,
		solverWorkspace: item.payload.kind === 'solve' ? (item.payload.solverWorkspace ?? null) : null,
		errorMessage: item.errorMessage,
		errorPhase: item.errorPhase,
		runOutcome: item.runOutcome,
		deployState: item.deployState,
		card: {
			state: item.status,
			statusLabel: STATUS_LABEL[item.status],
			statusTone: STATUS_TONE[item.status],
			pulse: item.status === 'running',
		},
		allowedActions: actionsForStatus(item.status, item.kind, item.source != null),
		runObservation,
		links: linksForItem(item),
		createdAt: item.createdAt,
		queuedAt: item.queuedAt,
		startedAt: item.startedAt,
		completedAt: item.completedAt,
		plannedAt: item.plannedAt,
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
