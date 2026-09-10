import { DEFAULT_SERVER_URL, getSync } from './storage'

export type SolverAgent = 'claude' | 'codex' | 'pi'
export type SolverEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
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
	profileId?: string
	kind: 'solve' | 'loop'
	executionMode: 'solve' | 'loop'
	status: string
	workMode: 'agent' | 'manual' | null
	projectSlug: string | null
	title: string
	source: { provider: string; externalId: string; url?: string } | null
	canAssignProject: boolean
	baseRef: string | null
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
	solverAgent?: SolverAgent | null
	solverModel?: string | null
	solverWorkspace?: SolverWorkspace | null
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

export interface PlainRunContextDocument {
	version: 2
	text: string
	images: Array<{ type: 'image'; url: string; name?: string; contentType?: string }>
	updatedAt: string
}

export interface RunContextResponse {
	item: { id: string; title: string; projectSlug: string | null; status: string }
	source: SourceTask | null
	document:
		| PlainRunContextDocument
		| { version: 1; blocks: Array<Record<string, unknown>>; markdown: string; updatedAt: string }
		| null
	revision: number
}

export interface SolveSelection {
	solverAgent?: SolverAgent
	/**
	 * Per-item model override. A model id sets it; null explicitly CLEARS a
	 * previously stored override (the "Auto" chip); undefined leaves it alone.
	 */
	solverModel?: string | null
	/** Per-item Almanac loop effort; null clears it to the agent default. */
	solverEffort?: SolverEffort | null
	/**
	 * Per-item execution workspace. A value ('worktree' | 'main') sets it; null
	 * explicitly CLEARS the override back to the config default; undefined leaves
	 * it alone. Mirrors `solverModel`'s null-for-default semantics.
	 */
	solverWorkspace?: SolverWorkspace | null
	expectedRunContextRevision?: number
}

function selectionBody(selection?: SolveSelection): Record<string, unknown> | undefined {
	if (!selection) return undefined
	const body: Record<string, unknown> = {}
	if (selection.solverAgent) body.solverAgent = selection.solverAgent
	if (selection.solverModel !== undefined) body.solverModel = selection.solverModel
	if (selection.solverEffort !== undefined) body.solverEffort = selection.solverEffort
	if (selection.solverWorkspace !== undefined) body.solverWorkspace = selection.solverWorkspace
	if (selection.expectedRunContextRevision !== undefined)
		body.expectedRunContextRevision = selection.expectedRunContextRevision
	return Object.keys(body).length > 0 ? body : undefined
}

/** A widget operation captures one canonical origin for its entire lifetime. */
export function createApi(origin?: string) {
	async function request<T>(path: string, method = 'GET', body?: unknown, formats = false): Promise<T> {
		const base = origin ?? new URL(await getServerUrl()).origin
		const response = await fetch(`${base}/api${path}`, {
			method,
			headers: {
				...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
				...(formats ? { 'X-Helm-Run-Context-Formats': '1,2' } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(method === 'GET' ? 10_000 : 120_000),
		})
		const json = await response.json()
		if (!response.ok) throw new Error(json.error ?? `API error: ${response.status}`)
		return json.data
	}
	return {
		status: () =>
			request<{ protocolVersion?: number; profile?: { id: string }; profileGeneration?: number }>('/status'),
		findItemBySource: (externalId: string) =>
			request<DashboardItem | null>(`/items/by-source/${encodeURIComponent(externalId)}`),
		createItemFromSource: (externalId: string) => request<DashboardItem>('/items/source', 'POST', { externalId }),
		itemAction: (id: string, action: DashboardActionId, selection?: SolveSelection) =>
			request<DashboardItem>(
				`/items/${encodeURIComponent(id)}/${action}`,
				'POST',
				action === 'approve' || action === 'start' || action === 'retry' ? selectionBody(selection) : undefined,
			),
		planItem: (id: string, selection?: SolveSelection) =>
			request<PlanInfo>(`/items/${encodeURIComponent(id)}/plan`, 'POST', selectionBody(selection) ?? {}),
		runContext: (id: string) =>
			request<RunContextResponse>(`/items/${encodeURIComponent(id)}/run-context`, 'GET', undefined, true),
		savePlainRunContext: (id: string, revision: number, text: string) =>
			request<{ document: PlainRunContextDocument; revision: number }>(
				`/items/${encodeURIComponent(id)}/run-context/plain`,
				'PUT',
				{ revision, text },
				true,
			),
		config: () =>
			request<{
				projects: Array<{ slug: string }>
				solver?: { agent?: SolverAgent; model?: string; workspace?: SolverWorkspace; type?: 'default' | 'okena' }
				modelCatalog?: Record<SolverAgent, ModelOption[]>
			}>('/config'),
	}
}
export const api = createApi()
