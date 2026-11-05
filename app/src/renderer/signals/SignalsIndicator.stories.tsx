import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * B — how Jakub notices new signals while Signals is closed. Each variant with 0 and with 3 new
 * signals (a review request, PR comments and a Sentry alert; a client mail already routed to an
 * agent does not count). The workspace is otherwise the production one: terminal, dock row.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/B Resting indicator',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { placement: 'closed', indicator: 'nothing', count: 3 },
	argTypes: {
		indicator: { control: 'inline-radio', options: ['topbar', 'dock-token', 'nothing', 'toast'] },
		count: { control: 'inline-radio', options: [0, 3] },
	},
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** B1 — a dim count in the top bar, before the Background stack. Zero: nothing (the top bar as today). */
export const TopbarCountNone: Story = { args: { indicator: 'topbar', count: 0 } }
/** B1 — `3 signals`, dim, in the top bar. */
export const TopbarCountThree: Story = { args: { indicator: 'topbar', count: 3 } }

/** B2 — a `⌁N` token in the dock row before the Agents entry. Zero: nothing (the row as today). */
export const DockTokenNone: Story = { args: { indicator: 'dock-token', count: 0 } }
/** B2 — `⌁3`: the glyph in --accent, the count like the Agents entry. */
export const DockTokenThree: Story = { args: { indicator: 'dock-token', count: 3 } }

/** B3 — nothing at rest: Jakub opens Signals himself (⌘⇧I). Zero and three look the same. */
export const NothingNone: Story = { args: { indicator: 'nothing', count: 0 } }
export const NothingThree: Story = { args: { indicator: 'nothing', count: 3 } }

/** B4 — nothing at rest either, but arrivals raise one production-style toast that then goes. */
export const ArrivalToastNone: Story = { args: { indicator: 'toast', count: 0 } }
/** B4 — the toast as it shows for a few seconds when the three arrive. */
export const ArrivalToastThree: Story = { args: { indicator: 'toast', count: 3 } }
