import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Done threads (§3.25): the threads done today sit collapsed under `Snoozed · done today N`; `D`
 * (or a click on the count) lists them, and the choice is kept per renderer. Each done row can say
 * how it got done: read in Mail, gone from GitHub, dismissed, closed by an agent (with its
 * note), an ask answered. The `Header` stories show the collapsed subhead three ways; the `Reason`
 * stories show the listed rows with the reason in three places, next to today's look. Jakub picks
 * one of each; until then production keeps `count` and `none`. The production column on the `done`
 * fixture.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Done reason',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'done' },
	argTypes: {
		doneReasonLook: { control: 'inline-radio', options: ['none', 'age', 'ref', 'line'] },
		doneHeaderLook: { control: 'inline-radio', options: ['count', 'word', 'split'] },
		doneShown: { control: 'boolean' },
	},
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** Production now: the done rows collapsed, `done today 8` a text button, `· D` while Signals has the keys. */
export const Collapsed: Story = { name: 'Collapsed (production)', args: { doneShown: false } }

/** Header A: the count alone, `Snoozed 1 · done today 8`. */
export const HeaderCount: Story = {
	name: 'Header A · count',
	args: { doneShown: false, doneHeaderLook: 'count' },
}

/** Header B: the count and what a click does, `Snoozed 1 · done today 8 · show`. */
export const HeaderWord: Story = {
	name: 'Header B · show / hide word',
	args: { doneShown: false, doneHeaderLook: 'word' },
}

/** Header C: its own line after the snoozed rows, where the done rows open: `Done today 8 · show`. */
export const HeaderSplit: Story = {
	name: 'Header C · own line',
	args: { doneShown: false, doneHeaderLook: 'split' },
}

/** Listed, today's look: each done row shows the time it closed; the reason only as a tooltip. */
export const ReasonCurrent: Story = {
	name: 'Reason · current (time only)',
	args: { doneShown: true, doneReasonLook: 'none' },
}

/** Reason A: a short dim word replaces the time (`read`, `gone`, `dismissed`, `by agent`); the time in the tooltip. */
export const ReasonAge: Story = {
	name: 'Reason A · word in place of the time',
	args: { doneShown: true, doneReasonLook: 'age' },
}

/** Reason B: after the ref on the first line, `okena#298 · gone from GitHub`; the time stays. */
export const ReasonRef: Story = {
	name: 'Reason B · after the ref',
	args: { doneShown: true, doneReasonLook: 'ref' },
}

/** Reason C: a dim third line, `closed by invoice-resend · invoice resent, reply drafted in Mail`; the time stays. */
export const ReasonLine: Story = {
	name: 'Reason C · third line with the note',
	args: { doneShown: true, doneReasonLook: 'line' },
}
