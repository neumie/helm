// Bounded, read-only discovery of Codex rollout files (`<root>/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`).
// Shared by Remote's usage page (`src/remote/usage-sources.ts`, newest rollouts) and Document Review's activity
// line (one thread's rollout by id). Plain `.jsonl` only: compressed `.jsonl.zst` (finished) rollouts never match.

import { lstat, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CodexRolloutWalk {
	/** Files returned, newest first. */
	limit: number
	/** Directory entries charged across the whole walk (all entries, not only matches). */
	entries: number
	depth: number
	/** Which `.jsonl` file names count. */
	match?: (name: string) => boolean
	signal?: AbortSignal
}

/** `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
export const codexSessionsRoot = (): string =>
	join(process.env.CODEX_HOME ? process.env.CODEX_HOME : join(homedir(), '.codex'), 'sessions')

/**
 * Newest matching rollouts under `root` (newest by name: dated folders and timestamped names sort by time).
 * Incomplete discovery (a symlinked or replaced folder, the entry budget) returns null, never a partial claim.
 */
export async function findCodexRollouts(root: string, walk: CodexRolloutWalk): Promise<string[] | null> {
	const { signal } = walk
	let visited = 0
	const visit = async (directory: string, depth: number): Promise<string[] | null> => {
		signal?.throwIfAborted()
		if (depth > walk.depth || (await realpath(directory).catch(() => null)) !== directory) return null
		signal?.throwIfAborted()
		const before = await lstat(directory).catch(() => null)
		if (!before?.isDirectory() || before.isSymbolicLink()) return null
		signal?.throwIfAborted()
		const dir = await opendir(directory, { bufferSize: 1 }).catch(() => null)
		if (!dir) return null
		const directories: string[] = []
		const files: string[] = []
		try {
			signal?.throwIfAborted()
			const after = await lstat(directory)
			if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()) return null
			for (;;) {
				signal?.throwIfAborted()
				if (visited >= walk.entries) return null
				const entry = await dir.read()
				if (!entry) break
				visited += 1
				if (entry.isDirectory()) directories.push(entry.name)
				else if (entry.isFile() && entry.name.endsWith('.jsonl') && (walk.match?.(entry.name) ?? true))
					files.push(join(directory, entry.name))
			}
		} finally {
			await dir.close()
		}
		files.sort().reverse()
		const found = files.slice(0, walk.limit)
		for (const name of directories.sort().reverse()) {
			if (found.length >= walk.limit) break
			const children = await visit(join(directory, name), depth + 1)
			if (children === null) return null
			found.push(...children.slice(0, walk.limit - found.length))
		}
		return found
	}
	return visit(root, 0).catch(() => null)
}
