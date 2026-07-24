import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import tabGroupModule from '../app/src/renderer/tab-groups.ts'
import type { TabGroupRendererTab } from '../app/src/renderer/tab-groups.ts'
import type { TabGroup } from '../app/src/shared.ts'

type TabGroupModule = typeof import('../app/src/renderer/tab-groups.ts')
const {
	collapsedGroupProxy,
	composeTabGroups,
	mergeGroupPeers,
	shouldReloadCollapsedGroup,
	tabGroupActionTargets,
	tabGroupMembersId,
	tabsWithGroupId,
} = tabGroupModule as TabGroupModule
const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf8')

const groups: TabGroup[] = [
	{ id: 'group-11111111', name: 'Build', collapsedStrip: true, collapsedBackground: false },
	{ id: 'group-22222222', name: 'Review', collapsedStrip: false, collapsedBackground: true },
	{ id: 'group-empty000', name: 'Empty', collapsedStrip: true, collapsedBackground: true },
]

const tabs: TabGroupRendererTab[] = [
	{
		id: 'build-active',
		groupId: 'group-11111111',
		parked: false,
		name: 'Build active',
		agentRunning: false,
		agentAttention: false,
	},
	{
		id: 'build-attention',
		groupId: 'group-11111111',
		parked: false,
		name: 'Build attention',
		agentRunning: false,
		agentAttention: true,
	},
	{ id: 'ungrouped-strip', groupId: null, parked: false, name: 'Scratch', agentRunning: false, agentAttention: false },
	{
		id: 'stale-membership',
		groupId: 'group-missing0',
		parked: false,
		name: 'Legacy',
		agentRunning: false,
		agentAttention: false,
	},
	{
		id: 'review-running',
		groupId: 'group-22222222',
		parked: true,
		name: 'Review running',
		agentRunning: true,
		agentAttention: false,
	},
	{
		id: 'review-attention',
		groupId: 'group-22222222',
		parked: true,
		name: 'Review attention',
		agentRunning: false,
		agentAttention: true,
	},
	{
		id: 'ungrouped-background',
		groupId: null,
		parked: true,
		name: 'Detached',
		agentRunning: false,
		agentAttention: false,
	},
]

test('composes canonical surface sections, preserving first-member order and placing stale membership in Ungrouped', () => {
	const composition = composeTabGroups({ tabs, groups, activeTabId: 'build-active' })

	assert.deepEqual(
		composition.strip.map(section => [
			section.kind,
			section.id,
			section.name,
			section.members.map(member => member.id),
		]),
		[
			['group', 'group-11111111', 'Build', ['build-active', 'build-attention']],
			['ungrouped', 'ungrouped', 'Ungrouped', ['ungrouped-strip', 'stale-membership']],
		],
	)
	assert.deepEqual(
		composition.background.map(section => [
			section.kind,
			section.id,
			section.name,
			section.members.map(member => member.id),
		]),
		[
			['group', 'group-22222222', 'Review', ['review-running', 'review-attention']],
			['ungrouped', 'ungrouped', 'Ungrouped', ['ungrouped-background']],
		],
	)
	assert.equal(
		composition.strip.some(section => section.id === 'group-empty000'),
		false,
	)
	assert.equal(composition.strip[0]?.members[0]?.active, true)
	assert.equal(composition.strip[0]?.members[1]?.active, false)
})

