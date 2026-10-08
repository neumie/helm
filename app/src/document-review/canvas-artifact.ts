import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, extname, relative, sep } from 'node:path'
import { z } from 'zod'
import type {
	CanvasReviewArchive,
	CanvasReviewEntry,
	CanvasReviewThread,
} from '../../../src/document-review/canvas-types.js'

const FILE_BYTES = 512 * 1024
const RECORD_BYTES = 256 * 1024
const JOURNAL_BYTES = 384 * 1024
const RECORD_COUNT = 1024
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const intent = z.enum(['discuss', 'change'])
const passage = z
	.object({
		revision,
		start: z.number().int().nonnegative().safe(),
		end: z.number().int().positive().safe(),
		source: z.string().max(8000),
		quote: z.string().max(8000),
		kind: z.enum(['exact', 'block']),
		canvasId: z.string().min(1).max(80).optional(),
	})
	.strict()
	.refine(value => value.end > value.start && value.end - value.start === value.source.length)
const fields = z
	.array(z.object({ id: z.string().min(1).max(80), value: z.union([z.string().max(4000), z.boolean()]) }).strict())
	.max(16)
	.refine(
		values =>
			new Set(values.map(value => value.id)).size === values.length &&
			values.reduce((sum, value) => sum + (typeof value.value === 'string' ? value.value.length : 0), 0) <= 16384,
	)
const annotations = z
	.array(
		z
			.object({
				id: z.string().min(1).max(160),
				passage,
				note: z.string().max(8000),
				intent,
				resolved: z.boolean(),
			})
			.strict(),
	)
	.max(256)
	.refine(values => new Set(values.map(value => value.id)).size === values.length)
const terminal = z.enum(['complete', 'error', 'unknown', 'rejected'])
const thread = z
	.object({
		id: z.string().uuid(),
		instruction: z
			.string()
			.min(1)
			.max(8000)
			.refine(value => value.trim().length > 0),
		intent,
		passage: passage.nullable(),
		fields,
		provider: z.enum(['claude', 'codex', 'pi']),
		name: z.string().min(1).max(160),
		state: z.enum(['unconfirmed', 'complete', 'error', 'unknown', 'rejected']),
		reply: z.string().max(64000).optional(),
		detail: z.string().max(8000).optional(),
	})
	.strict()
	.refine(value => value.state !== 'unconfirmed' || (value.reply === undefined && value.detail === undefined))
const entrySchema = z.discriminatedUnion('type', [
	z.object({ version: z.literal(1), type: z.literal('thread'), thread }).strict(),
	z
		.object({
			version: z.literal(1),
			type: z.literal('settle'),
			id: z.string().uuid(),
			state: terminal,
			reply: z.string().max(64000).optional(),
			detail: z.string().max(8000).optional(),
		})
		.strict(),
	z.object({ version: z.literal(1), type: z.literal('annotations'), annotations }).strict(),
])
const invalid = () =>
	new Error('The review journal is malformed, inconsistent or exceeds its limits. No content was changed.')
