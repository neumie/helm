// Empty / waiting states (§3.13): state first, then direction.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { EmptyState } from './ui'

const meta: Meta = {
	title: 'Sidebar/Empty state',
	decorators: [
		story => <div style={{ width: 340, height: 320, display: 'flex', flexDirection: 'column' }}>{story()}</div>,
	],
}

export default meta
type Story = StoryObj

export const EmptyBucket: Story = {
	render: () => <EmptyState title="Nothing needs you" detail="Items land here when a run finishes or fails." />,
}

export const WaitingForDaemon: Story = {
	render: () => <EmptyState title="Waiting for the daemon" detail="Start it with helm start." />,
}
