import { type ErrorPhase, errorPhaseSchema } from '../db/task-schema.js'

/**
 * The pipeline's error protocol — the single definition of how solve-path code
 * signals *which phase* failed and how cancellation is recognised.
 *
 * Before this module the contract was implicit: ~20 sites hand-built
 * `Object.assign(new Error(msg), { phase: 'solve' })` (an untyped string — a typo
 * fell through to the worker's `?? 'solve'` default) and
 * `Object.assign(new Error('Task cancelled'), { name: 'AbortError' })`, while the
 * worker classified them with `error.name === 'AbortError'` / `error.phase`. The
 * constructors and the classifiers are the two halves of one interface, so they
 * live here together — `phase` is now typed (typos are compile errors) and the
 * cancellation/phase reads can't drift from how the errors are built.
 */

/** Error carrying the pipeline phase it failed in. */
export interface PhaseError extends Error {
	phase: ErrorPhase
}

/**
 * Build a phase-tagged pipeline error. `phase` is typed as {@link ErrorPhase}, so
 * a mistyped phase is a compile error rather than a silent fall-through to the
 * worker's default.
 */
export function phaseError(phase: ErrorPhase, message: string): PhaseError {
	return Object.assign(new Error(message), { phase })
}

/**
 * Build the cancellation error the queue's `AbortSignal` flow expects. Carries
 * `name: 'AbortError'` so {@link isCancellation} (and Node's own abort plumbing)
 * recognise it.
 */
export function taskCancelled(message = 'Task cancelled'): Error {
	return Object.assign(new Error(message), { name: 'AbortError' })
}

/**
 * Whether an error represents user/abort cancellation rather than a real
 * failure. Matches both errors built by {@link taskCancelled} and an already-
 * aborted signal (the worker passes its signal so a race where the throw isn't
 * tagged but the signal fired is still classified as cancelled).
 */
export function isCancellation(err: unknown, signal?: AbortSignal): boolean {
	return (err instanceof Error && err.name === 'AbortError') || (signal?.aborted ?? false)
}

/**
 * Read the pipeline phase off an error, defaulting to `'solve'` — the catch-all
 * for an untagged failure inside the solve step.
 */
export function errorPhase(err: unknown): ErrorPhase {
	const phase = (err as { phase?: unknown } | null)?.phase
	return errorPhaseSchema.safeParse(phase).success ? (phase as ErrorPhase) : 'solve'
}
