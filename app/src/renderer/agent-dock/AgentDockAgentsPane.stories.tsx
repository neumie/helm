import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import type { AgentsLayout } from './presentation'

/**
 * The Agents overview (design §3.24 Agents): the production dock under a Claude Code session, the
 * `agents-overview` day open in the Agents pane — every agent's state relative to Jakub (question,
 * permission, plan, reply waiting 45m, working with subagents, background in a Helm terminal, read,
 * unknown, not connected), where it runs, and the first line of what it last said. Rows are a roving
 * list: ↑ ↓ move, Enter or a click opens the agent's item, else its detail.
 *
 * Layouts under review, one story-only `#agent-dock[data-agents-variant]` each over the same data and
 * keys (production: `two-lines` until Jakub picks): V1 two lines, V2 one line with an excerpt column,
 * V3 grouped by state.
 */
function AgentsPaneView({ variant, openAgent }: { variant: AgentsLayout; openAgent?: string }) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			agentDock: {
				scenario: 'agents-overview',
				position: 'bottom',
				output: 'claude-code',
				open: 'agents',
				agentsVariant: variant,
				...(openAgent ? { openAgent } : {}),
			},
		}),
		[variant, openAgent],
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

const WIDE = viewport(1400, 820)
const NARROW = viewport(900, 820)

const meta: Meta<typeof AgentsPaneView> = {
	title: 'Views/Agent dock agents pane',
	component: AgentsPaneView,
	parameters: { layout: 'fullscreen' },
	args: { variant: 'two-lines' },
	argTypes: { variant: { control: 'inline-radio', options: ['two-lines', 'excerpt-column', 'by-state'] } },
}

export default meta
type Story = StoryObj<typeof AgentsPaneView>

/** V1 two lines: by project; glyph · name · state · age · where, then the excerpt dim under the name. */
export const V1TwoLines: Story = { name: 'V1 two lines', ...WIDE, args: { variant: 'two-lines' } }
/** V2 one line: by project; glyph · name · state · age · excerpt (flexible, cut) · where. */
export const V2ExcerptColumn: Story = { name: 'V2 excerpt column', ...WIDE, args: { variant: 'excerpt-column' } }
/** V3 by state: Needs you / Reply waiting / Working / Background / Read / Unknown; the project a dim column. */
export const V3ByState: Story = { name: 'V3 by state', ...WIDE, args: { variant: 'by-state' } }

export const V1TwoLinesNarrow: Story = { name: 'V1 two lines 900', ...NARROW, args: { variant: 'two-lines' } }
export const V2ExcerptColumnNarrow: Story = {
	name: 'V2 excerpt column 900',
	...NARROW,
	args: { variant: 'excerpt-column' },
}
export const V3ByStateNarrow: Story = { name: 'V3 by state 900', ...NARROW, args: { variant: 'by-state' } }

/**
 * An agent's detail: the read JVS worktree opened from the list (a click): its state and where in
 * the header, its last message in full as quiet Markdown (read live through its source), a reply field
 * with Send (the same CAS and receipts as a turn reply). Esc goes back to its row; ‹ › step agents.
 */
export const AgentDetail: Story = {
	name: 'Agent detail',
	...WIDE,
	args: { variant: 'two-lines', openAgent: 'service-protocol-image-link' },
}
export const AgentDetailNarrow: Story = {
	name: 'Agent detail 900',
	...NARROW,
	args: { variant: 'two-lines', openAgent: 'service-protocol-image-link' },
}
