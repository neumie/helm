import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * Compact inbox zero: the empty column reads as a `helm signal ls` transcript with a blinking caret; with threads open the section titles are `# needs you 3` comment lines and rows are 4px tighter. Uses the mono face for the transcript and titles (a departure: §3.24 keeps mono for literal commands).
 */
const meta: Meta<typeof SignalsWorkspace> = { title: 'Views/Signals/Sidebar look/3 Terminal transcript', ...lookMeta }

export default meta

const stories = lookStories('terminal')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
