import { useSyncExternalStore } from 'react'
import { type UiScaleValue, uiScaleOrDefault } from '../../ui-scale'

/**
 * The cockpit's UI scale as the document window applies it (§9 ruling 108): `document-review.tsx` sets `--ui-scale`
 * on the document root (stories set it there too). CSS reads it directly; this is for the parts sized in script
 * (the CSV grid, row estimates, and the resize nudge that re-measures anchored bubbles and the code editor).
 */
export function documentUiScale(): UiScaleValue {
	if (typeof document === 'undefined') return 1
	const raw = document.documentElement.style.getPropertyValue('--ui-scale').trim()
	return raw ? uiScaleOrDefault(Number(raw)) : 1
}

function subscribe(onChange: () => void): () => void {
	const observer = new MutationObserver(onChange)
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
	return () => observer.disconnect()
}

/** Re-renders when the document root's `--ui-scale` changes. */
export function useDocumentUiScale(): UiScaleValue {
	return useSyncExternalStore(subscribe, documentUiScale, () => 1)
}
