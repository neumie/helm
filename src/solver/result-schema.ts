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
export const solverResultSchema = z.object({
	summary: z.string(),
	filesChanged: z.array(z.string()).default([]),
	prTitle: z.string().optional(),
	prBody: z.string().optional(),
	prUrl: z.string().optional(),
})

export type SolverResult = z.infer<typeof solverResultSchema>
