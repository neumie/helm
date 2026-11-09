import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Agent asks (§3.25): what an agent needs from Jakub — a design pick with Storybook links, a yes or
 * no, an approval — filed with `helm signal add` and listed in Needs you with who asked. `r` answers
 * (typed into the asking agent when its Okena terminal is idle, else saved on the thread for
 * `helm signal show`), `o` opens the link (or lists several), `s`/`d` as for any thread. The two
 * row variants are open for Jakub's pick: two lines like the other sources, or a third with the body.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Agent asks',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'asks', askLayout: 'title' },
	argTypes: { askLayout: { control: 'inline-radio', options: ['title', 'body'] } },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** Variant A: an ask reads like the other rows, who asks and the title; the link count on the right. */
export const TitleRows: Story = { name: 'Agent asks — title rows' }

/** Variant B: a dim third line with the body's first line and `· N links`. */
export const BodyLine: Story = { name: 'Agent asks — body line', args: { askLayout: 'body' } }

/** `r` on the design pick from `Signals asks`, an idle Okena agent: ⌘↵ saves the answer and types it in. */
export const Reply: Story = { name: 'Reply to an agent ask', args: { flow: 'reply' } }

/** `o` on an ask with three links: each shown as text, 1–3 opens that one. */
export const Links: Story = { name: 'Open an ask link', args: { flow: 'links' } }
