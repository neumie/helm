// Menus (§3.8), push-nav header (§3.10), and the pane-scoped sheet (§3.9).
import type { Meta, StoryObj } from '@storybook/react-vite'
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
