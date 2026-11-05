import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import type { AgentDockArrivalKind } from './agent-dock-fixtures'

/** When the new item arrives after the story loads (the first snapshot is the baseline: no flash). */
const ARRIVE_AFTER_MS = 1_000

/**
 * A new item in the queue row is seen as well as announced (the same arrivals as the polite live
 * region, never on load): the dock's 1px terminal-side edge takes the full color of the most urgent
 * arrival (an ask --warn, a turn --accent) and the new entry's cell a 10% tint, both fading back over
 * 1.4s; reduced motion holds the colors statically instead. Production dock, production mount;
 * Jakub's real day, then one new agent's item arrives a second after load. "Replay arrival"
 * (story-only, outside the dock) mounts it again.
 */
function AgentDockArrivalView({ kind }: { kind: AgentDockArrivalKind }) {
	const [run, setRun] = useState(0)
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			agentDock: {
				scenario: 'real-case',
				position: 'bottom',
				output: 'claude-code',
				arrive: { kind, afterMs: ARRIVE_AFTER_MS },
			},
			expose: true,
		}),
		[kind],
	)
	return (
		<>
			{/* A new key remounts the fixture: a fresh baseline, then the arrival again. */}
			<TerminalWorkspaceFixtureView key={run} options={options} />
			<button
				type="button"
				onClick={() => setRun(value => value + 1)}
				style={{
					position: 'fixed',
					top: 6,
					right: 8,
					zIndex: 10,
					font: '12px -apple-system, sans-serif',
					padding: '2px 8px',
					cursor: 'pointer',
				}}
			>
				Replay arrival
			</button>
		</>
	)
}

const meta: Meta<typeof AgentDockArrivalView> = {
	title: 'Views/Agent dock arrival',
	component: AgentDockArrivalView,
	globals: { viewport: { value: 'helm1400', isRotated: false } },
	parameters: {
		layout: 'fullscreen',
		viewport: { options: { helm1400: { name: 'Helm 1400×820', styles: { width: '1400px', height: '820px' } } } },
	},
	args: { kind: 'question' },
	argTypes: {
		kind: { control: 'inline-radio', options: ['question', 'permission', 'plan', 'turn'] },
	},
}

export default meta
type Story = StoryObj<typeof AgentDockArrivalView>

/** A question arrives: the edge turns --warn, its cell a 10% --warn tint, both fade. */
export const Question: Story = {}
/** A finished turn arrives: the edge and tint are --accent, the turn glyph's color. */
export const Turn: Story = { args: { kind: 'turn' } }
