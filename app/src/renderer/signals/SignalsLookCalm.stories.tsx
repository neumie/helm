import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * With nothing open the column becomes one centered calm state: three Braille cells in the ActivityIndicator's dot language, a slow gray wave (still under reduced motion, hollow while a source is not answering). With threads open the done line sits pinned at the bottom of the column.
 */
const meta: Meta<typeof SignalsWorkspace> = { title: 'Views/Signals/Sidebar look/2 Calm dots', ...lookMeta }

export default meta

const stories = lookStories('calm')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
