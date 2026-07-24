import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import tabGroupModule from '../app/src/renderer/tab-groups.ts'
import type { TabGroupRendererTab } from '../app/src/renderer/tab-groups.ts'
import type { TabGroup } from '../app/src/shared.ts'

type TabGroupModule = typeof import('../app/src/renderer/tab-groups.ts')
const {
	composeTabGroups,
	mergeGroupPeers,
	shouldReloadCollapsedGroup,
	tabGroupActionTargets,
	tabGroupHeading,
	tabGroupMembersId,
	tabsWithGroupId,
} = tabGroupModule as TabGroupModule
const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf8')

const groups: TabGroup[] = [
	{ id: 'group-11111111', name: 'Build', color: 'blue', collapsedStrip: true, collapsedBackground: false },
	{ id: 'group-22222222', name: 'Review', color: 'purple', collapsedStrip: false, collapsedBackground: true },
	{ id: 'group-empty000', name: 'Empty', color: 'green', collapsedStrip: true, collapsedBackground: true },
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

test('composes canonical surface sections while stale membership returns to the ordinary terminal flow', () => {
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
			['ungrouped', 'ungrouped', 'Terminals', ['ungrouped-strip', 'stale-membership']],
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
			['ungrouped', 'ungrouped', 'Terminals', ['ungrouped-background']],
		],
	)
	assert.equal(
		composition.strip.some(section => section.id === 'group-empty000'),
		false,
	)
	assert.equal(composition.strip[0]?.color, 'blue')
	assert.equal(composition.background[0]?.color, 'purple')
	assert.equal(composition.strip[0]?.members[0]?.active, true)
	assert.equal(composition.strip[0]?.members[1]?.active, false)
})

test('collapsed groups hide their entire mounted members container despite explicit display styles', () => {
	assert.match(styles, /\.tab-group-members\[hidden\],[\s\S]*\.bg-group-members\[hidden\][^{]*\{[^}]*display:\s*none/)
	assert.equal(
		[...renderer.matchAll(/membersEl\.hidden = section\.collapsed/g)].length,
		2,
		'strip and Background must both hide every member',
	)
})

test('group label and member tabs form one square colored band', () => {
	assert.match(renderer, /count\.className = 'tab-group-count'/)
	assert.match(renderer, /count\.textContent = String\(section\.members\.length\)/)
	assert.match(styles, /\.tab-group-section\s*\{[^}]*background:\s*color-mix\([^;]*var\(--group-color\) 15%/s)
	assert.match(styles, /\.tab-group-section\s*\{[^}]*box-shadow:\s*inset 0 2px var\(--group-color\)/s)
	assert.match(styles, /\.tab-group-members\s*\{[^}]*gap:\s*0/s)
	assert.match(styles, /\.tab-group-toggle\s*\{[^}]*border-radius:\s*0[^}]*background:\s*transparent/s)
	assert.match(styles, /\.tab-group-section \.tab\s*\{[^}]*border-radius:\s*0[^}]*background:\s*transparent/s)
	assert.match(styles, /\.tab-group-section \.tab\.active\s*\{[^}]*var\(--group-color\) 30%/s)
	assert.doesNotMatch(styles, /\.tab-group-toggle::after/)
	assert.doesNotMatch(styles, /\.tab-group-members::before/)
	assert.doesNotMatch(styles, /\.bg-group-members::before/)
})

test('collapse state is independent per surface and exposes no representative tab or row', () => {
	const composition = composeTabGroups({ tabs, groups, activeTabId: 'build-active' })
	const build = composition.strip[0]
	const review = composition.background[0]
	assert.ok(build)
	assert.ok(review)

	assert.equal(build.collapsed, true)
	assert.deepEqual(build.visibleMembers, [])
	assert.equal(review.collapsed, true)
	assert.deepEqual(review.visibleMembers, [])

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
	assert.deepEqual(
		independent.background[0]?.visibleMembers.map(member => member.id),
		['build-background'],
	)
})

test('collapsed projection does not mutate input tabs or duplicate a terminal identity', () => {
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
	assert.deepEqual(composition.strip[0]?.visibleMembers, [])
})

test('only named groups have headings or deterministic bulk commands', () => {
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
	assert.equal(tabGroupHeading(build), 'Build')
	assert.equal(tabGroupHeading(ungrouped), null)
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
	assert.equal(
		[...renderer.matchAll(/membersEl\.id = tabGroupMembersId\(section\.groupId, section\.surface\)/g)].length,
		2,
	)
	assert.match(renderer, /restoreFocusedGroupHeader\(tabsEl, focusedHeader\)/)
	assert.match(renderer, /restoreFocusedGroupHeader\(bgRows, focusedHeader\)/)
})

test('real OSC state transitions refresh group rendering while keepalives remain idempotent', () => {
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

test('renderer action adapter uses the validated intent and membership APIs for tab and group menus', () => {
	assert.match(renderer, /label: 'Move to existing group'/)
	assert.match(renderer, /label: 'Move to new group…'/)
	assert.match(renderer, /label: 'Remove from group'/)
	assert.match(renderer, /label: 'Color…'/)
	assert.match(renderer, /\.setColor\(groupId, color\)/)
	assert.doesNotMatch(renderer, /label: 'Ungrouped'/)
	assert.match(renderer, /function moveTabToGroup/)
	assert.match(renderer, /helm\.sessions\.groups\.intent\(intent\)/)
	assert.match(renderer, /helm\.sessions\.groups\.setMembership\(tab\.sessionId, groupId\)/)
	assert.match(renderer, /function openGroupMenu/)
	assert.match(renderer, /\? 'Open all'/)
	assert.match(renderer, /\? 'Restore all'/)
	assert.match(renderer, /\? 'Move group to Background'/)
	assert.match(renderer, /: 'Close all'/)
	assert.match(renderer, /helm\.sessions\.groups\.move\(target\.groupId, false\)/)
	assert.match(renderer, /restoreGroupMembers\(current, sessionIds\)/)
	assert.match(renderer, /helm\.sessions\.groups\.move\(target\.groupId, true\)/)
	assert.match(renderer, /backgroundGroupMembers\(current, sessionIds\)/)
	assert.match(renderer, /openGroupMembers\(current, authorization\.memberIds\)/)
	assert.match(renderer, /closeGroupMembers\(current, authorization\.memberIds\)/)
	assert.match(renderer, /event\.key !== 'ContextMenu' && !\(event\.shiftKey && event\.key === 'F10'\)/)
})

test('menu keyboard focus skips disabled actions and selection restores its trigger', () => {
	assert.match(renderer, /const enabledButtons = buttons\.filter\(button => !button\.disabled\)/)
	assert.match(renderer, /enabledButtons\[event\.key === 'Home' \? 0 : enabledButtons\.length - 1\]/)
	assert.match(renderer, /enabledButtons\[\(current \+ delta \+ enabledButtons\.length\) % enabledButtons\.length\]/)
	assert.match(renderer, /if \(trigger\.isConnected\) trigger\.focus\(\)/)
})

test('profile move menu leaves freeze and rollback exclusively to the transfer controller', () => {
	const start = renderer.indexOf('function openProfileMoveMenu')
	const end = renderer.indexOf('function openTabMenu', start)
	const menu = renderer.slice(start, end)
	assert.doesNotMatch(menu, /tab\.transferring = true/)
	assert.doesNotMatch(menu, /disableStdin = false/)
	assert.match(menu, /helm\.terminalTransfer\.move/)
})
