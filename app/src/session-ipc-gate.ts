/**
 * Single fail-closed admission boundary for terminal/session/buffer IPC.
 * Callers must enter this before touching a PTY, dtach support, registry,
 * socket scan, or buffer store.
 */
export interface SessionIpcGate {
	allows(token: unknown): boolean
	require(token: unknown): void
	event(token: unknown, operation: () => void): void
	handle<T>(token: unknown, closed: T, operation: () => T): T
}

export function createSessionIpcGate(acceptsToken: (token: unknown) => boolean): SessionIpcGate {
	const permitted = (token: unknown): boolean => acceptsToken(token)
	return {
		allows(token): boolean {
			return permitted(token)
		},
		require(token): void {
			if (!permitted(token)) throw new Error('Terminal profile changed — reload and try again')
		},
		event(token, operation): void {
			if (permitted(token)) operation()
		},
		handle(token, closed, operation) {
			return permitted(token) ? operation() : closed
		},
	}
}

export default { createSessionIpcGate }
