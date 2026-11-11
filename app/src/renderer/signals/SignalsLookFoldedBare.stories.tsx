import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * The folded look with calm dots, its top changed: the header says only Signals and nothing sits above the list; each section title carries its count, the done line is pinned to the bottom of the list.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Sidebar look/9 Folded, nothing on top',
	...lookMeta,
}

export default meta

const stories = lookStories('folded-bare')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
