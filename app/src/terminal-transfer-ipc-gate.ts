/**
 * Restricted admission boundary for the future terminal-transfer renderer bridge.
 *
 * A valid profile token is insufficient on its own: only the current main
 * renderer may ask about its own session. Keep transfer IPC separate from the
 * broader session gate because a future move has a stricter capability handoff.
 */
export interface TerminalTransferIpcGate {
	allows(sender: unknown, profileToken: unknown): boolean
	handle<T>(sender: unknown, profileToken: unknown, closed: T, operation: () => T): T
}

export function createTerminalTransferIpcGate(
	acceptsProfileToken: (profileToken: unknown) => boolean,
	mainRenderer: () => unknown,
): TerminalTransferIpcGate {
	const permitted = (sender: unknown, profileToken: unknown): boolean => {
		const renderer = mainRenderer()
		return renderer !== null && renderer !== undefined && sender === renderer && acceptsProfileToken(profileToken)
	}
	return {
		allows(sender, profileToken): boolean {
			return permitted(sender, profileToken)
		},
		handle(sender, profileToken, closed, operation) {
			return permitted(sender, profileToken) ? operation() : closed
		},
	}
}

export default { createTerminalTransferIpcGate }
