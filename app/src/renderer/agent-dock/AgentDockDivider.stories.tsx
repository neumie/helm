import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import type { AgentDockScenario } from './agent-dock-fixtures'
import type { AgentDockPosition } from './presentation'

type DockState = 'turn' | 'question' | 'permission' | 'queue' | 'collapsed'

/**
 * The dock against its worst case: a Claude Code session whose own full-width rules (titled
 * rule, prompt box, status block) sit right above it (design §3.24 Surface). The dock is one
 * --chrome surface with the topbar's --hairline edge toward the terminal, so the change of
 * material separates — the dock draws no rule of its own there.
 */
function AgentDockClaudeCodeView({
	scenario,
	state,
	position,
	theme,
}: {
	scenario: AgentDockScenario
	state: DockState
	position: AgentDockPosition
	theme: 'helm' | 'high-contrast'
}) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			...(theme === 'high-contrast' ? { theme } : {}),
			agentDock: {
				scenario,
				expanded: state !== 'collapsed',
				position,
				output: 'claude-code',
				...(state === 'turn' || state === 'question' || state === 'permission' ? { open: state } : {}),
			},
		}),
		[scenario, state, position, theme],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const meta: Meta<typeof AgentDockClaudeCodeView> = {
	title: 'Views/Agent dock divider',
	component: AgentDockClaudeCodeView,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'single-turn', state: 'turn', position: 'bottom', theme: 'helm' },
	argTypes: {
		scenario: { control: 'inline-radio', options: ['single-turn', 'real-case', 'overflow', 'crowded'] },
		state: { control: 'inline-radio', options: ['turn', 'question', 'permission', 'queue', 'collapsed'] },
		position: { control: 'inline-radio', options: ['bottom', 'top'] },
		theme: { control: 'inline-radio', options: ['helm', 'high-contrast'] },
	},
}

export default meta
type Story = StoryObj<typeof AgentDockClaudeCodeView>

/** Regression: the dock under a Claude Code session, a turn pane open (Jakub's 1/1 case). */
export const ClaudeCodeSession: Story = {}

/** Collapsed: the 28px strip on --chrome, the topbar's hairline toward the terminal. */
export const Collapsed: Story = { args: { state: 'collapsed' } }

/** The queue open with no pane, one entry. */
export const QueueSingleEntry: Story = { args: { state: 'queue' } }

/**
 * Jakub's real case: three items from panes named after long ClientCare tasks. Two sessions on
 * `fix/company-create-save-firm` read `company-create-save-firm` and `company-create-save-firm #2`;
 * the turn on `fix/repeated-android-camera-permission` reads `repeated-android-camera-permission`.
 */
export const RealCase: Story = { args: { scenario: 'real-case', state: 'queue' } }
export const RealCaseCollapsed: Story = { args: { scenario: 'real-case', state: 'collapsed' } }
/** The turn pane: the full task title as dim context above the message, never in the queue. */
export const RealCaseTurn: Story = { args: { scenario: 'real-case', state: 'turn' } }
export const RealCaseQuestion: Story = { args: { scenario: 'real-case', state: 'question' } }
export const RealCasePermission: Story = { args: { scenario: 'real-case', state: 'permission' } }

/** Eight items: the one row shows what fits, then one quiet "+N more" cell. */
export const Overflow: Story = { args: { scenario: 'overflow', state: 'queue' } }

/** Top position: the edge sits under the dock, above the terminal. */
export const Top: Story = { args: { scenario: 'real-case', state: 'turn', position: 'top' } }

/** High contrast preset: --chrome against a #000 terminal, lines at double alpha. */
export const HighContrast: Story = { args: { scenario: 'real-case', state: 'turn', theme: 'high-contrast' } }
