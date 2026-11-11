import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * Look 9 (nothing on top) with each section title on a full-width chrome-colored band that sticks to the top while its rows scroll under it.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Sidebar look/11 Folded, sections on a band',
	...lookMeta,
}

export default meta

const stories = lookStories('folded-band')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
