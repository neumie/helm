import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'

/**
 * The Agents pane (design §3.24 Agents): the production dock under a Claude Code session, the
 * `agents-pane` day open in the Agents pane — agents grouped under dim project headings (Psyon, vault,
 * JVS), the detached-HEAD Psyon checkout named `Psyon` (never its commit hash), no branch column.
 */
function AgentsPaneView() {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({ agentDock: { scenario: 'agents-pane', position: 'bottom', output: 'claude-code', open: 'agents' } }),
		[],
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

const meta: Meta<typeof AgentsPaneView> = {
	title: 'Views/Agent dock agents pane',
	component: AgentsPaneView,
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof AgentsPaneView>

/** Agents by project: glyph, short name, status word and right-aligned age, meta on one grid across groups. */
export const AgentsPane: Story = { name: 'Agents pane', ...viewport(1400, 820) }
/** The same at 900px wide. */
export const AgentsPaneNarrow: Story = { name: 'Agents pane 900', ...viewport(900, 820) }
