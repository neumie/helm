// Buttons (§3.1): four tones, two sizes, disabled/busy, block; icon buttons.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Btn, GLYPH, IconBtn } from './ui'

const meta: Meta = {
	title: 'Sidebar/Buttons',
}

export default meta
type Story = StoryObj

const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as const

export const Tones: Story = {
	render: () => (
		<div style={row}>
			<Btn tone="primary">Approve and queue</Btn>
			<Btn tone="quiet">Work manually</Btn>
			<Btn tone="danger">Reject</Btn>
			<Btn tone="ghost">Cancel</Btn>
		</div>
	),
}

export const Small: Story = {
	render: () => (
		<div style={row}>
			<Btn tone="primary" sm>
				Restart now
			</Btn>
			<Btn tone="quiet" sm>
				Retry
			</Btn>
			<Btn tone="danger" sm>
				Reject
			</Btn>
			<Btn tone="ghost" sm>
				Cancel
			</Btn>
		</div>
	),
}

export const Disabled: Story = {
	render: () => (
		<div style={row}>
			<Btn tone="primary" disabled>
				Approve and queue
			</Btn>
			<Btn tone="quiet" disabled>
				Work manually
			</Btn>
			<Btn tone="danger" disabled>
				Reject
			</Btn>
			<Btn tone="ghost" disabled>
				Cancel
			</Btn>
		</div>
	),
}

/** In-flight: label kept, ellipsis appended, control disabled. */
export const Busy: Story = {
	render: () => (
		<div style={row}>
			<Btn tone="primary" busy>
				Saving
			</Btn>
			<Btn tone="quiet" busy>
				Restarting
			</Btn>
		</div>
	),
}

export const Block: Story = {
	render: () => (
		<div style={{ width: 340 }}>
			<Btn tone="primary" block>
				Save changes
			</Btn>
		</div>
	),
}

export const IconButtons: Story = {
	render: () => (
		<div style={row}>
			<IconBtn label="New item">{GLYPH.plus}</IconBtn>
			<IconBtn label="Back">{GLYPH.back}</IconBtn>
			<IconBtn label="Overflow">{GLYPH.ellipsis}</IconBtn>
			<IconBtn label="Start agent">{GLYPH.agent}</IconBtn>
			<IconBtn label="Work manually">{GLYPH.manual}</IconBtn>
			<IconBtn label="Archive">{GLYPH.archive}</IconBtn>
			<IconBtn label="Settings">{GLYPH.settings}</IconBtn>
			<IconBtn label="Close">{GLYPH.close}</IconBtn>
			<IconBtn label="Disabled" disabled>
				{GLYPH.retry}
			</IconBtn>
		</div>
	),
}

/** Icon-led action vocabulary from the detail run controls. */
export const IconLedActions: Story = {
	render: () => (
		<div style={row}>
			<Btn tone="primary">{GLYPH.queue} Approve and queue</Btn>
			<Btn tone="primary">{GLYPH.agent} Start agent</Btn>
			<Btn tone="quiet">{GLYPH.retry} Queue retry</Btn>
			<Btn tone="quiet">{GLYPH.check} Set as done</Btn>
		</div>
	),
}
