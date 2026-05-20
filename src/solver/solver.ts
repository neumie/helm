import type { ProjectConfig, VigilConfig } from '../config.js'
import type { InvokeResult } from './invoker.js'

export interface SolveParams {
	projectConfig: ProjectConfig
	branchName: string
	/**
	 * Human-readable plan-dir name (`<YYYY-MM-DD>-<slug>`). Used by solvers to
	 * compute the path of the solver-result file the agent writes
	 * (`docs/plans/<planDirName>/solver-result.json`) and shown in the prompt.
	 */
	planDirName: string
	/**
	 * Builds the final solver prompt. Called by the Solver impl AFTER the
	 * worktree exists so transformers can read worktree-resident files
	 * (e.g. `docs/plans/<externalId>/*.md`). Always invoke with the path
	 * of the worktree the agent will run in.
	 */
	buildPrompt: (worktreePath: string) => string
	/**
	 * Builds the chat-session prompt. Same timing rules as `buildPrompt`.
	 * Undefined when chat is disabled.
	 */
	buildChatPrompt?: (worktreePath: string) => string
	taskTitle: string
	solverConfig: VigilConfig['solver']
	signal?: AbortSignal
	outputLogPath?: string
	/**
	 * Path of an already-existing worktree (e.g. created during a planning
	 * session via `solver.prepareWorktree(...)`). When set, solve() reuses
	 * it instead of creating a fresh one — preserving any planning artifacts
	 * the user wrote there (`docs/plans/<externalId>/*.md`, scaffolds, etc.).
	 */
	existingWorktreePath?: string
}

export interface PrepareWorktreeParams {
	projectConfig: ProjectConfig
	branchName: string
	taskTitle: string
	signal?: AbortSignal
}

export interface PrepareWorktreeResult {
	worktreePath: string
	branchName: string
}

export interface PlanningSessionParams {
	worktreePath: string
	planDirName: string
	taskTitle: string
	solverConfig: VigilConfig['solver']
	/** Built lazily because the planning prompt is worktree-aware. */
	buildPrompt: (worktreePath: string) => string
}

export interface PlanningSessionResult {
	/**
	 * Solver-specific human-readable hint to show the user. For okena: "Switch
	 * to Okena, planning session is running in terminal X". For default: "Open
	 * Claude Code in <path> — prompt staged at .vigil-planning-prompt.txt".
	 */
	hint: string
}

export interface SolveResult {
	worktreePath: string
	branchName: string
	invokeResult: InvokeResult
}

export interface Solver {
	/**
	 * Create (or reuse, where supported) a worktree without invoking the agent.
	 * Used by the plan endpoint so the user can drop into the worktree, run
	 * `/grill-me`/`/grill-plan`, write `docs/plans/<externalId>/` artifacts,
	 * and commit them BEFORE the autonomous solve. The same worktree is then
	 * reused by `solve()` via `SolveParams.existingWorktreePath`.
	 */
	prepareWorktree(params: PrepareWorktreeParams): Promise<PrepareWorktreeResult>
	/**
	 * Start an INTERACTIVE planning session in the worktree. Spawns the agent
	 * with the planning prompt and returns immediately — does NOT block, does
	 * NOT poll for completion. The user interacts at their leisure; the
	 * autonomous solve is triggered separately (via the dashboard / extension).
	 */
	startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult>
	solve(params: SolveParams): Promise<SolveResult>
}
