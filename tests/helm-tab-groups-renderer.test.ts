import assert from 'node:assert/strict'
import test from 'node:test'
import tabGroupModule from '../app/src/renderer/tab-groups.ts'
import type { TabGroupRendererTab } from '../app/src/renderer/tab-groups.ts'
import type { TabGroup } from '../app/src/shared.ts'

type TabGroupModule = typeof import('../app/src/renderer/tab-groups.ts')
const { collapsedGroupProxy, composeTabGroups, tabGroupActionTargets } = tabGroupModule as TabGroupModule

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
