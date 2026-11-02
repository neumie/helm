import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import type { AgentDockScenario } from './agent-dock-fixtures'
import type { AgentDockPosition } from './presentation'

type DockState = 'turn' | 'question' | 'permission' | 'collapsed'

/**
 * The dock against its worst case: a Claude Code session whose own full-width rules (titled
 * rule, prompt box, status block) sit right above it (design §3.24 Surface). The dock is one
 * --chrome surface with the topbar's --hairline edge toward the terminal, so the change of
 * material separates — the dock draws no rule of its own there. Production dock, production mount.
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
				position,
				output: 'claude-code',
				...(state === 'collapsed' ? {} : { open: state }),
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
		state: { control: 'inline-radio', options: ['turn', 'question', 'permission', 'collapsed'] },
		position: { control: 'inline-radio', options: ['bottom', 'top'] },
		theme: { control: 'inline-radio', options: ['helm', 'high-contrast'] },
	},
}

export default meta
type Story = StoryObj<typeof AgentDockClaudeCodeView>

/** Regression: the dock under a Claude Code session, a turn pane open (Jakub's 1/1 case). */
export const ClaudeCodeSession: Story = {}

/**
 * Jakub's real case: three items from panes named after long ClientCare tasks. Two sessions on
 * `fix/company-create-save-firm` read `company-create-save-firm` and `company-create-save-firm #2`;
 * the turn on `fix/repeated-android-camera-permission` reads `repeated-android-camera-permission`.
 *
 * Collapsed (no pane): the one 28px row — every entry `glyph name age`, then `agents 4 · 2 busy`,
 * Okena's dot and ⌘⇧J. No summary row; clicking an entry opens it.
 */
export const RealCaseCollapsed: Story = { args: { scenario: 'real-case', state: 'collapsed' } }
/** The question pane: the header names the kind and the question (`IČO`), ‹ 1/3 ›; the row's fill says whose. */
export const RealCaseQuestion: Story = { args: { scenario: 'real-case', state: 'question' } }
export const RealCasePermission: Story = { args: { scenario: 'real-case', state: 'permission' } }
/** The turn pane: the task title is the header's tooltip, never in the queue. */
export const RealCaseTurn: Story = { args: { scenario: 'real-case', state: 'turn' } }

/** Eight items: the one row shows what fits, then one quiet "+N more" cell. */
export const Overflow: Story = { args: { scenario: 'overflow', state: 'collapsed' } }

/** Top position: the edge sits under the dock, above the terminal. */
export const Top: Story = { args: { scenario: 'real-case', state: 'turn', position: 'top' } }

/** High contrast preset: --chrome against a #000 terminal, lines at double alpha. */
export const HighContrast: Story = { args: { scenario: 'real-case', state: 'turn', theme: 'high-contrast' } }
