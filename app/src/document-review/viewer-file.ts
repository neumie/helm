// Plain-mode admission for `helm open` (docs/plans/helm-open/spec.md, Access and security): one canonical path,
// one descriptor, Helm's private files refused by path and by inode. Feedback mode keeps `readReviewFile`.
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
	CSV_HEAD_BYTES,
	type LineEnding,
	PDF_HEAD_BYTES,
	PICTURE_HEAD_BYTES,
	type PictureType,
	type TextEncoding,
	binarySignature,
	countText,
	decoderLabel,
	detectViewerFormat,
	pdfMismatch,
	pictureMismatch,
	sizeText,
	textEncoding,
	textShape,
} from '../../../src/document-review/formats'
import { refuse } from '../../../src/document-review/refusal'
import { type ViewerFileSource, ViewerSourceChanged } from './viewer-protocol'

export { VIEWER_MARKDOWN_BYTES } from '../../../src/document-review/formats'
/** How many entries a hard-link check may visit under Helm's private roots before it gives up and refuses. */
export const PRIVATE_SCAN_ENTRIES = 50_000

/**
 * Helm's own state. `trees` are whole private directories; `daemonRoots` hold the daemon's config, database and
 * profiles next to unrelated repository files, so only those names are private there.
 */
export interface HelmPrivatePaths {
	trees: string[]
	daemonRoots: string[]
	files: string[]
	uid: number | null
	/** Folder that holds Helm's `/tmp/helm-*-<uid>` socket and run directories (canonical `/private/tmp` on macOS). */
	tmp: string
}

/** The daemon root's own files: config, database (+ WAL/SHM) and the profile registry (`ProfileStore.statePath`). */
const DAEMON_FILE = /^(?:(?:helm|vigil)\.(?:config\.json|db(?:-.*)?)|profiles\.json)$/i

async function canonical(path: string): Promise<string> {
	try {
		return await realpath(path)
	} catch {
		return resolve(path)
	}
}

/** Canonicalises every root once so a later path comparison sees `/private/tmp`, never `/tmp`. */
export async function helmPrivatePaths(input: {
	home: string
	userData: string
	daemonRoots: string[]
	authFile: string
	uid: number | null
	tmp?: string
}): Promise<HelmPrivatePaths> {
	return {
		trees: await Promise.all(
			[join(input.home, '.helm'), input.userData, join(input.home, 'Library', 'Logs', 'helm')].map(canonical),
		),
		daemonRoots: await Promise.all(input.daemonRoots.map(canonical)),
		files: [await canonical(input.authFile)],
		uid: input.uid,
		tmp: await canonical(input.tmp ?? '/tmp'),
	}
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`)
/**
 * macOS firmlinks: `realpath` keeps `/System/Volumes/Data/Users/…` as written although it is `/Users/…`. The
 * path check compares both spellings; the inode check below catches every other alias.
 */
const DATA_VOLUME = '/System/Volumes/Data'
const pathSpellings = (path: string) =>
	path.startsWith(`${DATA_VOLUME}/`) ? [path, path.slice(DATA_VOLUME.length)] : [path]
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const tmpEntry = (name: string, uid: number | null) =>
	uid !== null && (name === `helm-${uid}` || (name.startsWith('helm-') && name.endsWith(`-${uid}`)))

/** Path half of the deny check, on the canonical path. Returns the refusal, or null when the path is not private. */
export function privatePathRefusal(path: string, paths: HelmPrivatePaths): string | null {
	for (const spelling of pathSpellings(path)) {
		const refusal = spellingRefusal(spelling, paths)
		if (refusal) return refusal
	}
	return null
}
function spellingRefusal(path: string, paths: HelmPrivatePaths): string | null {
	const name = basename(path)
	const message = `${name} is one of Helm's private files; helm open never shows them.`
	if (path.split(sep).some(part => part.toLowerCase().startsWith('.helm-'))) return message
	if (paths.trees.some(root => inside(path, root))) return message
	if (paths.files.includes(path)) return message
	for (const root of paths.daemonRoots)
		if ((dirname(path) === root && DAEMON_FILE.test(name)) || inside(path, join(root, 'profiles'))) return message
	if (inside(path, paths.tmp)) {
		const first = path.slice(paths.tmp.length + 1).split(sep)[0] ?? ''
		if (tmpEntry(first, paths.uid)) return message
	}
	return null
}

