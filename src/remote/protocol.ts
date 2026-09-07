import { z } from 'zod'

export const REMOTE_PROTOCOL = 1
export const REMOTE_BODY_LIMIT = 256 * 1024
export const REMOTE_STALE_MS = 5000
export const REMOTE_COMMAND_TTL_MS = 10_000
const id = z.string().uuid()
const boundedText = z.string().max(8192)

export const remoteTargetSchema = z
	.object({
		sessionId: id,
		incarnation: id,
		scopeId: id.nullable(),
		generation: z.number().int().positive().safe(),
	})
	.strict()
export type RemoteTarget = z.infer<typeof remoteTargetSchema>

const selection = z.union([
	z.object({ option: z.number().int().min(0).max(3) }).strict(),
	z.object({ options: z.array(z.number().int().min(0).max(3)).max(4) }).strict(),
	z.object({ text: z.string().min(1).max(4000) }).strict(),
])
export const remoteOperationSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('prompt'),
			text: z.string().trim().min(1).max(16_384),
			delivery: z.enum(['steer', 'followUp']),
		})
		.strict(),
	z.object({ kind: z.literal('interrupt') }).strict(),
	z.object({ kind: z.literal('answer'), requestId: id, answers: z.array(selection).min(1).max(4) }).strict(),
])
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

export const remoteSnapshotSchema = z
	.object({
		target: remoteTargetSchema,
		revision: z.number().int().nonnegative().safe(),
		label: z.string().max(160),
		workspace: z.string().max(160),
		model: z.string().max(160).nullable(),
		activity: z.enum(['idle', 'working', 'waiting', 'unknown']),
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
						truncated: z.boolean(),
					})
					.strict(),
			)
			.max(40),
		historyTruncated: z.boolean(),
	})
	.strict()
export type RemoteSnapshot = z.infer<typeof remoteSnapshotSchema>
export const remoteViewSchema = remoteSnapshotSchema.extend({ connected: z.boolean() }).strict()
export type RemoteView = z.infer<typeof remoteViewSchema>
export const remoteSummarySchema = remoteViewSchema.omit({ messages: true, question: true })
export type RemoteSummary = z.infer<typeof remoteSummarySchema>
export const remoteDirectorySchema = z
	.object({ protocol: z.literal(REMOTE_PROTOCOL), hostEpoch: id, sessions: z.array(remoteSummarySchema).max(16) })
	.strict()
export type RemoteDirectory = z.infer<typeof remoteDirectorySchema>
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
