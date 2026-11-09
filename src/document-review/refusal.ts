// A registry symbol, not `instanceof`: tests (and any CJS/ESM split) can load this module twice.
const BRAND = Symbol.for('helm.document-review.refusal')
/**
 * A definite review refusal: the host checked something and did nothing.
 * Its message is safe to return to the CLI and to log. Never put tokens,
 * document text or feedback in it; a file or folder name is fine.
 */
export class ReviewRefusal extends Error {
	override readonly name = 'ReviewRefusal'
	readonly [BRAND] = true
}
export const isReviewRefusal = (error: unknown): error is ReviewRefusal =>
	error instanceof Error && (error as unknown as Record<symbol, unknown>)[BRAND] === true

export const refuse = (message: string): ReviewRefusal => new ReviewRefusal(message)

/** Short, single-line cause of a failed child/fs call: code, timeout, or git's first stderr line. */
export function failureCause(error: unknown): string {
	const value = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown; message?: unknown }
	if (value?.killed || value?.signal === 'SIGTERM') return 'timed out'
	const stderr = typeof value?.stderr === 'string' ? value.stderr.trim().split('\n')[0] : ''
	const fallback = typeof value?.message === 'string' ? value.message.split('\n')[0] : 'unknown error'
	const text = (stderr || `${value?.code ?? ''} ${fallback}`).trim()
	// Wire/log text stays one bounded line with no control characters.
	let line = ''
	for (const char of text.slice(0, 160)) {
		const code = char.charCodeAt(0)
		line += code < 32 || (code >= 127 && code <= 159) ? ' ' : char
	}
	return line
}

/** Git exits 128 with this text only when the folder really is outside every repository. */
export function gitRootRefusal(error: unknown, subject: string): ReviewRefusal {
	const stderr = String((error as { stderr?: unknown })?.stderr ?? '')
	if (/not a git repository/i.test(stderr))
		return refuse(`${subject} is not inside a Git repository. Review opens repository files only.`)
	return refuse(`Git could not find the repository of ${subject} (${failureCause(error)}). Nothing was opened.`)
}

export const UNCERTAIN_REVIEW_FAILURE =
	'Review operation unavailable. Check the connection, active profile, and document; do not replay uncertain feedback.'

/**
 * What the CLI may read and what the app may log for one failed operation.
 * Only a ReviewRefusal is specific on the wire: any other error may have
 * happened after an effect, so the caller keeps the do-not-replay warning.
 */
export function describeReviewFailure(error: unknown): { reply: string; log: string } {
	if (isReviewRefusal(error)) return { reply: error.message.slice(0, 400), log: error.message }
	// A frame parse error can quote the frame, and the frame carries a token.
	if (error instanceof SyntaxError) return { reply: UNCERTAIN_REVIEW_FAILURE, log: 'unreadable command frame' }
	if (error instanceof Error && error.name === 'ZodError') {
		const issues = (error as Error & { issues?: { path?: unknown[]; code?: unknown }[] }).issues ?? []
		const where = issues
			.slice(0, 4)
			.map(issue => `${(issue.path ?? []).join('.') || 'frame'} ${String(issue.code ?? '')}`.trim())
			.join(', ')
		return { reply: UNCERTAIN_REVIEW_FAILURE, log: `malformed command (${where || 'unknown'})` }
	}
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code
		const message = (error.message.split('\n')[0] ?? '').slice(0, 240)
		return { reply: UNCERTAIN_REVIEW_FAILURE, log: `${code ?? error.name}: ${message}` }
	}
	return { reply: UNCERTAIN_REVIEW_FAILURE, log: 'non-error rejection' }
}
