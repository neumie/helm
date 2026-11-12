// State grid (design-system §7): the Storybook-only harness every interactive
// primitive's `States` story uses. Each column renders the REAL primitive;
// hover / active / focus-visible come from `data-force-state`, which the
// primitive's CSS answers in the same rule as the pseudo-class. Disabled is the
// real attribute; selected / checked / busy / open are the row's own elements.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Btn } from '../button'
import { IconBtn } from '../icon-button'
import { GLYPH, Toggle } from '../sidebar/ui'
import { STATE_GRID_STATES, StateGrid } from './StateGrid'

const meta: Meta = {
	title: 'Primitives/State grid',
}

export default meta
type Story = StoryObj

const noop = () => {}

/** The convention on one row each: a component that forwards nothing (Btn,
 *  IconBtn, Toggle) still gets its state, because the grid sets the attribute
 *  on the cell's first focusable element. A dash marks a state the row does not
 *  have; "no style" marks a forced state the primitive's CSS does not style
 *  (`unstyled`), instead of a cell that copies rest. */
export const Convention: Story = {
	render: () => (
		<StateGrid
			states={STATE_GRID_STATES}
			rows={[
				{
					label: 'Btn quiet',
					element: <Btn tone="quiet">Retry</Btn>,
					unstyled: ['active'],
					variants: {
						busy: (
							<Btn tone="quiet" busy>
								Retry
							</Btn>
						),
					},
				},
				{ label: 'IconBtn', element: <IconBtn label="More">{GLYPH.ellipsis}</IconBtn>, unstyled: ['active'] },
				{
					label: 'Toggle',
					element: <Toggle label="Track deployments" value={false} onChange={noop} />,
					unstyled: ['hover', 'active'],
					variants: { checked: <Toggle label="Track deployments" value onChange={noop} /> },
				},
			]}
		/>
	),
}

/** A row whose element is a wrapper (a layout box, an open menu, a row with
 *  inner actions) names its `target`: only that element takes the forced or
 *  disabled state. The Segmented control, Menu and List row `States` stories
 *  use this. */
export const Target: Story = {
	render: () => (
		<StateGrid
			states={['rest', 'hover', 'focus-visible', 'disabled']}
			rows={[
				{
					label: 'second button',
					target: 'button:nth-of-type(2)',
					element: (
						<div style={{ display: 'flex', gap: 8 }}>
							<Btn tone="quiet">Cancel</Btn>
							<Btn tone="primary">Save</Btn>
						</div>
					),
				},
			]}
		/>
	),
}
