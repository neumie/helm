// Form fields (§3.7): inputs, textarea, select, toggle. Labels are the
// 12/500 sentence-case Label style (FieldLabel).
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { FieldLabel, SelectInput, TextArea, TextInput, Toggle } from './ui'

const meta: Meta = {
	title: 'Sidebar/Fields',
	decorators: [story => <div style={{ width: 340, display: 'flex', flexDirection: 'column', gap: 12 }}>{story()}</div>],
}

export default meta
type Story = StoryObj

function StatefulText({
	label,
	placeholder,
	initial = '',
	type,
	invalid,
}: {
	label: string
	placeholder?: string
	initial?: string
	type?: 'text' | 'password' | 'number'
	invalid?: boolean
}) {
	const [value, setValue] = useState(initial)
	const id = `field-${label.toLowerCase().replace(/\s+/g, '-')}`
	return (
		<div className="settings-field">
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<TextInput id={id} value={value} onChange={setValue} placeholder={placeholder} type={type} invalid={invalid} />
		</div>
	)
}

export const TextInputs: Story = {
	render: () => (
		<>
			<StatefulText label="Title" placeholder="Fix the flaky login test" />
			<StatefulText label="Base ref" initial="origin/main" />
			<StatefulText label="API token" type="password" initial="secret-token" />
			<StatefulText label="Poll seconds" type="number" initial="120" />
			<StatefulText label="Project slug" initial="not a slug!" invalid />
		</>
	),
}

export const TextAreaField: Story = {
	render: function TextAreaStory() {
		const [value, setValue] = useState('Investigate the failing deploy.\n\nRepro:\n1. Push to main\n2. Watch CI')
		return (
			<div className="settings-field">
				<FieldLabel htmlFor="prompt">Prompt</FieldLabel>
				<TextArea id="prompt" value={value} onChange={setValue} placeholder="Describe the work" />
			</div>
		)
	},
}

export const Select: Story = {
	render: function SelectStory() {
		const [value, setValue] = useState('claude')
		return (
			<>
				<div className="settings-field">
					<FieldLabel htmlFor="agent">Agent</FieldLabel>
					<SelectInput
						id="agent"
						value={value}
						onChange={setValue}
						options={[
							{ value: 'claude', label: 'Claude Code' },
							{ value: 'codex', label: 'Codex' },
						]}
					/>
				</div>
				<div className="settings-field">
					<FieldLabel htmlFor="agent-disabled">Agent (disabled)</FieldLabel>
					<SelectInput
						id="agent-disabled"
						value="claude"
						onChange={() => {}}
						disabled
						options={[{ value: 'claude', label: 'Claude Code' }]}
					/>
				</div>
			</>
		)
	},
}

export const Toggles: Story = {
	render: function ToggleStory() {
		const [on, setOn] = useState(true)
		const [off, setOff] = useState(false)
		return (
			<>
				<div className="toggle-row">
					<span className="toggle-label">Track deployments</span>
					<Toggle label="Track deployments" value={on} onChange={setOn} />
				</div>
				<div className="toggle-row">
					<span className="toggle-label">Post provider comments</span>
					<Toggle label="Post provider comments" value={off} onChange={setOff} />
				</div>
			</>
		)
	},
}
