import type { HelmConfig, ProjectConfig } from '../config.js'
import type { ItemOkenaTerminals } from '../items/okena-terminals.js'
import type { SolverEffort } from '../items/schema.js'
import type { TaskContext } from '../providers/provider.js'
import type { ClaudeEvent } from '../types.js'
import type { SolverWorkspace } from './workspace.js'

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
	 * Human-readable plan-dir name (`<YYYY-MM-DD>-<slug>`): where planning
	 * artifacts the user wrote live (`docs/plans/<planDirName>/`). Runs no longer
	 * write their result there.
	 */
	planDirName: string
	/**
	 * Absolute path in Helm's profile state (`runResultPath`) where the agent
	 * writes its result JSON. The solver clears it before launching the agent;
	 * the Okena solver waits for it; the worker reads it.
	 */
	resultPath: string
	/** GitHub issue tracking the task, named in the prompt so the PR closes it. */
	issue?: { number: number; url: string; reference: string } | null
	/** Canonical, unlocalized context for non-prompt diagnostics only. */
	canonicalContext: TaskContext
	/**
	 * Called exactly once after workspace readiness and before any prompt or agent
	 * consumption. Returns the adapter-ready context (localized captured
	 * attachments only after their bytes have been materialized).
	 */
	onWorktreeReady(worktreePath: string): TaskContext
	/** Stable Item/Task id used for logs, worktree naming, and persisted run state. */
	taskId: string
	taskTitle: string
	/** The Item's short display name (AI-derived, task language), if any; display-only. */
	taskDisplayName?: string | null
	/** This Item's terminal ownership in its own profile; Okena records its solve terminal here by id. */
	okenaTerminals?: ItemOkenaTerminals
	solverConfig: HelmConfig['solver']
	/** Emit candidate-sidecar instructions only for an admitted knowledge binding. */
	knowledgeCandidatesEnabled?: boolean
	/** Per-Item reasoning effort applied by both direct agent and loop execution. */
	solverEffort?: SolverEffort
	/**
	 * Execution workspace for this run (effective per-item value; defaults to
	 * 'worktree'). In 'main' mode the solver runs the agent DIRECTLY in the
	 * project's canonical checkout: no worktree is created, `branchName` is a
	 * label only (the agent branches itself), and the solver must never mutate
	 * the checkout's state (no checkout/reset/clean) on Helm's behalf.
	 */
	workspaceMode?: SolverWorkspace
	signal?: AbortSignal
	outputLogPath?: string
	/**
	 * Path of an already-existing worktree (created during a planning session).
	 * When set, solve() reuses it instead of creating a fresh one — preserving
	 * any planning artifacts the user wrote under `docs/plans/<planDirName>/`.
	 */
	existingWorktreePath?: string
	/**
	 * Called immediately after the solver renders the exact prompt and before it
	 * invokes the agent. Workers use this to persist the immutable solve input.
	 */
	onPromptSnapshot?: (prompt: string) => void
}

/**
 * The solve's observable outcome, produced by each Solver adapter — keeps the
 * default solver's stdout shape out of the shared interface. `events` is the
 * dashboard timeline (DefaultSolver asks the configured AgentAdapter to parse
 * CLI output; OkenaSolver has none today and returns `[]`). `rawOutput` is a
 * default-solver artifact (captured stdout) and is absent for solvers that don't
 * capture it.
 */
export interface SolveOutcome {
	events: ClaudeEvent[]
	exitCode: number | null
	rawOutput?: string
}

export interface SolveResult {
	worktreePath: string
	branchName: string
	outcome: SolveOutcome
}

export interface Solver {
	solve(params: SolveParams): Promise<SolveResult>
}
