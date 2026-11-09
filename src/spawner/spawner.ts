import type { HelmConfig, ProjectConfig } from '../config.js'
import type { ItemOkenaTerminals } from '../items/okena-terminals.js'
import type { TaskContext } from '../providers/provider.js'
import type { SolverWorkspace } from '../solver/workspace.js'

export interface PlanningSessionParams {
	projectConfig: ProjectConfig
	/** Stable ownership identity for interactive terminal reuse; never use title alone. */
	itemId: string
	branchName: string
	planDirName: string
	taskTitle: string
	/** The Item's short display name (AI-derived, task language), if any; display-only. */
	taskDisplayName?: string | null
	/**
	 * This Item's terminal ownership in its own profile, captured before the first
	 * await. An Okena adapter reuses a planning terminal only through this binding
	 * (plus a live layout check), never by the terminal's name.
	 */
	okenaTerminals?: ItemOkenaTerminals
	/** Canonical, unlocalized task context; private provider evidence is separate. */
	canonicalContext: TaskContext
	/** Exact immutable provider bytes, written only to a gitignored Helm sidecar. */
	knowledgeContext?: string | null
	/** Required readiness boundary; returns localized/materialized adapter context. */
	onWorktreeReady(worktreePath: string): TaskContext
	solverConfig: HelmConfig['solver']
	/** If set, reuse this worktree instead of creating a new one. */
	existingWorktreePath?: string
	/** Captured planning mode; omission is isolated Worktree, never inferred from a path. */
	workspaceMode?: SolverWorkspace
	/** Explicit Re-plan: replace an existing interactive planning agent instead of reusing it. */
	replaceExistingSession?: boolean
	signal?: AbortSignal
}

export interface PlanningSessionResult {
	worktreePath: string
	branchName: string
	hint: string
}

export interface Spawner {
	readonly name: string
	startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult>
}