/** Every private root a hard link to the opened inode could hide behind (same device only). */
async function privateRoots(paths: HelmPrivatePaths): Promise<string[]> {
	const roots = [...paths.trees, ...paths.files]
	for (const root of paths.daemonRoots) {
		roots.push(join(root, 'profiles'))
		try {
			for (const name of await readdir(root)) if (DAEMON_FILE.test(name)) roots.push(join(root, name))
		} catch (error) {
			// A missing daemon root holds nothing; one Helm cannot list could hide anything.
			if (!missing(error)) throw refuse(unchecked(root))
		}
	}
	try {
		for (const name of await readdir(paths.tmp)) if (tmpEntry(name, paths.uid)) roots.push(join(paths.tmp, name))
	} catch (error) {
		if (!missing(error)) throw refuse(unchecked(paths.tmp))
	}
	return roots
}
const unchecked = (folder: string) =>
	`Helm could not check its private files in ${folder}, so helm open shows nothing until it can. Nothing was opened.`
const linkedMessage = (name: string) =>
	`${name} is a hard link to one of Helm's private files; helm open never shows it.`
const identity = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`

/**
 * Inode half of the deny check, for every file: the opened inode must not be one of Helm's private roots, and no
 * folder on its canonical path may be one either. This catches a path alias the string check cannot see (a
 * firmlink, another mount of the same volume) without walking anything.
 */
async function aliasRefusal(name: string, file: string, stat: Stats, roots: string[]): Promise<string | null> {
	const ids = new Set<string>()
	for (const root of roots) {
		const entry = await lstat(root).catch(error => {
			if (missing(error)) return null
			throw refuse(unchecked(root))
		})
		if (entry) ids.add(identity(entry))
	}
	// The path check already passed, so a match was reached under another name: a hard link or an alias.
	if (ids.has(identity(stat)))
		return stat.nlink > 1 ? linkedMessage(name) : `${name} is one of Helm's private files; helm open never shows them.`
	for (let folder = dirname(file); ; folder = dirname(folder)) {
		const entry = await lstat(folder).catch(() => null)
		if (!entry) throw refuse(`${name} changed while it was opened. Try again.`)
		if (ids.has(identity(entry))) return `${name} is one of Helm's private files; helm open never shows them.`
		if (folder === dirname(folder)) return null
	}
}

/**
 * Hard-link half of the deny check, for a file with more than one link: `ln ~/.helm/local-api-token notes.md` must not
 * show the token. Walks Helm's private roots without following symlinks, within PRIVATE_SCAN_ENTRIES; a walk that
 * cannot finish refuses instead of guessing.
 */
async function hardLinkRefusal(name: string, stat: Stats, roots: string[]): Promise<string | null> {
	let budget = PRIVATE_SCAN_ENTRIES
	const incomplete = `${name} has more than one hard link and Helm could not check all of its private files against it. Copy ${name} and open the copy.`
	const pending: string[] = []
	for (const root of roots) {
		const entry = await lstat(root).catch(error => {
			if (missing(error)) return null
			throw refuse(incomplete)
		})
		if (!entry || entry.dev !== stat.dev) continue
		if (entry.ino === stat.ino) return linkedMessage(name)
		if (entry.isDirectory()) pending.push(root)
	}
	while (pending.length) {
		const folder = pending.pop() as string
		let names: string[]
		try {
			names = await readdir(folder)
		} catch {
			// A walk that cannot finish refuses instead of guessing.
			return incomplete
		}
		for (const child of names) {
			if (--budget < 0) return incomplete
			const path = join(folder, child)
			let entry: Stats
			try {
				entry = await lstat(path)
			} catch {
				return incomplete
			}
			if (entry.dev !== stat.dev) continue
			if (entry.ino === stat.ino) return linkedMessage(name)
			if (entry.isDirectory()) pending.push(path)
		}
	}
	return null
}

const kind = (stat: Stats) =>
	stat.isDirectory()
		? 'a folder'
		: stat.isFIFO()
			? 'a named pipe'
			: stat.isSocket()
				? 'a socket'
				: stat.isCharacterDevice() || stat.isBlockDevice()
					? 'a device'
					: 'not a regular file'
/** Plain formats this version shows; feedback mode keeps `readReviewFile`'s md/jsx/tsx rule. */
export type ViewerFormat = 'markdown' | 'code' | 'text' | 'data' | 'image' | 'svg' | 'heic' | 'pdf' | 'csv'
const VIEWER_FORMATS: ReadonlySet<string> = new Set([
	'markdown',
	'code',
	'text',
	'data',
	'image',
	'svg',
	'heic',
	'pdf',
	'csv',
])

