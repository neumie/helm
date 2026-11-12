import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsColumnFrames, SignalsWorkspace } from './SignalsWorkspace'

/**
 * Signals (§3.25): what the world wants from Jakub — review requests, PR comments, failed CI on his
 * PRs, mentions, mail (Sentry alerts arrive as mail) — in the task sidebar's column, as material to
 * prompt a running agent or start a new one in an Okena worktree. Threads he marks **managed** are
 * handled by the dispatcher and its agent; he sees outcomes. ⌘⇧I goes to Signals; there is no
 * resting indicator. The production column on in-memory services.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Column',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'column' },
	argTypes: {
		scenario: { control: 'inline-radio', options: ['column', 'quiet', 'source-down', 'empty', 'empty-down'] },
	},
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/**
 * Needs you, Managed and Snoozed, each under its sticky band (Braille count mark, label, count), and the
 * `Done today` line at the bottom (D opens the done list), with the selected row's keys in the footer.
 */
export const Column: Story = {}

/** A quiet afternoon: nothing needs Jakub (no Needs you band), two threads managed, one snoozed. */
export const Quiet: Story = { args: { scenario: 'quiet' } }

/** Mail needs the Automation permission: the footer says so, never an all-clear. */
export const SourceDown: Story = { args: { scenario: 'source-down' } }

/** Nothing open, every source answered: the slow gray Braille dot field over `Listening to GitHub and Mail`. */
export const Empty: Story = { args: { scenario: 'empty' } }

/** Nothing open while Mail needs permission: the dots go hollow and still, no all-clear. */
export const EmptySourceDown: Story = { args: { scenario: 'empty-down' } }

/** The bare column at its narrowest and widest (260 and 420px), at rest and busy. */
export const Widths: Story = {
	render: () => (
		<SignalsColumnFrames
			height={1000}
			frames={[
				{ width: 260, scenario: 'empty', label: '260 · at rest' },
				{ width: 260, scenario: 'asks', label: '260 · busy' },
				{ width: 420, scenario: 'empty', label: '420 · at rest' },
				{ width: 420, scenario: 'asks', label: '420 · busy' },
			]}
		/>
	),
}

/**
 * Story only, not picked yet: the space between one section's last row and the next section's band
 * (production today 12px). Each frame overrides it through its `data-signals-variant`.
 */
const SECTION_GAPS = [0, 12, 20, 28] as const
const SECTION_GAP_STYLE = SECTION_GAPS.map(
	gap => `[data-signals-variant='gap-${gap}'] .signals-section + .signals-section { margin-top: ${gap}px; }`,
).join('\n')

/** The gap above a section band, side by side: none, 12px (now), 20px and 28px. */
export const SectionGap: Story = {
	render: () => (
		<>
			<style>{SECTION_GAP_STYLE}</style>
			<SignalsColumnFrames
				height={560}
				frames={SECTION_GAPS.map(gap => ({
					width: 340,
					scenario: 'column' as const,
					label: gap === 12 ? '12px (now)' : gap === 0 ? 'None: the band alone' : `${gap}px`,
					variant: `gap-${gap}`,
				}))}
			/>
		</>
	),
}
