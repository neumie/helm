import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * Look 9 (nothing on top) with a wider gap between sections and a 2px rail down the left edge of each, from its title to its last row.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Sidebar look/12 Folded, sections on a rail',
	...lookMeta,
}

export default meta

const stories = lookStories('folded-rail')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
