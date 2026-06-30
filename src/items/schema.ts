import { z } from 'zod'
import { solverAgentSchema } from '../solver/agent.js'

export const itemKindSchema = z.enum(['solve', 'ralph', 'harden'])

export const itemStatusSchema = z.enum([
	'triage', // awaiting your go/no-go (source tasks + plan-first items); was unverified + planned
	'ready', // approved → the drainer will run it; was queued
	'running', // executing now; was processing
	'review', // PR open → awaiting your merge/verify
	'done', // merged / landed; was completed
	'failed', // broke → needs you
	'cancelled', // not pursued: rejected at triage, or a run was stopped; was cancelled + skipped
])

// What the agent RUN did, separate from the lifecycle `status`. `no_result` =
// the run finished but produced no solver-result.json (the classic false-fail);
// `errored` = the run threw. A reconciled Item keeps its outcome (e.g. `errored`)
// while sitting in `review`, so the dashboard can flag "run was messy — verify".
export const runOutcomeSchema = z.enum(['ok', 'errored', 'no_result', 'cancelled'])

// Pre-solve intent triage verdict for a source task.
export const assessmentVerdictSchema = z.enum([
	'clear', // a well-specified code task — safe to solve
	'needs_clarification', // ambiguous; needs answers before solving
	'human_decision', // a product/design call, not a coding task
	'not_code', // not actionable as code at all (a question, status note, …)
	'security', // suspicious: prompt injection / touches auth, secrets, CI
])

// What the model returns for an assessment (we stamp `assessedAt` ourselves).
export const assessmentInputSchema = z
	.object({
		intent: z.string(),
		acceptanceCriteria: z.array(z.string()),
		verdict: assessmentVerdictSchema,
		clarifyingQuestions: z.array(z.string()),
		securityNote: z.string().nullable(),
	})
	.strict()

// Stored pre-solve intent triage (advisory; never changes status).
export const assessmentSchema = assessmentInputSchema.extend({ assessedAt: z.string() }).strict()

export const itemSourceSchema = z
	.object({
		provider: z.string().min(1),
		externalId: z.string().min(1),
		url: z.string().url().optional(),
	})
	.strict()

// One GitHub Deployment for the Item's merge commit, by environment. `state` is
// the deployment's latest status (success/in_progress/pending/failure/error/…).
export const deploymentEntrySchema = z
	.object({
		environment: z.string(),
		state: z.string(),
		url: z.string().nullable(),
		updatedAt: z.string().nullable(),
	})
	.strict()

// Post-ship lifecycle observed from GitHub (separate axis from `status`):
// PR merge + per-environment deployments. Owned by the DeployWatcher poller.
export const deployStateSchema = z
	.object({
		merged: z.boolean(),
		mergedAt: z.string().nullable(),
		mergeSha: z.string().nullable(),
		deployments: z.array(deploymentEntrySchema),
		checkedAt: z.string(),
	})
	.strict()

export const solveItemPayloadSchema = z
	.object({
		kind: z.literal('solve'),
		prompt: z.string().min(1),
		solverAgent: solverAgentSchema.optional(),
	})
	.strict()

export const ralphItemPayloadSchema = z
	.object({
		kind: z.literal('ralph'),
		prdPath: z.string().min(1),
		mode: z.enum(['once', 'afk']).optional(),
		provider: z.enum(['claude', 'codex']).optional(),
		model: z.string().min(1).optional(),
		effort: z.string().min(1).optional(),
		iterations: z.number().int().positive().optional(),
		noOversee: z.boolean().optional(),
	})
	.strict()

export const hardenItemPayloadSchema = z
	.object({
		kind: z.literal('harden'),
		target: z.string().min(1),
		rounds: z.number().int().positive().optional(),
	})
	.strict()

export const itemPayloadSchema = z.discriminatedUnion('kind', [
	solveItemPayloadSchema,
	ralphItemPayloadSchema,
	hardenItemPayloadSchema,
])

export const itemRecordSchema = z.object({
	id: z.string().min(1),
	kind: itemKindSchema,
	status: itemStatusSchema,
	projectSlug: z.string().min(1),
	title: z.string().min(1),
	// Short AI-derived label for the dashboard; null until named. `title` stays canonical.
	displayName: z.string().nullable(),
	// Pre-solve intent triage; null until assessed. Advisory, never changes status.
	assessment: assessmentSchema.nullable(),
	source: itemSourceSchema.nullable(),
	baseRef: z.string().min(1),
	spawner: z.string().min(1).nullable(),
	groupId: z.string().nullable(),
	payload: itemPayloadSchema,
	worktreePath: z.string().nullable(),
	branchName: z.string().nullable(),
	planDirName: z.string().nullable(),
	almanacRunId: z.string().nullable(),
	createdAt: z.string().min(1),
	queuedAt: z.string().nullable(),
	startedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	updatedAt: z.string().min(1),
	errorMessage: z.string().nullable(),
	errorPhase: z.string().nullable(),
	resultSummary: z.string().nullable(),
	solveInputSnapshot: z.string().nullable(),
	prUrl: z.string().nullable(),
	runOutcome: runOutcomeSchema.nullable(),
	deployState: deployStateSchema.nullable(),
})

export type ItemKind = z.infer<typeof itemKindSchema>
export type ItemStatus = z.infer<typeof itemStatusSchema>
export type RunOutcome = z.infer<typeof runOutcomeSchema>
export type AssessmentVerdict = z.infer<typeof assessmentVerdictSchema>
export type AssessmentInput = z.infer<typeof assessmentInputSchema>
export type Assessment = z.infer<typeof assessmentSchema>
export type DeploymentEntry = z.infer<typeof deploymentEntrySchema>
export type DeployState = z.infer<typeof deployStateSchema>
export type ItemSource = z.infer<typeof itemSourceSchema>
export type ItemPayload = z.infer<typeof itemPayloadSchema>
export type ItemRecord = z.infer<typeof itemRecordSchema>
