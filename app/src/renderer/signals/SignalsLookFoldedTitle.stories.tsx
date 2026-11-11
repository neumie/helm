import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * The folded look with calm dots, its top changed: no status block; the header's dim summary (`6 need you · 2 managed`) as in production, each section title with its count (Needs you also says how many are handled), and the done line pinned to the bottom of the list.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Sidebar look/7 Folded, counts in the title',
	...lookMeta,
}

export default meta

const stories = lookStories('folded-title')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
