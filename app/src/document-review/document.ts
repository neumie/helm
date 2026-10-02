import { createHash, randomUUID } from 'node:crypto'
import { constants, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, relative, sep } from 'node:path'
import { REVIEW_DOCUMENT_BYTES } from './types'
import type { ReviewDocument } from './types'

export const reviewRevision = (text: string) => createHash('sha256').update(text).digest('hex')
export async function readReviewFile(root: string, file: string): Promise<string> {
	if (
		(await realpath(root)) !== root ||
		(await realpath(dirname(file))) !== dirname(file) ||
		!file.startsWith(`${root}${sep}`) ||
		!/\.md$/i.test(file) ||
		/(?:^|[/\\])\.[^/\\]+/.test(relative(root, file))
	)
		throw new Error('Choose a visible Markdown file inside the approved repository.')
	const parent = await lstat(dirname(file))
	if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('The document folder is unavailable.')
	const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const before = await fd.stat()
		if (!before.isFile() || before.nlink !== 1 || before.size > REVIEW_DOCUMENT_BYTES)
			throw new Error('Review supports regular Markdown files up to 512 KiB; linked files are not supported.')
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
			throw new Error('The file changed during reading. Try again.')
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used))
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
			const text = await readReviewFile(this.root, this.file)
			if (this.disposed) return
			const revision = reviewRevision(text)
			if (revision === this.snapshot.revision && !this.snapshot.error) return
			this.snapshot = {
				...this.snapshot,
				text,
				revision,
				previous:
					this.snapshot.revision && revision !== this.snapshot.revision ? this.snapshot.text : this.snapshot.previous,
				error: null,
			}
		} catch {
			if (this.disposed) return
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
