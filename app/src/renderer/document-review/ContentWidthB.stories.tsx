import type { Meta, StoryObj } from '@storybook/react-vite'
import './document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { ContentWidthReview, atWindow, contentWidthParameters } from './content-width-stories'

const meta = {
	title: 'Views/Document review/Content width/B Fluid content',
	component: ContentWidthReview,
	parameters: contentWidthParameters,
	args: { contentWidth: 'fluid' },
} satisfies Meta<typeof ContentWidthReview>
export default meta
type Story = StoryObj<typeof meta>

const about = 'The whole document fills the column up to 1160px, centered. Prose lines grow with the window.'
export const Window1000: Story = atWindow('window1000', about)
export const Window1400: Story = atWindow('window1400', about)
export const Window1900: Story = atWindow('window1900', about)
