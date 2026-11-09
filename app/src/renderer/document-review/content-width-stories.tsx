/**
 * Harness for Views/Document review/Content width (Storybook only). Each story
 * is a real window width with the companion visible, so the production layout
 * code measures the actual space.
 */
import { useEffect, useMemo } from 'react'
import { DocumentReview } from './DocumentReview'
import { createReviewFixture } from './fixtures'

export const CONTENT_WIDTH_WINDOWS = {
	window1000: { name: 'Window 1000×800', styles: { width: '1000px', height: '800px' }, type: 'desktop' },
	window1400: { name: 'Window 1400×800', styles: { width: '1400px', height: '800px' }, type: 'desktop' },
	window1900: { name: 'Window 1900×800', styles: { width: '1900px', height: '800px' }, type: 'desktop' },
} as const
export type ContentWidthWindow = keyof typeof CONTENT_WIDTH_WINDOWS

export function ContentWidthReview() {
	const fixture = useMemo(() => createReviewFixture('content-width'), [])
	useEffect(() => () => fixture.dispose(), [fixture])
	return <DocumentReview api={fixture.api} />
}

/** Story fields that open the review in one of the three reference windows. */
export function atWindow(window: ContentWidthWindow, description: string) {
	return {
		name: CONTENT_WIDTH_WINDOWS[window].name,
		globals: { viewport: { value: window, isRotated: false } },
		parameters: { docs: { description: { story: description } } },
	}
}

export const contentWidthParameters = {
	layout: 'fullscreen',
	viewport: { options: CONTENT_WIDTH_WINDOWS },
} as const
