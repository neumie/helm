import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Compare filesystem identities when a path exists, retaining a deterministic
 * lexical identity for paths that have not been created yet. This keeps planned
 * branch paths usable before a worktree exists while preventing symlink aliases
 * from turning the canonical checkout into a worktree.
 */
export function canonicalPathIdentity(path: string): string {
	const absolute = resolve(path)
	if (!existsSync(absolute)) return absolute
	try {
		return realpathSync.native(absolute)
	} catch {
		// A path can disappear between existsSync and realpathSync. Its resolved
		// spelling is the deliberate missing-path fallback.
		return absolute
	}
}

export function sameFilesystemPath(left: string, right: string): boolean {
	return canonicalPathIdentity(left) === canonicalPathIdentity(right)
}
