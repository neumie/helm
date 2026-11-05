import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Signals: what the world wants from Jakub — review requests, PR comments, CI on his PRs, mail
 * (Sentry alerts arrive as mail) — as material to prompt an existing agent or start a new one in an
 * Okena worktree. Threads he marks **managed** are handled by the dispatcher and its agent; he sees
 * only outcomes. Signals takes the task sidebar's column (⌘⇧I); there is no resting indicator.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Column',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { count: 3 },
	argTypes: { count: { control: 'inline-radio', options: [0, 3] } },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** Needs you, Managed and Snoozed · done, with the selected row's keys in the footer. */
export const Column: Story = {}

/** A quiet afternoon: nothing needs Jakub. */
export const Quiet: Story = { args: { count: 0 } }
