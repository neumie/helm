import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * The folded look with calm dots, its top changed: one large count of what needs you (and how many are handled), the managed and snoozed counts on their titles, the done line pinned to the bottom of the list.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Sidebar look/8 Folded, one big number',
	...lookMeta,
}

export default meta

const stories = lookStories('folded-number')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
