import { lstatSync, mkdirSync, renameSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

/** Artifacts a runtime owns for its lifetime and leaves behind when it is killed. */
export const RUNTIME_ARTIFACTS = ['runtime.lock', 'control.sock', 'host.sock'] as const
const PROBE_TIMEOUT_MS = 2000

/**
 * Resolve whether anything still answers a socket. A refused connection and a missing
 * socket are the only evidence treated as dead; a timeout, a permission error or an
 * accepted connection all mean "assume live", because replacing a live runtime is far
 * worse than staying down.
 */
export function socketAnswered(path: string): Promise<boolean> {
	return new Promise(resolve => {
		const socket = connect(path)
		const settle = (answered: boolean) => {
			socket.destroy()
			resolve(answered)
		}
		socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(true))
		socket.once('connect', () => settle(true))
		socket.once('error', (error: NodeJS.ErrnoException) =>
			settle(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'),
		)
	})
}

function reclaimable(path: string): boolean {
	let stats: ReturnType<typeof lstatSync>
	try {
		stats = lstatSync(path)
	} catch {
		// Already gone is already reclaimed.
		return true
	}
	if (stats.isSymbolicLink()) return false
	if (stats.uid !== process.getuid?.()) return false
	if ((stats.mode & 0o777) !== 0o600) return false
	return stats.isSocket() || (stats.isFile() && stats.nlink === 1)
}

/**
 * Reclaim the artifacts of a runtime that is provably gone, so a supervised restart
 * after a crash is not blocked forever by its own leftovers. Every artifact is
 * preserved rather than deleted: a lock that turns out to matter is recoverable, and
 * the directory is evidence that a crash happened.
 *
 * Returns false whenever anything is still answering or any artifact fails the
 * ownership checks, in which case the caller must refuse to start.
 */
export async function reclaimDeadRuntime(root: string, now: () => Date = () => new Date()): Promise<boolean> {
	for (const name of ['control.sock', 'host.sock']) if (await socketAnswered(join(root, name))) return false
	const present = RUNTIME_ARTIFACTS.filter(name => {
		try {
			lstatSync(join(root, name))
			return true
		} catch {
			return false
		}
	})
	if (!present.length) return false
	if (!present.every(name => reclaimable(join(root, name)))) return false

	const stamp = now().toISOString().replace(/[:.]/g, '-')
	const directory = join(root, `recovery-${stamp}-reclaimed`)
	mkdirSync(directory, { recursive: false, mode: 0o700 })
	for (const name of present) renameSync(join(root, name), join(directory, name))
	console.warn(`Remote reclaimed the artifacts of a runtime that is no longer running into ${directory}`)
	return true
}
