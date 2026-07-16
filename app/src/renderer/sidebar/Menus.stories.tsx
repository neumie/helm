// Menus (§3.8), push-nav header (§3.10), and the pane-scoped sheet (§3.9).
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { Btn, FieldLabel, GLYPH, IconBtn, MenuButton, PushHeader, Sheet, TextInput } from './ui'

const meta: Meta = {
	title: 'Sidebar/Menus & Chrome',
}

export default meta
type Story = StoryObj

const noop = () => {}

/** Overflow menu: leading icon vocabulary, separator group, danger entry. */
export const OverflowMenu: Story = {
	render: () => (
		<div style={{ height: 220 }}>
			<MenuButton
				triggerLabel="More actions"
				trigger={GLYPH.ellipsis}
				align="start"
				entries={[
					{ label: 'Queue retry', icon: GLYPH.retry, onSelect: noop },
					{ label: 'Plan', icon: GLYPH.plan, onSelect: noop },
					{ label: 'Set as done', icon: GLYPH.check, onSelect: noop },
					{ label: 'Cancel run', icon: GLYPH.stop, onSelect: noop, disabled: true },
					{ label: 'Reject', icon: GLYPH.close, onSelect: noop, danger: true, group: true },
				]}
			/>
		</div>
	),
}

/** Radio-menu group (organization picker): checked entry carries the check. */
export const RadioMenu: Story = {
	render: () => (
		<div style={{ height: 180 }}>
			<MenuButton
				triggerLabel="Organize"
				trigger={GLYPH.group}
				align="start"
				entries={[
					{ label: 'Balanced index', checked: true, onSelect: noop },
					{ label: 'Group by project', checked: false, onSelect: noop },
				]}
			/>
		</div>
	),
}

export const PushNavHeader: Story = {
	render: () => (
		<div style={{ width: 340 }}>
			<PushHeader
				title="Fix the flaky login test"
				onBack={noop}
				trailing={<IconBtn label="Open task">{GLYPH.external}</IconBtn>}
			/>
		</div>
	),
}

export const PushNavHeaderLongTitle: Story = {
	render: () => (
		<div style={{ width: 340 }}>
			<PushHeader
				title="Investigate why the deploy watcher misses merge events when the branch was renamed mid-run"
				onBack={noop}
			/>
		</div>
	),
}

/** Pane-scoped modal sheet (§3.9): scrim + focus trap + Esc close. */
export const NewItemSheet: Story = {
	render: function SheetStory() {
		const [open, setOpen] = useState(true)
		const [title, setTitle] = useState('')
		return (
			<div style={{ position: 'relative', width: 360, height: 420 }}>
				<Btn onClick={() => setOpen(true)}>New item</Btn>
				{open && (
					<Sheet
						title="New item"
						onClose={() => setOpen(false)}
						footer={
							<>
								<Btn tone="ghost" onClick={() => setOpen(false)}>
									Cancel
								</Btn>
								<Btn tone="primary">Create</Btn>
							</>
						}
					>
						<div className="sheet-field">
							<FieldLabel htmlFor="sheet-title">Title</FieldLabel>
							<TextInput id="sheet-title" value={title} onChange={setTitle} placeholder="What needs doing?" />
						</div>
					</Sheet>
				)}
			</div>
		)
	},
}
