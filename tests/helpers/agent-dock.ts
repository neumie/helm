// Shared helpers for the agent-dock and claude-remote tests.

import { readFileSync } from 'node:fs'

/** A recorded Okena Claude Remote body from tests/fixtures/okena-claude/. */
export function okenaFixture<T = Record<string, unknown>>(name: string): T {
	return JSON.parse(readFileSync(new URL(`../fixtures/okena-claude/${name}`, import.meta.url), 'utf8')) as T
}

/** Polls `check` every 5 ms until it holds; throws `timed out waiting for <label>` after `timeoutMs`. */
export async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}