export interface ViewerFormatChoice {
	format: ViewerFormat
	/** CodeMirror language id (code/text) or data language (data); 'markdown' for Markdown. */
	language: string
	limit: number
	maxLines: number | null
	noun: string
}

/** Which plain viewer shows a canonical path, from the shared registry (src/document-review/formats.ts). */
export function viewerFormat(path: string): ViewerFormatChoice {
	const detected = detectViewerFormat(basename(path))
	if (!detected.ok) throw refuse(detected.reason)
	const format = detected.entry.format
	if (!VIEWER_FORMATS.has(format)) throw refuse(`Helm can't show ${detected.entry.noun} yet (${basename(path)}).`)
	return {
		format: format as ViewerFormat,
		language: detected.language,
		limit: detected.entry.maxBytes,
		maxLines: detected.entry.maxLines ?? null,
		noun: detected.entry.noun,
	}
}

export interface ViewerFile {
	file: string
	format: ViewerFormat
	/**
	 * CodeMirror/data language for text families; the picture type (`png`, `svg`, `heic`, …) for pictures; `pdf`;
	 * `csv` or `tsv` (tab-separated) for CSV files.
	 */
	language: string
	/** Decoded text for text families and SVG; empty for raster/HEIC pictures, PDFs and CSV (their bytes go by token). */
	text: string
	size: number
	encoding: TextEncoding
	lines: number
	ending: LineEnding
	/** Only with `pin`: the admitted descriptor, still open. The caller owns it and must close it. */
	handle?: FileHandle
	/** Only with `pin`: identity the descriptor must keep for its bytes to still be the admitted ones. */
	identity?: ViewerFileIdentity
}
export interface ViewerFileIdentity {
	dev: number
	ino: number
	size: number
	mtimeMs: number
	ctimeMs: number
}
export interface ViewerReadHooks {
	/** Test seam: runs between the path checks and the open, where a path swap would land. */
	beforeOpen?(canonical: string): Promise<void> | void
}
export interface ViewerReadOptions {
	/** Keep the descriptor open so the viewer protocol can serve exactly these bytes later. */
	pin?: boolean
}

/** Decode a text family's bytes, or refuse with what they are instead. */
export function decodeViewerText(name: string, bytes: Uint8Array): { text: string; encoding: TextEncoding } {
	const encoding = textEncoding(bytes.subarray(0, 4))
	if (encoding === 'utf-8') {
		const what = binarySignature(bytes.subarray(0, 16))
		if (what) throw refuse(`${name} is not a text file (it starts like ${what}).`)
	}
	if ((encoding === 'utf-16le' || encoding === 'utf-16be') && bytes.length % 2 !== 0)
		throw refuse(`${name} is not valid UTF-16 text (an odd number of bytes).`)
	let text: string
	try {
		text = new TextDecoder(decoderLabel(encoding), { fatal: true, ignoreBOM: true }).decode(bytes)
	} catch {
		throw refuse(
			encoding === 'utf-8'
				? `${name} is not valid UTF-8 text; Helm shows UTF-8 and UTF-16 (with a byte order mark) text.`
				: `${name} is not valid UTF-16 text.`,
		)
	}
	if (text.includes('\u0000')) throw refuse(`${name} contains NUL bytes, so it is not a text file.`)
	return { text, encoding }
}

/**
 * One admission, one descriptor: realpath → deny by path → lstat (regular file, size) → open with
 * O_NOFOLLOW|O_NONBLOCK|O_NOCTTY → fstat must be the same inode as the lstat and the path, parent unchanged → deny
 * by inode → read → re-stat. Any change refuses with "changed while reading". Never writes, never follows a link
 * after the realpath. Limits come from the format registry (Markdown 512 KiB, text/code 16 MiB and 1 M lines,
 * data 32 MiB).
 */
