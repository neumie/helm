import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * Empty sections leave the list and fold into one quiet line (`Nothing needs you · nothing managed`) with the done line under it; with nothing open, one centered "listening" illustration names the sources that answered. The header drops its summary, the folded line says it.
 */
const meta: Meta<typeof SignalsWorkspace> = { title: 'Views/Signals/Sidebar look/4 Folded summary', ...lookMeta }

export default meta

const stories = lookStories('summary')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
