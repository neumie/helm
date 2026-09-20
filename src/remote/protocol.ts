import { z } from 'zod'
import {
	imageInputCapabilitiesSchema,
	remoteImageReferenceSchema,
	validImageReferenceSet,
} from './image-input-protocol.js'
import { remoteSubagentActivitySchema } from './subagent-activity-protocol.js'

export const REMOTE_PROTOCOL = 1
export const REMOTE_BODY_LIMIT = 256 * 1024
export const REMOTE_STALE_MS = 5000
export const REMOTE_COMMAND_TTL_MS = 10_000
/** One shared bound for outstanding grants plus retained live observations. */
export const REMOTE_MAX_OWNERS = 64
/** Zod string lengths and this bound use UTF-16 code units, not code points. */
export const REMOTE_CATALOG_LABEL_MAX_LENGTH = 160
const id = z.string().uuid()
const boundedText = z.string().max(8192)

export const remoteRegistrationRequestSchema = z.object({ sessionId: id }).strict()

export const remoteTargetSchema = z
	.object({
		sessionId: id,
		incarnation: id,
		scopeId: id.nullable(),
		generation: z.number().int().positive().safe(),
	})
	.strict()
export type RemoteTarget = z.infer<typeof remoteTargetSchema>

export const remoteTerminalSourceSchema = z.enum(['okena', 'helm'])
export type RemoteTerminalSource = z.infer<typeof remoteTerminalSourceSchema>

/** Operator-only, memory-only source repair. It is not native ownership evidence. */
export const remoteSourceCandidateSchema = z
	.object({
		target: remoteTargetSchema,
		caption: z.string().max(REMOTE_CATALOG_LABEL_MAX_LENGTH),
		connected: z.boolean(),
		nativeSource: remoteTerminalSourceSchema.nullable(),
		manualSource: remoteTerminalSourceSchema.nullable(),
	})
	.strict()
export type RemoteSourceCandidate = z.infer<typeof remoteSourceCandidateSchema>
export const remoteSourceCandidatesSchema = z
	.object({
		hostEpoch: id,
		candidates: z.array(remoteSourceCandidateSchema).max(REMOTE_MAX_OWNERS),
	})
	.strict()
export type RemoteSourceCandidates = z.infer<typeof remoteSourceCandidatesSchema>
export const remoteSourceConfirmationSchema = z
	.object({ hostEpoch: id, target: remoteTargetSchema, source: remoteTerminalSourceSchema.nullable() })
	.strict()
export type RemoteSourceConfirmation = z.infer<typeof remoteSourceConfirmationSchema>

const selection = z.union([
	z.object({ option: z.number().int().min(0).max(3) }).strict(),
	z.object({ options: z.array(z.number().int().min(0).max(3)).max(4) }).strict(),
	z.object({ text: z.string().min(1).max(4000) }).strict(),
])
const remotePromptOperationSchema = z
	.object({
		kind: z.literal('prompt'),
		text: z.string().trim().max(16_384),
		delivery: z.enum(['steer', 'followUp']),
		images: z.array(remoteImageReferenceSchema).max(4).optional(),
	})
	.strict()
export const REMOTE_MAX_MODELS = 32
/** Pi's thinking levels, in the order a reader should see them. */
export const REMOTE_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const remoteThinkingLevelSchema = z.enum(REMOTE_THINKING_LEVELS)
export type RemoteThinkingLevel = z.infer<typeof remoteThinkingLevelSchema>
/** Absent from a bridge that predates effort selection; empty means the model supports none. */
export const remoteThinkingSchema = z
	.object({ level: remoteThinkingLevelSchema, levels: z.array(remoteThinkingLevelSchema).max(7) })
	.strict()
export type RemoteThinking = z.infer<typeof remoteThinkingSchema>
/**
 * One selectable model. `image` travels with it because whether a conversation can take
 * images is a property of its model, and the reader choosing one needs to know that
 * before the choice rather than after a refused upload.
 */
export const remoteModelSchema = z
	.object({
		provider: z.string().min(1).max(64),
		id: z.string().min(1).max(128),
		label: z.string().min(1).max(96),
		image: z.boolean(),
	})
	.strict()
