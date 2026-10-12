import { connect } from 'node:net'

/** Artifacts a runtime owns for its lifetime and leaves behind when it is killed. */
export const RUNTIME_ARTIFACTS = ['runtime.lock', 'control.sock', 'host.sock'] as const
const PROBE_TIMEOUT_MS = 2000

/**
 * Resolve whether anything still answers a socket. A refused connection and a missing
 * socket establish listener absence only, not owner death. A timeout, permission error or an
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

/**
 * Legacy locks contain no verifiable process owner. Absent listeners cannot
 * distinguish a crashed runtime from one still starting, so preserve every artifact.
 * Recovery needs a separately approved dead-owner protocol, not socket guesses.
 */
export async function reclaimDeadRuntime(_root: string, _now: () => Date = () => new Date()): Promise<boolean> {
	return false
}
