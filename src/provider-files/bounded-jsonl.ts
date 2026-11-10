// Bounded, read-only tails of an agent provider's own JSONL session file (Claude Code transcripts, Codex
// rollouts). Shared by the agent dock (`app/src/agent-dock/claude-transcript-tail.ts`) and Document Review's
// display-only activity line (`app/src/document-review/activity-watcher.ts`).
//
// Never writes, renames, locks or deletes anything. Opens without following a symlink, needs a regular file of
// this user, and reads only complete lines. The first read covers the last `firstReadBytes`; each later read takes
// only what was appended. With `strict` the file must also be a single link whose real path is itself, under
// `root`, and keep the same identity (device + inode) between reads; growth past `maxReadBytes` between reads
// then fails instead of starting over.

import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { sep } from 'node:path'

/** Where the next read starts; null = a fresh window. */
export interface JsonlCursor {
	offset: number
	dev: number
	ino: number
}
export interface JsonlRead {
	/** Complete lines, without their newline. */
	lines: string[]
	cursor: JsonlCursor | null
	/** This read started a fresh window (the caller drops what it derived from earlier reads). */
	fresh: boolean
}
export interface JsonlReadOptions {
	firstReadBytes: number
	maxReadBytes: number
	/** Single link, real path equal to the path and under `root`, same identity across reads; overflow fails. */
	strict?: { root: string }
}

export class JsonlReadError extends Error {}

const ownUid = () => (typeof process.getuid === 'function' ? process.getuid() : null)

/** Reads what was appended since `cursor`. Throws `JsonlReadError` (or an fs error) when the file is not acceptable. */
export async function readAppendedJsonl(
	path: string,
	cursor: JsonlCursor | null,
	options: JsonlReadOptions,
): Promise<JsonlRead> {
	if (options.strict) {
		const real = await realpath(path)
		if (real !== path || !real.startsWith(`${options.strict.root}${sep}`))
			throw new JsonlReadError('outside the provider root')
	}
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const info = await handle.stat()
		const uid = ownUid()
		if (!info.isFile() || (uid !== null && info.uid !== uid)) throw new JsonlReadError('not a session file')
		if (options.strict) {
			if (info.nlink !== 1) throw new JsonlReadError('hard-linked')
			// The name still points at the descriptor we hold (not replaced between realpath and open).
			const named = await stat(path)
			if (named.dev !== info.dev || named.ino !== info.ino) throw new JsonlReadError('replaced')
			if (cursor && (cursor.dev !== info.dev || cursor.ino !== info.ino)) throw new JsonlReadError('replaced')
			if (cursor && info.size < cursor.offset) throw new JsonlReadError('shrunk')
			if (cursor && info.size - cursor.offset > options.maxReadBytes) throw new JsonlReadError('grew past the bound')
		}
		// Shrunk (rewritten), too far behind, or a first read: start over from a fresh window.
		const fresh = cursor === null || info.size < cursor.offset || info.size - cursor.offset > options.maxReadBytes
		const start = fresh ? Math.max(0, info.size - options.firstReadBytes) : (cursor as JsonlCursor).offset
		const identity = { dev: info.dev, ino: info.ino }
		const length = info.size - start
		if (length <= 0) return { lines: [], cursor: { offset: info.size, ...identity }, fresh }
		const buffer = Buffer.alloc(length)
		const { bytesRead } = await handle.read(buffer, 0, length, start)
		const chunk = buffer.subarray(0, bytesRead)
		const lastNewline = chunk.lastIndexOf(0x0a)
		// No complete line yet: a fresh window is read again next time.
		if (lastNewline === -1) return { lines: [], cursor: fresh ? null : (cursor as JsonlCursor), fresh }
		// A window that starts mid-file starts mid-line: skip to the first full one.
		const firstLine = fresh && start > 0 ? chunk.indexOf(0x0a) + 1 : 0
		const text = chunk.subarray(firstLine, lastNewline).toString('utf8')
		return {
			lines: text ? text.split('\n').filter(Boolean) : [],
			cursor: { offset: start + lastNewline + 1, ...identity },
			fresh,
		}
	} finally {
		await handle.close().catch(() => {})
	}
}

/** The first line of a file, read through the same guards; null when it has none within `maxBytes`. */
export async function readFirstJsonlLine(path: string, maxBytes: number, root: string): Promise<string | null> {
	const real = await realpath(path)
	if (real !== path || !real.startsWith(`${root}${sep}`)) throw new JsonlReadError('outside the provider root')
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const info = await handle.stat()
		const uid = ownUid()
		if (!info.isFile() || (uid !== null && info.uid !== uid) || info.nlink !== 1)
			throw new JsonlReadError('not a session file')
		const buffer = Buffer.alloc(Math.min(maxBytes, info.size))
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
		const end = buffer.subarray(0, bytesRead).indexOf(0x0a)
		return end === -1 ? null : buffer.subarray(0, end).toString('utf8')
	} finally {
		await handle.close().catch(() => {})
	}
}