test('collapse state is independent per surface and collapsed proxies prefer active, attention, running, then canonical first', () => {
	const composition = composeTabGroups({ tabs, groups, activeTabId: 'build-active' })
	const build = composition.strip[0]
	const review = composition.background[0]
	assert.ok(build)
	assert.ok(review)

	assert.equal(build.collapsed, true)
	assert.equal(build.visibleMembers.length, 1)
	assert.deepEqual(build.proxy, {
		id: 'build-active',
		groupId: 'group-11111111',
		parked: false,
		name: 'Build active',
		agentRunning: false,
		agentAttention: false,
		active: true,
		proxyForId: 'build-active',
	})
	assert.equal(review.collapsed, true)
	assert.equal(review.visibleMembers.length, 1)
	assert.equal(review.proxy?.proxyForId, 'review-attention')
	assert.equal(review.proxy?.name, 'Review attention')
	assert.equal(review.proxy?.agentAttention, true)
	assert.equal(review.proxy?.agentRunning, false)

	const independent = composeTabGroups({
		tabs: [
			{
				id: 'build-background',
				groupId: 'group-11111111',
				parked: true,
				name: 'Build background',
				agentRunning: false,
				agentAttention: false,
			},
		],
		groups,
		activeTabId: null,
	})
	assert.equal(independent.background[0]?.collapsed, false)
	assert.equal(independent.background[0]?.proxy, null)
	assert.deepEqual(
		independent.background[0]?.visibleMembers.map(member => member.id),
		['build-background'],
	)

	assert.equal(collapsedGroupProxy([]), null)
	assert.equal(
		collapsedGroupProxy([
			{
				id: 'first',
				groupId: null,
				parked: false,
				name: 'First',
				agentRunning: false,
				agentAttention: false,
				active: false,
			},
			{
				id: 'running',
				groupId: null,
				parked: false,
				name: 'Running',
				agentRunning: true,
				agentAttention: false,
				active: false,
			},
		])?.proxyForId,
		'running',
	)
})

test('collapsed proxy projection does not mutate input tabs or duplicate a terminal identity', () => {
	const before = structuredClone(tabs)
	const duplicate: TabGroupRendererTab = {
		id: 'build-active',
		groupId: null,
		parked: true,
		name: 'Malformed duplicate',
		agentRunning: true,
		agentAttention: false,
	}
	const firstGroup = groups[0]
	assert.ok(firstGroup)
	const composition = composeTabGroups({
		tabs: [...tabs, duplicate],
		groups: [...groups, { ...firstGroup }],
		activeTabId: 'build-active',
	})
	const allMemberIds = [...composition.strip, ...composition.background].flatMap(section =>
		section.members.map(member => member.id),
	)

	assert.deepEqual(tabs, before)
	assert.deepEqual(allMemberIds, [...new Set(allMemberIds)])
	assert.equal(allMemberIds.filter(id => id === 'build-active').length, 1)
	assert.deepEqual(
		composition.strip[0]?.visibleMembers.map(member => member.id),
		['build-active'],
	)
})

test('named group action targets are deterministic ordered snapshots and Ungrouped has no invented bulk command', () => {
	const composition = composeTabGroups({ tabs, groups, activeTabId: null })
	const build = composition.strip[0]
	const review = composition.background[0]
	const ungrouped = composition.background[1]
	assert.ok(build)
	assert.ok(review)
	assert.ok(ungrouped)

	assert.deepEqual(build.actionTargets, [
		{
			action: 'background',
			groupId: 'group-11111111',
			memberIds: ['build-active', 'build-attention'],
			intent: { type: 'move-all-background', groupId: 'group-11111111' },
		},
	])
	assert.deepEqual(review.actionTargets, [
		{
			action: 'open',
			groupId: 'group-22222222',
			memberIds: ['review-running', 'review-attention'],
			intent: { type: 'open-all', groupId: 'group-22222222' },
		},
		{
			action: 'restore',
			groupId: 'group-22222222',
			memberIds: ['review-running', 'review-attention'],
			intent: { type: 'restore-all', groupId: 'group-22222222' },
		},
		{
			action: 'close',
			groupId: 'group-22222222',
			memberIds: ['review-running', 'review-attention'],
			intent: { type: 'close-all', groupId: 'group-22222222' },
		},
	])
	assert.deepEqual(ungrouped.actionTargets, [])
	assert.deepEqual(tabGroupActionTargets(ungrouped), [])
})

