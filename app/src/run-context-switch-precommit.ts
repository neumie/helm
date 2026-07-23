import type { RunContextDrainResult } from './run-context-access'

export interface RunContextSwitchPrecommit {
	beginDrain(): RunContextDrainResult
	flushBuffers(): Promise<void>
	beginBridgeFence(): Promise<void>
	advanceGeneration(): void
}

export type RunContextSwitchPrecommitResult =
	| { ok: false; error?: unknown }
	| { ok: true; profileReady: Promise<void>; release(): void }

/**
 * Current (pre-coordinator) profile-switch precommit order. Its cleanup is
 * deliberately local: a failed drain/flush/fence setup always releases only
 * the lease it acquired, never a later switch's admission gate.
 */
export async function prepareRunContextProfileSwitch(
	steps: RunContextSwitchPrecommit,
): Promise<RunContextSwitchPrecommitResult> {
	let drain: Extract<RunContextDrainResult, { ok: true }> | undefined
	try {
		const result = steps.beginDrain()
		if (!result.ok) return result
		drain = result
		await drain.drained
		await steps.flushBuffers()
		const profileReady = steps.beginBridgeFence()
		steps.advanceGeneration()
		return { ok: true, profileReady, release: drain.release }
	} catch (error) {
		drain?.release()
		return { ok: false, error }
	}
}

export default { prepareRunContextProfileSwitch }
