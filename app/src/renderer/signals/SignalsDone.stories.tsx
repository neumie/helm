import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Done threads (§3.25): after the snoozed rows, their own `Done today 8 · show` line, with the
 * filtered mail count after it (`· 5 filtered`). `D` (or a click on the count) lists or hides the
 * done rows, and the choice is kept per renderer; `f` opens the filtered mail. A listed done row
 * says how it got done after its ref (`okena#298 · gone from GitHub`), the whole as tooltip. The
 * production column on the `done` fixture: one row per way a thread gets done.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Done',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'done' },
	argTypes: { doneShown: { control: 'boolean' } },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** The done rows collapsed under `Done today 8 · show · 5 filtered`. */
export const Collapsed: Story = { args: { doneShown: false } }

/** The done rows listed, each with how it got done after its ref. */
export const Listed: Story = { args: { doneShown: true } }
