import { z } from 'zod'
import { scopedCapabilityDigestSchema } from '../auth/scoped-capability.js'

const utcIsoSchema = z
	.string()
	.datetime({ offset: true })
	.refine(value => value.endsWith('Z'), 'must be a UTC ISO timestamp')
const boundedText = (max: number) =>
	z
		.string()
		.min(1)
		.refine(value => Buffer.byteLength(value, 'utf8') <= max, `must be at most ${max} UTF-8 bytes`)

export const scheduledTargetSchema = z.discriminatedUnion('kind', [
	z
		.object({ kind: z.literal('project'), projectSlug: boundedText(120), baseRef: boundedText(300).optional() })
		.strict(),
	z.object({ kind: z.literal('system'), riskAcknowledgement: z.literal('broad-host-access') }).strict(),
])
export const scheduledAgentSchema = z.enum(['claude', 'codex'])
export const scheduledEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export const cadenceKindSchema = z.enum(['hourly', 'daily', 'weekly', 'cron'])
export const fiveFieldCronSchema = z
	.string()
	.min(1)
	.max(100)
	.refine(value => value.trim().split(/\s+/).length === 5, 'cron must contain exactly five fields')
	.refine(value => !value.includes('@'), 'cron aliases are not supported')

/** The sensitive persisted definition; never return this directly to a client. */
export const scheduleDefinitionSchema = z
	.object({
		prompt: boundedText(65_536),
		target: scheduledTargetSchema,
		agent: scheduledAgentSchema,
		model: boundedText(100).optional(),
		effort: scheduledEffortSchema.optional(),
		maximumRuntimeMinutes: z.number().int().min(5).max(360).default(120),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.target.kind === 'system' && value.maximumRuntimeMinutes > 120) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['maximumRuntimeMinutes'],
				message: 'system runs are limited to 120 minutes',
			})
		}
	})

export const scheduleStateSchema = z.enum(['enabled', 'disabled', 'archived'])
export const scheduledTerminalIntentSchema = z.enum(['quiet', 'cancel', 'timeout'])
export type ScheduledTerminalIntent = z.infer<typeof scheduledTerminalIntentSchema>

export const scheduledRunStateSchema = z.enum([
	'admitted',
	'preparing',
	'launching',
	'running',
	'reported_quiet',
	'closing',
	'closed_quiet',
	'needs_attention',
	'cancel_requested',
	'timeout_requested',
	'cancelled',
	'timed_out',
	'failed',
	'interrupted',
	'quarantined',
	'session_lost',
	'skipped_overlap',
	'skipped_misfire',
	'skipped_profile_archived',
	'skipped_project_disabled',
	'skipped_system_targets_disabled',
	'skipped_capacity',
])

/** Operator input; recurrence persistence is command-owned, including nextRunAt. */
export const scheduleCreateSchema = z
	.object({
		id: z.string().min(1).optional(),
		name: boundedText(120),
		enabled: z.boolean().default(true),
		definition: scheduleDefinitionSchema,
		cron: fiveFieldCronSchema,
		cadenceKind: cadenceKindSchema,
		timezone: boundedText(120),
	})
	.strict()

/** Internal persistence input constructed only after recurrence normalization. */
export const schedulePersistenceSchema = scheduleCreateSchema.extend({ nextRunAt: utcIsoSchema.nullable() }).strict()

export const scheduleUpdateSchema = scheduleCreateSchema
	.omit({ id: true })
	.extend({ revision: z.number().int().nonnegative() })
	.strict()

export const scheduleRecordSchema = z.object({
	id: z.string().min(1),
	profileId: z.string().min(1),
	revision: z.number().int().nonnegative(),
	name: boundedText(120),
	enabled: z.boolean(),
	targetKind: z.enum(['project', 'system']),
	projectSlug: z.string().nullable(),
	definition: scheduleDefinitionSchema,
	cron: fiveFieldCronSchema,
	cadenceKind: cadenceKindSchema,
	timezone: boundedText(120),
	overlapPolicy: z.literal('skip'),
	nextRunAt: utcIsoSchema.nullable(),
	createdAt: utcIsoSchema,
	updatedAt: utcIsoSchema,
	disabledReason: z.string().nullable(),
	archivedAt: utcIsoSchema.nullable(),
	systemRiskAcknowledgedAt: utcIsoSchema.nullable(),
})

