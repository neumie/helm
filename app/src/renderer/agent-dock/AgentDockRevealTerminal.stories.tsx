import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import {
	type AgentDockOpenFixture,
	type TerminalWorkspaceFixtureOptions,
	TerminalWorkspaceFixtureView,
} from '../terminal-workspace-fixtures'
import type { RevealAffordance } from './RevealTerminal'
import type { AgentDockRevealMode, AgentDockScenario } from './agent-dock-fixtures'

/**
 * "Show terminal" (design §3.24): from an item's pane or an agent's detail, bring up the terminal the
 * agent runs in. Okena pane: Okena focuses it (switches its tab, retargets zoom/fullscreen, orders its
 * window front) and Helm raises the Okena app. Helm terminal: its tab is selected and focused, and its
 * frame takes one accent pulse. ⌘O from anywhere in the pane, or the affordance; the pane stays open.
 * A failure (Okena unreachable, the terminal gone) is a quiet line in the footer, never a dialog.
 *
 * The mechanism is one; its look is Jakub's pick, three variants (production default: `button`):
 *   button  a quiet footer key left of Ack / Send ("Show in Okena" / "Show terminal"), `⌘O terminal` hint
 *   where   the header's where text as a link-like token ("Okena ↗ service-date-and-people"), `⌘O` after it
 *   hint    no control: a clickable `⌘O terminal` in the footer's hint row, always shown
 * The `… keys` stories hold the keys in the pane (as after ⌘⇧J), so the key hints show.
 */
function RevealView({
	affordance,
	scenario = 'reveal-okena',
	open = 'turn',
	openAgent,
	focusPane = false,
	reveal = false,
	revealMode,
}: {
	affordance: RevealAffordance
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
				revealAffordance: affordance,
				focusPane,
				reveal,
				...(openAgent ? { openAgent } : {}),
				...(revealMode ? { revealMode } : {}),
			},
		}),
		[affordance, scenario, open, openAgent, focusPane, reveal, revealMode],
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
	args: { affordance: 'button' },
	argTypes: {
		affordance: { control: 'inline-radio', options: ['button', 'where', 'hint'] },
		revealMode: { control: 'inline-radio', options: ['shown', 'not-raised', 'gone', 'unreachable'] },
	},
}

export default meta
type Story = StoryObj<typeof RevealView>

// V1 — footer button (production default).
/** Jakub's report: the turn pane of an Okena agent, "Show in Okena" left of Ack / Send. */
export const ButtonTurnOkena: Story = { name: 'V1 button · turn · Okena', ...WIDE, args: { affordance: 'button' } }
/** The same with the keys in the pane: `⌘O terminal` joins the hints after `⌘⌫ ack`. */
export const ButtonTurnOkenaKeys: Story = {
	name: 'V1 button · turn · Okena · keys',
	...WIDE,
	args: { affordance: 'button', focusPane: true },
}
export const ButtonQuestionOkena: Story = {
	name: 'V1 button · question · Okena',
	...WIDE,
	args: { affordance: 'button', open: 'question', focusPane: true },
}
/** A Helm terminal's agent: "Show terminal" (its tab in this window). */
export const ButtonTurnHelm: Story = {
	name: 'V1 button · turn · Helm terminal',
	...WIDE,
	args: { affordance: 'button', scenario: 'reveal-helm' },
}
export const ButtonQuestionHelm: Story = {
	name: 'V1 button · question · Helm terminal',
	...WIDE,
	args: { affordance: 'button', scenario: 'reveal-helm', open: 'question' },
}
/** The agent detail (Agents pane → `rental-pricing`, working, owes nothing): the key left of Send. */
export const ButtonAgentDetail: Story = {
	name: 'V1 button · agent detail · Okena',
	...WIDE,
	args: { affordance: 'button', open: 'agents', openAgent: 'rental-pricing', focusPane: true },
}

// V2 — where link in the header.
export const WhereTurnOkena: Story = {
	name: 'V2 where · turn · Okena',
	...WIDE,
	args: { affordance: 'where', focusPane: true },
}
export const WhereQuestionOkena: Story = {
	name: 'V2 where · question · Okena',
	...WIDE,
	args: { affordance: 'where', open: 'question' },
}
export const WhereTurnHelm: Story = {
	name: 'V2 where · turn · Helm terminal',
	...WIDE,
	args: { affordance: 'where', scenario: 'reveal-helm', focusPane: true },
}
/** The agent detail: its where line (`Okena · worktree · PR #957`) leads with the link. */
export const WhereAgentDetail: Story = {
	name: 'V2 where · agent detail · Okena',
	...WIDE,
	args: { affordance: 'where', open: 'agents', openAgent: 'rental-pricing', focusPane: true },
}

// V3 — key hint only (clickable).
export const HintTurnOkena: Story = { name: 'V3 hint · turn · Okena', ...WIDE, args: { affordance: 'hint' } }
export const HintQuestionOkena: Story = {
	name: 'V3 hint · question · Okena',
	...WIDE,
	args: { affordance: 'hint', open: 'question', focusPane: true },
}
export const HintTurnHelm: Story = {
	name: 'V3 hint · turn · Helm terminal',
	...WIDE,
	args: { affordance: 'hint', scenario: 'reveal-helm' },
}
export const HintAgentDetail: Story = {
	name: 'V3 hint · agent detail · Okena',
	...WIDE,
	args: { affordance: 'hint', open: 'agents', openAgent: 'rental-pricing' },
}

// The mechanism (any variant).
/** ⌘O on a Helm terminal's turn: the `compile` tab is selected and its frame pulses once (1.4s). */
export const RevealedHelm: Story = {
	name: 'Revealed · Helm terminal (pulse)',
	...WIDE,
	args: { affordance: 'button', scenario: 'reveal-helm', reveal: true },
}
/** ⌘O, but the agent's Okena terminal closed meanwhile: a quiet line in the footer (8s), no dialog. */
export const FailureGone: Story = {
	name: 'Failure · terminal gone',
	...WIDE,
	args: { affordance: 'button', reveal: true, revealMode: 'gone' },
}
/** ⌘O while Okena is unreachable: its words (main's, verbatim reason) in the footer. */
export const FailureUnreachable: Story = {
	name: 'Failure · Okena unreachable',
	...WIDE,
	args: { affordance: 'button', open: 'question', reveal: true, revealMode: 'unreachable' },
}
/** Okena focused the pane but Helm could not raise the app (osascript refused): said, quietly. */
export const NotRaised: Story = {
	name: 'Focused · Okena not raised',
	...WIDE,
	args: { affordance: 'hint', reveal: true, revealMode: 'not-raised' },
}
