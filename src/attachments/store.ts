import {
	constants,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
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
		while (existsSync(join(dir, `${stem}-${i}${ext}`))) i++
		finalName = `${stem}-${i}${ext}`
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

function writeRegularNoFollow(path: string, bytes: Buffer): void {
	let fd: number | undefined
	try {
		fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW, 0o600)
		const stat = fstatSync(fd)
		if (!stat.isFile()) throw new Error(`Attachment destination is not a regular file: ${path}`)
		writeFileSync(fd, bytes)
	} finally {
		if (fd !== undefined) closeSync(fd)
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
	if (!existsSync(path)) mkdirSync(path)
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
	const root = join(worktreePath, WORKTREE_ATTACHMENT_SUBDIR)
	assertDirectoryOrCreate(root)
	const dest = join(root, sanitizeAttachmentName(itemId))
	assertDirectoryOrCreate(dest)
	// Validate every destination before the first write; a rejected component
	// therefore cannot leave a partly copied declared attachment set.
	for (const name of names) {
		const output = join(dest, name)
		if (existsSync(output) && lstatSync(output).isSymbolicLink())
			throw new Error(`Attachment destination is a symlink: ${name}`)
	}
	for (const [index, file] of files.entries()) writeRegularNoFollow(join(dest, names[index]), file.bytes)
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
