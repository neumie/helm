import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { FormatStage } from './FormatStage'
import { ImageView } from './ImageView'
import { FIXTURES } from './fixtures'
import type { FeedbackAnchor, FeedbackHost } from './types'

const meta: Meta = {
	title: 'Views/Helm open/C Format views/Image',
	parameters: { layout: 'fullscreen' },
}
export default meta

type Story = StoryObj

/** Fitted to the view with a 24px inset. Keys: 0 fit, 1 actual size, + / − zoom, arrows pan. */
export const Default: Story = {
	render: () => <FormatStage file={FIXTURES.png} Renderer={ImageView} />,
}

/** One image pixel per CSS pixel; drag or arrow keys pan. */
export const ActualSize: Story = {
	render: () => <FormatStage file={FIXTURES.png} Renderer={ImageView} zoom={1} />,
}

/** The red error banner of the @2x screenshot, in image pixels. */
const ERROR_BANNER: FeedbackAnchor = { kind: 'image-region', rect: { x: 472, y: 950, width: 1456, height: 100 } }

function FeedbackStory() {
	const [active, setActive] = useState<FeedbackAnchor | null>(ERROR_BANNER)
	const feedback: FeedbackHost = { active, onAnchor: anchor => setActive(anchor) }
	return <FormatStage file={FIXTURES.png} Renderer={ImageView} feedback={feedback} />
}

/** Drag draws a region; space + drag pans; Enter points at the part in view. */
export const FeedbackMode: Story = {
	render: () => <FeedbackStory />,
}
