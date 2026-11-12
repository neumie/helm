// Button primitive (§3.1): four tones, two sizes, disabled/busy, block; icon buttons.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef, useState } from 'react'
import { StateGrid } from '../storybook/StateGrid'
import { Btn, GLYPH, IconBtn } from './ui'

const meta: Meta = {
	title: 'Primitives/Button',
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

function FocusReturnExample() {
	const primary = useRef<HTMLButtonElement>(null)
	return (
		<div style={row}>
			<Btn ref={primary} tone="primary">
				Pair device
			</Btn>
			<Btn onClick={() => primary.current?.focus()}>Restore focus</Btn>
		</div>
	)
}

export const FocusReturn: Story = {
	render: () => <FocusReturnExample />,
}

function FormExample() {
	const [submitted, setSubmitted] = useState(0)
	return (
		<form
			onSubmit={event => {
				event.preventDefault()
				setSubmitted(value => value + 1)
			}}
		>
			<div style={row}>
				<Btn type="submit" tone="primary">
					Submit form
				</Btn>
				<Btn type="submit" ariaDisabled>
					Unavailable action
				</Btn>
			</div>
			<output>Submissions: {submitted}</output>
		</form>
	)
}

export const FormSubmission: Story = { render: () => <FormExample /> }

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

/** SPA destination semantics without a second button implementation. */
export const CurrentDestination: Story = {
	render: () => (
		<nav aria-label="Example destinations" style={row}>
			<Btn tone="ghost" ariaCurrent="page">
				Conversations
			</Btn>
			<Btn tone="ghost">History</Btn>
		</nav>
	),
}

/** Forced interaction states (§7 StateGrid). Buttons have no pressed style, so
 *  there is no active column; busy is the real prop (label + ellipsis,
 *  disabled). */
export const States: Story = {
	render: () => (
		<div style={{ display: 'grid', gap: 24 }}>
			<StateGrid
				states={['rest', 'hover', 'focus-visible', 'disabled', 'busy']}
				rows={[
					{
						label: 'primary',
						element: <Btn tone="primary">Approve</Btn>,
						variants: {
							busy: (
								<Btn tone="primary" busy>
									Saving
								</Btn>
							),
						},
					},
					{
						label: 'quiet',
						element: <Btn tone="quiet">Retry</Btn>,
						variants: {
							busy: (
								<Btn tone="quiet" busy>
									Retry
								</Btn>
							),
						},
					},
					{
						label: 'danger',
						element: <Btn tone="danger">Reject</Btn>,
						variants: {
							busy: (
								<Btn tone="danger" busy>
									Reject
								</Btn>
							),
						},
					},
					{
						label: 'ghost',
						element: <Btn tone="ghost">Cancel</Btn>,
						variants: {
							busy: (
								<Btn tone="ghost" busy>
									Cancel
								</Btn>
							),
						},
					},
					{
						label: 'quiet, small',
						element: (
							<Btn tone="quiet" sm>
								Retry
							</Btn>
						),
						variants: {
							busy: (
								<Btn tone="quiet" sm busy>
									Retry
								</Btn>
							),
						},
					},
				]}
			/>
			<StateGrid
				states={['rest', 'hover', 'focus-visible', 'disabled']}
				rows={[
					{ label: 'icon button', element: <IconBtn label="More">{GLYPH.ellipsis}</IconBtn> },
					{ label: 'icon button, agent', element: <IconBtn label="Start agent">{GLYPH.agent}</IconBtn> },
				]}
			/>
		</div>
	),
}
