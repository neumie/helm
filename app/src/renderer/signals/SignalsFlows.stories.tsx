import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * C — routing a thread to an agent, shown in the A1 pane (the flow body is the same in any
 * placement). Both prefill an editable prompt that fences the outside text as data.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/C Flows',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { placement: 'pane', count: 3, paneWidth: 480 },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** C1 — `p` on crane-rental#970's two comments: pick a running agent (the PR's own first), edit, ⌘↵. */
export const SendToAgent: Story = { args: { flow: 'send' } }

/** C2 — `n` on the Sentry alert: a new worktree in psyon-admin, pick the agent CLI, edit, ⌘↵. */
export const NewAgentInOkena: Story = { args: { flow: 'new-agent' } }
