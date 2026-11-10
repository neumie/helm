import { createHash, randomUUID } from 'node:crypto'
import { constants, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, relative, sep } from 'node:path'
import { PICTURE_MIME, type PictureType } from '../../../src/document-review/formats'
import { refuse } from '../../../src/document-review/refusal'
import { parseReviewArtifact } from './canvas-artifact'
import { compileReviewCanvas } from './canvas-compiler'
import { convertHeic, memoryViewerSource } from './heic'
import { REVIEW_DOCUMENT_BYTES } from './types'
import type { ReviewDocument, ReviewViewerFile, ReviewViewerPicture } from './types'
import { pinnedViewerSource, readViewerFile, viewerFormat } from './viewer-file'
import type { HelmPrivatePaths, ViewerFileIdentity, ViewerFormat } from './viewer-file'
import { type ViewerFileSource, type ViewerFileTokens, viewerFileUrl } from './viewer-protocol'

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

/** Plain viewing (`helm open`): the viewer admission instead of the repository grant, and a display path. */
export interface PlainObservation {
	paths: HelmPrivatePaths
	displayPath: string
	/** The view's own helm-viewer: tokens; code/text/data bytes are served through them, never over IPC. */
	tokens?: ViewerFileTokens
	/** Test seam for the HEIC conversion (another `sips`, shorter budgets). */
	heic?: import('./heic').HeicOptions
}
interface PlainRead {
	format: ViewerFormat
	text: string
	revision: string
	viewer?: Omit<ReviewViewerFile, 'url'>
	picture?: Omit<ReviewViewerPicture, 'url'>
	source?: ViewerFileSource
	/** The pinned descriptor's identity: when it moves, the token must too, even for the same bytes. */
	identity?: ViewerFileIdentity
}
const sameIdentity = (a: ViewerFileIdentity | null, b: ViewerFileIdentity | undefined) =>
	Boolean(a && b) &&
	a?.dev === b?.dev &&
	a?.ino === b?.ino &&
	a?.size === b?.size &&
	a?.mtimeMs === b?.mtimeMs &&
	a?.ctimeMs === b?.ctimeMs

