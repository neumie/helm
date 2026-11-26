import { z } from 'zod'

/**
 * Single source of truth for the agent's structured result (`solver-result.json`).
 *
 * The TS type (`SolverResult`) is `z.infer` of this schema, so the type, the
 * read-time validation, and the JSON contract in the solver prompt all derive
 * from one place.
 *
 * Note: `z.object` strips unknown keys, so any field the agent may write (e.g.
 * `prUrl` after `/almanac:ship`) MUST be declared here or it is silently dropped.
 */
/**
 * An agent session ID as Claude Code, Pi and Codex print them (UUIDs). Kept
 * strict because it is shown in issue comments and shell commands.
 */
export const AGENT_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

export const solverResultSchema = z.object({
	summary: z.string(),
	filesChanged: z.array(z.string()).default([]),
	prTitle: z.string().optional(),
	prBody: z.string().optional(),
	prUrl: z.string().optional(),
	/**
	 * The agent's own session ID, so the run can be resumed. Helm assigns it for
	 * Claude Code and Pi itself; Codex reports it here. A bad value is dropped,
	 * never a reason to reject the whole result.
	 */
	sessionId: z.string().trim().regex(AGENT_SESSION_ID).optional().catch(undefined),
})

export type SolverResult = z.infer<typeof solverResultSchema>
