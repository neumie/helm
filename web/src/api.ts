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

export interface TaskRecord {
	id: string
	clientcareId: string
	projectSlug: string
	title: string
	status: string
	solverSummary: string | null
	solverAgent: 'claude' | 'codex' | null
	filesChanged: string | null
	worktreePath: string | null
	branchName: string | null
	prUrl: string | null
	prDraft: number | null
	taskContext: string | null
	queuedAt: string
	startedAt: string | null
	completedAt: string | null
	errorMessage: string | null
	errorPhase: string | null
}

export interface EventEntry {
	id: number
	taskId: string | null
	eventType: string
	payload: string | null
	createdAt: string
}

export interface QueueStatus {
	paused: boolean
	pending: number
	active: number
	maxConcurrency: number
	activeTasks: Array<{ taskId: string; title: string; startedAt: string }>
}

export interface DaemonStatus {
	uptime: number
	queue: QueueStatus
	projects: string[]
	pollInterval: number
}

export interface AppConfig {
	taskBaseUrl?: string
	projectColors?: Record<string, string>
	projects?: Array<{ slug: string; repoPath?: string; baseBranch?: string; color?: string }>
	solver?: { type?: 'default' | 'okena'; agent?: 'claude' | 'codex' }
}

export const api = {
	config: () => fetchJSON<AppConfig>('/config'),
	status: () => fetchJSON<DaemonStatus>('/status'),
	tasks: (params?: string) => fetchJSON<TaskRecord[]>(`/tasks${params ? `?${params}` : ''}`),
	taskEvents: (id: string) => fetchJSON<EventEntry[]>(`/tasks/${id}/events`),
	start: (id: string) => postJSON<{ message: string }>(`/tasks/${id}/start`),
	retry: (id: string) => postJSON<{ message: string }>(`/tasks/${id}/retry`),
	cancel: (id: string) => postJSON<{ message: string }>(`/tasks/${id}/cancel`),
	deleteTask: (id: string) =>
		fetch(`${BASE}/tasks/${id}`, { method: 'DELETE' })
			.then(r => r.json())
			.then(r => r.data),
	setStatus: (id: string, status: string) =>
		fetch(`${BASE}/tasks/${id}/status`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status }),
		})
			.then(r => r.json())
			.then(r => r.data),
	prStatus: (id: string) =>
		fetchJSON<{ state: string | null; merged?: boolean; mergedAt?: string }>(`/tasks/${id}/pr-status`),
	output: (id: string, offset = 0) =>
		fetchJSON<{ content: string; offset: number; done: boolean }>(`/tasks/${id}/output?offset=${offset}`),
	triggerPoll: () => postJSON<{ message: string }>('/poll/trigger'),
	pauseQueue: () => postJSON<{ paused: boolean }>('/queue/pause'),
	resumeQueue: () => postJSON<{ paused: boolean }>('/queue/resume'),
	configFull: () => fetchJSON<Record<string, unknown>>('/config/full'),
	updateConfig: (config: Record<string, unknown>) => putJSON<{ message: string }>('/config', config),
}
