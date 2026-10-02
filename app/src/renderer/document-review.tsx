import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReviewApi } from '../document-review/types'
import { DocumentReview } from './document-review/DocumentReview'
import './styles.css'
import './sidebar/sidebar.css'

declare global {
	interface Window {
		documentReview: ReviewApi
	}
}
const root = document.getElementById('document-review-root')
if (!root) throw new Error('Missing document review root')
createRoot(root).render(
	<StrictMode>
		<DocumentReview api={window.documentReview} />
	</StrictMode>,
)
