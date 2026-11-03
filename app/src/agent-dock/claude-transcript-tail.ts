// Agent dock, Electron main: tails Claude Code's own JSONL transcript of a
// session for its background tasks (background-tasks.ts). Okena's transcript
// API hides the task notifications that end them, so the file is the only
// structured end signal for Okena panes.
//
// Bounded and fail closed: the session id must look like one (it names the
// file), the file must resolve under a Claude config dir, be a regular file of
// this user, opened without following a symlink. The first read covers only the
// last FIRST_READ_BYTES (a task started before that window is not seen: no
// claim); each later read takes only what was appended, and an append larger
// than READ_MAX_BYTES starts over from a fresh window. Anything unreadable
// reports nothing, never a guess. A missing or unreadable file is looked up again at most
// every LOCATE_RETRY_MS.

import { constants } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import {
	type BackgroundTaskState,
	type ObservedBackgroundTasks,
	applyBackgroundLine,
	backgroundTaskCounts,
	emptyBackgroundTasks,
} from './background-tasks'

export const FIRST_READ_BYTES = 2 * 1024 * 1024
export const READ_MAX_BYTES = 8 * 1024 * 1024
export const LOCATE_RETRY_MS = 60_000
/** Sessions tracked at once (LRU by last observation). */
export const TAIL_SESSIONS_MAX = 128
/** Project folders stat'ed when the cwd-named one does not hold the session. */
const LOCATE_SCAN_MAX = 4096
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

/** What OkenaClaudeSource asks per pane (structural, so tests inject a double). */
export interface BackgroundTaskObserver {
	/** Current counts for this session, reading what the transcript appended first when `refresh`. */
	observe(
		sessionId: string,
		options: { cwd?: string; refresh: boolean; now: number },
	): Promise<ObservedBackgroundTasks | undefined>
}

interface Tail {
	path?: string
	/** When the file was last looked for and not found. */
	missedAt?: number
	offset: number
	tasks: BackgroundTaskState
	seenAt: number
}

/** Claude's project folder name for a cwd (every character but [A-Za-z0-9] becomes '-'). */
export const claudeProjectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

export class ClaudeTranscriptTail implements BackgroundTaskObserver {
	private readonly tails = new Map<string, Tail>()
	private readonly roots: string[]

	/** `roots`: Claude config dirs (default ~/.claude and $CLAUDE_CONFIG_DIR). */
	constructor(roots?: string[]) {
		const configDir = process.env.CLAUDE_CONFIG_DIR
		this.roots = roots ?? [...(configDir ? [configDir] : []), join(homedir(), '.claude')]
	}

	async observe(
		sessionId: string,
		options: { cwd?: string; refresh: boolean; now: number },
	): Promise<ObservedBackgroundTasks | undefined> {
		if (!SESSION_ID.test(sessionId)) return undefined
		let tail = this.tails.get(sessionId)
		if (!tail) {
			tail = { offset: 0, tasks: emptyBackgroundTasks(), seenAt: options.now }
			this.tails.set(sessionId, tail)
			this.prune()
		}
		tail.seenAt = options.now
		if (options.refresh || tail.path === undefined) {
			try {
				if (!(await this.read(tail, sessionId, options.cwd, options.now))) return undefined
			} catch {
				// Unreadable now: no claim; looked up again (fresh window) after LOCATE_RETRY_MS, not
				// every tick (a scan of the projects folder each poll for a file it cannot read).
				tail.path = undefined
				tail.missedAt = options.now
				tail.offset = 0
				tail.tasks = emptyBackgroundTasks()
				return undefined
			}
		}
		if (tail.path === undefined) return undefined
		return { sessionId, ...backgroundTaskCounts(tail.tasks, options.now) }
	}

	private prune(): void {
		if (this.tails.size <= TAIL_SESSIONS_MAX) return
		const oldest = [...this.tails.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)
		for (const [id] of oldest.slice(0, this.tails.size - TAIL_SESSIONS_MAX)) this.tails.delete(id)
	}

	/** Reads what was appended since the last read; false when the file is not known. */
	private async read(tail: Tail, sessionId: string, cwd: string | undefined, now: number): Promise<boolean> {
		if (tail.path === undefined) {
			if (tail.missedAt !== undefined && now - tail.missedAt < LOCATE_RETRY_MS) return false
			const found = await this.locate(sessionId, cwd)
			if (!found) {
				tail.missedAt = now
				return false
			}
			tail.path = found
			tail.missedAt = undefined
			tail.offset = 0
			tail.tasks = emptyBackgroundTasks()
		}
		const handle = await open(tail.path, constants.O_RDONLY | constants.O_NOFOLLOW)
		try {
			const info = await handle.stat()
			if (!info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
				throw new Error('not a transcript file')
			// Shrunk (rewritten) or a first read: start over from a fresh window.
			let fresh = tail.offset === 0 || info.size < tail.offset
			if (!fresh && info.size - tail.offset > READ_MAX_BYTES) fresh = true
			const start = fresh ? Math.max(0, info.size - FIRST_READ_BYTES) : tail.offset
			if (fresh) tail.tasks = emptyBackgroundTasks()
			const length = info.size - start
			if (length <= 0) {
				tail.offset = info.size
				return true
			}
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await handle.read(buffer, 0, length, start)
			const chunk = buffer.subarray(0, bytesRead)
			const lastNewline = chunk.lastIndexOf(0x0a)
			if (lastNewline === -1) {
				// No complete line yet: a fresh window is read again next time.
				if (fresh) tail.offset = 0
				return true
			}
			// A window that starts mid-file starts mid-line: skip to the first full one.
			const firstLine = fresh && start > 0 ? chunk.indexOf(0x0a) + 1 : 0
			const text = chunk.subarray(firstLine, lastNewline).toString('utf8')
			let tasks = tail.tasks
			for (const line of text.split('\n')) if (line) tasks = applyBackgroundLine(tasks, line)
			tail.tasks = tasks
			tail.offset = start + lastNewline + 1
			return true
		} finally {
			await handle.close()
		}
	}

	/** `<root>/projects/<cwd folder>/<sessionId>.jsonl`, else any project folder holding it. */
	private async locate(sessionId: string, cwd: string | undefined): Promise<string | undefined> {
		const name = `${sessionId}.jsonl`
		for (const root of this.roots) {
			const base = await realpath(join(root, 'projects')).catch(() => null)
			if (!base) continue
			const folders = cwd ? [claudeProjectDir(cwd)] : []
			for (const folder of folders) {
				const found = await this.inside(base, join(base, folder, name))
				if (found) return found
			}
			// Long cwds get a shortened folder name (and Claude may run elsewhere than the pane's project).
			const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
			for (const entry of entries.slice(0, LOCATE_SCAN_MAX)) {
				if (!entry.isDirectory() || folders.includes(entry.name)) continue
				const found = await this.inside(base, join(base, entry.name, name))
				if (found) return found
			}
		}
		return undefined
	}

	private async inside(base: string, path: string): Promise<string | undefined> {
		const info = await stat(path).catch(() => null)
		if (!info?.isFile()) return undefined
		const real = await realpath(path).catch(() => null)
		return real?.startsWith(`${base}${sep}`) ? real : undefined
	}
}
