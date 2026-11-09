import type { Meta, StoryObj } from '@storybook/react-vite'
import './document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { ContentWidthReview, atWindow, contentWidthParameters } from './content-width-stories'

const meta = {
	title: 'Views/Document review/Content width/Today (680px cap)',
	component: ContentWidthReview,
	parameters: contentWidthParameters,
	args: {},
} satisfies Meta<typeof ContentWidthReview>
export default meta
type Story = StoryObj<typeof meta>

const about =
	'Production today: .review-prose caps the whole document at 680px, tables included. Inline code drops to 12px and breaks anywhere, so the e-mail column collapses.'
export const Window1000: Story = atWindow('window1000', about)
export const Window1400: Story = atWindow('window1400', about)
export const Window1900: Story = atWindow('window1900', about)
