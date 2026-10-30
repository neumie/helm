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

/** Opt-in task-sidebar proof; no daemon/task backend and no default workload changes. */
/** Shared production width/visibility seam; task DOM and terminal identities stay mounted. */
export const SidebarVisibility: Story = { args: { options: { sidebarVisibility: true, expose: true } } }

/** Opt-in agent dock below the terminals (production layout + reducer-built Okena fixtures): rail open. */
export const AgentDock: Story = {
	args: { options: { agentDock: { scenario: 'busy', expanded: true, position: 'bottom', output: true } } },
}

/** The default 28px strip; arriving items never change its height or open the rail. */
export const AgentDockCollapsed: Story = {
	args: { options: { agentDock: { scenario: 'busy', expanded: false, position: 'bottom', output: true } } },
}

/** Two-question AskUserQuestion with option previews; the popover keeps the last terminal rows visible. */
export const AgentDockQuestion: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', expanded: true, position: 'bottom', output: true, open: 'question' } },
	},
}

/** Permission dialog: the command, and "Always allow" only from Claude's own permission_suggestions. */
export const AgentDockPermission: Story = {
	args: {
		options: {
			agentDock: { scenario: 'crowded', expanded: true, position: 'bottom', output: true, open: 'permission' },
		},
	},
}

/** Plan approval: the plan verbatim in a well; approval stays in the terminal for now. */
export const AgentDockPlan: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', expanded: true, position: 'bottom', output: true, open: 'plan' } },
	},
}

/** Unchecked turn: the full last message, PR facts, and a live Ack. */
export const AgentDockTurn: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', expanded: true, position: 'bottom', output: true, open: 'turn' } },
	},
}

/** Orphaned question (Okena restarted while it was open): dashed edge, warning line, Ack. */
export const AgentDockOrphaned: Story = {
	args: {
		options: {
			agentDock: { scenario: 'orphaned', expanded: true, position: 'bottom', output: true, open: 'orphaned' },
		},
	},
}

/** The Agents button's popover: every listed agent with observed status/meta, then Recent. */
export const AgentDockAgents: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', expanded: true, position: 'bottom', output: true, open: 'agents' } },
	},
}

const NARROW_VIEWPORT = {
	globals: { viewport: { value: 'helm900', isRotated: false } },
	parameters: {
		viewport: { options: { helm900: { name: 'Helm 900×700', styles: { width: '900px', height: '700px' } } } },
	},
}

/** 900px window: five items fold into compact cards so every one stays visible. */
export const AgentDockNarrow: Story = {
	...NARROW_VIEWPORT,
	args: { options: { agentDock: { scenario: 'crowded', expanded: true, position: 'bottom', output: true } } },
}

/** 900px window with the question open: the preview stacks under the options. */
export const AgentDockNarrowQuestion: Story = {
	...NARROW_VIEWPORT,
	args: {
		options: { agentDock: { scenario: 'crowded', expanded: true, position: 'bottom', output: true, open: 'question' } },
	},
}

/** Okena unreachable: the rail leads with the outage, cards and agents are frozen, never "all clear". */
export const AgentDockSourceDown: Story = {
	args: { options: { agentDock: { scenario: 'down', expanded: true, position: 'bottom', output: true } } },
}

/** Okena reachable, no Claude session connected. */
export const AgentDockEmpty: Story = {
	args: { options: { agentDock: { scenario: 'empty', expanded: true, position: 'bottom' } } },
}

/** The persisted top position: the rail opens downward and so does the popover. */
export const AgentDockTop: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', expanded: true, position: 'top', output: true, open: 'question' } },
	},
}

/** Chromium harness: stored layout preferences decide placement; the test drives scenarios. */
export const AgentDockHarness: Story = { args: { options: { agentDock: { scenario: 'empty' }, expose: true } } }
