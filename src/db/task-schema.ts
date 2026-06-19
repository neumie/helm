import { z } from 'zod'
import { solverAgentSchema } from '../solver/agent.js'

/**
 * Single source of truth for the `tasks` table shape.
 *
 * The TS type (`TaskRecord`), the camelCase↔snake_case column mapping, and the
 * read-time validation all derive from this one schema. Adding a column means
 * editing here (+ an append-only migration in `schema.ts`) — nothing else.
 *
 * Column names are NOT stored separately: snake_case is a pure mechanical
 * transform of the camelCase key (`camelToSnake`), so there's no hand-kept map
 * to drift out of sync.
 */

export const taskStatusSchema = z.enum([
	'queued',
	'processing',
	'review',
	'completed',
	'failed',
	'cancelled',
	'skipped',
])
export const errorPhaseSchema = z.enum(['poll', 'worktree', 'solve', 'action'])

/** Statuses a user may set manually (subset of TaskStatus — excludes queued/processing). */
export const manualStatusSchema = z.enum(['completed', 'review', 'failed', 'cancelled', 'skipped'])

export const taskRecordSchema = z.object({
	id: z.string(),
	clientcareId: z.string(),
	projectSlug: z.string(),
	title: z.string(),
	status: taskStatusSchema,
	taskContext: z.string().nullable(),
	solverSummary: z.string().nullable(),
	filesChanged: z.string().nullable(),
	solverRawResult: z.string().nullable(),
	solverAgent: solverAgentSchema.nullable(),
	worktreePath: z.string().nullable(),
	branchName: z.string().nullable(),
	planDirName: z.string().nullable(),
	prUrl: z.string().nullable(),
	prDraft: z.number().nullable(),
	commentId: z.string().nullable(),
	queuedAt: z.string(),
	startedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	errorMessage: z.string().nullable(),
	errorPhase: errorPhaseSchema.nullable(),
	claudeExitCode: z.number().nullable(),
	claudeRawOutput: z.string().nullable(),
})

export type TaskRecord = z.infer<typeof taskRecordSchema>
export type TaskStatus = z.infer<typeof taskStatusSchema>
export type ErrorPhase = z.infer<typeof errorPhaseSchema>

/** camelCase → snake_case. Pure function; the only "mapping" the DB needs. */
export function camelToSnake(s: string): string {
	return s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
}

/** camelCase task field → snake_case column, derived from the schema. */
export const TASK_COLUMNS = Object.fromEntries(
	Object.keys(taskRecordSchema.shape).map(key => [key, camelToSnake(key)]),
) as Record<keyof TaskRecord, string>

/**
 * Map a raw `SELECT *` row (snake_case columns) to a validated `TaskRecord`.
 * Throws if a row violates the schema — that signals real DB corruption rather
 * than silently coercing, which is what we want.
 */
export function rowToTaskRecord(row: Record<string, unknown>): TaskRecord {
	const raw: Record<string, unknown> = {}
	for (const key of Object.keys(taskRecordSchema.shape) as Array<keyof TaskRecord>) {
		raw[key] = row[TASK_COLUMNS[key]] ?? null
	}
	return taskRecordSchema.parse(raw)
}
