import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import {
	AGENT_DOCK_DIVIDERS,
	AGENT_DOCK_DIVIDER_DEFAULT,
	type AgentDockDivider,
	type AgentDockPosition,
} from './presentation'

type DockState = 'turn' | 'question' | 'queue' | 'collapsed'

/**
 * Where the terminal ends and the dock begins (design §3.24 Divider), judged against the
 * worst case: a Claude Code session whose own full-width rules (titled rule, prompt box,
 * status block) sit right above the dock. Production renders the default variant; the
 * others are selectable here only.
 */
function AgentDockDividerView({
	divider,
	state,
	position,
	theme,
}: {
	divider: AgentDockDivider
	state: DockState
	position: AgentDockPosition
	theme: 'helm' | 'high-contrast'
}) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			...(theme === 'high-contrast' ? { theme } : {}),
			agentDock: {
				scenario: state === 'question' ? 'crowded' : 'single-turn',
				expanded: state !== 'collapsed',
				position,
				output: 'claude-code',
				divider,
				...(state === 'turn' || state === 'question' ? { open: state } : {}),
			},
		}),
		[divider, state, position, theme],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const meta: Meta<typeof AgentDockDividerView> = {
	title: 'Views/Agent dock divider',
	component: AgentDockDividerView,
	parameters: { layout: 'fullscreen' },
	args: { divider: AGENT_DOCK_DIVIDER_DEFAULT, state: 'turn', position: 'bottom', theme: 'helm' },
	argTypes: {
		divider: { control: 'inline-radio', options: AGENT_DOCK_DIVIDERS },
		state: { control: 'inline-radio', options: ['turn', 'question', 'queue', 'collapsed'] },
		position: { control: 'inline-radio', options: ['bottom', 'top'] },
		theme: { control: 'inline-radio', options: ['helm', 'high-contrast'] },
	},
}

export default meta
type Story = StoryObj<typeof AgentDockDividerView>

/** Regression: production's divider under a Claude Code session, a turn pane open (Jakub's 1/1 case). */
export const ClaudeCodeSession: Story = {}

/** A — surface: the dock is window chrome (--chrome) behind a --hairline-strong edge. */
export const SurfaceTurn: Story = { args: { divider: 'surface' } }
export const SurfaceCollapsed: Story = { args: { divider: 'surface', state: 'collapsed' } }

/** B — pane gap: a 4px --chrome sash between --hairline-strong lines, the dock a pane below it. */
export const PaneGapTurn: Story = { args: { divider: 'pane-gap' } }
export const PaneGapCollapsed: Story = { args: { divider: 'pane-gap', state: 'collapsed' } }

/** C — accent edge: the edge in the open item's tone (here a turn: accent), neutral while collapsed. */
export const AccentEdgeTurn: Story = { args: { divider: 'accent-edge' } }
export const AccentEdgeCollapsed: Story = { args: { divider: 'accent-edge', state: 'collapsed' } }
/** C with a question past 2h open: the edge takes its danger tone. */
export const AccentEdgeQuestion: Story = { args: { divider: 'accent-edge', state: 'question' } }

/** The queue open with no pane, one entry: no empty cell between it and the Agents column. */
export const QueueSingleEntry: Story = { args: { state: 'queue' } }

/** Top position: the edge (or sash) sits under the dock, above the terminal. */
export const SurfaceTop: Story = { args: { divider: 'surface', position: 'top' } }
export const PaneGapTop: Story = { args: { divider: 'pane-gap', position: 'top' } }
export const AccentEdgeTop: Story = { args: { divider: 'accent-edge', position: 'top' } }

/** High contrast preset: --chrome #16181b against a #000 terminal, lines at double alpha. */
export const SurfaceHighContrast: Story = { args: { divider: 'surface', theme: 'high-contrast' } }
export const PaneGapHighContrast: Story = { args: { divider: 'pane-gap', theme: 'high-contrast' } }
export const AccentEdgeHighContrast: Story = { args: { divider: 'accent-edge', theme: 'high-contrast' } }
