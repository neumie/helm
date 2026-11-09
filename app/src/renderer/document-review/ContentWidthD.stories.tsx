import type { Meta, StoryObj } from '@storybook/react-vite'
import './document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { ContentWidthReview, atWindow, contentWidthParameters } from './content-width-stories'

const meta = {
	title: 'Views/Document review/Content width/D Measure, blocks fit content',
	component: ContentWidthReview,
	parameters: contentWidthParameters,
	args: { contentWidth: 'fit' },
} satisfies Meta<typeof ContentWidthReview>
export default meta
type Story = StoryObj<typeof meta>

const about =
	'Prose keeps the 680px measure. A table or code block is as wide as its content needs: at least the measure, at most the column (1280px cap), centered on the prose.'
export const Window1000: Story = atWindow('window1000', about)
export const Window1400: Story = atWindow('window1400', about)
export const Window1900: Story = atWindow('window1900', about)
