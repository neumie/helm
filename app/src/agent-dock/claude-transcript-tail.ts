// Agent dock, Electron main: tails Claude Code's own JSONL transcript of a
// session for its background tasks (background-tasks.ts) and its main agent's
// recent tool calls (tool-calls.ts). Okena's transcript API hides the task
// notifications that end them, so the file is the only structured end signal
// for Okena panes; its tool_use/tool_result records carry the input and the
// times that prove an Okena dialog was already answered in the terminal.
//
// Bounded and fail closed: the session id must look like one (it names the
// file), the file must resolve under a Claude config dir, be a regular file of
// this user, opened without following a symlink. The first read covers only the
// last FIRST_READ_BYTES (a task started before that window is not seen: no
// claim); each later read takes only what was appended, and an append larger
// than READ_MAX_BYTES starts over from a fresh window. Anything unreadable
// reports nothing, never a guess. A missing or unreadable file is looked up again at most
// every LOCATE_RETRY_MS.

import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { type JsonlCursor, readAppendedJsonl } from '../../../src/provider-files/bounded-jsonl'
import {
	type BackgroundTaskState,
	type ObservedBackgroundTasks,
	applyBackgroundLine,
	backgroundTaskCounts,
	emptyBackgroundTasks,
} from './background-tasks'
import { type ToolCallState, applyToolCallLine, emptyToolCalls } from './tool-calls'

export const FIRST_READ_BYTES = 2 * 1024 * 1024
export const READ_MAX_BYTES = 8 * 1024 * 1024
export const LOCATE_RETRY_MS = 60_000
/** Sessions tracked at once (LRU by last observation). */
export const TAIL_SESSIONS_MAX = 128
/** Project folders stat'ed when the cwd-named one does not hold the session. */
const LOCATE_SCAN_MAX = 4096
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

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
	/** Null = the next read takes a fresh window. */
	cursor: JsonlCursor | null
	tasks: BackgroundTaskState
	/** The main agent's recent tool calls (answered-dialog proof, tool-calls.ts). */
	calls: ToolCallState
	seenAt: number
}

/** Claude's project folder name for a cwd (every character but [A-Za-z0-9] becomes '-'). */
export const claudeProjectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** Claude config dirs: $CLAUDE_CONFIG_DIR, then ~/.claude. */
export const claudeConfigRoots = (): string[] => {
	const configDir = process.env.CLAUDE_CONFIG_DIR
	return [...(configDir ? [configDir] : []), join(homedir(), '.claude')]
}

/**
 * `<root>/projects/<cwd folder>/<sessionId>.jsonl`, else any project folder holding it (at most 4096 folders).
 * Returns the real path and the real `projects` folder it is under; undefined when not found.
 */
export async function locateClaudeTranscript(
	roots: readonly string[],
	sessionId: string,
	cwd: string | undefined,
): Promise<{ path: string; base: string } | undefined> {
	if (!SESSION_ID.test(sessionId)) return undefined
	const name = `${sessionId}.jsonl`
	for (const root of roots) {
		const base = await realpath(join(root, 'projects')).catch(() => null)
		if (!base) continue
		const folders = cwd ? [claudeProjectDir(cwd)] : []
		for (const folder of folders) {
			const found = await inside(base, join(base, folder, name))
			if (found) return { path: found, base }
		}
		// Long cwds get a shortened folder name (and Claude may run elsewhere than the pane's project).
		const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
		for (const entry of entries.slice(0, LOCATE_SCAN_MAX)) {
			if (!entry.isDirectory() || folders.includes(entry.name)) continue
			const found = await inside(base, join(base, entry.name, name))
			if (found) return { path: found, base }
		}
	}
	return undefined
}

async function inside(base: string, path: string): Promise<string | undefined> {
	// lstat: a symlinked `<session>.jsonl` (to another session's file) is refused, not followed.
	const info = await lstat(path).catch(() => null)
	if (!info?.isFile()) return undefined
	const real = await realpath(path).catch(() => null)
	return real?.startsWith(`${base}${sep}`) ? real : undefined
}

export class ClaudeTranscriptTail implements BackgroundTaskObserver {
	private readonly tails = new Map<string, Tail>()
	private readonly roots: string[]

	/** `roots`: Claude config dirs (default ~/.claude and $CLAUDE_CONFIG_DIR). */
	constructor(roots?: string[]) {
		this.roots = roots ?? claudeConfigRoots()
	}

	async observe(
		sessionId: string,
		options: { cwd?: string; refresh: boolean; now: number },
	): Promise<ObservedBackgroundTasks | undefined> {
		if (!SESSION_ID.test(sessionId)) return undefined
		let tail = this.tails.get(sessionId)
		if (!tail) {
			tail = { cursor: null, tasks: emptyBackgroundTasks(), calls: emptyToolCalls(), seenAt: options.now }
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
				tail.cursor = null
				tail.tasks = emptyBackgroundTasks()
				tail.calls = emptyToolCalls()
				return undefined
			}
		}
		if (tail.path === undefined) return undefined
		const calls = tail.calls.calls
		return {
			sessionId,
			...backgroundTaskCounts(tail.tasks, options.now),
			...(calls.length > 0 ? { calls: [...calls] } : {}),
		}
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
			const found = await locateClaudeTranscript(this.roots, sessionId, cwd)
			if (!found) {
				tail.missedAt = now
				return false
			}
			tail.path = found.path
			tail.missedAt = undefined
			tail.cursor = null
			tail.tasks = emptyBackgroundTasks()
			tail.calls = emptyToolCalls()
		}
		const read = await readAppendedJsonl(tail.path, tail.cursor, {
			firstReadBytes: FIRST_READ_BYTES,
			maxReadBytes: READ_MAX_BYTES,
		})
		let tasks = read.fresh ? emptyBackgroundTasks() : tail.tasks
		let calls = read.fresh ? emptyToolCalls() : tail.calls
		for (const line of read.lines) {
			tasks = applyBackgroundLine(tasks, line)
			calls = applyToolCallLine(calls, line)
		}
		tail.tasks = tasks
		tail.calls = calls
		tail.cursor = read.cursor
		return true
	}
}