export type RemoteModel = z.infer<typeof remoteModelSchema>
export const remoteOperationSchema = z
	.union([
		remotePromptOperationSchema,
		z.object({ kind: z.literal('interrupt') }).strict(),
		z.object({ kind: z.literal('answer'), requestId: id, answers: z.array(selection).min(1).max(4) }).strict(),
		z
			.object({ kind: z.literal('model'), provider: z.string().min(1).max(64), id: z.string().min(1).max(128) })
			.strict(),
		z.object({ kind: z.literal('thinking'), level: remoteThinkingLevelSchema }).strict(),
	])
	.superRefine((value, ctx) => {
		if (value.kind !== 'prompt') return
		if ((!value.text && !value.images) || (value.images !== undefined && !validImageReferenceSet(value.images)))
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'prompt_requires_text_or_images' })
	})
export const remoteCommandSchema = z
	.object({
		protocol: z.literal(REMOTE_PROTOCOL),
		hostEpoch: id,
		commandId: id,
		target: remoteTargetSchema,
		operation: remoteOperationSchema,
	})
	.strict()
export type RemoteCommand = z.infer<typeof remoteCommandSchema>
export const remoteImageReadRequestSchema = z
	.object({
		protocol: z.literal(REMOTE_PROTOCOL),
		hostEpoch: id,
		target: remoteTargetSchema,
		commandId: id,
		image: remoteImageReferenceSchema,
	})
	.strict()
export type RemoteImageReadRequest = z.infer<typeof remoteImageReadRequestSchema>

export const remoteHostExchangeSchema = z
	.object({
		protocol: z.literal(REMOTE_PROTOCOL),
		hostEpoch: id,
		commands: z
			.array(z.object({ command: remoteCommandSchema, expiresAt: z.number().int().positive().safe() }).strict())
			.max(8),
	})
	.strict()

export const remoteReceiptSchema = z
	.object({
		commandId: id,
		status: z.enum(['pending', 'dispatched', 'answered', 'rejected', 'unknown']),
	})
	.strict()
export type RemoteReceipt = z.infer<typeof remoteReceiptSchema>

export const remoteQuestionSchema = z
	.object({
		requestId: id,
		questions: z
			.array(
				z
					.object({
						question: z.string().max(4000),
						header: z.string().max(16),
						multiSelect: z.boolean().optional(),
						options: z
							.array(
								z
									.object({
										label: z.string().max(60),
										description: z.string().max(4000),
										preview: boundedText.optional(),
									})
									.strict(),
							)
							.min(2)
							.max(4),
					})
					.strict(),
			)
			.min(1)
			.max(4),
	})
	.strict()

export const remoteTerminalMetadataSchema = z
	.object({
		source: remoteTerminalSourceSchema,
		/** The owning Okena parent project; null for Helm terminal metadata. */
		project: z.string().max(160).nullable(),
		/** The Okena worktree/project name, distinct from the parent and Git branch. */
		worktree: z.string().max(160).nullable().optional(),
		/** The read-only Git HEAD observed after exact Okena terminal association. */
		branch: z.string().max(160).nullable().optional(),
		/** A native terminal/tab name, when one exists. */
		name: z.string().max(160).nullable(),
		group: z.string().max(160).nullable(),
	})
	.strict()
export type RemoteTerminalMetadata = z.infer<typeof remoteTerminalMetadataSchema>

export const remoteSnapshotSchema = z
	.object({
		target: remoteTargetSchema,
		revision: z.number().int().nonnegative().safe(),
		label: z.string().max(160),
		workspace: z.string().max(160),
		imageInput: imageInputCapabilitiesSchema.optional(),
		terminal: remoteTerminalMetadataSchema.optional(),
		model: z.string().max(160).nullable(),
		/** Absent from a bridge that predates model selection; never inferred from `model`. */
		models: z.array(remoteModelSchema).max(REMOTE_MAX_MODELS).optional(),
		thinking: remoteThinkingSchema.optional(),
		activity: z.enum(['idle', 'working', 'waiting', 'unknown']),
		subagents: remoteSubagentActivitySchema.optional(),
		capabilities: z.object({ prompt: z.boolean(), interrupt: z.boolean(), answer: z.boolean() }).strict(),
		question: remoteQuestionSchema.nullable(),
		messages: z
			.array(
				z
					.object({
						id: z.string().max(100),
						role: z.enum(['user', 'assistant', 'toolResult']),
						text: boundedText,
						thinking: boundedText,
						toolCalls: boundedText.optional(),
						truncated: z.boolean(),
					})
					.strict(),
			)
			.max(40),
		historyTruncated: z.boolean(),
	})
	.strict()