export async function readViewerFile(
	rawPath: string,
	paths: HelmPrivatePaths,
	hooks: ViewerReadHooks = {},
	options: ViewerReadOptions = {},
): Promise<ViewerFile> {
	const requested = resolve(rawPath)
	let file: string
	try {
		file = await realpath(requested)
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		const name = basename(requested)
		if (code === 'ENOENT') throw refuse(`${name} does not exist.`)
		if (code === 'EACCES') throw refuse(`${name} is not readable by Helm (a folder on its path is closed).`)
		if (code === 'ELOOP') throw refuse(`${name} is a symlink loop.`)
		throw refuse(`${name} could not be resolved (${code ?? 'unknown error'}).`)
	}
	const name = basename(file)
	const denied = privatePathRefusal(file, paths)
	if (denied) throw refuse(denied)
	const before = await lstat(file).catch(() => null)
	if (!before) throw refuse(`${name} changed while it was opened. Try again.`)
	if (before.isSymbolicLink()) throw refuse(`${name} changed while it was opened (it became a symlink). Try again.`)
	if (!before.isFile()) throw refuse(`${name} is ${kind(before)}; helm open shows regular files only.`)
	const choice = viewerFormat(file)
	const limit = choice.limit
	const tooBig = (size: number) =>
		refuse(`${name} is ${sizeText(size)}; Helm shows ${choice.noun} up to ${sizeText(limit)}.`)
	if (before.size > limit) throw tooBig(before.size)
	await hooks.beforeOpen?.(file)
	const fd = await open(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0),
	).catch(error => {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ELOOP') throw refuse(`${name} changed while it was opened (it became a symlink). Try again.`)
		if (code === 'ENOENT') throw refuse(`${name} changed while it was opened (it is gone). Try again.`)
		if (code === 'EACCES') throw refuse(`${name} is not readable by Helm.`)
		throw refuse(`${name} could not be opened (${code ?? 'unknown error'}).`)
	})
	let keep = false
	try {
		const opened = await fd.stat()
		const path = await lstat(file).catch(() => null)
		if (
			!opened.isFile() ||
			!path ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino ||
			path.dev !== opened.dev ||
			path.ino !== opened.ino ||
			(await realpath(dirname(file)).catch(() => null)) !== dirname(file)
		)
			throw refuse(`${name} changed while it was opened. Try again.`)
		const roots = await privateRoots(paths)
		const alias = await aliasRefusal(name, file, opened, roots)
		if (alias) throw refuse(alias)
		if (opened.nlink > 1) {
			const linked = await hardLinkRefusal(name, opened, roots)
			if (linked) throw refuse(linked)
		}
		if (opened.size > limit) throw tooBig(opened.size)
		if (choice.format === 'image' || choice.format === 'heic' || choice.format === 'pdf' || choice.format === 'csv') {
			// Pictures, PDFs and CSV: only the first bytes are read here; extension and magic must agree. Width/height
			// come from the header in the viewer's image worker (HEIC from `sips`), pages from pdf.js in its own worker,
			// rows from the grid's worker (which also decodes strictly); nothing in main decodes the bytes.
			const headBytes =
				choice.format === 'pdf' ? PDF_HEAD_BYTES : choice.format === 'csv' ? CSV_HEAD_BYTES : PICTURE_HEAD_BYTES
			const head = Buffer.alloc(Math.min(opened.size, headBytes))
			let got = 0
			while (got < head.length) {
				const read = await fd.read(head, got, head.length - got, got)
				if (read.bytesRead === 0) break
				got += read.bytesRead
			}
			const after = await fd.stat()
			const still = await lstat(file).catch(() => null)
			if (
				got !== head.length ||
				after.size !== opened.size ||
				after.mtimeMs !== opened.mtimeMs ||
				after.ctimeMs !== opened.ctimeMs ||
				!still ||
				still.dev !== opened.dev ||
				still.ino !== opened.ino
			)
				throw refuse(`${name} changed while it was read. Try again.`)
			// An empty CSV is an empty grid; an empty picture or PDF is nothing to show.
			if (opened.size === 0 && choice.format !== 'csv') throw refuse(`${name} is empty.`)
			let encoding: TextEncoding = 'utf-8'
			if (choice.format === 'csv') {
				encoding = textEncoding(head)
				const what = encoding === 'utf-8' ? binarySignature(head) : null
				if (what) throw refuse(`${name} is not a text file (it starts like ${what}).`)
				if ((encoding === 'utf-16le' || encoding === 'utf-16be') && opened.size % 2 !== 0)
					throw refuse(`${name} is not valid UTF-16 text (an odd number of bytes).`)
			} else {
				const mismatch =
					choice.format === 'pdf'
						? pdfMismatch(name, head)
						: pictureMismatch(name, choice.language as Exclude<PictureType, 'svg'>, head)
				if (mismatch) throw refuse(mismatch)
			}
			const identity = {
				dev: opened.dev,
				ino: opened.ino,
				size: opened.size,
				mtimeMs: opened.mtimeMs,
				ctimeMs: opened.ctimeMs,
			}
			const result: ViewerFile = {
				file,
				format: choice.format,
				language: choice.language,
				text: '',
				size: opened.size,
				encoding,
				lines: 0,
				ending: 'none',
				identity,
			}
			if (options.pin) {
				keep = true
				result.handle = fd
			}
			return result
		}
		// One byte past the admitted size shows growth; never the whole family limit (32 MiB for a 1 KiB file).
		const bytes = Buffer.alloc(Math.min(opened.size, limit) + 1)
		let used = 0
		while (used < bytes.length) {
			const read = await fd.read(bytes, used, bytes.length - used, used)
			if (read.bytesRead === 0) break
			used += read.bytesRead
		}
		const after = await fd.stat()
		const still = await lstat(file).catch(() => null)
		if (
			used > limit ||
			used !== opened.size ||
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs ||
			!still ||
			still.dev !== opened.dev ||
			still.ino !== opened.ino
		)
			throw refuse(`${name} changed while it was read. Try again.`)
		const { text, encoding } = decodeViewerText(name, bytes.subarray(0, used))
		// An SVG is shown only as an <img>; the text must at least have an <svg> element (no SVGZ, no HTML).
		if (choice.format === 'svg' && !/<(?:[A-Za-z_][\w.-]*:)?svg[\s>/]/.test(text))
			throw refuse(`${name} is not an SVG image (it has no <svg> element).`)
		const shape = textShape(text)
		if (choice.maxLines !== null && shape.lines > choice.maxLines)
			throw refuse(
				`${name} has ${countText(shape.lines)} lines; Helm shows ${choice.noun} up to ${countText(choice.maxLines)} lines.`,
			)
		const result: ViewerFile = {
			file,
			format: choice.format,
			language: choice.language,
			text,
			size: used,
			encoding,
			lines: shape.lines,
			ending: shape.ending,
		}
		if (options.pin) {
			keep = true
			result.handle = fd
			result.identity = {
				dev: opened.dev,
				ino: opened.ino,
				size: opened.size,
				mtimeMs: opened.mtimeMs,
				ctimeMs: opened.ctimeMs,
			}
		}
		return result
	} finally {
		if (!keep) await fd.close()
	}
}

