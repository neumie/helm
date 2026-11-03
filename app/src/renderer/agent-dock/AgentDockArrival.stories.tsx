import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'
import {
	type AgentDockArrivalFlash,
	type TerminalWorkspaceFixtureOptions,
	TerminalWorkspaceFixtureView,
} from '../terminal-workspace-fixtures'
import type { AgentDockArrivalKind } from './agent-dock-fixtures'

/** When the new item arrives after the story loads (the first snapshot is the baseline: no flash). */
const ARRIVE_AFTER_MS = 1_000

/**
 * A new item in the queue row flashes once in its kind's color (an ask --warn, a turn --accent), so
 * the row changing is seen as well as announced; the same arrivals as the polite live region, never
 * on load. Three candidates, picked here only (story-only `data-arrival-flash` on #agent-dock):
 * F1 tints the entry's cell, F2 lights its glyph and name, F3 pulses the dock's terminal-side edge
 * plus a light cell tint. Each runs once over 1.4s with ease-out; reduced motion holds the colors
 * statically instead. Production dock, production mount; Jakub's real day, then one new agent's item
 * arrives a second after load. "Replay arrival" (story-only, outside the dock) mounts it again.
 */
function AgentDockArrivalView({ variant, kind }: { variant: AgentDockArrivalFlash; kind: AgentDockArrivalKind }) {
	const [run, setRun] = useState(0)
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			agentDock: {
				scenario: 'real-case',
				position: 'bottom',
				output: 'claude-code',
				arrivalFlash: variant,
				arrive: { kind, afterMs: ARRIVE_AFTER_MS },
			},
			expose: true,
		}),
		[variant, kind],
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
	args: { variant: 'tinted-cell', kind: 'question' },
	argTypes: {
		variant: { control: 'inline-radio', options: ['tinted-cell', 'glyph-name', 'edge-pulse'] },
		kind: { control: 'inline-radio', options: ['question', 'permission', 'plan', 'turn'] },
	},
}

export default meta
type Story = StoryObj<typeof AgentDockArrivalView>

/** F1: a question arrives; its full-height cell takes a 20% --warn tint that fades out. */
export const F1TintedCell: Story = { name: 'F1 tinted cell' }
/** F1 for a finished turn: the tint is --accent, the turn glyph's color. */
export const F1TintedCellTurn: Story = { name: 'F1 tinted cell, turn', args: { kind: 'turn' } }

/** F2: a question arrives; its glyph and name light up in --warn and fade back. No fill. */
export const F2GlyphName: Story = { name: 'F2 glyph name', args: { variant: 'glyph-name' } }
export const F2GlyphNameTurn: Story = { name: 'F2 glyph name, turn', args: { variant: 'glyph-name', kind: 'turn' } }

/** F3: a question arrives; the dock's 1px terminal-side edge turns --warn, the cell lightly tinted, both fade. */
export const F3EdgePulse: Story = { name: 'F3 edge pulse', args: { variant: 'edge-pulse' } }
export const F3EdgePulseTurn: Story = { name: 'F3 edge pulse, turn', args: { variant: 'edge-pulse', kind: 'turn' } }
