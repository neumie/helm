import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Done threads (§3.25): after the snoozed rows, one `Done today 8` line with the filtered mail
 * count after it (`· 5 filtered`). `D` (or a click on the count) opens **Done today** in place of
 * the list, built like Filtered mail (`f`): every thread done in the last 24 hours, each saying how
 * it got done after its ref (`okena#298 · gone from GitHub`, the whole as tooltip); `t` reopens,
 * `o` opens, Esc back. The production column on the `done` fixture: one row per way a thread gets done.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Done',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'done' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** The list with its `Done today 8 · 5 filtered` line after the snoozed rows. */
export const Line: Story = {}

/** `D`: the Done today list, each row with how it got done after its ref. */
export const List: Story = { args: { flow: 'done' } }
