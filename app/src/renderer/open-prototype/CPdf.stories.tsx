import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { FormatStage } from './FormatStage'
import { PdfView } from './PdfView'
import { FIXTURES } from './fixtures'
import type { FeedbackAnchor, FeedbackHost } from './types'

const meta: Meta = {
	title: 'Views/Helm open/C Format views/PDF',
	parameters: { layout: 'fullscreen' },
}
export default meta

type Story = StoryObj

/** Every page on the well, fit to width; pages paint as they near the view. Text selects and copies. */
export const Default: Story = {
	render: () => <FormatStage file={FIXTURES.pdf} Renderer={PdfView} />,
}

/** Zoom 1.5 over fit-width: wider than the view, so the view scrolls sideways as well. */
export const Zoomed: Story = {
	render: () => <FormatStage file={FIXTURES.pdf} Renderer={PdfView} zoom={1.5} />,
}

/** The "Revenue by client" chart on page 1, as normalized page fractions. */
const REVENUE_CHART: FeedbackAnchor = {
	kind: 'pdf-region',
	page: 1,
	rect: { x: 0.09, y: 0.45, width: 0.82, height: 0.26 },
}

function FeedbackStory() {
	const [active, setActive] = useState<FeedbackAnchor | null>(REVENUE_CHART)
	const feedback: FeedbackHost = { active, onAnchor: anchor => setActive(anchor) }
	return <FormatStage file={FIXTURES.pdf} Renderer={PdfView} feedback={feedback} />
}

/** Select text to point at a quote; hold Option and drag to point at a region. The anchor stays painted. */
export const FeedbackMode: Story = {
	render: () => <FeedbackStory />,
}
