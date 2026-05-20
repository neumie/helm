export interface TaskRecord {
	id: string
	clientcareId: string
	projectSlug: string
	title: string
	status: string
	tier: string | null
	solverSummary: string | null
	solverConfidence: number | null
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
	externalId: string
	readmePath: string
	solverType: 'default' | 'okena'
}

export const api = {
	findTask: (clientcareId: string) =>
		fetchAPI<TaskRecord | null>(`/tasks/by-clientcare-id/${clientcareId}`),

	createTask: (clientcareId: string) =>
		postAPI<TaskRecord>('/tasks', { clientcareId }),

	start: (id: string) => postAPI<{ message: string }>(`/tasks/${id}/start`),
	retry: (id: string) => postAPI<{ message: string }>(`/tasks/${id}/retry`),
	cancel: (id: string) => postAPI<{ message: string }>(`/tasks/${id}/cancel`),
	plan: (id: string) => postAPI<PlanInfo>(`/tasks/${id}/plan`),
	setStatus: (id: string, status: string) =>
		postAPI<{ message: string }>(`/tasks/${id}/status`, { status }),
	deleteTask: (id: string) => deleteAPI<{ message: string }>(`/tasks/${id}`),
	resumeQueue: () => postAPI<{ paused: boolean }>('/queue/resume'),
	config: () => fetchAPI<{ projects: Array<{ slug: string }> }>('/config'),
}
