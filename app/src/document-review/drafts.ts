import { createHash, randomUUID } from 'node:crypto'
import {
	constants,
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { defaultReviewDraft } from './types'
import type { ReviewDraft } from './types'

const passageSchema = z
	.object({
		revision: z.string().regex(/^[a-f0-9]{64}$/),
		start: z.number().int().min(0),
		end: z.number().int().min(1),
		source: z.string().max(8000),
		quote: z.string().max(8000),
		kind: z.enum(['exact', 'block']),
	})
	.strict()
export const reviewDraftSchema = z
	.object({
		instruction: z.string().max(8000),
		annotations: z
			.array(
				z
					.object({
						id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
						passage: passageSchema,
						note: z.string().max(8000),
						intent: z.enum(['discuss', 'change']),
						resolved: z.boolean(),
					})
					.strict(),
			)
			.max(64),
		sessionId: z
			.string()
			.regex(/^review:[a-f0-9-]{36}$/)
			.nullable(),
		paneWidth: z.number().min(280).max(640),
		theme: z.enum(['dark', 'light']),
	})
	.strict()
const dataSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), reviewDraftSchema)
const MAX_BYTES = 1024 * 1024

/** Preference/draft bytes only. Nothing loaded here can authorize a file or command. */
export class ReviewDraftStore {
	private document: Record<string, ReviewDraft> = {}
	readonly file: string
	constructor(profileDir: string) {
		this.file = join(profileDir, 'document-review-drafts.json')
		try {
			const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
			try {
				const stat = fstatSync(fd)
				if (
					!stat.isFile() ||
					stat.nlink !== 1 ||
					stat.size > MAX_BYTES ||
					stat.mode & 0o077 ||
					(process.getuid && stat.uid !== process.getuid())
				)
					throw new Error('Unsafe review drafts')
				const bytes = Buffer.alloc(MAX_BYTES + 1)
				let used = 0
				while (used < bytes.length) {
					const count = readSync(fd, bytes, used, bytes.length - used, used)
					if (count === 0) break
					used += count
				}
				const after = fstatSync(fd)
				const current = lstatSync(this.file)
				if (
					used > MAX_BYTES ||
					stat.size !== used ||
					after.size !== stat.size ||
					stat.mtimeMs !== after.mtimeMs ||
					stat.ctimeMs !== after.ctimeMs ||
					current.dev !== stat.dev ||
					current.ino !== stat.ino ||
					current.isSymbolicLink() ||
					after.nlink !== 1
				)
					throw new Error('Review drafts changed during reading')
				const document = dataSchema.parse(
					JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))),
				)
				if (Object.keys(document).length > 256) throw new Error('Too many saved review drafts')
				this.document = document
			} finally {
				closeSync(fd)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw new Error('Saved review drafts are unavailable. The existing file was preserved.')
		}
	}
	key(workspace: string, file: string, sessionId: string | null): string {
		return createHash('sha256')
			.update(JSON.stringify([workspace, file, sessionId]))
			.digest('hex')
	}
	load(key: string): ReviewDraft {
		return structuredClone(this.document[key] ?? defaultReviewDraft())
	}
	save(key: string, raw: unknown): void {
		const draft = reviewDraftSchema.parse(raw)
		const candidate = { ...this.document, [key]: draft }
		const bytes = JSON.stringify(candidate)
		if (Object.keys(candidate).length > 256 || Buffer.byteLength(bytes) > MAX_BYTES)
			throw new Error('Saved review drafts reached their 1 MiB limit. Delete unused comments before saving more.')
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
		const parent = lstatSync(dirname(this.file))
		if (
			!parent.isDirectory() ||
			parent.isSymbolicLink() ||
			parent.mode & 0o077 ||
			(process.getuid && parent.uid !== process.getuid())
		)
			throw new Error('The private review draft folder is unavailable.')
		try {
			const stat = lstatSync(this.file)
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1 ||
				stat.mode & 0o077 ||
				(process.getuid && stat.uid !== process.getuid())
			)
				throw new Error('Unsafe review drafts')
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
		}
		const temporary = `${this.file}.${randomUUID()}.tmp`
		try {
			writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
			renameSync(temporary, this.file)
			this.document = candidate
		} finally {
			try {
				unlinkSync(temporary)
			} catch {
				/* consumed by rename */
			}
		}
	}
}