function validate(value: unknown): CanvasReviewEntry {
	const result = entrySchema.safeParse(value)
	if (!result.success || Buffer.byteLength(JSON.stringify(result.data)) > RECORD_BYTES) throw invalid()
	return result.data
}
function apply(archive: CanvasReviewArchive, entry: CanvasReviewEntry): void {
	if (entry.type === 'annotations') {
		archive.annotations = entry.annotations
		return
	}
	const id = entry.type === 'thread' ? entry.thread.id : entry.id
	const existing = archive.threads.find(value => value.id === id)
	if (entry.type === 'thread') {
		if (existing) {
			// The immutable start survives settlement; duplicate starts do not undo it.
			const start = ({ state: _state, reply: _reply, detail: _detail, ...value }: CanvasReviewThread) => value
			if (JSON.stringify(start(existing)) !== JSON.stringify(start(entry.thread))) throw invalid()
			if (entry.thread.state !== 'unconfirmed' && JSON.stringify(existing) !== JSON.stringify(entry.thread))
				throw invalid()
			return
		}
		if (archive.threads.length >= 64) throw invalid()
		archive.threads.push(entry.thread)
		return
	}
	if (!existing) throw invalid()
	const settled = {
		...existing,
		state: entry.state,
		reply: entry.reply,
		detail: entry.detail,
	}
	if (existing.state !== 'unconfirmed' && JSON.stringify(existing) !== JSON.stringify(settled)) throw invalid()
	Object.assign(existing, settled)
}
function delimiters(format: 'markdown' | 'jsx') {
	return format === 'markdown'
		? { prefix: '\n<!-- helm-review:v1 ', reserved: '\n<!-- helm-review:', end: ' -->' }
		: { prefix: '\n/* helm-review:v1 ', reserved: '\n/* helm-review:', end: ' */' }
}
function parse(
	raw: string,
	format: 'markdown' | 'jsx',
): { body: string; archive: CanvasReviewArchive; count: number; journalBytes: number } {
	if (Buffer.byteLength(raw) > FILE_BYTES) throw invalid()
	const { prefix, reserved, end } = delimiters(format)
	const records: CanvasReviewEntry[] = []
	let body = raw
	while (true) {
		const index = body.lastIndexOf(reserved)
		if (index < 0) break
		const suffix = body.slice(index)
		// A complete marker line followed by ordinary content is source. Only the
		// reserved trailing syntax is metadata; ambiguous partial tails are refused.
		const closing = suffix.indexOf(end)
		if (closing >= 0 && closing + end.length !== suffix.length) {
			if (suffix.slice(closing + end.length).trim().length === 0) throw invalid()
			break
		}
		if (!suffix.startsWith(prefix) || !suffix.endsWith(end)) throw invalid()
		const encoded = suffix.slice(prefix.length, -end.length)
		if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > Math.ceil((RECORD_BYTES * 4) / 3)) throw invalid()
		const bytes = Buffer.from(encoded, 'base64url')
		if (bytes.length > RECORD_BYTES || bytes.toString('base64url') !== encoded) throw invalid()
		try {
			records.push(validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))))
		} catch {
			throw invalid()
		}
		if (records.length > RECORD_COUNT) throw invalid()
		body = body.slice(0, index)
	}
	const journalBytes = Buffer.byteLength(raw.slice(body.length))
	if (journalBytes > JOURNAL_BYTES) throw invalid()
	const archive: CanvasReviewArchive = { version: 1, revision: hash(raw), threads: [], annotations: [] }
	for (const entry of records.reverse()) apply(archive, entry)
	return { body, archive, count: records.length, journalBytes }
}
/** Only a contiguous trailing journal is metadata; the exact preceding source is untouched. */
export function parseReviewArtifact(
	raw: string,
	format: 'markdown' | 'jsx',
): { body: string; archive: CanvasReviewArchive } {
	const { body, archive } = parse(raw, format)
	return { body, archive }
}

