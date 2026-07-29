import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import tabGroupModule from '../app/src/renderer/tab-groups.ts'
import type { TabGroupRendererTab } from '../app/src/renderer/tab-groups.ts'
import type { TabGroup } from '../app/src/shared.ts'

type TabGroupModule = typeof import('../app/src/renderer/tab-groups.ts')
const { composeTabGroups, shouldReloadCollapsedGroup, tabGroupActionTargets, tabGroupHeading, tabGroupMembersId } =
	tabGroupModule as TabGroupModule
const styles = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf8')

const groups: TabGroup[] = [
	{ id: 'build', name: 'Build', color: 'blue', collapsedStrip: true, collapsedBackground: false },
	{ id: 'review', name: 'Review', color: 'purple', collapsedStrip: false, collapsedBackground: true },
]
const tabs: TabGroupRendererTab[] = [
	{ id: 'compile', groupId: 'build', parked: false, name: 'Compile', agentRunning: false, agentAttention: false },
	{ id: 'tests', groupId: 'build', parked: false, name: 'Tests', agentRunning: true, agentAttention: false },
	{ id: 'scratch', groupId: null, parked: false, name: 'Scratch', agentRunning: false, agentAttention: false },
	{ id: 'review-a', groupId: 'review', parked: true, name: 'Review', agentRunning: false, agentAttention: true },
	{ id: 'review-b', groupId: 'review', parked: true, name: 'Logs', agentRunning: false, agentAttention: false },
	{ id: 'legacy', groupId: 'missing', parked: true, name: 'Legacy', agentRunning: false, agentAttention: false },
]

test('composition keeps named groups contiguous and stale membership ordinary', () => {
	const composition = composeTabGroups({ tabs, groups, activeTabId: 'compile' })
	assert.deepEqual(
		composition.strip.map(section => [section.kind, section.id, section.members.map(member => member.id)]),
		[
			['group', 'build', ['compile', 'tests']],
			['ungrouped', 'ungrouped', ['scratch']],
		],
	)
	assert.deepEqual(
		composition.background.map(section => [section.kind, section.id, section.members.map(member => member.id)]),
		[
			['group', 'review', ['review-a', 'review-b']],
			['ungrouped', 'ungrouped', ['legacy']],
		],
	)
	assert.equal(composition.strip[0]?.members[0]?.active, true)
})

test('drag surface projection is visual and does not mutate committed parked ownership', () => {
	const composition = composeTabGroups({
		tabs: [
			{
				id: 'to-strip',
				groupId: null,
				parked: true,
				surface: 'strip',
				name: 'Background',
				agentRunning: false,
				agentAttention: false,
			},
			{
				id: 'to-background',
				groupId: null,
				parked: false,
				surface: 'background',
				name: 'Foreground',
				agentRunning: false,
				agentAttention: false,
			},
		],
		groups: [],
		activeTabId: null,
	})
	assert.deepEqual(
		composition.strip.flatMap(section => section.members.map(member => member.id)),
		['to-strip'],
	)
	assert.deepEqual(
		composition.background.flatMap(section => section.members.map(member => member.id)),
		['to-background'],
	)
})

test('pure group labels, action targets, and independent collapse semantics stay stable', () => {
	assert.equal(tabGroupHeading({ kind: 'group', name: 'Build' }), 'Build')
	assert.equal(tabGroupHeading({ kind: 'ungrouped', name: 'Terminals' }), null)
	assert.equal(tabGroupMembersId('build', 'strip'), 'tab-group-members-strip-build')
	assert.equal(shouldReloadCollapsedGroup(2, 2, false), true)
	assert.equal(shouldReloadCollapsedGroup(1, 2, false), false)
	assert.deepEqual(
		tabGroupActionTargets({
			groupId: 'build',
			surface: 'background',
			members: [
				{
					id: 'compile',
					groupId: 'build',
					parked: true,
					name: 'Compile',
					agentRunning: false,
					agentAttention: false,
					active: false,
				},
				{
					id: 'tests',
					groupId: 'build',
					parked: true,
					name: 'Tests',
					agentRunning: false,
					agentAttention: false,
					active: false,
				},
			],
		}).map(target => target.action),
		['open', 'restore', 'close'],
	)
})

test('group CSS preserves mounted-hidden semantics and continuous strip geometry', () => {
	assert.match(styles, /\.tab-group-members\[hidden\],[\s\S]*\.bg-group-members\[hidden\][^{]*\{[^}]*display:\s*none/)
	assert.match(styles, /\.tab-group-members\s*\{[^}]*gap:\s*0/s)
	assert.match(styles, /\.ungrouped-tab-members\s*\{[^}]*gap:\s*4px/s)
	assert.match(styles, /\.tab-group-section > \.tab-group-toggle:first-child\s*\{[^}]*border-radius:\s*6px 0 0 6px/s)
	assert.match(
		styles,
		/\.tab-group-section > \.tab-group-members:last-child \.tab:last-child\s*\{[^}]*border-radius:\s*0 6px 6px 0/s,
	)
})