/** Watches only the granted file's containing directory, never a repository tree. */
export class ReviewDocumentObservation {
	readonly id = randomUUID()
	private watcher: FSWatcher | null = null
	private timer: ReturnType<typeof setTimeout> | null = null
	private convertSignal: AbortSignal | undefined
	private active: Promise<void> | null = null
	private again = false
	private disposed = false
	private snapshot: ReviewDocument
	/** The token serving the current plain code/text/data revision. */
	private token: string | null = null
	/** Identity the current token's pinned descriptor checks on every read. */
	private tokenIdentity: ViewerFileIdentity | null = null
	/** Why the last read failed, for the opener's log and CLI reason; never shown with document text. */
	failure: unknown = null
	constructor(
		readonly root: string,
		readonly file: string,
		private readonly changed: () => void,
		/** Present for a plain `helm open` window: read-only, no repository, the journal hidden but never required. */
		readonly plain: PlainObservation | null = null,
	) {
		this.snapshot = {
			id: this.id,
			name: basename(file),
			relativePath: plain ? plain.displayPath : relative(root, file),
			revision: '',
			text: '',
			previous: null,
			error: null,
		}
	}
	current(): ReviewDocument {
		return { ...this.snapshot }
	}
	/** `convert` bounds a HEIC conversion during this first read only (helm open's batch budget). */
	async start(options: { convert?: AbortSignal } = {}): Promise<void> {
		this.convertSignal = options.convert
		try {
			await this.refresh()
		} finally {
			this.convertSignal = undefined
		}
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
	/**
	 * Plain viewing reruns the whole viewer admission on every read and requires the same canonical file. Markdown
	 * comes back as text; code, text and data keep their admitted descriptor pinned for the view's token.
	 */
	private async readPlain(plain: PlainObservation): Promise<PlainRead> {
		const pin = Boolean(plain.tokens) && viewerFormat(this.file).format !== 'markdown'
		const read = await readViewerFile(this.file, plain.paths, {}, { pin })
		if (read.file !== this.file) {
			await read.handle?.close()
			throw refuse(`${basename(this.file)} now leads to another file. Open it again with helm open.`)
		}
		if (read.format === 'markdown') {
			let text = read.text
			try {
				// A trailing helm-review journal is review machinery: hidden from plain viewing (its saved comments
				// belong to feedback mode), never required and never written here. Unreadable, it is shown as text.
				text = parseReviewArtifact(read.text, 'markdown').body
			} catch {}
			return { format: 'markdown', text, revision: reviewRevision(text) }
		}
		if (read.format === 'image' || read.format === 'heic' || read.format === 'svg') return this.readPicture(read)
		let body = read.text
		// A plain .jsx/.tsx is source; its trailing review journal is hidden like Markdown's. Other formats never
		// have one, so their tail is never parsed as a journal.
		if ((read.language === 'jsx' || read.language === 'tsx') && read.encoding.startsWith('utf-8'))
			try {
				body = parseReviewArtifact(read.text, 'jsx').body
			} catch {}
		const served = body === read.text ? read.size : Buffer.byteLength(body, 'utf8')
		const viewer = {
			language: read.language,
			size: served,
			encoding: read.encoding,
			lines: read.lines,
			ending: read.ending,
		}
		const source = read.handle && read.identity ? pinnedViewerSource(read.handle, read.identity, served) : undefined
		return {
			format: read.format,
			text: '',
			revision: reviewRevision(body),
			viewer,
			...(source && read.identity ? { source, identity: read.identity } : {}),
		}
	}
	/**
	 * Pictures: raster and SVG bytes are served from the pinned descriptor as they are; a HEIC is converted to PNG
	 * out of process once per file identity (a spurious watch event does not convert it again).
	 */
	private async readPicture(read: Awaited<ReturnType<typeof readViewerFile>>): Promise<PlainRead> {
		const type = read.language as PictureType
		const identity = read.identity
		const revision =
			read.format === 'svg'
				? reviewRevision(read.text)
				: `picture:${identity ? `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}` : ''}`
		const fileSize = read.size
		if (!read.handle || !identity) {
			await read.handle?.close()
			return { format: 'image', text: '', revision }
		}
		const pinned = pinnedViewerSource(read.handle, identity, read.size)
		if (read.format !== 'heic')
			return {
				format: 'image',
				text: '',
				revision,
				picture: { type, mime: PICTURE_MIME[type], size: read.size, fileSize },
				source: pinned,
				identity,
			}
		if (revision === this.snapshot.revision && !this.snapshot.error) {
			await pinned.close()
			return { format: 'image', text: '', revision }
		}
		try {
			const signal = this.convertSignal ?? this.plain?.heic?.signal
			const converted = await convertHeic(basename(this.file), pinned, { ...this.plain?.heic, signal })
			return {
				format: 'image',
				text: '',
				revision,
				picture: {
					type: 'heic',
					mime: PICTURE_MIME.heic,
					size: converted.png.length,
					fileSize,
					pixels: { width: converted.width, height: converted.height },
				},
				source: memoryViewerSource(converted.png),
				identity,
			}
		} finally {
			await pinned.close()
		}
	}
	private async read(): Promise<void> {
		try {
			if (this.plain) {
				const next = await this.readPlain(this.plain)
				// Same bytes and no error: nothing to publish, unless the file was touched, chmod-ed or rewritten with
				// identical bytes. Then the current token answers 409 for good, so it is replaced like a new version.
				const unchanged =
					next.revision === this.snapshot.revision &&
					!this.snapshot.error &&
					(!next.source || sameIdentity(this.tokenIdentity, next.identity))
				if (this.disposed || unchanged) {
					await next.source?.close()
					return
				}
				let viewer: ReviewViewerFile | undefined
				let picture: ReviewViewerPicture | undefined
				if ((next.viewer || next.picture) && next.source && this.plain.tokens) {
					const token = this.plain.tokens.issue(next.source)
					const previous = this.token
					this.token = token
					this.tokenIdentity = next.identity ?? null
					if (previous) void this.plain.tokens.revoke(previous)
					if (next.viewer) viewer = { ...next.viewer, url: viewerFileUrl(token) }
					if (next.picture) picture = { ...next.picture, url: viewerFileUrl(token) }
				}
				const { viewer: _old, picture: _oldPicture, ...rest } = this.snapshot
				this.snapshot = {
					...rest,
					text: next.text,
					revision: next.revision,
					format: next.format === 'svg' || next.format === 'heic' ? 'image' : next.format,
					...(viewer ? { viewer } : {}),
					...(picture ? { picture } : {}),
					previous:
						next.format === 'markdown' && this.snapshot.revision && next.revision !== this.snapshot.revision
							? this.snapshot.text
							: next.format === 'markdown'
								? this.snapshot.previous
								: null,
					error: null,
				}
				this.failure = null
				if (!this.disposed) this.changed()
				return
			}
			const raw = await readReviewFile(this.root, this.file)
			if (this.disposed) return
			const format = /\.md$/i.test(this.file) ? 'markdown' : 'jsx'
			let parsed: ReturnType<typeof parseReviewArtifact>
			try {
				parsed = parseReviewArtifact(raw, format)
			} catch (error) {
				// The parser's reason is a fixed phrase and line number, never document text.
				const reason = (error as { reason?: unknown })?.reason
				throw refuse(
					`The helm-review journal at the end of ${basename(this.file)} ${typeof reason === 'string' ? `cannot be read (${reason})` : 'is malformed'}; it was left untouched.`,
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
		if (this.token && this.plain?.tokens) await this.plain.tokens.revoke(this.token)
		this.token = null
		this.tokenIdentity = null
	}
}
