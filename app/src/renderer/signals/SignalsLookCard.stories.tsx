import type { Meta } from '@storybook/react-vite'
import type { SignalsWorkspace } from './SignalsWorkspace'
import { lookMeta, lookStories } from './sidebar-look-stories'

/**
 * Each empty section is a centered dashed card with a small line-art glyph (an empty tray for Needs you, a hand-off arrow for Managed). Section titles carry their count. Departs from §3.25 "no cards" on purpose (Jakub's suggestion).
 */
const meta: Meta<typeof SignalsWorkspace> = { title: 'Views/Signals/Sidebar look/1 Dashed card', ...lookMeta }

export default meta

const stories = lookStories('card')
export const Empty = stories.Empty
export const Busy = stories.Busy
export const HalfQuiet = stories.HalfQuiet
export const EmptySourceDown = stories.EmptySourceDown
export const Widths = stories.Widths
