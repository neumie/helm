import type { Meta, StoryObj } from '@storybook/react-vite'
import { TerminalWorkspaceFixtureView, fixtureGroups, fixtureSessions } from './terminal-workspace-fixtures'

const meta: Meta<typeof TerminalWorkspaceFixtureView> = {
	title: 'Views/Terminal workspace',
	component: TerminalWorkspaceFixtureView,
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof TerminalWorkspaceFixtureView>

/** All terminal/group/popover markup comes from the real mount, never story JSX. */
export const FullWorkspace: Story = { args: { options: {} } }

export const TabStrip: Story = {
	args: {
		options: {
			sessions: fixtureSessions().map(session => ({ ...session, parked: false })),
		},
	},
}

export const BackgroundTerminals: Story = { args: { options: { openBackground: true } } }

export const CollapsedBackgroundGroup: Story = {
	args: {
		options: {
			openBackground: true,
			groups: fixtureGroups().map(group =>
				group.id === 'group-000000b2' ? { ...group, collapsedBackground: true } : group,
			),
		},
	},
}

export const GroupedTabHeaders: Story = { args: { options: {} } }

export const CollapsedTabGroup: Story = {
	args: {
		options: {
			groups: fixtureGroups().map(group =>
				group.id === 'group-000000a1' ? { ...group, collapsedStrip: true } : group,
			),
		},
	},
}

/** Stable interaction fixture for Chromium; it exposes only fake-bridge call records. */
export const BrowserHarness: Story = { args: { options: { openBackground: true, expose: true } } }
