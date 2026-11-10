import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Signals (§3.25): what the world wants from Jakub — review requests, PR comments, failed CI on his
 * PRs, mentions, mail (Sentry alerts arrive as mail) — in the task sidebar's column, as material to
 * prompt a running agent or start a new one in an Okena worktree. Threads he marks **managed** are
 * handled by the dispatcher and its agent; he sees outcomes. ⌘⇧I goes to Signals; there is no
 * resting indicator. The production column on in-memory services.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Column',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'column' },
	argTypes: { scenario: { control: 'inline-radio', options: ['column', 'quiet', 'source-down'] } },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** Needs you, Managed, Snoozed and the `Done today` line (D opens the done list), with the selected row's keys in the footer. */
export const Column: Story = {}

/** A quiet afternoon: nothing needs Jakub, every source answered. */
export const Quiet: Story = { args: { scenario: 'quiet' } }

/** Mail needs the Automation permission: the footer says so, never an all-clear. */
export const SourceDown: Story = { args: { scenario: 'source-down' } }
