const BASE = '/api'

async function fetchJSON<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`)
	if (!res.ok) throw new Error(`API error: ${res.status}`)
	const json = await res.json()
	return json.data
}

async function postJSON<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`, { method: 'POST' })
	if (!res.ok) throw new Error(`API error: ${res.status}`)
	const json = await res.json()
	return json.data
}

async function postJSONBody<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const json = await res.json()
	if (!res.ok) throw new Error(json.error ?? `API error: ${res.status}`)
	return json.data
}

async function putJSON<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const json = await res.json()
	if (!res.ok) throw new Error(json.error ?? `API error: ${res.status}`)
	return json.data
}

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

export type CreateItemInput =
	| {
			kind: 'solve'
			title: string
			projectSlug: string
			prompt: string
			baseRef?: string
			baseItemId?: string
			spawner?: string
			parallelism?: number
			intent?: 'queue' | 'plan'
	  }
	| {
			kind: 'ralph'
			title: string
			projectSlug: string
			prdPath: string
			baseRef?: string
			baseItemId?: string
			spawner?: string
			mode?: 'once' | 'afk'
			provider?: 'claude' | 'codex'
			model?: string
			effort?: string
			iterations?: number
			noOversee?: boolean
			parallelism?: number
			intent?: 'queue' | 'plan'
	  }
	| {
			kind: 'harden'
			title: string
			projectSlug: string
			target: string
			baseRef?: string
			baseItemId?: string
			spawner?: string
			rounds?: number
			parallelism?: number
			intent?: 'queue' | 'plan'
	  }

export interface PlanInfo {
	worktreePath: string
	branchName: string
	planDirName: string
	readmePath: string
	spawner: string
	solverAgent: 'claude' | 'codex'
	hint: string
}

export interface QueueStatus {
	paused: boolean
	pending: number
	active: number
	maxConcurrency: number
	activeTasks: Array<{ taskId: string; title: string; startedAt: string }>
	lanes?: {
		solve: { pending: number; active: number; maxConcurrency: number }
		loop: { pending: number; active: number; maxConcurrency: number }
	}
}

export interface DaemonStatus {
	uptime: number
	queue: QueueStatus
	projects: string[]
	pollInterval: number
}

export interface AppConfig {
	projectColors?: Record<string, string>
	projects?: Array<{ slug: string; repoPath?: string; baseBranch?: string; color?: string }>
	solver?: { type?: 'default' | 'okena'; agent?: 'claude' | 'codex' }
	spawner?: { name?: string }
	spawnerAdapters?: Array<{ name: string; available: boolean }>
	provider?: Record<string, unknown>
	polling?: Record<string, unknown>
	server?: Record<string, unknown>
	github?: Record<string, unknown>
}

export type ConfigFieldInput = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'color'

export interface ConfigFieldOption {
	value: string
	label: string
}

export interface ConfigEditField {
	path: string[]
	label: string
	input: ConfigFieldInput
	required?: boolean
	secret?: boolean
	placeholder?: string
	options?: ConfigFieldOption[]
}

export interface ConfigEditFieldControl extends ConfigEditField {
	type: 'field'
}

export interface ConfigEditListControl {
	type: 'list'
	path: string[]
	addLabel: string
	emptyLabel: string
	itemTitlePath: string[]
	defaultItem: Record<string, unknown>
	fields: ConfigEditField[]
}

export type ConfigEditControl = ConfigEditFieldControl | ConfigEditListControl

export interface ConfigEditSection {
	id: string
	title: string
	description?: string
	controls: ConfigEditControl[]
}

export interface ConfigDocument {
	config: Record<string, unknown>
	dashboard: AppConfig
	edit: { sections: ConfigEditSection[] }
	secretRedaction: string
}

export const api = {
	config: () => fetchJSON<AppConfig>('/config'),
	status: () => fetchJSON<DaemonStatus>('/status'),
	items: (params?: string) => fetchJSON<DashboardItem[]>(`/items${params ? `?${params}` : ''}`),
	createItem: (input: CreateItemInput) => postJSONBody<DashboardItem | DashboardItem[]>('/items', input),
	planItem: (id: string) => postJSONBody<PlanInfo>(`/items/${id}/plan`, {}),
	itemAction: (id: string, action: DashboardActionId) => {
		switch (action) {
			case 'approve':
			case 'reject':
			case 'start':
			case 'cancel':
			case 'retry':
				return postJSON<DashboardItem>(`/items/${id}/${action}`)
		}
	},
	triggerPoll: () => postJSON<{ message: string }>('/poll/trigger'),
	pauseQueue: () => postJSON<{ paused: boolean }>('/queue/pause'),
	resumeQueue: () => postJSON<{ paused: boolean }>('/queue/resume'),
	configFull: () => fetchJSON<ConfigDocument>('/config/full'),
	updateConfig: (config: Record<string, unknown>) => putJSON<{ message: string }>('/config', config),
}
