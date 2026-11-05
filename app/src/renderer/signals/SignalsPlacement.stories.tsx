import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Signals (design exploration): what the world wants from Jakub — review requests, PR comments,
 * CI on his PRs, mail (Sentry alerts arrive as mail) — as material to prompt an existing agent or
 * start a new one in an Okena worktree. Threads he marks **managed** are handled by the dispatcher
 * and its agent; he sees only outcomes. Mock data only: nothing polls GitHub or Mail.
 *
 * A — where Signals lives. Every placement shows `needs you`, `managed` and `snoozed · done`;
 * the selected row's actions are key hints (p send to agent · n new agent · m manage · t take back
 * · s snooze · d dismiss · o open). Click a row or use j/k; the keys act on the fixture.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/A Placement',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { placement: 'pane', count: 3, paneWidth: 480 },
	argTypes: {
		placement: { control: 'inline-radio', options: ['pane', 'agents', 'band', 'sidebar'] },
		count: { control: 'inline-radio', options: [0, 3] },
		paneWidth: { control: { type: 'range', min: 340, max: 720, step: 20 } },
	},
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/**
 * A1 — its own pane right of the terminal (⌘⇧I toggles it): a vertical split on the dock's
 * --chrome surface with the dock's hairline edge, the footer dock still spanning the window bottom.
 */
export const RightPane: Story = { args: { placement: 'pane' } }

/**
 * A2 — groups inside the dock's existing Agents pane (opened from `agents 4 · 2 busy`): the agent
 * table, Recent, then `needs you`, `managed` and the `snoozed · done` count. The pane has the keys,
 * so its footer shows the selected row's actions.
 */
export const InAgentsPane: Story = { args: { placement: 'agents' } }

/**
 * A3 — a band at the top of the dispatcher's terminal: shown while the dispatcher tab is active,
 * in-flow (the terminal starts under it). `snoozed · done` folds into one line.
 */
export const DispatcherBand: Story = { args: { placement: 'band' } }

/**
 * A4 — the task sidebar's column (code-suggested fit: the sidebar already holds work that came
 * from outside, toggles with its own key and stops provider polling while hidden).
 */
export const TaskSidebar: Story = { args: { placement: 'sidebar' } }
