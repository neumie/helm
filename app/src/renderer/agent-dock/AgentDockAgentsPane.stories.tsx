import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import type { AgentDockScenario } from './agent-dock-fixtures'
import type { AgentsLayout } from './presentation'

/**
 * The Agents overview (design §3.24 Agents): the production dock under a Claude Code session, the
 * `agents-overview` day open in the Agents pane — every agent's state relative to Jakub (question,
 * permission, plan, reply waiting 45m, working with subagents, a background shell in a Helm terminal,
 * read, unknown, not connected), where it runs, and the first line of what it last said. Rows are a
 * roving list: ↑ ↓ move, Enter or a click opens the agent's item, else its detail.
 *
 * The header says each source's health (`Okena ● · Helm terminals ●`) and switches the grouping
 * (`group state project`, or G): by state (default) or by project, stored in renderer storage (per Helm userData, like the dock position).
 */
function AgentsPaneView({
	layout,
	scenario = 'agents-overview',
	openAgent,
}: {
	layout: AgentsLayout
	scenario?: AgentDockScenario
	openAgent?: string
}) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			agentDock: {
				scenario,
				position: 'bottom',
				output: 'claude-code',
				open: 'agents',
				agentsLayout: layout,
				...(openAgent ? { openAgent } : {}),
			},
		}),
		[layout, scenario, openAgent],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const viewport = (width: number, height: number) => ({
	globals: { viewport: { value: `helm${width}`, isRotated: false } },
	parameters: {
		viewport: {
			options: {
				[`helm${width}`]: {
					name: `Helm ${width}×${height}`,
					styles: { width: `${width}px`, height: `${height}px` },
				},
			},
		},
	},
})

const WIDE = viewport(1400, 820)
const NARROW = viewport(900, 820)
const PHONE = viewport(600, 820)

const meta: Meta<typeof AgentsPaneView> = {
	title: 'Views/Agent dock agents pane',
	component: AgentsPaneView,
	parameters: { layout: 'fullscreen' },
	args: { layout: 'by-state' },
	argTypes: { layout: { control: 'inline-radio', options: ['by-state', 'by-project'] } },
}

export default meta
type Story = StoryObj<typeof AgentsPaneView>

/** By state (default): Needs you / Reply waiting / Working / Background / Read / Unknown; the project a dim column. */
export const ByState: Story = { name: 'By state', ...WIDE, args: { layout: 'by-state' } }
/** By project: one dim heading per repository, led by its most urgent agent; the excerpt a flexible column. */
export const ByProject: Story = { name: 'By project', ...WIDE, args: { layout: 'by-project' } }

export const ByStateNarrow: Story = { name: 'By state 900', ...NARROW, args: { layout: 'by-state' } }
export const ByProjectNarrow: Story = { name: 'By project 900', ...NARROW, args: { layout: 'by-project' } }

/**
 * Each source's health in the header: both connected (green dots), Okena unreachable (red, its agents
 * frozen; the row keeps its `! Okena unreachable` note), Helm terminals still connecting (neutral).
 * The words are each dot's tooltip and accessible name.
 */
export const SourcesConnected: Story = { name: 'Sources: both connected', ...WIDE, args: { layout: 'by-state' } }
export const SourcesOkenaDown: Story = {
	name: 'Sources: Okena down',
	...WIDE,
	args: { layout: 'by-state', scenario: 'agents-okena-down' },
}
export const SourcesHelmConnecting: Story = {
	name: 'Sources: Helm connecting',
	...WIDE,
	args: { layout: 'by-state', scenario: 'agents-helm-connecting' },
}
/** Below 640px the header keeps only the dots (their words stay their names). */
export const SourcesOkenaDownNarrow: Story = {
	name: 'Sources: Okena down 600',
	...PHONE,
	args: { layout: 'by-state', scenario: 'agents-okena-down' },
}

/**
 * An agent's detail: the read JVS worktree opened from the list (a click): its state and where in
 * the header, its last message in full as quiet Markdown (read live through its source), a reply field
 * with Send (the same CAS and receipts as a turn reply). Esc goes back to its row; ‹ › step agents.
 */
export const AgentDetail: Story = {
	name: 'Agent detail',
	...WIDE,
	args: { layout: 'by-state', openAgent: 'service-protocol-image-link' },
}
export const AgentDetailNarrow: Story = {
	name: 'Agent detail 900',
	...NARROW,
	args: { layout: 'by-state', openAgent: 'service-protocol-image-link' },
}