const writers = new Map<string, Promise<void>>()
type Options = { expectedSourceRevision: string; expectedArchiveRevision?: string; current: () => boolean }
function guard(options: Options): void {
	if (!options.current()) throw new Error('This review operation is no longer current. No further content was written.')
}
async function checked<T>(promise: Promise<T>, options: Options): Promise<T> {
	const result = await promise
	guard(options)
	return result
}
async function attest(root: string, file: string, options: Options): Promise<void> {
	if (
		(await checked(realpath(root), options)) !== root ||
		(await checked(realpath(dirname(file)), options)) !== dirname(file) ||
		!file.startsWith(`${root}${sep}`) ||
		/(?:^|[/\\])\.[^/\\]+/.test(relative(root, file)) ||
		!/\.(?:md|jsx|tsx)$/i.test(file)
	)
		throw new Error('Choose a visible document inside the approved canonical repository.')
	const parent = await checked(lstat(dirname(file)), options)
	if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('The document folder is unavailable.')
}
function regular(stat: Stats): boolean {
	return stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && stat.size <= FILE_BYTES
}
function same(a: Stats, b: Stats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		regular(b)
	)
}
async function read(
	fd: FileHandle,
	root: string,
	file: string,
	options: Options,
): Promise<{ raw: string; stat: Stats }> {
	const before = await checked(fd.stat(), options)
	if (!regular(before)) throw new Error('Review requires an owner-owned single-link regular file up to 512 KiB.')
	const buffer = Buffer.alloc(FILE_BYTES + 1)
	let used = 0
	while (used < buffer.length) {
		const chunk = await checked(fd.read(buffer, used, buffer.length - used, used), options)
		if (chunk.bytesRead === 0) break
		used += chunk.bytesRead
	}
	const after = await checked(fd.stat(), options)
	const path = await checked(lstat(file), options)
	await attest(root, file, options)
	if (used > FILE_BYTES || used !== before.size || !same(before, after) || !same(after, path) || path.isSymbolicLink())
		throw new Error('The document changed or was substituted. Reopen before saving.')
	return {
		raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used)),
		stat: after,
	}
}
/** Serialize Helm writers, pin one descriptor, append one complete buffer; never replace or repair source. */
export async function appendReviewArtifact(
	root: string,
	file: string,
	entries: CanvasReviewEntry[],
	options: Options,
): Promise<{ body: string; archive: CanvasReviewArchive }> {
	guard(options)
	if (
		!revision.safeParse(options.expectedSourceRevision).success ||
		(options.expectedArchiveRevision !== undefined && !revision.safeParse(options.expectedArchiveRevision).success)
	)
		throw invalid()
	if (!Array.isArray(entries) || entries.length > RECORD_COUNT) throw invalid()
	const captured = entries.map(validate)
	const previous = writers.get(file) ?? Promise.resolve()
	let release: () => void = () => {}
	const gate = new Promise<void>(resolve => {
		release = resolve
	})
	const queued = previous.then(() => gate)
	writers.set(file, queued)
	let fd: FileHandle | null = null
	let attempted = false
	try {
		await checked(previous, options)
		await attest(root, file, options)
		// Check after open inside the ownership scope so cancellation still closes the descriptor.
		fd = await open(file, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		guard(options)
		const initial = await read(fd, root, file, options)
		const format = extname(file).toLowerCase() === '.md' ? 'markdown' : 'jsx'
		const parsed = parse(initial.raw, format)
		if (
			hash(parsed.body) !== options.expectedSourceRevision ||
			(options.expectedArchiveRevision !== undefined && hash(initial.raw) !== options.expectedArchiveRevision)
		)
			throw new Error('The document or review history changed. Reload before saving.')
		const { prefix, end } = delimiters(format)
		const addition = captured
			.map(entry => `${prefix}${Buffer.from(JSON.stringify(entry)).toString('base64url')}${end}`)
			.join('')
		if (
			parsed.count + captured.length > RECORD_COUNT ||
			parsed.journalBytes + Buffer.byteLength(addition) > JOURNAL_BYTES ||
			Buffer.byteLength(initial.raw + addition) > FILE_BYTES
		)
			throw invalid()
		const result = parseReviewArtifact(initial.raw + addition, format)
		const final = await read(fd, root, file, options)
		if (!same(initial.stat, final.stat) || final.raw !== initial.raw)
			throw new Error('The document changed before saving. Reopen before saving.')
		guard(options)
		if (addition.length) {
			const bytes = Buffer.from(addition)
			attempted = true
			const written = await checked(fd.write(bytes, 0, bytes.length, null), options)
			if (written.bytesWritten !== bytes.length) throw new Error('Partial append')
			await checked(fd.sync(), options)
			const published = await read(fd, root, file, options)
			if (published.raw !== initial.raw + addition) throw new Error('Concurrent external append')
		}
		guard(options)
		await checked(fd.close(), options)
		fd = null
		guard(options)
		return result
	} catch (error) {
		if (attempted)
			throw new Error(
				'Review append may be partial or already saved. Reload and inspect before retrying; no content was repaired.',
				{ cause: error },
			)
		throw error
	} finally {
		try {
			await fd?.close()
		} finally {
			release()
			if (writers.get(file) === queued) writers.delete(file)
		}
	}
}
