import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import {
	type AgentDockOpenFixture,
	type TerminalWorkspaceFixtureOptions,
	TerminalWorkspaceFixtureView,
} from '../terminal-workspace-fixtures'
import type { AgentDockRevealMode, AgentDockScenario } from './agent-dock-fixtures'

/**
 * "Show terminal" (design §3.24): from an item's pane or an agent's detail, bring up the terminal the
 * agent runs in. Okena pane: Okena focuses it (switches its tab, retargets zoom/fullscreen, orders its
 * window front) and Helm raises the Okena app. Helm terminal: its tab is selected and focused, and its
 * frame takes one accent pulse. ⌘O from anywhere in the pane, or the header's where link; the pane
 * stays open. A failure (Okena unreachable, the terminal gone) is a quiet line in the footer, never a
 * dialog.
 *
 * The look: the header's where text as a link-like token after the kind — `Okena ↗ service-date-and-people`
 * (`Terminal ↗ …` for a Helm terminal); in the agent detail `Okena ↗` leads its where line — with a dim
 * `⌘O` after it while the pane holds the keys (the `… keys` stories, as after ⌘⇧J).
 */
function RevealView({
	scenario = 'reveal-okena',
	open = 'turn',
	openAgent,
	focusPane = false,
	reveal = false,
	revealMode,
}: {
	scenario?: AgentDockScenario
	open?: AgentDockOpenFixture
	openAgent?: string
	focusPane?: boolean
	reveal?: boolean
	revealMode?: AgentDockRevealMode
}) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			agentDock: {
				scenario,
				position: 'bottom',
				output: 'claude-code',
				open,
				focusPane,
				reveal,
				...(openAgent ? { openAgent } : {}),
				...(revealMode ? { revealMode } : {}),
			},
		}),
		[scenario, open, openAgent, focusPane, reveal, revealMode],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const WIDE = {
	globals: { viewport: { value: 'helm1280', isRotated: false } },
	parameters: {
		viewport: {
			options: { helm1280: { name: 'Helm 1280×800', styles: { width: '1280px', height: '800px' } } },
		},
	},
}

const meta: Meta<typeof RevealView> = {
	title: 'Views/Agent dock reveal terminal',
	component: RevealView,
	parameters: { layout: 'fullscreen' },
	argTypes: {
		revealMode: { control: 'inline-radio', options: ['shown', 'not-raised', 'gone', 'unreachable'] },
	},
}

export default meta
type Story = StoryObj<typeof RevealView>

/** Jakub's report: the turn pane of an Okena agent, `Okena ↗ service-date-and-people` after the kind. */
export const TurnOkena: Story = { name: 'Turn · Okena', ...WIDE }
/** The same with the keys in the pane: a dim `⌘O` follows the link. */
export const TurnOkenaKeys: Story = { name: 'Turn · Okena · keys', ...WIDE, args: { focusPane: true } }
/** A question: its context first, then the link. */
export const QuestionOkena: Story = { name: 'Question · Okena', ...WIDE, args: { open: 'question' } }
/** A Helm terminal's agent: `Terminal ↗ name` (its tab in this window). */
export const TurnHelm: Story = {
	name: 'Turn · Helm terminal · keys',
	...WIDE,
	args: { scenario: 'reveal-helm', focusPane: true },
}
/** The agent detail (Agents pane → `rental-pricing`, working, owes nothing): its where line leads with `Okena ↗`. */
export const AgentDetail: Story = {
	name: 'Agent detail · Okena · keys',
	...WIDE,
	args: { open: 'agents', openAgent: 'rental-pricing', focusPane: true },
}

// The mechanism.
/** ⌘O on a Helm terminal's turn: the `compile` tab is selected and its frame pulses once (1.4s). */
export const RevealedHelm: Story = {
	name: 'Revealed · Helm terminal (pulse)',
	...WIDE,
	args: { scenario: 'reveal-helm', reveal: true },
}
/** ⌘O, but the agent's Okena terminal closed meanwhile: a quiet line in the footer (8s), no dialog. */
export const FailureGone: Story = {
	name: 'Failure · terminal gone',
	...WIDE,
	args: { reveal: true, revealMode: 'gone' },
}
/** ⌘O while Okena is unreachable: its words (main's, verbatim reason) in the footer. */
export const FailureUnreachable: Story = {
	name: 'Failure · Okena unreachable',
	...WIDE,
	args: { open: 'question', reveal: true, revealMode: 'unreachable' },
}
/** Okena focused the pane but Helm could not raise the app (osascript refused): said, quietly. */
export const NotRaised: Story = {
	name: 'Focused · Okena not raised',
	...WIDE,
	args: { reveal: true, revealMode: 'not-raised' },
}
