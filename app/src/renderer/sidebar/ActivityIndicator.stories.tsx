import type { Meta, StoryObj } from '@storybook/react-vite'
import { ActivityIndicator } from '../activity-indicator'

const meta: Meta<typeof ActivityIndicator> = {
	title: 'Primitives/Activity indicator',
	component: ActivityIndicator,
	decorators: [
		story => (
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: 24,
					background: 'var(--bg-0)',
					color: 'var(--text-0)',
				}}
			>
				{story()}
			</div>
		),
	],
}

export default meta
type Story = StoryObj<typeof ActivityIndicator>

/** Ordinary progress stays words-free and grayscale; the state remains named for assistive technology. */
export const InProgress: Story = {
	args: { label: 'Running' },
}

/** An authoritative idle agent remains identifiable without motion or accent. */
export const Idle: Story = {
	args: { label: 'Pi is idle', variant: 'idle' },
}

/** Only a completed background run introduces accent, until its tab is checked. */
export const NeedsAttention: Story = {
	args: { label: 'Run finished — unchecked', variant: 'attention' },
}

/** Surfaces may pair the reusable motion primitive with their own visible copy. */
export const WithVisibleLabel: Story = {
	render: () => (
		<>
			<ActivityIndicator label="Loading Items" />
			<span className="activity-indicator-label">Loading Items</span>
		</>
	),
}
