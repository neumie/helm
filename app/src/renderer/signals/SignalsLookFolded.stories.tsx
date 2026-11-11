import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * Jakub's pick (2026-11-11, "4 with 2"): the folded summary (the header says only Signals; one status block holds every count, the done line under it; only sections with threads are listed) in the calm look's Braille dots: a count mark on each section title, and with nothing open the slow gray dot field above "Listening to GitHub and Mail" (hollow and still while a source is not answering). The status says how many Needs you rows are already handled, so its count adds up with the list.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Sidebar look/6 Folded summary with calm dots',
	...lookMeta,
}

export default meta

const stories = lookStories('folded')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
