import { dirname, join, resolve } from 'node:path'
import type { ProfileRuntime } from './store.js'

let runtime: ProfileRuntime | null = null

/** Bind or switch the active UI/admission profile without replacing the daemon. */
export function configureProfileRuntime(next: ProfileRuntime): void {
	if (runtime && runtime.dbPath !== next.dbPath) {
		throw new Error('Profile runtime belongs to a different daemon database')
	}
	runtime = structuredClone(next)
}

/**
 * Resolve a profile-owned filesystem root. Async jobs pass their persisted
 * Item profile; active API work may omit it. Tests without profile bootstrap
 * retain the legacy cwd fallback.
 */
export function profileRuntimeRoot(profileId?: string): string {
	if (!runtime) return resolve(process.cwd())
	if (!profileId || profileId === runtime.profile.id) return runtime.rootDir
	return join(dirname(runtime.rootDir), profileId)
}

export function activeProfileId(): string {
	return runtime?.profile.id ?? 'work'
}

export function activeProfileRuntime(): ProfileRuntime | null {
	return runtime ? structuredClone(runtime) : null
}
