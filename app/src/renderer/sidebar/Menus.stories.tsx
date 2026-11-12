// Menus (§3.8), push-nav header (§3.10), and the pane-scoped sheet (§3.9).
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useRef } from 'react'
import { StateGrid } from '../storybook/StateGrid'
import { AssignItemSheet } from './AssignItemSheet'
import { item } from './SidebarViews.stories'
import { GLYPH, IconBtn, MenuButton, PushHeader } from './ui'

const meta: Meta = {
	title: 'Compositions/Menu and navigation',
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

/** Work's More menu: named sections, aligned labels, one view preference, and trailing metadata. */
export const WorkMenu: Story = {
	render: () => (
		<div style={{ height: 340 }}>
			<MenuButton
				triggerLabel="More"
				trigger={GLYPH.ellipsis}
				align="start"
				entries={[
					{ label: 'Scheduled runs', icon: GLYPH.calendar, section: 'Work', onSelect: noop },
					{ label: 'Archive', icon: GLYPH.archive, meta: 12, onSelect: noop },
					{ label: 'Poll now', icon: GLYPH.retry, onSelect: noop },
					{ label: 'Pause queue', icon: GLYPH.pause, onSelect: noop },
					{
						label: 'Group by project',
						checked: false,
						checkedRole: 'checkbox',
						section: 'View',
						onSelect: noop,
					},
					{ label: 'Work', checked: true, section: 'Profiles', onSelect: noop },
					{ label: 'Personal', checked: false, onSelect: noop },
					{ label: 'Manage profiles…', onSelect: noop },
					{ label: 'Settings', icon: GLYPH.settings, onSelect: noop, group: true },
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

const unassignedItem = item({
	id: 'unassigned-story',
	status: 'ready',
	workMode: null,
	projectSlug: null,
	baseRef: null,
	title: 'Untitled item',
	displayName: null,
	assessment: null,
	source: null,
	canAssignProject: true,
	spawner: null,
	branchName: null,
	solverAgent: null,
	solverModel: null,
	solverEffort: null,
	solverWorkspace: null,
	runOutcome: null,
	startedAt: null,
	completedAt: null,
	allowedActions: [{ id: 'cancel', label: 'Cancel', tone: 'danger' }],
	links: { source: null, branch: null, pr: null },
})

/** Deferred repository assignment, mounting the production setup component. */
export const FinishItemSetupSheet: Story = {
	render: () => (
		<div style={{ position: 'relative', width: 340, height: 420 }}>
			<AssignItemSheet
				item={unassignedItem}
				projects={[{ slug: 'helm' }, { slug: 'client-care' }]}
				onClose={noop}
				onAssigned={noop}
			/>
		</div>
	),
}

/** A real MenuButton opened on mount (no pointer, no focus) so its first
 *  entry can take a forced state. */
function OpenMenu({
	danger,
	disabled,
	checked,
}: {
	danger?: boolean
	disabled?: boolean
	checked?: boolean
}) {
	const triggerRef = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		const trigger = triggerRef.current
		if (trigger && trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
	}, [])
	return (
		<MenuButton
			triggerRef={triggerRef}
			triggerLabel="More actions"
			trigger={GLYPH.ellipsis}
			align="start"
			entries={[
				checked !== undefined
					? { label: 'Group by project', checked, checkedRole: 'checkbox', onSelect: noop, disabled }
					: danger
						? { label: 'Reject', icon: GLYPH.close, danger: true, onSelect: noop, disabled }
						: { label: 'Queue retry', icon: GLYPH.retry, onSelect: noop, disabled },
				{ label: 'Plan', icon: GLYPH.plan, onSelect: noop },
			]}
		/>
	)
}

const MENU_CELL = 112
const MENU_WIDTH = 188

/** Forced states (§7 StateGrid): the trigger (an icon button, or the project
 *  filter's text trigger) and the first entry of an open menu. `open` and
 *  `checked` are real states. Menus have no pressed style. States run down so
 *  the open-menu cells fit a narrow canvas. */
export const States: Story = {
	render: () => (
		<div style={{ display: 'grid', gap: 24 }}>
			<StateGrid
				transpose
				states={['rest', 'hover', 'focus-visible', 'disabled', 'open']}
				rows={[
					{
						label: 'icon trigger',
						height: MENU_CELL,
						width: MENU_WIDTH,
						element: (
							<MenuButton
								triggerLabel="More actions"
								trigger={GLYPH.ellipsis}
								align="start"
								entries={[{ label: 'Queue retry', icon: GLYPH.retry, onSelect: noop }]}
							/>
						),
						variants: { open: <OpenMenu /> },
					},
					{
						label: 'project trigger',
						element: (
							<MenuButton
								triggerLabel="Project filter"
								triggerClass="project-trigger"
								trigger={
									<>
										<span className="project-trigger-label">All projects</span>
										{GLYPH.chevronDown}
									</>
								}
								align="start"
								entries={[{ label: 'All projects', checked: true, onSelect: noop }]}
							/>
						),
					},
				]}
			/>
			<StateGrid
				transpose
				states={['rest', 'hover', 'focus-visible', 'disabled', 'checked']}
				rows={[
					{
						label: 'entry',
						target: '.menu-item',
						height: MENU_CELL,
						width: MENU_WIDTH,
						element: <OpenMenu />,
						variants: { checked: <OpenMenu checked /> },
					},
					{
						label: 'danger entry',
						target: '.menu-item',
						height: MENU_CELL,
						width: MENU_WIDTH,
						element: <OpenMenu danger />,
					},
				]}
			/>
		</div>
	),
}
