import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import {
	type AgentsPaneVariant,
	type TerminalWorkspaceFixtureOptions,
	TerminalWorkspaceFixtureView,
} from '../terminal-workspace-fixtures'

/**
 * The Agents pane under review (design §3.24 Agents): the production dock under a Claude Code
 * session, the `agents-pane` day open in the Agents pane. Each layout is one story-only
 * `#agent-dock[data-agents-variant]` over the same markup — production sets none (the calm table).
 * Every layout names the detached-HEAD Psyon checkout `Psyon` (never its commit hash) and drops
 * the branch column.
 */
function AgentsPaneView({ variant }: { variant: AgentsPaneVariant }) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			agentDock: {
				scenario: 'agents-pane',
				position: 'bottom',
				output: 'claude-code',
				open: 'agents',
				agentsVariant: variant,
			},
		}),
		[variant],
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
	argTypes: { variant: { control: 'inline-radio', options: ['table', 'by-project', 'one-liners'] } },
}

export default meta
type Story = StoryObj<typeof AgentsPaneView>

/** A: one aligned grid — glyph, name, repository (only where the name does not say it), status, age, meta. */
export const ACalmTable: Story = { name: 'A calm table', ...WIDE, args: { variant: 'table' } }
/** B: rows grouped under dim repository headings (Psyon, JVS, vault); no repository column. */
export const BByProject: Story = { name: 'B by project', ...WIDE, args: { variant: 'by-project' } }
/** C: one quiet line per agent in the queue row's language; the name bright, the rest dim. */
export const COneLiners: Story = { name: 'C one-liners', ...WIDE, args: { variant: 'one-liners' } }

export const ACalmTableNarrow: Story = { name: 'A calm table 900', ...NARROW, args: { variant: 'table' } }
export const BByProjectNarrow: Story = { name: 'B by project 900', ...NARROW, args: { variant: 'by-project' } }
export const COneLinersNarrow: Story = { name: 'C one-liners 900', ...NARROW, args: { variant: 'one-liners' } }
