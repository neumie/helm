import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import tabGroupModule from '../app/src/renderer/tab-groups.ts'
import tabNumberModule from '../app/src/renderer/tab-numbers.ts'
import type { TabGroupRendererTab } from '../app/src/renderer/tab-groups.ts'
import type { TabGroup } from '../app/src/shared.ts'

type TabGroupModule = typeof import('../app/src/renderer/tab-groups.ts')
type TabNumberModule = typeof import('../app/src/renderer/tab-numbers.ts')
const { composeTabGroups } = tabGroupModule as TabGroupModule
const { tabNumberSlots, tabNumberSlot, tabNumberLabels } = tabNumberModule as TabNumberModule
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const tab = (id: string, groupId: string | null = null, parked = false): TabGroupRendererTab => ({
	id,
	groupId,
	parked,
	name: id,
	agentRunning: false,
	agentAttention: false,
})
const group = (id: string, collapsedStrip: boolean): TabGroup => ({
	id,
	name: id,
	color: 'blue',
	collapsedStrip,
	collapsedBackground: false,
})

/** Jakub's screenshot: active shell, Build › compile (collapsed), then more tabs. */
function strip(buildCollapsed: boolean, activeTabId: string | null = 'shell') {
	return composeTabGroups({
		tabs: [
			tab('shell'),
			tab('compile', 'build'),
			tab('dev'),
			tab('tests', 'review'),
			tab('logs', 'review'),
			tab('parked', null, true),
			tab('api'),
		],
		groups: [group('build', buildCollapsed), group('review', true)],
		activeTabId,
	}).strip
}
const ids = (slots: ReturnType<typeof tabNumberSlots>) => slots.map(slot => [slot.number, slot.tabId, slot.groupId])

test('all (production) numbers every strip tab, including hidden collapsed members', () => {
	assert.deepEqual(ids(tabNumberSlots(strip(true), 'all')), [
		[1, 'shell', null],
		[2, 'compile', null],
		[3, 'dev', null],
		[4, 'tests', null],
		[5, 'logs', null],
		[6, 'api', null],
	])
})

test('skip-collapsed numbers only tabs visible in the strip', () => {
	assert.deepEqual(ids(tabNumberSlots(strip(true), 'skip-collapsed')), [
		[1, 'shell', null],
		[2, 'dev', null],
		[3, 'api', null],
	])
	assert.deepEqual(ids(tabNumberSlots(strip(false), 'skip-collapsed')), [
		[1, 'shell', null],
		[2, 'compile', null],
		[3, 'dev', null],
		[4, 'api', null],
	])
})

test('folder-slot gives a collapsed group one number that reopens its last-active member', () => {
	assert.deepEqual(ids(tabNumberSlots(strip(true), 'folder-slot')), [
		[1, 'shell', null],
		[2, 'compile', 'build'],
		[3, 'dev', null],
		[4, 'tests', 'review'],
		[5, 'api', null],
	])
	const remembered = tabNumberSlots(strip(true), 'folder-slot', new Map([['review', 'logs']]))
	assert.deepEqual(tabNumberSlot(remembered, 4), { number: 4, tabId: 'logs', groupId: 'review' })
	// A remembered id that left the group falls back to the active member, then the first.
	const stale = tabNumberSlots(strip(true, 'logs'), 'folder-slot', new Map([['review', 'gone']]))
	assert.equal(tabNumberSlot(stale, 4)?.tabId, 'logs')
	// Expanded groups are numbered member by member.
	assert.deepEqual(ids(tabNumberSlots(strip(false), 'folder-slot')).slice(0, 3), [
		[1, 'shell', null],
		[2, 'compile', null],
		[3, 'dev', null],
	])
})

test('only nine slots exist; ⌘9 is the ninth slot and nothing past it is numbered', () => {
	const many = composeTabGroups({
		tabs: Array.from({ length: 12 }, (_, i) => tab(`t${i + 1}`)),
		groups: [],
		activeTabId: null,
	}).strip
	const slots = tabNumberSlots(many, 'skip-collapsed')
	assert.equal(slots.length, 9)
	assert.equal(tabNumberSlot(slots, 9)?.tabId, 't9')
	assert.equal(tabNumberSlot(slots, 10), null)
	assert.equal(tabNumberSlot([], 1), null)
})

test('labels split individually numbered tabs from whole collapsed groups', () => {
	const { byTab, byGroup } = tabNumberLabels(tabNumberSlots(strip(true), 'folder-slot'))
	assert.deepEqual([...byTab], [
		['shell', 1],
		['dev', 3],
		['api', 5],
	])
	assert.deepEqual([...byGroup], [
		['build', 2],
		['review', 4],
	])
})

test('the shortcut handler and the strip hints share the one numbering function', () => {
	const workspace = read('app/src/renderer/terminal-workspace.ts')
	assert.match(workspace, /function selectTabNumber[\s\S]*?tabNumberSlots\(tabGroupComposition\(\)\.strip, tabNumberMode/)
	assert.match(workspace, /tabNumberLabels\(tabNumberSlots\(strip, tabNumberMode, lastActiveByGroup\)\)/)
	// Production keeps today's flat walk until a variant is chosen.
	assert.match(workspace, /options\.tabNumbers\?\.mode \?\? 'all'/)
	assert.match(workspace, /options\.tabNumbers\?\.hints \?\? 'none'/)
})
