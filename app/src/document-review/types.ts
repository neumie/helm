// Shared by the sandboxed renderer, native host, CLI, and caller-owned connectors.
export * from '../../../src/document-review/types'

/** The cockpit's UI scale for a document view (§9 ruling 108); values are untrusted until `uiScaleOrDefault`. */
export interface ReviewAppearanceApi {
	/** The scale in effect now, for the first paint. */
	uiScale(): unknown
	/** Follow later changes; returns the unsubscribe. */
	onUiScale(listener: (scale: unknown) => void): () => void
}
