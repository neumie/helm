import type { Meta, StoryObj } from '@storybook/react-vite'
import './document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { ContentWidthReview, atWindow, contentWidthParameters } from './content-width-stories'

const meta = {
	title: 'Views/Document review/Content width/A Prose measure, wide blocks out',
	component: ContentWidthReview,
	parameters: contentWidthParameters,
	args: { contentWidth: 'measure' },
} satisfies Meta<typeof ContentWidthReview>
export default meta
type Story = StoryObj<typeof meta>

const about =
	'Paragraphs, lists and headings keep the 680px measure. Tables and code blocks take the whole column up to 1280px and scroll sideways in their own box.'
export const Window1000: Story = atWindow('window1000', about)
export const Window1400: Story = atWindow('window1400', about)
export const Window1900: Story = atWindow('window1900', about)
