import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import type { AgentDockScenario } from './agent-dock-fixtures'

/**
 * ⌘⇧J only moves the keys into the dock (no layout change, so no PTY resize under a TUI), so the
 * hand-off has to be seen (design §3.24 Focus): while the dock holds the keys — row or pane — its
 * 1px edge toward the terminal is --accent, and the focused entry shows the selected fill, never a
 * ring. Production dock, production mount; each story presses ⌘⇧J from the focused xterm on load.
 * Esc (or ⌘⇧J again) hands the keys back: the edge returns to the quiet hairline.
 */
function AgentDockFocusView({ scenario }: { scenario: AgentDockScenario }) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({ agentDock: { scenario, position: 'bottom', output: 'claude-code', focusDock: true } }),
		[scenario],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const meta: Meta<typeof AgentDockFocusView> = {
	title: 'Views/Agent dock focus',
	component: AgentDockFocusView,
	globals: { viewport: { value: 'helm1280', isRotated: false } },
	parameters: {
		layout: 'fullscreen',
		viewport: { options: { helm1280: { name: 'Helm 1280×800', styles: { width: '1280px', height: '800px' } } } },
	},
	args: { scenario: 'real-case' },
	argTypes: {
		scenario: { control: 'inline-radio', options: ['real-case', 'crowded', 'empty', 'connecting', 'down'] },
	},
}

export default meta
type Story = StoryObj<typeof AgentDockFocusView>

/** Items queued: the first entry holds the keys (selected fill), the edge toward the terminal is accent. */
export const Focused: Story = {}

/** Nothing queued: the Agents entry holds the keys, and the edge still says so. */
export const FocusedEmpty: Story = { name: 'Focused empty', args: { scenario: 'empty' } }