export const createScheduledRunSchema = z
	.object({
		id: z.string().min(1).optional(),
		scheduleId: z.string().min(1),
		scheduleRevision: z.number().int().nonnegative(),
		scheduledFor: utcIsoSchema,
		localCivilSlot: boundedText(80),
		utcOffsetMinutes: z.number().int().min(-840).max(840),
		slotKey: boundedText(160),
		definitionSnapshot: scheduleDefinitionSchema,
		state: scheduledRunStateSchema.default('admitted'),
		sessionId: boundedText(80),
		socketDescriptor: z.string().max(500).nullable().default(null),
		reportTokenHash: scopedCapabilityDigestSchema.nullable().default(null),
		reportTokenVersion: z.number().int().nonnegative().default(1),
		processFingerprint: z.string().max(1000).nullable().default(null),
		cwd: z.string().max(2000).nullable().default(null),
		worktreePath: z.string().max(2000).nullable().default(null),
		branchName: z.string().max(500).nullable().default(null),
		runDir: z.string().max(2000).nullable().default(null),
		missedCount: z.number().int().nonnegative().default(0),
		missedMany: z.boolean().default(false),
		/** Only command-owned occurrence claims may create an immediately terminal skip. */
		closedAt: utcIsoSchema.optional(),
	})
	.strict()

export const SCHEDULED_REPORT_SUMMARY_MAX_BYTES = 1000
/** A claimed native notification is retried after this bounded crash-recovery lease. */
export const ATTENTION_NOTIFICATION_CLAIM_LEASE_MS = 2 * 60 * 1000
export const scheduledRunReportSchema = z
	.object({ kind: z.enum(['quiet', 'needs_attention']), summary: boundedText(SCHEDULED_REPORT_SUMMARY_MAX_BYTES) })
	.strict()
export const scheduledRunDiagnosticSchema = boundedText(262_144).nullable()

export const attentionAdoptionIdentitySchema = z
	.object({
		adoptionId: z.string().uuid(),
		adopter: z.string().uuid(),
	})
	.strict()
export const attentionAdoptionRollbackReasonSchema = z.enum(['client', 'expired', 'restart', 'attestation_failed'])
/**
 * Internal-only Electron handoff record. It deliberately excludes process,
 * socket, filesystem, and bearer-capability material.
 */
export const attentionAdoptionSchema = z.discriminatedUnion('state', [
	attentionAdoptionIdentitySchema
		.extend({ state: z.literal('reserved'), reservedAt: utcIsoSchema, expiresAt: utcIsoSchema })
		.strict(),
	attentionAdoptionIdentitySchema
		.extend({
			state: z.literal('completed'),
			reservedAt: utcIsoSchema,
			expiresAt: utcIsoSchema,
			completedAt: utcIsoSchema,
		})
		.strict(),
	attentionAdoptionIdentitySchema
		.extend({
			state: z.literal('rolled_back'),
			reservedAt: utcIsoSchema,
			expiresAt: utcIsoSchema,
			rolledBackAt: utcIsoSchema,
			reason: attentionAdoptionRollbackReasonSchema,
		})
		.strict(),
])
export type AttentionAdoption = z.infer<typeof attentionAdoptionSchema>
export type AttentionAdoptionIdentity = z.infer<typeof attentionAdoptionIdentitySchema>
export type AttentionAdoptionRollbackReason = z.infer<typeof attentionAdoptionRollbackReasonSchema>

export const scheduledRunRecordSchema = z.object({
	...createScheduledRunSchema.shape,
	id: z.string().min(1),
	profileId: z.string().min(1),
	revision: z.number().int().nonnegative(),
	startedAt: utcIsoSchema.nullable(),
	reportedAt: utcIsoSchema.nullable(),
	closedAt: utcIsoSchema.nullable(),
	reportKind: z.enum(['quiet', 'needs_attention']).nullable(),
	reportSummary: boundedText(1000).nullable(),
	diagnosticDetail: scheduledRunDiagnosticSchema,
	notificationClaimedAt: utcIsoSchema.nullable(),
	notificationDeliveredAt: utcIsoSchema.nullable(),
	cleanupState: z.string().nullable(),
	terminalResolvedAt: utcIsoSchema.nullable(),
	/** Internal durable Electron ownership handoff; never exposed by contracts. */
	attentionAdoption: attentionAdoptionSchema.nullable(),
	/** Durable first-writer teardown outcome; cleared only by its terminal transition. */
	pendingTerminalIntent: scheduledTerminalIntentSchema.nullable(),
	createdAt: utcIsoSchema,
	updatedAt: utcIsoSchema,
})

export type ScheduledTarget = z.infer<typeof scheduledTargetSchema>
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>
export type ScheduleRecord = z.infer<typeof scheduleRecordSchema>
export type ScheduledRunRecord = z.infer<typeof scheduledRunRecordSchema>
export type ScheduledRunState = z.infer<typeof scheduledRunStateSchema>
export type CreateScheduledRunInput = z.input<typeof createScheduledRunSchema>
