import type { Meta, StoryObj } from '@storybook/react-vite'
import './document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { ContentWidthReview, atWindow, contentWidthParameters } from './content-width-stories'

const meta = {
	title: 'Views/Document review/Content width/C Width toggle',
	component: ContentWidthReview,
	parameters: contentWidthParameters,
	args: { contentWidth: 'choice', initialReadingWidth: 'wide' },
} satisfies Meta<typeof ContentWidthReview>
export default meta
type Story = StoryObj<typeof meta>

const about =
	'Document options → Width offers Narrow (680px), Wide (960px, default) and Full (no cap); ⌥⌘1/2/3 switch directly. The choice is one app-wide preference (localStorage helm.reading.width), not per window or document. Each story starts from its named choice.'
export const WideWindow1000: Story = { ...atWindow('window1000', about), name: 'Wide · Window 1000×800' }
export const WideWindow1400: Story = { ...atWindow('window1400', about), name: 'Wide · Window 1400×800' }
export const WideWindow1900: Story = { ...atWindow('window1900', about), name: 'Wide · Window 1900×800' }
export const NarrowWindow1900: Story = {
	...atWindow('window1900', about),
	name: 'Narrow · Window 1900×800',
	args: { initialReadingWidth: 'narrow' },
}
export const FullWindow1900: Story = {
	...atWindow('window1900', about),
	name: 'Full · Window 1900×800',
	args: { initialReadingWidth: 'full' },
}
