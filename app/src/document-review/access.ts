/** Pure authentication seam used at every native request/return boundary. Never trust renderer IDs alone. */
export interface ReviewFrame {
	isDestroyed(): boolean
}
export interface ReviewContents {
	isDestroyed(): boolean
	readonly mainFrame: ReviewFrame
}
export function requireReviewAccess(
	expected: ReviewContents | null,
	sender: unknown,
	senderFrame: unknown,
	expectedToken: string,
	presentedToken: unknown,
	current: () => boolean,
): void {
	try {
		if (
			expected &&
			sender === expected &&
			!expected.isDestroyed() &&
			senderFrame === expected.mainFrame &&
			!expected.mainFrame.isDestroyed() &&
			presentedToken === expectedToken &&
			current()
		)
			return
	} catch {
		/* disposed frame getters are refusal, not attestation */
	}
	throw new Error('This review is no longer current. Reopen it in the active profile.')
}
