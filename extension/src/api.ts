import { DEFAULT_SERVER_URL, getSync } from './storage'

export type SolverAgent = 'claude' | 'codex'
export type SolverWorkspace = 'worktree' | 'main'

export type DashboardTone = 'gray' | 'blue' | 'green' | 'amber' | 'red'
export type DashboardActionTone = 'primary' | 'muted' | 'danger'
export type DashboardActionId = 'approve' | 'reject' | 'start' | 'cancel' | 'retry' | 'reopen'
export type RunOutcome = 'ok' | 'errored' | 'no_result' | 'cancelled'

export interface DeploymentEntry {
	environment: string
	state: string
	url: string | null
	updatedAt: string | null
}
export interface DeployState {
	merged: boolean
	mergedAt: string | null
	mergeSha: string | null
	deployments: DeploymentEntry[]
	checkedAt: string
}

export type DescriptionBlock =
	| { type: 'text'; text: string; heading?: number }
	| { type: 'image'; url: string; name?: string; contentType?: string }

export interface SourceTask {
	title: string
	description?: string
	descriptionBlocks?: DescriptionBlock[]
	metadata?: Record<string, string>
	comments?: Array<{ author: string; createdAt: string; body: string }>
	attachments?: Array<{ name: string; url: string; contentType?: string }>
	projectContext?: string
}

export interface DashboardAction {
	id: DashboardActionId
	label: string
	tone: DashboardActionTone
}

export interface DashboardLink {
	label: string
	url: string | null
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

export type RunObservationSource = 'none' | 'solve' | 'loop'
export type RunObservationState = 'idle' | 'running' | 'review' | 'completed' | 'failed' | 'cancelled' | 'unknown'

export interface RunObservationEvent {
	type: string
	label: string
	tone: DashboardTone
	createdAt: string | null
}

export interface RunObservation {
	source: RunObservationSource
	state: RunObservationState
	stateLabel: string
	summary: string | null
	events: RunObservationEvent[]
	log: {
		path: string | null
		available: boolean
		content: string
		truncated: boolean
	}
	pr: {
		url: string | null
		state: string | null
		merged: boolean | null
	}
	almanac: {
		runId: string | null
		statusPath: string | null
		status: string | null
		round: string | null
		summary: string | null
		failureReason: string | null
	}
}

export interface PlanStatus {
	stage: 'planning' | 'plan_ready' | 'tickets_ready'
	specName: string | null
	localTickets: { total: number; open: number; readyForAgent: number; readyForHuman: number }
	githubTickets: { total: number; open: number; readyForAgent: number; readyForHuman: number }
	githubAvailable: boolean
	checkedAt: string
}

export interface DashboardItem {
	id: string
	kind: 'solve' | 'loop'
	executionMode: 'solve' | 'loop'
	status: string
	workMode: 'agent' | 'manual' | null
	projectSlug: string
	title: string
	source: { provider: string; externalId: string; url?: string } | null
	baseRef: string
	spawner: string | null
	groupId: string | null
	group: DashboardGroup | null
	branchName: string | null
	forkContext: DashboardForkContext | null
	plan: DashboardPlan | null
	planStatus: PlanStatus | null
	resultSummary: string | null
	solveInputSnapshot: string | null
	errorMessage: string | null
	errorPhase: string | null
	runOutcome: RunOutcome | null
	deployState: DeployState | null
	sourceTask?: SourceTask | null
	card: {
		state: string
		statusLabel: string
		statusTone: DashboardTone
		pulse: boolean
	}
	allowedActions: DashboardAction[]
	runObservation: RunObservation
	links: {
		source: DashboardLink | null
		branch: DashboardLink | null
		pr: DashboardLink | null
	}
	createdAt: string
	queuedAt: string | null
	updatedAt: string
}

let cachedServerUrl = DEFAULT_SERVER_URL

export async function getServerUrl(): Promise<string> {
	const items = await getSync({ serverUrl: cachedServerUrl })
	cachedServerUrl = String(items.serverUrl || DEFAULT_SERVER_URL)
	return cachedServerUrl
}

async function fetchAPI<T>(path: string): Promise<T> {
	const base = await getServerUrl()
	const res = await fetch(`${base}/api${path}`)
	if (!res.ok) throw new Error(`API error: ${res.status}`)
	const json = await res.json()
	return json.data
}

async function postAPI<T>(path: string, body?: unknown): Promise<T> {
	const base = await getServerUrl()
	const res = await fetch(`${base}/api${path}`, {
		method: 'POST',
		headers: body ? { 'Content-Type': 'application/json' } : {},
		body: body ? JSON.stringify(body) : undefined,
	})
	const json = await res.json()
	if (!res.ok) throw new Error(json.error ?? `API error: ${res.status}`)
	return json.data
}

export interface PlanInfo {
	worktreePath: string
	branchName: string
	planDirName: string
	readmePath: string
	spawner: string
	solverAgent: SolverAgent
	hint: string
}

export interface ModelOption {
	id: string
	label: string
}

export interface SolveSelection {
	solverAgent?: SolverAgent
	/**
	 * Per-item model override. A model id sets it; null explicitly CLEARS a
	 * previously stored override (the "Auto" chip); undefined leaves it alone.
	 */
	solverModel?: string | null
	/**
	 * Per-item execution workspace. A value ('worktree' | 'main') sets it; null
	 * explicitly CLEARS the override back to the config default; undefined leaves
	 * it alone. Mirrors `solverModel`'s null-for-default semantics.
	 */
	solverWorkspace?: SolverWorkspace | null
}

function selectionBody(selection?: SolveSelection): Record<string, unknown> | undefined {
	if (!selection) return undefined
	const body: Record<string, unknown> = {}
	if (selection.solverAgent) body.solverAgent = selection.solverAgent
	if (selection.solverModel !== undefined) body.solverModel = selection.solverModel
	if (selection.solverWorkspace !== undefined) body.solverWorkspace = selection.solverWorkspace
	return Object.keys(body).length > 0 ? body : undefined
}

export const api = {
	findItemBySource: (externalId: string) => fetchAPI<DashboardItem | null>(`/items/by-source/${externalId}`),

	createItemFromSource: (externalId: string) => postAPI<DashboardItem>('/items/source', { externalId }),

	itemAction: (id: string, action: DashboardActionId, selection?: SolveSelection) => {
		const body = action === 'approve' || action === 'start' || action === 'retry' ? selectionBody(selection) : undefined
		switch (action) {
			case 'approve':
			case 'reject':
			case 'start':
			case 'cancel':
			case 'retry':
			case 'reopen':
				return postAPI<DashboardItem>(`/items/${id}/${action}`, body)
		}
	},
	planItem: (id: string, selection?: SolveSelection) =>
		postAPI<PlanInfo>(`/items/${id}/plan`, selectionBody(selection) ?? {}),
	config: () =>
		fetchAPI<{
			projects: Array<{ slug: string }>
			solver?: { agent?: SolverAgent; model?: string; type?: 'default' | 'okena' }
			modelCatalog?: Record<SolverAgent, ModelOption[]>
		}>('/config'),
}
