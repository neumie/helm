import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'
import { DocxView } from './DocxView'
import { FormatStage } from './FormatStage'
import { MarkdownView } from './MarkdownView'
import { FIXTURES } from './fixtures'
import type { FeedbackAnchor, FeedbackHost, RendererProps } from './types'

/**
 * `helm open` document renderers (story-only prototype, docs/plans/helm-open/spec.md). DOCX through
 * docx-preview: paper pages on the well, fit to width up to 100%, links stripped, no alt-chunk HTML.
 * Markdown through marked's Lexer into explicit React elements: no parser HTML, no image fetches,
 * links that never navigate; a Rendered / Source pair at the top right.
 */
const meta: Meta = {
	title: 'Views/Helm open/C Format views/Documents',
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

/** Agent feedback mode host: the latest anchor stays active (painted) until the next one. */
function useFeedbackHost(initial: FeedbackAnchor | null): FeedbackHost {
	const [active, setActive] = useState<FeedbackAnchor | null>(initial)
	return useMemo(() => ({ active, onAnchor: anchor => setActive(anchor) }), [active])
}

function MarkdownSourceView(props: RendererProps) {
	return <MarkdownView {...props} initialMode="source" />
}

export const Docx: Story = {
	render: () => <FormatStage file={FIXTURES.docx} Renderer={DocxView} />,
}

export const Markdown: Story = {
	render: () => <FormatStage file={FIXTURES.md} Renderer={MarkdownView} />,
}

export const MarkdownSource: Story = {
	render: () => <FormatStage file={FIXTURES.md} Renderer={MarkdownSourceView} />,
}

function DocxFeedback() {
	const feedback = useFeedbackHost({ kind: 'text', quote: '2 100 CZK / hour' })
	return <FormatStage file={FIXTURES.docx} Renderer={DocxView} feedback={feedback} />
}

/** Feedback mode: select text on the page to anchor; the active anchor stays painted. */
export const DocxFeedbackMode: Story = {
	render: () => <DocxFeedback />,
}

function MarkdownFeedback() {
	const feedback = useFeedbackHost({
		kind: 'text',
		quote: 'Treat a missing ARES record as unverified, not as an error.',
	})
	return <FormatStage file={FIXTURES.md} Renderer={MarkdownView} feedback={feedback} />
}

/** Feedback mode on Markdown: selections report a text anchor with its block id. */
export const MarkdownFeedbackMode: Story = {
	render: () => <MarkdownFeedback />,
}
