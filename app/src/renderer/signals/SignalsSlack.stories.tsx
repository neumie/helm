// Views / Signals / Slack (§3.25). The Slack source in the production Signals column, and the
// shipped reply flow (heads only — Jakub's pick, 2026-11-11).

import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Slack',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'slack' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** Slack DMs, a group DM, an @mention and a followed thread in Needs you, plus a filtered bot message. */
export const Column: Story = {}

/** `r` on the DM from Klára: the heads-only reply flow posts to Slack and closes the thread. */
export const Reply: Story = { args: { flow: 'slack-reply' } }
