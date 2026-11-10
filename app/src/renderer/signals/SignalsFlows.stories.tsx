import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Routing a thread to an agent from the Signals column (§3.25). Both prefill an editable prompt that
 * fences the outside text as data; ⌘↵ sends or starts, Esc goes back to the list.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Flows',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'column' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** `p` on crane-rental#970's two comments: the PR's own agent preselected, busy agents dim, ⌘↵ sends. */
export const SendToAgent: Story = { args: { flow: 'send' } }

/** `n` on the Sentry alert: an Okena project, a new worktree branch, claude, ⌘↵ starts it. */
export const NewAgentInOkena: Story = { args: { flow: 'new-agent' } }

/**
 * `f` / the `5 filtered` line: mail the rules kept out, heads only, last 7 days. `i` always shows the
 * sender; on a muted (`excluded`, `x` in the list) row it unmutes it instead (`ci@builds.example`).
 */
export const FilteredMail: Story = { args: { flow: 'filtered' } }
