import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo } from 'react'
import './document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { DocumentReview } from './DocumentReview'
import { createReviewFixture } from './fixtures'
import type { ReviewFixtureScenario } from './fixtures'

declare global {
	interface Window {
		__helmDocumentReviewProof?: ReturnType<typeof createReviewFixture>
	}
}
function ReviewFixture({ scenario = 'normal' }: { scenario?: ReviewFixtureScenario }) {
	const fixture = useMemo(() => createReviewFixture(scenario), [scenario])
	useEffect(() => {
		window.__helmDocumentReviewProof = fixture
		return () => {
			if (window.__helmDocumentReviewProof === fixture) window.__helmDocumentReviewProof = undefined
			fixture.dispose()
		}
	}, [fixture])
	return <DocumentReview api={fixture.api} />
}
const meta = {
	title: 'Views/Document review',
	component: ReviewFixture,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'normal' },
} satisfies Meta<typeof ReviewFixture>
export default meta
type Story = StoryObj<typeof meta>
export const Reading: Story = {}
export const Light: Story = { args: { scenario: 'light' } }
export const Working: Story = { args: { scenario: 'working' } }
export const MissingFile: Story = { args: { scenario: 'missing' } }
export const UnknownOutcome: Story = { args: { scenario: 'uncertain' } }
export const Comments: Story = { args: { scenario: 'comments' } }
export const StaleAnchor: Story = { args: { scenario: 'stale' } }
export const Changes: Story = { args: { scenario: 'changes' } }
export const SaveFailure: Story = { args: { scenario: 'save-failure' } }
export const NoConnectedAgent: Story = { args: { scenario: 'no-agent' } }
export const ListenerPaused: Story = { args: { scenario: 'not-listening' } }

export const PassageFeedback: Story = {
	play: async ({ canvasElement }) => {
		await new Promise<void>((resolve, reject) => {
			const open = () => {
				const button = canvasElement.querySelector<HTMLButtonElement>(
					'[aria-label="Review passage Dispatch guarantees"]',
				)
				if (!button) return false
				button.click()
				return true
			}
			if (open()) return resolve()
			const timer = setTimeout(() => {
				observer.disconnect()
				reject(new Error('Review fixture did not load'))
			}, 10000)
			const observer = new MutationObserver(() => {
				if (open()) {
					observer.disconnect()
					clearTimeout(timer)
					resolve()
				}
			})
			observer.observe(canvasElement, { childList: true, subtree: true })
		})
	},
}
