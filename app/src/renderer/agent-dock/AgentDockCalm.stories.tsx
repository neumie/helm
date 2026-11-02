import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import type { AgentDockLook } from './look'

type CalmState = 'question' | 'turn' | 'permission' | 'collapsed'

/**
 * Calmer dock looks for Jakub to compare (agent-dock/look.ts), each over his real case (three items
 * from panes named after long ClientCare tasks) under a Claude Code session, through the production
 * mount: same data, same keys. The shipped dock is `current`; production never renders the others.
 */
function AgentDockCalmView({ look, state }: { look: AgentDockLook; state: CalmState }) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			agentDock: {
				scenario: 'real-case',
				expanded: state !== 'collapsed',
				position: 'bottom',
				output: 'claude-code',
				look,
				...(state === 'collapsed' ? {} : { open: state }),
			},
		}),
		[look, state],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const meta: Meta<typeof AgentDockCalmView> = {
	title: 'Views/Agent dock calm',
	component: AgentDockCalmView,
	parameters: { layout: 'fullscreen' },
	args: { look: 'one-typeface', state: 'question' },
	argTypes: {
		look: { control: 'inline-radio', options: ['current', 'one-typeface', 'two-bands', 'focus'] },
		state: { control: 'inline-radio', options: ['question', 'turn', 'permission', 'collapsed'] },
	},
}

export default meta
type Story = StoryObj<typeof AgentDockCalmView>

// Ids are pinned (`__id`, a literal: the indexer reads it statically) so they read `--v1-question`,
// not Storybook's `--v-1-question`.

/** The shipped dock, for side-by-side comparison. */
export const CurrentQuestion: Story = {
	args: { look: 'current', state: 'question' },
	parameters: { __id: 'views-agent-dock-calm--current-question' },
}

/** V1 One typeface: the same structure in one face; header glyph + name + age; one-line choices. */
export const V1Question: Story = {
	args: { look: 'one-typeface', state: 'question' },
	parameters: { __id: 'views-agent-dock-calm--v1-question' },
}
export const V1Turn: Story = {
	args: { look: 'one-typeface', state: 'turn' },
	parameters: { __id: 'views-agent-dock-calm--v1-turn' },
}
export const V1Permission: Story = {
	args: { look: 'one-typeface', state: 'permission' },
	parameters: { __id: 'views-agent-dock-calm--v1-permission' },
}
export const V1Collapsed: Story = {
	args: { look: 'one-typeface', state: 'collapsed' },
	parameters: { __id: 'views-agent-dock-calm--v1-collapsed' },
}

/** V2 Two bands: the strip merged into a one-line queue row; the header says what, the row says whose. */
export const V2Question: Story = {
	args: { look: 'two-bands', state: 'question' },
	parameters: { __id: 'views-agent-dock-calm--v2-question' },
}
export const V2Turn: Story = {
	args: { look: 'two-bands', state: 'turn' },
	parameters: { __id: 'views-agent-dock-calm--v2-turn' },
}
export const V2Permission: Story = {
	args: { look: 'two-bands', state: 'permission' },
	parameters: { __id: 'views-agent-dock-calm--v2-permission' },
}
export const V2Collapsed: Story = {
	args: { look: 'two-bands', state: 'collapsed' },
	parameters: { __id: 'views-agent-dock-calm--v2-collapsed' },
}

/** V3 Focus: an open pane is the whole dock (name · age, ‹ 1/3 ›); closed, the one quiet row. */
export const V3Question: Story = {
	args: { look: 'focus', state: 'question' },
	parameters: { __id: 'views-agent-dock-calm--v3-question' },
}
export const V3Turn: Story = {
	args: { look: 'focus', state: 'turn' },
	parameters: { __id: 'views-agent-dock-calm--v3-turn' },
}
export const V3Permission: Story = {
	args: { look: 'focus', state: 'permission' },
	parameters: { __id: 'views-agent-dock-calm--v3-permission' },
}
export const V3Collapsed: Story = {
	args: { look: 'focus', state: 'collapsed' },
	parameters: { __id: 'views-agent-dock-calm--v3-collapsed' },
}
