import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { profileRuntimeRoot } from '../profiles/runtime.js'

/**
 * On-disk store for ingested-task attachments (e.g. an email's images/PDFs).
 *
 * Bytes live under the active profile's `attachments/<itemId>/`, beside that
 * profile's `logs/` and `helm.db`. Tests without profile bootstrap retain the
 * legacy daemon-cwd fallback. They are served read-only over HTTP for the dashboard
 * (`GET /api/items/:id/attachments/:name`) and copied into the solve worktree
 * under `.helm-attachments/` so the coding agent can open them directly. That
 * subdir matches the `.helm-*` git exclude (`src/worktree/manager.ts`; the old
 * `.vigil-*` pattern stays in the exclude list only for pre-rename worktree
 * artifacts), so attachment files never land on the branch.
 */
const attachmentsRoot = (profileId?: string) => resolve(profileRuntimeRoot(profileId), 'attachments')

/** Worktree subdir attachment files are copied into for the solve agent. Matches the `.helm-*` exclude. */
export const WORKTREE_ATTACHMENT_SUBDIR = '.helm-attachments'

// Deliberately NO svg/html/xml: those render+execute script inline. The server
// derives the served Content-Type from THIS map only (never the caller-declared
// type), so an attacker can't get an active type. Anything not here → octet-stream
// + `Content-Disposition: attachment` at serve time.
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

/** Content-Types safe to render inline in the dashboard; everything else is forced to download. */
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'application/pdf'])

export function isInlineSafeContentType(contentType: string): boolean {
	return INLINE_SAFE.has(contentType)
}

/**
 * Collapse a caller-supplied filename to a safe, URL-safe basename. Strips any
 * path component (defeats `../` traversal), keeps only `[A-Za-z0-9._-]`, drops
 * leading dots, and clamps length. The result is used verbatim as both the
 * on-disk filename and the last URL path segment, so it must need no encoding.
 */
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

/** MIME type for an attachment, from its extension; `application/octet-stream` when unknown. */
export function attachmentMimeType(name: string, fallback = 'application/octet-stream'): string {
	return MIME_BY_EXT[extname(sanitizeAttachmentName(name)).toLowerCase()] ?? fallback
}

/**
 * Persist one attachment's bytes under the Item's dir, returning the final
 * (sanitized, collision-resolved) filename. Two attachments whose names sanitize
 * to the same string get `-1`, `-2`, … suffixes so neither is clobbered.
 */
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

/** Read an attachment's bytes, or null if absent. The name is sanitized, so traversal is impossible. */
export function readAttachment(itemId: string, name: string, profileId?: string): Buffer | null {
	const path = join(attachmentsDir(itemId, profileId), sanitizeAttachmentName(name))
	if (!existsSync(path)) return null
	return readFileSync(path)
}

// Extensions safe to hand to the OS `open`/`xdg-open` — documents and media that
// open in a viewer, NOT anything that could EXECUTE (.command/.sh/.app/.scpt/
// .pkg/.dmg/.html/.svg). Gates the native-open endpoint so a crafted attachment
// can't be turned into code execution on click.
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

/** True when this filename is a document/media type safe to launch via the OS opener. */
export function isOpenableAttachment(name: string): boolean {
	return OPENABLE_EXT.has(extname(sanitizeAttachmentName(name)).toLowerCase())
}

/** Absolute on-disk path of a saved attachment, or null if it doesn't exist. */
export function attachmentPath(itemId: string, name: string, profileId?: string): string | null {
	const path = join(attachmentsDir(itemId, profileId), sanitizeAttachmentName(name))
	return existsSync(path) ? path : null
}

/** Delete an Item's attachment dir (best-effort) — e.g. to clean up after a failed ingest. */
export function removeItemAttachments(itemId: string, profileId?: string): void {
	rmSync(attachmentsDir(itemId, profileId), { recursive: true, force: true })
}

/** Copy every saved attachment for an Item into `<worktree>/.helm-attachments/`. No-op when none. */
export function copyAttachmentsToWorktree(itemId: string, worktreePath: string, profileId?: string): void {
	const dir = attachmentsDir(itemId, profileId)
	if (!existsSync(dir)) return
	const dest = join(worktreePath, WORKTREE_ATTACHMENT_SUBDIR)
	mkdirSync(dest, { recursive: true })
	for (const file of readdirSync(dir)) {
		writeFileSync(join(dest, file), readFileSync(join(dir, file)))
	}
}
