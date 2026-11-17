import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReviewApi, ReviewAppearanceApi } from '../document-review/types'
import { uiScaleOrDefault } from '../ui-scale'
import { DocumentReview } from './document-review/DocumentReview'
import './styles.css'
import './sidebar/sidebar.css'

declare global {
	interface Window {
		documentReview: ReviewApi
		documentReviewAppearance?: ReviewAppearanceApi
	}
}
// The window follows the cockpit's UI scale (§9 ruling 108): set before the first paint, then on every change.
const applyUiScale = (raw: unknown) =>
	document.documentElement.style.setProperty('--ui-scale', String(uiScaleOrDefault(raw)))
const appearance = window.documentReviewAppearance
if (appearance) {
	applyUiScale(appearance.uiScale())
	appearance.onUiScale(applyUiScale)
}
const root = document.getElementById('document-review-root')
if (!root) throw new Error('Missing document review root')
createRoot(root).render(
	<StrictMode>
		<DocumentReview api={window.documentReview} />
	</StrictMode>,
)
