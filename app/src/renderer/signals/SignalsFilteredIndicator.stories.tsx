import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * The filtered mail count (§3.25): how many mails the rules kept out of Needs you. `f` opens the
 * list and `i` there includes a sender, whatever look the count has. Production keeps it as the
 * footer's last line until Jakub picks one of the other three. The production column on the
 * `done` fixture (5 filtered mails, the done rows collapsed).
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Filtered indicator',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'done', doneShown: false },
	argTypes: {
		filteredLook: { control: 'inline-radio', options: ['footer', 'closed', 'key', 'header'] },
	},
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** Production now: `5 filtered · f` as the footer's last line, under the key hints. */
export const Footer: Story = { name: 'Footer (production)', args: { filteredLook: 'footer' } }

/** A: in the closed subhead after the done count, `Snoozed 1 · done today 8 · 5 filtered`. */
export const Closed: Story = { name: 'A · next to the done count', args: { filteredLook: 'closed' } }

/** B: no resting text; `f 5 filtered` shows among the key hints only while Signals holds the keys. */
export const Key: Story = { name: 'B · key hint only', args: { filteredLook: 'key' } }

/** C: a dim `· 5 filtered` after the header summary, only when the count is above 0. */
export const Header: Story = { name: 'C · in the header line', args: { filteredLook: 'header' } }
