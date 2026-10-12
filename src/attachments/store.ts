import { randomUUID } from 'node:crypto'
import {
	constants,
	type Stats,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { profileRuntimeRoot } from '../profiles/runtime.js'

const attachmentsRoot = (profileId?: string) => resolve(profileRuntimeRoot(profileId), 'attachments')
export const WORKTREE_ATTACHMENT_SUBDIR = '.helm-attachments'

const MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.heic': 'image/heic',
	'.pdf': 'application/pdf',
	'.txt': 'text/plain',
	'.md': 'text/markdown',
	'.csv': 'text/csv',
	'.json': 'application/json',
}
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'application/pdf'])
export function isInlineSafeContentType(contentType: string): boolean {
	return INLINE_SAFE.has(contentType)
}
export function sanitizeAttachmentName(name: string): string {
	const safe = basename(name)
		.replace(/[^A-Za-z0-9._-]/g, '_')
		.replace(/^\.+/, '')
		.slice(0, 120)
	return safe.length > 0 ? safe : 'file'
}
export function attachmentsDir(itemId: string, profileId?: string): string {
	return join(attachmentsRoot(profileId), sanitizeAttachmentName(itemId))
}
export function attachmentMimeType(name: string, fallback = 'application/octet-stream'): string {
	return MIME_BY_EXT[extname(sanitizeAttachmentName(name)).toLowerCase()] ?? fallback
}
export function saveAttachment(itemId: string, name: string, bytes: Buffer, profileId?: string): string {
	const dir = attachmentsDir(itemId, profileId)
	mkdirSync(dir, { recursive: true })
	let finalName = sanitizeAttachmentName(name)
	if (existsSync(join(dir, finalName))) {
		const ext = extname(finalName)
		const stem = finalName.slice(0, finalName.length - ext.length)
		let i = 1
		do {
			const suffix = `-${i++}`
			// Sanitization produces ASCII, so these UTF-16 slices cannot split a surrogate.
			const boundedExt = ext.slice(0, 120 - suffix.length - 1)
			finalName = `${stem.slice(0, 120 - suffix.length - boundedExt.length)}${suffix}${boundedExt}`
		} while (existsSync(join(dir, finalName)))
	}
	writeFileSync(join(dir, finalName), bytes)
	return finalName
}
export function readAttachment(itemId: string, name: string, profileId?: string): Buffer | null {
	const path = join(attachmentsDir(itemId, profileId), sanitizeAttachmentName(name))
	if (!existsSync(path)) return null
	return readFileSync(path)
}
const OPENABLE_EXT = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.heic',
	'.bmp',
	'.pdf',
	'.txt',
	'.md',
	'.csv',
	'.json',
	'.xml',
	'.xlsx',
	'.xls',
	'.docx',
	'.doc',
	'.pptx',
	'.ppt',
	'.mp4',
	'.mov',
	'.webm',
	'.wav',
	'.mp3',
])
export function isOpenableAttachment(name: string): boolean {
	return OPENABLE_EXT.has(extname(sanitizeAttachmentName(name)).toLowerCase())
}
export function attachmentPath(itemId: string, name: string, profileId?: string): string | null {
	const path = join(attachmentsDir(itemId, profileId), sanitizeAttachmentName(name))
	return existsSync(path) ? path : null
}
export function removeItemAttachments(itemId: string, profileId?: string): void {
	rmSync(attachmentsDir(itemId, profileId), { recursive: true, force: true })
}

export interface PreparedAttachment {
	name: string
	bytes: Buffer
}

