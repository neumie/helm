import { z } from 'zod'
import { reviewRequestSchema } from './request-admission.js'

export const REVIEW_WIRE_BYTES = 512 * 1024
export const REVIEW_VERSION = 1
const uuid = z.string().uuid()
const token = z.string().regex(/^[a-f0-9]{64}$/)
export const reviewId = z
	.string()
	.regex(/^review:[a-f0-9-]{36}$/)
	.refine(value => uuid.safeParse(value.slice(7)).success)
const noControls = (value: string) => {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code < 32 || (code >= 127 && code <= 159)) return false
	}
	return true
}
const path = z.string().min(1).max(2048).refine(noControls)
const label = z.string().trim().min(1).max(80).refine(noControls)
export const discoverySchema = z.object({ version: z.literal(1), epoch: uuid, socket: path, token }).strict()
export const connectionSchema = z
	.object({
		version: z.literal(1),
		epoch: uuid,
		socket: path,
		id: reviewId,
		owner: uuid,
		token,
	})
	.strict()
export type ReviewConnection = z.infer<typeof connectionSchema>
export const commandSchema = z.discriminatedUnion('action', [
	z
		.object({
			action: z.literal('connect'),
			workspace: path,
			provider: z.enum(['claude', 'codex', 'pi']),
			label,
			transport: z.enum(['tool-return', 'in-process']),
		})
		.strict(),
	z.object({ action: z.literal('open'), file: path }).strict(),
	z.object({ action: z.literal('list') }).strict(),
	z.object({ action: z.literal('status') }).strict(),
	z.object({ action: z.literal('next'), timeoutMs: z.number().int().min(1).max(60000) }).strict(),
	z.object({ action: z.literal('ack'), requestId: uuid }).strict(),
	z
		.object({
			action: z.literal('reply'),
			requestId: uuid,
			sequence: z.number().int().nonnegative().safe(),
			state: z.enum(['working', 'complete', 'error']),
			text: z.string().max(64000),
		})
		.strict(),
	z.object({ action: z.literal('receipt'), requestId: uuid }).strict(),
	z.object({ action: z.literal('disconnect') }).strict(),
])
export type ReviewCommand = z.infer<typeof commandSchema>
export const envelopeSchema = z
	.object({ epoch: uuid, token, id: reviewId.optional(), owner: uuid.optional(), command: commandSchema })
	.strict()
export type ReviewEnvelope = z.infer<typeof envelopeSchema>
export const feedbackSchema = z
	.object({ request: reviewRequestSchema, prompt: z.string().max(24000), relativePath: path })
	.strict()
export const connectedSchema = z.object({ connection: path, id: reviewId, owner: uuid }).strict()
export const openedSchema = z.object({ documentId: uuid, revision: token, relativePath: path }).strict()
export const receiptSchema = z
	.object({ id: uuid, outcome: z.enum(['pending', 'dispatched', 'rejected', 'unknown']), detail: z.string().max(400) })
	.strict()
export const sessionSchema = z
	.object({
		id: reviewId,
		owner: uuid,
		provider: z.enum(['claude', 'codex', 'pi']),
		name: label,
		capabilities: z
			.object({
				transport: z.enum(['tool-return', 'in-process']),
				continuation: z.literal('live-session'),
				readOnlyPolicy: z.literal('session-owned'),
				interactiveQuestions: z.literal(true),
				interrupt: z.literal('unsupported'),
				providerAcknowledgement: z.literal(false),
				minimumVersion: z.string().max(80).nullable(),
			})
			.strict(),
		state: z.enum(['idle', 'starting', 'working', 'waiting', 'disconnected', 'error']),
		listening: z.boolean(),
		busy: z.boolean(),
		needsAcknowledgement: z.boolean(),
		messages: z
			.array(
				z
					.object({
						id: z.string().max(160),
						archiveThreadId: uuid.optional(),
						role: z.enum(['user', 'assistant', 'activity']),
						text: z.string().max(64000),
						passageContext: z
							.object({ documentId: uuid, passage: reviewRequestSchema.shape.passage.unwrap() })
							.strict()
							.optional(),
					})
					.strict(),
			)
			.max(80),
		error: z.string().max(400).nullable(),
		historyTruncated: z.boolean(),
	})
	.strict()
export const responseSchema = z.union([
	z.object({ data: z.unknown() }).strict(),
	z.object({ error: z.string().max(400) }).strict(),
])
