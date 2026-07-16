// Segmented control (§3.2): boxed track, the accent commit variant (true
// either/or choices only), and the work-list lifecycle index with its 2px
// accent underline active state.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import type { BucketKey } from './model'
import { Segmented } from './ui'

const meta: Meta = {
	title: 'Sidebar/Segmented',
	decorators: [story => <div style={{ width: 340 }}>{story()}</div>],
}

export default meta
type Story = StoryObj

export const Boxed: Story = {
	render: function BoxedStory() {
		const [value, setValue] = useState('worktree')
		return (
			<Segmented
				label="Workspace"
				value={value}
				onChange={setValue}
				options={[
					{ value: 'worktree', label: 'Worktree' },
					{ value: 'main', label: 'Main' },
				]}
			/>
		)
	},
}

/** Accent fill marks a true either/or commit choice (agent picker) — the one
 *  sanctioned accent fill per card (§3.2). */
export const Commit: Story = {
	render: function CommitStory() {
		const [value, setValue] = useState('claude')
		return (
			<Segmented
				label="Agent"
				commit
				value={value}
				onChange={setValue}
				options={[
					{ value: 'claude', label: 'Claude' },
					{ value: 'codex', label: 'Codex' },
				]}
			/>
		)
	},
}

const BUCKETS = [
	{ value: 'needs', label: 'Needs', count: 2 },
	{ value: 'active', label: 'Active', count: 1 },
	{ value: 'queue', label: 'Queue', count: 4 },
	{ value: 'inbox', label: 'Inbox', count: 0 },
] as const

/** The work-list lifecycle index: text on a bottom hairline; active = --text-0
 *  weight + 2px accent underline sized to label+count — never accent text,
 *  never an option fill. */
export const LifecycleIndex: Story = {
	render: function IndexStory() {
		const [bucket, setBucket] = useState<BucketKey>('needs')
		return (
			<div className="list-filter">
				<Segmented<BucketKey>
					label="Work filter"
					variant="index"
					value={bucket}
					onChange={setBucket}
					options={[...BUCKETS]}
				/>
			</div>
		)
	},
}

/** Every active-underline position, side by side. */
export const LifecycleIndexStates: Story = {
	render: () => (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
			{BUCKETS.map(active => (
				<div className="list-filter" key={active.value}>
					<Segmented<BucketKey>
						label={`Work filter (${active.label} active)`}
						variant="index"
						value={active.value}
						onChange={() => {}}
						options={[...BUCKETS]}
					/>
				</div>
			))}
		</div>
	),
}
