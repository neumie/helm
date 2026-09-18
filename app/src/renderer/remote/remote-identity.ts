import type { RemoteDirectory, RemoteTarget } from '../../../../src/remote/protocol.js'

/** Complete identity used for renderer-owned drafts and selection. */
export function remoteSessionIdentity(hostEpoch: string, target: RemoteTarget): string {
	return `${hostEpoch}:${target.scopeId ?? 'personal'}:${target.generation}:${target.sessionId}:${target.incarnation}`
}

/**
 * Remove only identities absent from a complete, successfully published directory.
 * Directory filtering and history visibility happen in the renderer after this
 * boundary, so those local views never authorize draft retirement.
 */
export function pruneAbsentRemoteDrafts<T>(
	drafts: Map<string, T>,
	directory: RemoteDirectory,
	dispose?: (draft: T) => void,
): void {
	const published = new Set(
		directory.sessions.map(session => remoteSessionIdentity(directory.hostEpoch, session.target)),
	)
	for (const [key, draft] of drafts) {
		if (published.has(key)) continue
		drafts.delete(key)
		dispose?.(draft)
	}
}