test('drag reorders same-group peers only and merges them back without moving other groups', () => {
	const groupA = { id: 'a', groupId: 'group-a' }
	const ungrouped = { id: 'u', groupId: null }
	const groupB = { id: 'b', groupId: 'group-a' }
	const other = { id: 'x', groupId: 'group-b' }
	const flat = [groupA, ungrouped, groupB, other]
	const peers = tabsWithGroupId(flat, 'group-a')

	assert.deepEqual(
		peers.map(tab => tab.id),
		['a', 'b'],
	)
	assert.deepEqual(
		mergeGroupPeers(flat, 'group-a', [groupB, groupA]).map(tab => tab.id),
		['b', 'u', 'a', 'x'],
	)
	assert.deepEqual(
		mergeGroupPeers(flat, 'group-a', [groupA]).map(tab => tab.id),
		['a', 'u', 'b', 'x'],
	)
})

test('collapse rollback only reloads a current rejected or false write', () => {
	assert.equal(shouldReloadCollapsedGroup(3, 3, true), false)
	assert.equal(shouldReloadCollapsedGroup(3, 3, false), true)
	assert.equal(shouldReloadCollapsedGroup(3, 4, false), false)
	assert.match(
		renderer,
		/\.then\(accepted => \{\n\s*if \(shouldReloadCollapsedGroup\(version, tabGroupsVersion, accepted\)\) loadTabGroups\(\)/,
	)
	assert.match(
		renderer,
		/\.catch\(\(\) => \{\n\s*if \(shouldReloadCollapsedGroup\(version, tabGroupsVersion, false\)\) loadTabGroups\(\)/,
	)
})

test('restored membership and disclosure aria ids stay stable across a group rerender', () => {
	assert.equal(tabGroupMembersId('group-11111111', 'strip'), 'tab-group-members-strip-group-11111111')
	assert.equal(tabGroupMembersId('group-11111111', 'background'), 'tab-group-members-background-group-11111111')
	assert.match(renderer, /groupId: session\.groupId/)
	assert.match(
		renderer,
		/toggle\.setAttribute\('aria-controls', tabGroupMembersId\(section\.groupId, section\.surface\)\)/,
	)
	assert.match(renderer, /membersEl\.id = tabGroupMembersId\(section\.groupId, section\.surface\)/)
	assert.match(renderer, /restoreFocusedGroupHeader\(tabsEl, focusedHeader\)/)
	assert.match(renderer, /restoreFocusedGroupHeader\(bgRows, focusedHeader\)/)
})

test('real OSC state transitions refresh collapsed representatives while keepalives remain idempotent', () => {
	const runningSetter = renderer.slice(
		renderer.indexOf('function setTabAgentRunning'),
		renderer.indexOf('// ---------- manual rename'),
	)
	const agentRender = renderer.slice(
		renderer.indexOf('function renderTabAgentState'),
		renderer.indexOf('function setTabAgentAttention'),
	)
	assert.match(runningSetter, /if \(tab\.agentRunning === running\) return/)
	assert.match(runningSetter, /renderTabAgentState\(tab\)/)
	assert.match(agentRender, /renderTabGroups\(\)/)
})

test('collapsed proxy keeps the selected terminal’s exact OSC state instead of synthesizing group activity', () => {
	const composition = composeTabGroups({
		tabs: [
			{
				id: 'selected',
				groupId: 'group-11111111',
				parked: false,
				name: 'Deploy',
				agentRunning: true,
				agentAttention: true,
			},
			{
				id: 'other',
				groupId: 'group-11111111',
				parked: false,
				name: 'Tests',
				agentRunning: false,
				agentAttention: false,
			},
		],
		groups,
		activeTabId: 'selected',
	})
	const proxy = composition.strip[0]?.proxy
	assert.equal(proxy?.proxyForId, 'selected')
	assert.equal(proxy?.name, 'Deploy')
	assert.equal(proxy?.agentRunning, true)
	assert.equal(proxy?.agentAttention, true)
})
