/**
 * Daemon clients parse a response body as text first: a non-JSON body (an older
 * daemon's plain-text 500, a proxy page) must surface as a readable error with its
 * status, never as `Unexpected token ... is not valid JSON`. The extension keeps a
 * copy in `extension/src/api.ts` because its tsconfig cannot import from `src/`.
 */
const SNIPPET_LENGTH = 120

export function daemonResponseError(status: number, text: string): Error {
	const flat = text.replace(/\s+/g, ' ').trim()
	const snippet = flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH)}…` : flat
	return new Error(`Helm daemon error ${status}${snippet ? `: ${snippet}` : ''}`)
}

/** Parse a daemon `{ data | error }` envelope; throws {@link daemonResponseError} otherwise. */
export function parseDaemonEnvelope(status: number, text: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(text)
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
	} catch {
		// Fall through to the readable status error.
	}
	throw daemonResponseError(status, text)
}
