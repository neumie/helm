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

/** Opt-in agent dock below the terminals (production layout + reducer-built Okena fixtures): the 28px queue row, no pane; arriving items never change its height. */
export const AgentDock: Story = {
	args: { options: { agentDock: { scenario: 'busy', position: 'bottom', output: true } } },
}

/** Two-question AskUserQuestion with option previews in a pane split off the terminal (it refits once, nothing floats). */
export const AgentDockQuestion: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', position: 'bottom', output: true, open: 'question' } },
	},
}

/** Permission dialog: the command, and "Always allow" only from Claude's own permission_suggestions. */
export const AgentDockPermission: Story = {
	args: {
		options: {
			agentDock: { scenario: 'crowded', position: 'bottom', output: true, open: 'permission' },
		},
	},
}

/** Plan approval: the plan verbatim, Approve the plan / Keep planning. */
export const AgentDockPlan: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', position: 'bottom', output: true, open: 'plan' } },
	},
}

/** Unchecked turn: the full last message, PR facts, and a live Ack. */
export const AgentDockTurn: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', position: 'bottom', output: true, open: 'turn' } },
	},
}

/** Orphaned question (Okena restarted while it was open): amber kind, warning line, Ack. */
export const AgentDockOrphaned: Story = {
	args: {
		options: {
			agentDock: { scenario: 'orphaned', position: 'bottom', output: true, open: 'orphaned' },
		},
	},
}

/** The Agents pane: every listed agent with observed status/meta, then Recent. */
export const AgentDockAgents: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', position: 'bottom', output: true, open: 'agents' } },
	},
}

const NARROW_VIEWPORT = {
	globals: { viewport: { value: 'helm900', isRotated: false } },
	parameters: {
		viewport: { options: { helm900: { name: 'Helm 900×700', styles: { width: '900px', height: '700px' } } } },
	},
}

/** 900px window: five items in the one row, names shortened in the middle, the rest behind "+N more". */
export const AgentDockNarrow: Story = {
	...NARROW_VIEWPORT,
	args: { options: { agentDock: { scenario: 'crowded', position: 'bottom', output: true } } },
}

/** 900px window with the question open: the preview stacks under the options. */
export const AgentDockNarrowQuestion: Story = {
	...NARROW_VIEWPORT,
	args: {
		options: { agentDock: { scenario: 'crowded', position: 'bottom', output: true, open: 'question' } },
	},
}

/** Okena unreachable: the queue leads with the outage, entries and agents are frozen, never "all clear". */
export const AgentDockSourceDown: Story = {
	args: { options: { agentDock: { scenario: 'down', position: 'bottom', output: true } } },
}

/** Okena reachable, no Claude session connected. */
export const AgentDockEmpty: Story = {
	args: { options: { agentDock: { scenario: 'empty', position: 'bottom' } } },
}

/** The persisted top position: the queue row, then the pane above the terminal. */
export const AgentDockTop: Story = {
	args: {
		options: { agentDock: { scenario: 'crowded', position: 'top', output: true, open: 'question' } },
	},
}

/** Answering: Sending… while main runs the Okena CAS read and POST (receipt on the entry and in the pane). */
export const AgentDockReceiptSending: Story = {
	args: {
		options: {
			agentDock: { scenario: 'receipt-sending', position: 'bottom', output: true, open: 'question' },
		},
	},
}

/** Sent but not observed within 10 s: amber "sent, unconfirmed" with Ack. */
export const AgentDockReceiptUnconfirmed: Story = {
	args: {
		options: {
			agentDock: {
				scenario: 'receipt-unconfirmed',
				position: 'bottom',
				output: true,
				open: 'question',
			},
		},
	},
}

/** Observed landing: "✓ answered" shows in place on the entry (it keeps its slot) before it leaves the queue. */
export const AgentDockReceiptAnswered: Story = {
	args: {
		options: {
			agentDock: { scenario: 'receipt-answered', position: 'bottom', output: true, open: 'question' },
		},
	},
}

/** CAS mismatch: "refused: already answered elsewhere". */
export const AgentDockReceiptRefused: Story = {
	args: {
		options: {
			agentDock: { scenario: 'receipt-refused', position: 'bottom', output: true, open: 'question' },
		},
	},
}

/** Okena error: verbatim, controls live again. */
export const AgentDockReceiptFailed: Story = {
	args: {
		options: {
			agentDock: { scenario: 'receipt-failed', position: 'bottom', output: true, open: 'question' },
		},
	},
}

/** Chromium harness: stored layout preferences decide placement; the test drives scenarios. */
export const AgentDockHarness: Story = { args: { options: { agentDock: { scenario: 'empty' }, expose: true } } }
