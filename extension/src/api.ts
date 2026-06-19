export type SolverAgent = 'claude' | 'codex'

export interface TaskRecord {
	id: string
	clientcareId: string
	projectSlug: string
	title: string
	status: string
	solverSummary: string | null
	solverAgent: SolverAgent | null
	prUrl: string | null
	prDraft: number | null
	branchName: string | null
	errorMessage: string | null
	errorPhase: string | null
	queuedAt: string
	startedAt: string | null
	completedAt: string | null
}

export async function getServerUrl(): Promise<string> {
	return new Promise(resolve => {
		chrome.storage.sync.get({ serverUrl: 'http://localhost:7474' }, items => {
			resolve(items.serverUrl)
		})
	})
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

async function deleteAPI<T>(path: string): Promise<T> {
	const base = await getServerUrl()
	const res = await fetch(`${base}/api${path}`, { method: 'DELETE' })
	const json = await res.json()
	if (!res.ok) throw new Error(json.error ?? `API error: ${res.status}`)
	return json.data
}

export interface PlanInfo {
	worktreePath: string
	branchName: string
	planDirName: string
	readmePath: string
	solverType: 'default' | 'okena'
	solverAgent: SolverAgent
	hint: string
}

export const api = {
	findTask: (clientcareId: string) => fetchAPI<TaskRecord | null>(`/tasks/by-clientcare-id/${clientcareId}`),

	createTask: (clientcareId: string, solverAgent?: SolverAgent) =>
		postAPI<TaskRecord>('/tasks', { clientcareId, solverAgent }),

	start: (id: string, solverAgent?: SolverAgent) => postAPI<{ message: string }>(`/tasks/${id}/start`, { solverAgent }),
	retry: (id: string, solverAgent?: SolverAgent) => postAPI<{ message: string }>(`/tasks/${id}/retry`, { solverAgent }),
	cancel: (id: string) => postAPI<{ message: string }>(`/tasks/${id}/cancel`),
	plan: (id: string, solverAgent?: SolverAgent) => postAPI<PlanInfo>(`/tasks/${id}/plan`, { solverAgent }),
	setStatus: (id: string, status: string) => postAPI<{ message: string }>(`/tasks/${id}/status`, { status }),
	deleteTask: (id: string) => deleteAPI<{ message: string }>(`/tasks/${id}`),
	config: () =>
		fetchAPI<{ projects: Array<{ slug: string }>; solver?: { agent?: SolverAgent; type?: 'default' | 'okena' } }>(
			'/config',
		),
}
