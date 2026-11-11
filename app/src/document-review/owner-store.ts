import { join } from 'node:path'
import { z } from 'zod'
import {
	privateDirectory,
	readPrivateJson,
	removePrivateFile,
	replacePrivateJson,
} from '../../../src/document-review/private-state'
import { REVIEW_SESSION_HINT, feedbackSchema, reviewId, sessionSchema } from '../../../src/document-review/protocol'
import { reviewThreadSchema } from './canvas-artifact'

/** One caller's state can hold a whole feedback, its history and replies; never more than this on disk. */
export const OWNER_RECORD_BYTES = 1024 * 1024
/** A kept caller that nobody used for this long does not come back after a restart. */
export const OWNER_RECORD_TTL_MS = 24 * 60 * 60 * 1000
const uuid = z.string().uuid()
const path = z.string().min(1).max(2048)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const archiveReference = z.object({ thread: reviewThreadSchema, root: path, file: path }).strict()
/**
 * What survives a Helm restart for one caller (S13). Everything else (waiters, timers, admission) is rebuilt.
 * `documents` are the windows this caller had open; `pending` is the one feedback it had not finished; `settled`
 * deduplicates a reply whose answer was lost in the restart. The snapshot's `listening`/`busy` are recomputed.
 */
export const ownerRecordSchema = z
	.object({
		version: z.literal(1),
		profileId: z.string().min(1).max(200),
		workspace: path,
		usedAt: z.number().int().nonnegative().safe(),
		hint: z
			.object({ provider: z.enum(['claude', 'codex']), session: z.string().regex(REVIEW_SESSION_HINT) })
			.strict()
			.optional(),
		snapshot: sessionSchema,
		documents: z.array(z.object({ documentId: uuid, root: path, file: path }).strict()).max(8),
		pending: z
			.object({
				feedback: feedbackSchema,
				/** The feedback was handed to some listener at least once (its answer may have been lost). */
				offered: z.boolean(),
				/** The listener nonce it was handed to; only that listening process may get it again. */
				offeredTo: uuid.nullable(),
				confirmed: z.boolean(),
				confirmedAt: z.number().int().nonnegative().safe(),
				sequence: z.number().int().min(-1).safe(),
				lastReport: hash.nullable(),
				sentAt: z.number().int().nonnegative().safe(),
				archive: archiveReference.nullable(),
			})
			.strict()
			.nullable(),
		settled: z.array(z.object({ requestId: uuid, report: hash }).strict()).max(8),
		/** Journal settlements decided but not written yet; the next start writes them. */
		outstanding: z
			.array(
				z
					.object({
						reference: archiveReference,
						settlement: z
							.object({
								state: z.enum(['complete', 'error', 'unknown', 'rejected']),
								reply: z.string().max(64000).optional(),
								detail: z.string().max(8000).optional(),
							})
							.strict(),
					})
					.strict(),
			)
			.max(8),
	})
	.strict()
export type ReviewOwnerRecord = z.infer<typeof ownerRecordSchema>

const fileName = (id: string) => `caller-${id.slice('review:'.length)}.json`

/**
 * Owner-private caller state next to the CLI's connection files (`caller-<uuid>.json`). Writes are serialized per
 * caller and coalesced: `save` resolves once the newest state asked for at or after the call is on disk. A write
 * error rejects that save; the in-memory caller is unchanged (callers decide what a failed write means).
 */
export class ReviewOwnerStore {
	private readonly chains = new Map<string, Promise<void>>()
	private readonly latest = new Map<string, ReviewOwnerRecord | null>()
	constructor(readonly root: string) {}
	save(id: string, record: ReviewOwnerRecord | null): Promise<void> {
		reviewId.parse(id)
		this.latest.set(id, record === null ? null : structuredClone(record))
		const previous = this.chains.get(id) ?? Promise.resolve()
		const write = previous
			.catch(() => {})
			.then(async () => {
				if (!this.latest.has(id)) return
				const value = this.latest.get(id) ?? null
				this.latest.delete(id)
				try {
					await privateDirectory(this.root)
					const target = join(this.root, fileName(id))
					if (value === null) await removePrivateFile(target)
					else await replacePrivateJson(target, ownerRecordSchema.parse(value), OWNER_RECORD_BYTES)
				} catch (error) {
					// A later save must still write this state if nothing newer replaced it meanwhile.
					if (!this.latest.has(id)) this.latest.set(id, value)
					throw error
				}
			})
		this.chains.set(id, write)
		void write
			.finally(() => {
				if (this.chains.get(id) === write) this.chains.delete(id)
			})
			.catch(() => {})
		return write
	}
	remove(id: string): Promise<void> {
		return this.save(id, null)
	}
	/** Every write asked for so far has settled (successfully or not). */
	async drain(): Promise<void> {
		await Promise.allSettled([...this.chains.values()])
	}
	/** The kept record of one caller, or null when it is missing, unreadable or invalid (expiry is the caller's call). */
	async load(id: string): Promise<ReviewOwnerRecord | null> {
		reviewId.parse(id)
		try {
			const record = ownerRecordSchema.parse(
				await readPrivateJson(join(await privateDirectory(this.root), fileName(id)), OWNER_RECORD_BYTES),
			)
			return record.snapshot.id === id ? record : null
		} catch {
			return null
		}
	}
}
