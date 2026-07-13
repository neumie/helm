import { z } from 'zod'

/**
 * Where a solve run executes:
 * - `worktree` (default) — an isolated git worktree per run; safe for concurrent
 *   solves and never touches the user's checkout.
 * - `main` — directly in the project's canonical checkout
 *   (`projectConfig.repoPath`). No worktree is created, no branch is pre-created
 *   (the agent branches itself), and the user's working state is sacred: nothing
 *   may `checkout --detach`, reset, or otherwise mutate the checkout on Helm's
 *   behalf.
 */
export const solverWorkspaceSchema = z.enum(['worktree', 'main'])

export type SolverWorkspace = z.infer<typeof solverWorkspaceSchema>
