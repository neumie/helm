/** Polls `check` until it holds (instead of a fixed sleep that loses the race under load). */
export async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}
