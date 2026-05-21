import type { ProjectConfig, VigilConfig } from '../config.js'
import type { TaskContext } from '../providers/provider.js'
import type { InvokeResult } from './invoker.js'

/**
 * Raw materials a solver needs to assemble its own prompts. The solver builds
 * the prompt itself (after the worktree exists, so the task-context builder can
 * read worktree-resident `docs/plans/<planDirName>/*.md` artifacts) rather than
 * receiving a pre-built string or a thunk.
 */
export interface SolveParams {
	projectConfig: ProjectConfig
	branchName: string
	/**
	 * Human-readable plan-dir name (`<YYYY-MM-DD>-<slug>`). The solver-result
	 * file the agent writes lives at `docs/plans/<planDirName>/solver-result.json`.
	 */
	planDirName: string
	/** Raw task context — the solver formats it into the prompt itself. */
	taskContext: TaskContext
	/** Needed by solvers that run a clarification chat (the chat session keys on it). */
	taskId: string
	taskTitle: string
	solverConfig: VigilConfig['solver']
	signal?: AbortSignal
	outputLogPath?: string
	/**
	 * Path of an already-existing worktree (created during a planning session).
	 * When set, solve() reuses it instead of creating a fresh one — preserving
	 * any planning artifacts the user wrote under `docs/plans/<planDirName>/`.
	 */
	existingWorktreePath?: string
}

export interface PlanningSessionParams {
	projectConfig: ProjectConfig
	branchName: string
	planDirName: string
	taskTitle: string
	/** Raw task context — the solver writes `context.md` + builds the prompt. */
	taskContext: TaskContext
	solverConfig: VigilConfig['solver']
	/** If set, reuse this worktree instead of creating a new one. */
	existingWorktreePath?: string
	signal?: AbortSignal
}

export interface PlanningSessionResult {
	worktreePath: string
	branchName: string
	/**
	 * Solver-specific human-readable hint to show the user. For okena: "Switch
	 * to Okena, planning session is running in terminal X". For default: "Open
	 * Claude Code in <path> — prompt staged at .planning-prompt.txt".
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
	 * Start an INTERACTIVE planning session: ensure the worktree, write the
	 * task context to `docs/plans/<planDirName>/context.md`, spawn the agent
	 * with the planning prompt, and return immediately — does NOT block or poll.
	 * The user interacts at their leisure; the autonomous solve is triggered
	 * separately. The same worktree is reused by `solve()` via
	 * `SolveParams.existingWorktreePath`.
	 */
	startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult>
	solve(params: SolveParams): Promise<SolveResult>
}
