import { z } from 'zod'
import { remoteHostExchangeSchema, remoteSnapshotSchema, remoteTargetSchema } from './protocol.js'

/** Additive history-v1, negotiated separately from the legacy live/command wire. */
export const HISTORY_HEADER = 'X-Helm-History'
export const HISTORY_REQUEST_BYTES = 4096
export const HISTORY_DESCRIPTOR_BYTES = 4096
export const HISTORY_RESULT_BYTES = 96 * 1024
export const HISTORY_RECORD_BYTES = 48 * 1024
export const HISTORY_PAGE_BYTES = 64 * 1024
export const HISTORY_ATTEMPTS = 128
export const HISTORY_LEASE_MS = 60_000
export const HISTORY_DEADLINE_MS = 4000
export const historyEntryIdSchema = z.string().regex(/^[a-f0-9]{8}$/)
const cursor = z.string().min(1).max(1024)
const sequence = z.number().int().nonnegative().safe()
export const historyActionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('open'), anchor: historyEntryIdSchema.optional() }).strict(),
	z.object({ kind: z.literal('page'), cursor }).strict(),
	z.object({ kind: z.literal('newer'), cursor }).strict(),
	z.object({ kind: z.literal('continue'), cursor }).strict(),
	z.object({ kind: z.literal('close') }).strict(),
])
export const historyRequestSchema = z
	.object({
		version: z.literal(1),
		hostEpoch: z.string().uuid(),
		target: remoteTargetSchema,
		viewId: z.string().uuid(),
		sequence,
		action: historyActionSchema,
	})
	.strict()
export type HistoryRequest = z.infer<typeof historyRequestSchema>
export const historyDescriptorSchema = z
	.object({
		requestId: z.string().uuid(),
		principalKey: z.string().max(128),
		expiresAt: sequence,
		request: historyRequestSchema,
	})
	.strict()
	.refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= HISTORY_DESCRIPTOR_BYTES)
export type HistoryDescriptor = z.infer<typeof historyDescriptorSchema>
const message = remoteSnapshotSchema.shape.messages.element
export const historyRecordSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('message'), message: message.extend({ id: historyEntryIdSchema }).strict() }).strict(),
	z
		.object({ kind: z.literal('marker'), id: historyEntryIdSchema, marker: z.enum(['compaction', 'branch-summary']) })
		.strict(),
])
export type HistoryRecord = z.infer<typeof historyRecordSchema>
export const historyOmissionsSchema = z
	.object({
		clipped: z.number().int().min(0).max(1_000_000),
		images: z.number().int().min(0).max(1_000_000),
		unsupported: z.number().int().min(0).max(1_000_000),
	})
	.strict()
export type HistoryOmissions = z.infer<typeof historyOmissionsSchema>
export const historyPageSchema = z
	.object({
		newest: historyEntryIdSchema.nullable(),
		oldest: historyEntryIdSchema.nullable(),
		records: z.array(historyRecordSchema).max(40),
		omissions: historyOmissionsSchema,
		reread: cursor,
		older: cursor.nullable(),
		newer: cursor.nullable(),
		stopped: z.enum(['entries', 'records', 'bytes', 'root', 'boundary']),
	})
	.strict()
export type HistoryPage = z.infer<typeof historyPageSchema>
export const historyResultSchema = z
	.object({
		version: z.literal(1),
		requestId: z.string().uuid(),
		hostEpoch: z.string().uuid(),
		target: remoteTargetSchema,
		viewId: z.string().uuid(),
		sequence,
		input: historyActionSchema,
		state: z.enum(['page', 'progress', 'closed', 'gap', 'expired', 'stale', 'busy']),
		page: historyPageSchema.nullable(),
		continuation: cursor.nullable(),
		attempts: z.number().int().min(0).max(HISTORY_ATTEMPTS),
		examined: sequence,
	})
	.strict()
export type HistoryResult = z.infer<typeof historyResultSchema>
export const remoteHistoryExchangeSchema = remoteHostExchangeSchema
	.extend({ historyRead: historyDescriptorSchema.optional() })
	.strict()
export const emptyHistoryOmissions = (): HistoryOmissions => ({ clipped: 0, images: 0, unsupported: 0 })
export function addHistoryOmissions(a: HistoryOmissions, b: HistoryOmissions): HistoryOmissions {
	return {
		clipped: Math.min(1_000_000, a.clipped + b.clipped),
		images: Math.min(1_000_000, a.images + b.images),
		unsupported: Math.min(1_000_000, a.unsupported + b.unsupported),
	}
}
