import { DEFAULT_SERVER_URL, getSync } from './storage'

export type SolverAgent = 'claude' | 'codex'

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

export interface DashboardItem {
	id: string
	kind: 'solve' | 'ralph' | 'harden'
	status: string
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
	resultSummary: string | null
	solveInputSnapshot: string | null
	errorMessage: string | null
	errorPhase: string | null
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

export const api = {
	findItemBySource: (externalId: string) => fetchAPI<DashboardItem | null>(`/items/by-source/${externalId}`),

	createItemFromSource: (externalId: string) => postAPI<DashboardItem>('/items/source', { externalId }),

	itemAction: (id: string, action: DashboardActionId, solverAgent?: SolverAgent) => {
		const body =
			solverAgent && (action === 'approve' || action === 'start' || action === 'retry') ? { solverAgent } : undefined
		switch (action) {
			case 'approve':
			case 'reject':
			case 'start':
			case 'cancel':
			case 'retry':
				return postAPI<DashboardItem>(`/items/${id}/${action}`, body)
		}
	},
	planItem: (id: string, solverAgent?: SolverAgent) => postAPI<PlanInfo>(`/items/${id}/plan`, { solverAgent }),
	config: () =>
		fetchAPI<{ projects: Array<{ slug: string }>; solver?: { agent?: SolverAgent; type?: 'default' | 'okena' } }>(
			'/config',
		),
}
