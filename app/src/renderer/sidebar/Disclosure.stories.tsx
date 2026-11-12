// Disclosure group (§3.20): heavy inline evidence stays behind a quiet
// section-header action. Content SNAPS open, never height-animates, and renders
// only while open.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { StateGrid } from '../storybook/StateGrid'
import { Disclosure } from './ui'

const meta: Meta = {
	title: 'Compositions/Disclosure group',
	decorators: [
		(story, { name }) =>
			name === 'States' ? (
				story()
			) : (
				<div className="page-scroll" style={{ width: 340, height: 240 }}>
					{story()}
				</div>
			),
	],
}

export default meta
type Story = StoryObj

const INPUT = `Implement the approved task in the prepared worktree.
Preserve the existing authentication flow and add regression coverage.`

/** Closed at rest: the section header and its quiet action are the entire
 * visible footprint; the empty controlled-region shell stays hidden so the
 * action's aria-controls target remains valid. */
export const Closed: Story = {
	render: () => (
		<Disclosure heading="Solve input" label="Show" hideLabel="Hide">
			<section className="log-well">{INPUT}</section>
		</Disclosure>
	),
}

/** Open mount state: the action flips to Hide and the evidence snaps directly
 * into the section flow. */
export const Open: Story = {
	render: () => (
		<Disclosure heading="Solve input" label="Show" hideLabel="Hide" defaultOpen>
			<section className="log-well">{INPUT}</section>
		</Disclosure>
	),
}

/** A useful resting summary stays visible while only the editing controls are
 * conditional. */
export const WithSummaryAtRest: Story = {
	render: () => (
		<Disclosure
			heading="Execution setup"
			label="Change"
			hideLabel="Done"
			summary={<p className="run-setup-summary">Claude Code · Default model · Worktree</p>}
		>
			<p className="section-description">The four run-selection fields render here when open.</p>
		</Disclosure>
	),
}

/** Forced states (§7 StateGrid) on the section-header action (a small quiet
 *  Btn); `open` is the real expanded state with its content mounted. */
export const States: Story = {
	render: () => (
		<StateGrid
			states={['rest', 'hover', 'focus-visible', 'open']}
			rows={[
				{
					label: 'header action',
					target: '.card-head button',
					element: (
						<div className="page-scroll" style={{ width: 240 }}>
							<Disclosure heading="Solve input" label="Show" hideLabel="Hide">
								<section className="log-well">{INPUT}</section>
							</Disclosure>
						</div>
					),
					variants: {
						open: (
							<div className="page-scroll" style={{ width: 240 }}>
								<Disclosure heading="Solve input" label="Show" hideLabel="Hide" defaultOpen>
									<section className="log-well">{INPUT}</section>
								</Disclosure>
							</div>
						),
					},
				},
			]}
		/>
	),
}
