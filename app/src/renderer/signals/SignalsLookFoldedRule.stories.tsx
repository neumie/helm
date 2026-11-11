import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * Look 9 (nothing on top) with each section set apart by a full-width hairline over its title (all but the first) and the gap around it.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Sidebar look/10 Folded, sections under a rule',
	...lookMeta,
}

export default meta

const stories = lookStories('folded-rule')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
