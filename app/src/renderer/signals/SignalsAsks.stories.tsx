import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Agent asks (§3.25): what an agent needs from Jakub — a design pick with Storybook links, a yes or
 * no, an approval — filed with `helm signal add` and listed in Needs you with who asked. `r` answers
 * (typed into the asking agent when its Okena terminal is idle, else saved on the thread for
 * `helm signal show`), `o` opens the link (or lists several), `s`/`d` as for any thread. An ask's row
 * adds a dim third line: its body's first line and `· N links`.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Agent asks',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'asks' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** Asks in Needs you: who asks and the title, then a dim line with the body's first line and `· N links`. */
export const NeedsYou: Story = { name: 'Agent asks in Needs you' }

/** `r` on the design pick from `Signals asks`, an idle Okena agent: ⌘↵ saves the answer and types it in. */
export const Reply: Story = { name: 'Reply to an agent ask', args: { flow: 'reply' } }

/** `o` on an ask with three links: each shown as text, 1–3 opens that one. */
export const Links: Story = { name: 'Open an ask link', args: { flow: 'links' } }
