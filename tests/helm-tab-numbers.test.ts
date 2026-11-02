import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import tabGroupModule from '../app/src/renderer/tab-groups.ts'
import type { TabGroupRendererTab } from '../app/src/renderer/tab-groups.ts'
import tabNumberModule from '../app/src/renderer/tab-numbers.ts'
import type { TabGroup } from '../app/src/shared.ts'

type TabGroupModule = typeof import('../app/src/renderer/tab-groups.ts')
type TabNumberModule = typeof import('../app/src/renderer/tab-numbers.ts')
const { composeTabGroups } = tabGroupModule as TabGroupModule
const { tabNumberSlots, tabNumberSlot } = tabNumberModule as TabNumberModule
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

/** Active shell, Build › compile, dev, a collapsed two-tab Review folder, a parked tab, api. */
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
const ids = (slots: ReturnType<typeof tabNumberSlots>) => slots.map(slot => [slot.number, slot.tabId])

test('only tabs visible in the strip are numbered; collapsed folder members are skipped', () => {
	assert.deepEqual(ids(tabNumberSlots(strip(true))), [
		[1, 'shell'],
		[2, 'dev'],
		[3, 'api'],
	])
})

test('an expanded folder numbers its members in strip order like ordinary tabs', () => {
	assert.deepEqual(ids(tabNumberSlots(strip(false))), [
		[1, 'shell'],
		[2, 'compile'],
		[3, 'dev'],
		[4, 'api'],
	])
})

test('a collapsed folder stays skipped even when it holds the active tab', () => {
	assert.deepEqual(ids(tabNumberSlots(strip(true, 'compile'))), [
		[1, 'shell'],
		[2, 'dev'],
		[3, 'api'],
	])
})

test('only nine slots exist; ⌘9 is the ninth visible tab and fewer tabs leave the number empty', () => {
	const many = composeTabGroups({
		tabs: Array.from({ length: 12 }, (_, i) => tab(`t${i + 1}`)),
		groups: [],
		activeTabId: null,
	}).strip
	const slots = tabNumberSlots(many)
	assert.equal(slots.length, 9)
	assert.equal(tabNumberSlot(slots, 9)?.tabId, 't9')
	assert.equal(tabNumberSlot(slots, 10), null)
	assert.equal(tabNumberSlot(tabNumberSlots(strip(true)), 4), null)
	assert.equal(tabNumberSlot([], 1), null)
})

test('the shortcut handler and the strip digits share the one numbering function', () => {
	const workspace = read('app/src/renderer/terminal-workspace.ts')
	assert.match(workspace, /tabNumberSlot\(tabNumberSlots\(tabGroupComposition\(\)\.strip\), index\)/)
	assert.match(workspace, /function refreshTabNumbers[\s\S]*?tabNumberSlots\(strip\)/)
	// No flat walk over every strip tab remains: a hidden collapsed member is never selectable by number.
	assert.doesNotMatch(workspace, /tabs\[index - 1\]/)
	assert.doesNotMatch(workspace, /tabNumbers\?:/)
})
