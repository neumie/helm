import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * A count strip under the title (needs you, managed, done today, filtered; done and filtered open their lists). Only sections holding threads get a title. At rest the empty space shows what lands here: the kind glyph legend and when each source last answered.
 */
const meta: Meta<typeof SignalsWorkspace> = { title: 'Views/Signals/Sidebar look/5 Ledger and legend', ...lookMeta }

export default meta

const stories = lookStories('ledger')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
