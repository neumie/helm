// Main's "raise Okena" for the dock's reveal (⌘O): runs the ordered strategies of
// src/extensions/okena/activate.ts (AppKit, then System Events), logs what each did, and turns a
// permission refusal into the footer's fix — once per run, later refusals get the plain note.
//
// Types only from activate.ts (it spawns osascript): main injects `raiseOkenaApp`, tests a double.

import type { OkenaRaiseResult } from '../../../src/extensions/okena/activate'
import { type OkenaRaised, REVEAL_TEXT } from './reveal'

export interface OkenaRaiserDeps {
	raise(): Promise<OkenaRaiseResult>
	/** describeOkenaRaise. */
	describe(result: OkenaRaiseResult): string
	log(line: string): void
}

/** The dock's `activate` (OkenaRevealDeps): never throws. */
export function createOkenaRaiser(deps: OkenaRaiserDeps): () => Promise<OkenaRaised> {
	let permissionSaid = false
	return async () => {
		let result: OkenaRaiseResult
		try {
			result = await deps.raise()
		} catch (error) {
			deps.log(`raise Okena: ${error instanceof Error ? error.message : String(error)}`)
			return false
		}
		deps.log(`raise Okena: ${deps.describe(result)}`)
		if (result.ok) return true
		if (result.reason === 'denied' && !permissionSaid) {
			permissionSaid = true
			return {
				raised: false,
				note: result.permission === 'accessibility' ? REVEAL_TEXT.needsAccessibility : REVEAL_TEXT.needsAutomation,
			}
		}
		return false
	}
}
