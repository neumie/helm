import { createHash, randomUUID } from 'node:crypto'
import { constants, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, relative, sep } from 'node:path'
import { refuse } from '../../../src/document-review/refusal'
import { parseReviewArtifact } from './canvas-artifact'
import { compileReviewCanvas } from './canvas-compiler'
import { REVIEW_DOCUMENT_BYTES } from './types'
import type { ReviewDocument } from './types'

export const reviewRevision = (text: string) => createHash('sha256').update(text).digest('hex')
/**
 * Hidden names (`.helm-*`, `.git/…`) are Helm-private or tool-private evidence and never
 * reviewable. Returns the refusal that names the hidden segment and the way out.
 */
export function reviewHiddenPathRefusal(relativePath: string): string | null {
	const parts = relativePath.split(/[/\\]/)
	const hidden = parts.findIndex(part => part.startsWith('.'))
	if (hidden < 0) return null
	const part = parts[hidden] as string
	return hidden === parts.length - 1
		? `${part} is a hidden file (its name starts with a dot); review opens visible files only. Rename it without the leading dot, for example ${part.replace(/^\.+/, '') || 'review.md'}.`
		: `${parts[parts.length - 1]} is inside the hidden folder ${part}; review opens visible files only. Move it to a visible folder.`
}
export async function readReviewFile(root: string, file: string): Promise<string> {
	const name = basename(file)
	if ((await realpath(root)) !== root || (await realpath(dirname(file))) !== dirname(file))
		throw refuse(`The path to ${name} goes through a symlink. Open its real path.`)
	if (!file.startsWith(`${root}${sep}`)) throw refuse(`${name} is outside the approved repository.`)
	if (!/\.(md|jsx|tsx)$/i.test(file)) throw refuse(`${name} is not a .md, .jsx or .tsx file.`)
	const hidden = reviewHiddenPathRefusal(relative(root, file))
	if (hidden) throw refuse(hidden)
	const parent = await lstat(dirname(file))
	if (!parent.isDirectory() || parent.isSymbolicLink()) throw refuse(`The folder of ${name} is unavailable.`)
	const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT') throw refuse(`${name} does not exist.`)
		if (code === 'ELOOP') throw refuse(`${name} is a symlink. Open the real file.`)
		if (code === 'EACCES') throw refuse(`${name} is not readable by Helm.`)
		throw error
	})
	try {
		const before = await fd.stat()
		if (!before.isFile()) throw refuse(`${name} is not a regular file.`)
		if (before.nlink !== 1) throw refuse(`${name} has more than one hard link; copy it to a new file.`)
		if (before.size > REVIEW_DOCUMENT_BYTES) throw refuse(`${name} is larger than 512 KiB.`)
		if (process.getuid && before.uid !== process.getuid()) throw refuse(`${name} belongs to another user.`)
		if (before.mode & 0o022) throw refuse(`${name} is writable by group or others; run chmod go-w on it.`)
		const bytes = Buffer.alloc(REVIEW_DOCUMENT_BYTES + 1)
		let used = 0
		while (used < bytes.length) {
			const read = await fd.read(bytes, used, bytes.length - used, used)
			if (read.bytesRead === 0) break
			used += read.bytesRead
		}
		const after = await fd.stat()
		const current = await lstat(file)
		if (
			used > REVIEW_DOCUMENT_BYTES ||
			before.dev !== current.dev ||
			before.ino !== current.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			current.isSymbolicLink() ||
			after.nlink !== 1 ||
			(await realpath(root)) !== root ||
			(await realpath(dirname(file))) !== dirname(file)
		)
			throw refuse(`${name} changed while it was read. Try again.`)
		try {
			return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used))
		} catch {
			throw refuse(`${name} is not valid UTF-8 text.`)
		}
	} finally {
		await fd.close()
	}
}

/** Watches only the granted file's containing directory, never a repository tree. */
export class ReviewDocumentObservation {
	readonly id = randomUUID()
	private watcher: FSWatcher | null = null
	private timer: ReturnType<typeof setTimeout> | null = null
	private active: Promise<void> | null = null
	private again = false
	private disposed = false
	private snapshot: ReviewDocument
	/** Why the last read failed, for the opener's log and CLI reason; never shown with document text. */
	failure: unknown = null
	constructor(
		readonly root: string,
		readonly file: string,
		private readonly changed: () => void,
	) {
		this.snapshot = {
			id: this.id,
			name: basename(file),
			relativePath: relative(root, file),
			revision: '',
			text: '',
			previous: null,
			error: null,
		}
	}
	current(): ReviewDocument {
		return { ...this.snapshot }
	}
	async start(): Promise<void> {
		await this.refresh()
		if (this.disposed) return
		this.watcher = watch(dirname(this.file), (_event, name) => {
			if (name !== null && name.toString() !== basename(this.file)) return
			if (this.timer) clearTimeout(this.timer)
			this.timer = setTimeout(() => {
				this.timer = null
				void this.refresh()
			}, 160)
		})
		this.watcher.on('error', () => {
			if (this.disposed) return
			this.snapshot = { ...this.snapshot, error: 'File watching is unavailable. Reopen the document to reconnect.' }
			this.changed()
		})
	}
	refresh(): Promise<void> {
		if (this.disposed) return Promise.resolve()
		if (this.active) {
			this.again = true
			return this.active
		}
		this.active = this.read().finally(() => {
			this.active = null
			if (this.again && !this.disposed) {
				this.again = false
				void this.refresh()
			}
		})
		return this.active
	}
	private async read(): Promise<void> {
		try {
			const raw = await readReviewFile(this.root, this.file)
			if (this.disposed) return
			const format = /\.md$/i.test(this.file) ? 'markdown' : 'jsx'
			let parsed: ReturnType<typeof parseReviewArtifact>
			try {
				parsed = parseReviewArtifact(raw, format)
			} catch {
				throw refuse(
					`The helm-review journal at the end of ${basename(this.file)} is malformed; it was left untouched.`,
				)
			}
			const { body: text, archive } = parsed
			const revision = reviewRevision(text)
			if (
				revision === this.snapshot.revision &&
				archive.revision === this.snapshot.archive?.revision &&
				!this.snapshot.error
			)
				return
			this.snapshot = {
				...this.snapshot,
				text,
				revision,
				format,
				archive,
				...(format === 'jsx'
					? { canvas: revision === this.snapshot.revision ? this.snapshot.canvas : compileReviewCanvas(text) }
					: {}),
				previous:
					this.snapshot.revision && revision !== this.snapshot.revision ? this.snapshot.text : this.snapshot.previous,
				error: null,
			}
			this.failure = null
		} catch (error) {
			if (this.disposed) return
			this.failure = error
			this.snapshot = {
				...this.snapshot,
				error:
					'Document unavailable. It may have moved, been deleted, changed while reading, or lost permission. Reopen or retry; no request will be sent.',
			}
		}
		if (!this.disposed) this.changed()
	}
	async dispose(): Promise<void> {
		this.disposed = true
		this.watcher?.close()
		if (this.timer) clearTimeout(this.timer)
		await this.active
	}
}