export type RemoteSnapshot = z.infer<typeof remoteSnapshotSchema>
export const remoteViewSchema = remoteSnapshotSchema
	.extend({ connected: z.boolean(), subagentsFreshForMs: z.number().int().positive().max(REMOTE_STALE_MS).optional() })
	.strict()
export type RemoteView = z.infer<typeof remoteViewSchema>
export const remoteSummarySchema = remoteViewSchema.omit({ messages: true, question: true })
export type RemoteSummary = z.infer<typeof remoteSummarySchema>
export const remoteDirectorySchema = z
	.object({
		protocol: z.literal(REMOTE_PROTOCOL),
		hostEpoch: id,
		/** Opaque stamp binding the authorized live UUID suppression overlay. */
		overlayStamp: z.string().max(64),
		sessions: z.array(remoteSummarySchema).max(REMOTE_MAX_OWNERS),
	})
	.strict()
export type RemoteDirectory = z.infer<typeof remoteDirectorySchema>

/** Read-only filesystem inventory. It is intentionally separate from command-capable live targets. */
export const remoteCatalogRowSchema = z
	.object({
		id: z.string().regex(/^catalog_[a-f0-9]{32}$/),
		label: z.string().max(REMOTE_CATALOG_LABEL_MAX_LENGTH),
		createdAt: z.number().int().nonnegative(),
		modifiedAt: z.number().int().nonnegative(),
		messageCount: z.number().int().nonnegative().nullable(),
		hasParent: z.boolean(),
		liveness: z.literal('unknown'),
		readOnly: z.literal(true),
	})
	.strict()
export type RemoteCatalogRow = z.infer<typeof remoteCatalogRowSchema>
export const remoteCatalogPageSchema = z
	.object({
		protocol: z.literal(REMOTE_PROTOCOL),
		hostEpoch: id,
		/** Pending never claims an end-of-results; ready is a fully selected page. */
		state: z.enum(['pending', 'ready', 'invalidated', 'unavailable', 'busy', 'superseded']),
		rows: z.array(remoteCatalogRowSchema).max(50),
		/** Saturating counters (1,000,000 = at least); no paths or error samples. */
		omissions: z
			.object({
				malformed: z.number().int().min(0).max(1_000_000),
				unsupported: z.number().int().min(0).max(1_000_000),
			})
			.strict(),
		pageCursor: z.string().max(512).nullable(),
		previousCursor: z.string().max(512).nullable(),
		nextCursor: z.string().max(512).nullable(),
		/** Opaque authorized live-overlay identity; historical rows are valid only against this projection. */
		overlayStamp: z.string().max(64),
		reason: z
			.enum([
				'scanning',
				'superseding',
				'invalid_cursor',
				'view_capacity',
				'filesystem_error',
				'malformed_metadata',
				'unsupported_metadata',
				'publication_substitution',
				'stopped',
			])
			.nullable(),
	})
	.strict()
export type RemoteCatalogPage = z.infer<typeof remoteCatalogPageSchema>
export const remoteAccessSchema = z
	.object({
		hostEpoch: id,
		device: z.union([
			z
				.object({
					id,
					grant: z
						.object({
							personalCurrentAndFuture: z.boolean(),
							scopeIds: z.array(id).max(64),
							operations: z
								.object({ read: z.boolean(), prompt: z.boolean(), interrupt: z.boolean(), answer: z.boolean() })
								.strict(),
						})
						.strict(),
				})
				.strict(),
			z.object({ development: z.literal(true) }).strict(),
		]),
	})
	.strict()
export type RemoteAccessDocument = z.infer<typeof remoteAccessSchema>
export const remoteDetailSchema = z
	.object({ protocol: z.literal(REMOTE_PROTOCOL), hostEpoch: id, snapshot: remoteViewSchema, resync: z.literal(true) })
	.strict()
export type RemoteDetail = z.infer<typeof remoteDetailSchema>

export const remoteExchangeSchema = z
	.object({
		protocol: z.literal(REMOTE_PROTOCOL),
		enrollmentId: id,
		snapshot: remoteSnapshotSchema,
		receipts: z.array(remoteReceiptSchema).max(32),
	})
	.strict()

export function sameRemoteTarget(a: RemoteTarget, b: RemoteTarget): boolean {
	return (
		a.sessionId === b.sessionId &&
		a.incarnation === b.incarnation &&
		a.scopeId === b.scopeId &&
		a.generation === b.generation
	)
}
