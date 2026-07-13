// Helm daemon wire types + the HelmBridge IPC surface.
//
// The contract types below are COPIED from web/src/api.ts (the web dashboard is
// scheduled for deletion — helm must not import from it). They mirror the
// server-owned contract in src/items/contract.ts; when the daemon contract
// changes, update this copy in the same slice.

export type DashboardTone = 'gray' | 'blue' | 'green' | 'amber' | 'red'
export type DashboardActionTone = 'primary' | 'muted' | 'danger'

export type AssessmentVerdict = 'clear' | 'needs_clarification' | 'human_decision' | 'not_code' | 'security'
export interface Assessment {
	intent: string
	verdict: AssessmentVerdict
	clarifyingQuestions: string[]
	securityNote: string | null
	assessedAt: string
}
export type ItemStatus = 'triage' | 'ready' | 'running' | 'review' | 'done' | 'failed' | 'cancelled'

export const ITEM_STATUSES: ItemStatus[] = ['triage', 'ready', 'running', 'review', 'done', 'failed', 'cancelled']

export type DashboardActionId = 'approve' | 'reject' | 'start' | 'cancel' | 'retry' | 'reopen'
export type RunOutcome = 'ok' | 'errored' | 'no_result' | 'cancelled'

/** The cheap on-demand agent passes runnable from the item detail. */
export type AiPass = 'display-name' | 'branch-name' | 'assess'

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

/** One plan-dir markdown file (prd.md / …) for the detail preview. */
export interface PlanArtifact {
	name: string
	content: string
}

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

export interface DashboardItem {
	id: string
	kind: 'solve' | 'ralph' | 'harden'
	status: ItemStatus
	projectSlug: string
	title: string
	displayName: string | null
	assessment: Assessment | null
	source: { provider: string; externalId: string; url?: string } | null
	/** True for ingested (captured-context) Items — e.g. an email. */
	captured: boolean
	/** Single-item routes only: the "create source task" action applies. */
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
	runOutcome: RunOutcome | null
	deployState: DeployState | null
	sourceTask?: SourceTask | null
	// Detail-only (omitted from list rows): the user's plan files for the preview.
	planArtifacts?: PlanArtifact[]
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
	startedAt: string | null
	completedAt: string | null
	plannedAt: string | null
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

/** One curated model choice for an agent CLI (src/solver/models.ts). */
export interface ModelOption {
	id: string
	label: string
}

export interface AppConfig {
	projectColors?: Record<string, string>
	projects?: Array<{ slug: string; repoPath?: string; baseBranch?: string; color?: string }>
	solver?: { type?: 'default' | 'okena'; agent?: 'claude' | 'codex'; workspace?: SolverWorkspace }
	spawner?: { name?: string }
	spawnerAdapters?: Array<{ name: string; available: boolean }>
	/** Curated per-agent model options for model pickers (server-owned). */
	modelCatalog?: Record<'claude' | 'codex', ModelOption[]>
	provider?: Record<string, unknown>
	polling?: Record<string, unknown>
	server?: Record<string, unknown>
	github?: Record<string, unknown>
}

export type ConfigFieldInput = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'color' | 'textarea'

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

/**
 * PUT /api/config response. `applied: true` means the save was written AND the
 * daemon is restarting itself (launchd KeepAlive respawn) to load it — expect
 * a ~2s unreachable blip. `applied: false` means the save was written but a
 * restart is still needed: `pendingRuns` carries the active-run count when
 * that's the reason (absent when the daemon isn't launchd-managed).
 */
export interface ConfigSaveResult {
	message: string
	applied: boolean
	pendingRuns?: number
}

/** POST /api/daemon/restart response (guard failures arrive as `{ error }`). */
export interface DaemonRestartResult {
	message: string
	applied: boolean
}

// ---------------------------------------------------------------------------
// HelmBridge wire shapes (helm-specific, not copied from web/).

/**
 * Daemon response envelope, passed through verbatim: the daemon answers
 * `{ data }` on success and `{ error }` on failure; a network-level failure
 * becomes `{ error: <message> }` in the bridge.
 */
export type HelmResult<T> = { data: T; error?: undefined } | { data?: undefined; error: string }

/**
 * Full state pushed over `daemon:snapshot`. `status`/`items`/`config` are null
 * until their first successful fetch (`config` is fetched once, then only on
 * demand after a config save).
 */
export interface HelmSnapshot {
	/** Last poll reached the daemon. The topbar connection dot reads this. */
	reachable: boolean
	status: DaemonStatus | null
	items: DashboardItem[] | null
	config: AppConfig | null
}

/** Where a solve run executes (`src/solver/workspace.ts`). */
export type SolverWorkspace = 'worktree' | 'main'

/**
 * Optional body for item action / plan routes. approve/start/retry/plan accept
 * a solver agent, a model override (`null` clears a stored per-item model), and
 * an execution-workspace override (`null` clears it back to the config default).
 */
export interface SolverAgentBody {
	solverAgent?: 'claude' | 'codex'
	solverModel?: string | null
	solverWorkspace?: SolverWorkspace | null
}

/**
 * Renderer-facing bridge API (preload implements over ipcRenderer). All
 * daemon HTTP happens in the main process — the file:// renderer never
 * fetches :7474 directly (CORS).
 */
export interface DaemonApi {
	/** Returns the bridge's current snapshot and starts `onSnapshot` pushes for this window. */
	subscribe(): Promise<HelmSnapshot>
	/** Full snapshot pushed whenever polled state actually changed. Returns unsubscribe. */
	onSnapshot(listener: (snapshot: HelmSnapshot) => void): () => void
	item(id: string): Promise<HelmResult<DashboardItem>>
	itemAction(id: string, action: DashboardActionId, body?: SolverAgentBody): Promise<HelmResult<DashboardItem>>
	plan(id: string, body?: SolverAgentBody): Promise<HelmResult<PlanInfo>>
	aiPass(id: string, pass: AiPass): Promise<HelmResult<DashboardItem>>
	createItem(body: CreateItemInput): Promise<HelmResult<DashboardItem | DashboardItem[]>>
	/** Promote a captured (ingested) Item into a real task in the source system. */
	sourceTask(id: string): Promise<HelmResult<DashboardItem>>
	setStatus(id: string, status: ItemStatus): Promise<HelmResult<DashboardItem>>
	config(): Promise<HelmResult<ConfigDocument>>
	updateConfig(body: Record<string, unknown>): Promise<HelmResult<ConfigSaveResult>>
	/** Deferred config apply: restart the (idle, launchd-managed) daemon. */
	restartDaemon(): Promise<HelmResult<DaemonRestartResult>>
	/** Pause when running, resume when paused (reads the latest snapshot). */
	pauseToggle(): Promise<HelmResult<{ paused: boolean }>>
	poll(): Promise<HelmResult<{ message: string }>>
}
