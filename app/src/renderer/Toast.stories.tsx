import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'

function Toast({
	message,
	detail,
	action,
	countdown,
}: { message: string; detail?: string; action?: string; countdown?: boolean }) {
	return (
		<div className="toast shown">
			<div className="toast-body">
				<div className="toast-msg">{message}</div>
				{detail ? <div className="toast-detail">{detail}</div> : null}
			</div>
			{action ? (
				<button type="button" className="toast-action">
					{action}
				</button>
			) : null}
			{countdown ? <div className="toast-countdown" style={{ transform: 'scaleX(0.62)' }} /> : null}
		</div>
	)
}

function Stage({ children }: { children: ReactNode }) {
	return (
		<div style={{ minHeight: 280, padding: 24, display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end' }}>
			<div style={{ width: 'min(320px, calc(100vw - 32px))' }}>{children}</div>
		</div>
	)
}

const meta: Meta = {
	title: 'Compositions/Toast',
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

export const Message: Story = {
	render: () => (
		<Stage>
			<Toast message="Settings applied" />
		</Stage>
	),
}

export const WithDetail: Story = {
	render: () => (
		<Stage>
			<Toast message="Opened in Okena" detail="fix/restore-terminal-sessions" />
		</Stage>
	),
}

export const WithAction: Story = {
	render: () => (
		<Stage>
			<Toast message="deploy watch closed" action="Undo" countdown />
		</Stage>
	),
}

export const StackLimit: Story = {
	render: () => (
		<Stage>
			<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
				<Toast message="Settings applied" />
				<Toast message="Opened in Okena" detail="fix/restore-terminal-sessions" />
				<Toast message="deploy watch closed" action="Undo" countdown />
			</div>
		</Stage>
	),
}