/** The launchd daemon's `WorkingDirectory` from its plist text (where it keeps helm.db), or null. */
export function plistWorkingDirectory(plist: string): string | null {
	const match = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)
	if (!match?.[1]) return null
	const value = match[1]
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&')
	return value.startsWith('/') ? value : null
}

/**
 * Serves a pinned descriptor's admitted bytes to the viewer protocol: every read checks before and after that the
 * descriptor still has the identity it had when it was admitted (same inode, size, mtime, ctime), so a file rewritten
 * in place answers "changed" (409) instead of unvalidated or mixed bytes; the watcher then admits the new revision.
 * `length` may stop short of the file (a plain .tsx hides its trailing review journal).
 */
export function pinnedViewerSource(handle: FileHandle, identity: ViewerFileIdentity, length: number): ViewerFileSource {
	let closed = false
	return {
		size: length,
		async read(offset, count) {
			if (closed) throw new ViewerSourceChanged('closed')
			if (offset < 0 || count < 0 || offset + count > length) throw new RangeError('outside the served bytes')
			const unchanged = async () => {
				const now = await handle.stat()
				return (
					now.dev === identity.dev &&
					now.ino === identity.ino &&
					now.size === identity.size &&
					now.mtimeMs === identity.mtimeMs &&
					// An editor's atomic save unlinks the old inode, which moves only its ctime: once no name points at
					// it, nothing can open it to write, so its bytes are still the admitted ones (a writer that already
					// had it open moves mtime).
					(now.ctimeMs === identity.ctimeMs || now.nlink === 0)
				)
			}
			if (!(await unchanged())) throw new ViewerSourceChanged('changed')
			const bytes = Buffer.alloc(count)
			let used = 0
			while (used < count) {
				const read = await handle.read(bytes, used, count - used, offset + used)
				if (read.bytesRead === 0) break
				used += read.bytesRead
			}
			if (used !== count) throw new ViewerSourceChanged('short read')
			// A write that landed during the read would mix two versions in one answer: check again afterwards.
			if (!(await unchanged())) throw new ViewerSourceChanged('changed')
			return bytes
		},
		async close() {
			if (closed) return
			closed = true
			await handle.close()
		},
	}
}