function assertSafeDirectory(path: string, label: string): void {
	const stat = lstatSync(path)
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is unsafe`)
}

/** Node lacks openat(2), so ancestor swaps cannot be eliminated completely. The
 * final open uses O_NOFOLLOW and every owned component is lstat-checked. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

function readRegularNoFollow(path: string, label: string): Buffer {
	let fd: number | undefined
	try {
		fd = openSync(path, constants.O_RDONLY | NO_FOLLOW)
		const stat = fstatSync(fd)
		if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
		return Buffer.from(readFileSync(fd))
	} finally {
		if (fd !== undefined) closeSync(fd)
	}
}

function optionalLstat(path: string): Stats | null {
	try {
		return lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}

function sameInode(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino
}

function assertOwnedDestination(stat: Stats, path: string): void {
	if ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0)
		throw new Error(`Attachment destination ownership or permissions are unsafe: ${path}`)
}

function destinationIdentity(path: string): Stats | null {
	const stat = optionalLstat(path)
	if (stat) {
		if (!stat.isFile() || stat.nlink !== 1)
			throw new Error(`Attachment destination must be a regular single-link file: ${path}`)
		assertOwnedDestination(stat, path)
	}
	return stat
}

function assertDestinationUnchanged(path: string, expected: Stats | null): void {
	const current = destinationIdentity(path)
	if (
		expected === null
			? current !== null
			: !current ||
				!sameInode(expected, current) ||
				expected.size !== current.size ||
				expected.mtimeMs !== current.mtimeMs ||
				expected.ctimeMs !== current.ctimeMs
	)
		throw new Error(`Attachment destination changed: ${path}`)
}

/** Never truncate a retained inode. Checks narrow pathname races, but Node has
 * no descriptor-relative rename: this is not isolation from arbitrary same-user swaps. */
function writeRegularNoFollow(path: string, bytes: Buffer, expected: Stats | null, assertParents: () => void): void {
	const temp = join(resolve(path, '..'), `.helm-attachment-${randomUUID()}.tmp`)
	let fd: number | undefined
	let owned: Stats | undefined
	try {
		assertParents()
		assertDestinationUnchanged(path, expected)
		fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600)
		owned = fstatSync(fd)
		writeFileSync(fd, bytes)
		const written = fstatSync(fd)
		assertParents()
		assertDestinationUnchanged(path, expected)
		const published = destinationIdentity(temp)
		if (
			!published ||
			!sameInode(written, published) ||
			published.size !== bytes.length ||
			published.mtimeMs !== written.mtimeMs ||
			published.ctimeMs !== written.ctimeMs
		)
			throw new Error('Attachment temporary file changed')
		renameSync(temp, path)
	} finally {
		if (fd !== undefined) closeSync(fd)
		if (owned) {
			// Never remove a substituted path or a temporary beneath replaced parents.
			try {
				assertParents()
				const current = optionalLstat(temp)
				if (current && sameInode(owned, current)) unlinkSync(temp)
			} catch {
				/* Preserve unknown ownership rather than cleaning an unrelated path. */
			}
		}
	}
}

/** Snapshot exactly the declared source bytes before an adapter may create external state. */
export function snapshotDeclaredAttachments(
	itemId: string,
	filenames: readonly string[],
	profileId?: string,
): PreparedAttachment[] {
	const names = filenames.map(sanitizeAttachmentName)
	if (new Set(names).size !== names.length) throw new Error('Declared attachments contain duplicate final filenames')
	const root = attachmentsRoot(profileId)
	const dir = attachmentsDir(itemId, profileId)
	if (!existsSync(root) || !existsSync(dir)) throw new Error('Declared attachment directory is missing')
	// Check the profile attachment root as well as the Item directory: checking
	// only dir follows a malicious `attachments` ancestor symlink.
	assertSafeDirectory(root, 'Attachment source root')
	assertSafeDirectory(dir, 'Attachment source directory')
	return names.map(name => {
		const path = join(dir, name)
		let stat: ReturnType<typeof lstatSync>
		try {
			stat = lstatSync(path)
		} catch {
			throw new Error(`Declared attachment is missing: ${name}`)
		}
		if (stat.isSymbolicLink() || !stat.isFile())
			throw new Error(`Attachment ${name} must be a regular non-symlink file`)
		return { name, bytes: readRegularNoFollow(path, `Attachment ${name}`) }
	})
}
function assertDirectoryOrCreate(path: string): void {
	if (!optionalLstat(path)) mkdirSync(path, { mode: 0o700 })
	assertSafeDirectory(path, 'Attachment destination component')
}
/** Item-qualified destination avoids Main-checkout collisions between concurrent Items. */
export function worktreeAttachmentRelativePath(itemId: string, name: string): string {
	return `${WORKTREE_ATTACHMENT_SUBDIR}/${sanitizeAttachmentName(itemId)}/${sanitizeAttachmentName(name)}`
}
export function materializePreparedAttachmentsToWorktree(
	itemId: string,
	files: readonly PreparedAttachment[],
	worktreePath: string,
): void {
	if (files.length === 0) return
	const names = files.map(file => {
		const name = sanitizeAttachmentName(file.name)
		if (name !== file.name) throw new Error(`Attachment destination filename is unsafe: ${file.name}`)
		return name
	})
	if (new Set(names).size !== names.length) throw new Error('Prepared attachments contain duplicate final filenames')
	const workspace = realpathSync(worktreePath)
	const parents: Array<{ path: string; stat: Stats }> = []
	const assertParents = () => {
		if (realpathSync(worktreePath) !== workspace) throw new Error('Attachment workspace changed')
		for (const parent of parents) {
			assertSafeDirectory(parent.path, 'Attachment destination component')
			const current = lstatSync(parent.path)
			assertOwnedDestination(current, parent.path)
			if (!sameInode(parent.stat, current) || realpathSync(parent.path) !== parent.path)
				throw new Error('Attachment destination parent changed')
		}
	}
	const captureParent = (path: string) => {
		parents.push({ path, stat: lstatSync(path) })
		assertParents()
	}
	captureParent(workspace)
	const root = join(workspace, WORKTREE_ATTACHMENT_SUBDIR)
	assertDirectoryOrCreate(root)
	captureParent(root)
	const dest = join(root, sanitizeAttachmentName(itemId))
	assertDirectoryOrCreate(dest)
	captureParent(dest)
	// Validate the complete set before publishing any replacement.
	const outputs = files.map((file, index) => ({
		path: join(dest, names[index]),
		bytes: file.bytes,
		expected: destinationIdentity(join(dest, names[index])),
	}))
	for (const output of outputs) writeRegularNoFollow(output.path, output.bytes, output.expected, assertParents)
}
/** Compatibility helper for non-prepared callers; new solve/plan paths must snapshot first. */
export function materializeAttachmentsToWorktree(
	itemId: string,
	filenames: readonly string[],
	worktreePath: string,
	profileId?: string,
): void {
	materializePreparedAttachmentsToWorktree(
		itemId,
		snapshotDeclaredAttachments(itemId, filenames, profileId),
		worktreePath,
	)
}
export function copyAttachmentsToWorktree(itemId: string, worktreePath: string, profileId?: string): void {
	const dir = attachmentsDir(itemId, profileId)
	if (!existsSync(dir)) return
	materializeAttachmentsToWorktree(itemId, readdirSync(dir), worktreePath, profileId)
}
