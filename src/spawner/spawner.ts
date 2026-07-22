import type { HelmConfig, ProjectConfig } from '../config.js'
import type { TaskContext } from '../providers/provider.js'

export interface PlanningSessionParams {
	projectConfig: ProjectConfig
	branchName: string
	planDirName: string
	taskTitle: string
	taskContext: TaskContext
	solverConfig: HelmConfig['solver']
	/** If set, reuse this worktree instead of creating a new one. */
	existingWorktreePath?: string
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
