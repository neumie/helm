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
const { tabNumberSlots, tabNumberSlot, adjacentVisibleTabId } = tabNumberModule as TabNumberModule
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

const step = (buildCollapsed: boolean, activeTabId: string | null, direction: 1 | -1) =>
	adjacentVisibleTabId(strip(buildCollapsed, activeTabId), activeTabId, direction)

test('previous/next skip tabs inside collapsed folders and wrap around the visible tabs', () => {
	assert.equal(step(true, 'shell', 1), 'dev')
	assert.equal(step(true, 'dev', 1), 'api')
	assert.equal(step(true, 'api', -1), 'dev')
	assert.equal(step(true, 'dev', -1), 'shell')
	assert.equal(step(true, 'shell', -1), 'api')
	assert.equal(step(true, 'api', 1), 'shell')
})

test("an expanded folder's members are cycled like ordinary tabs", () => {
	assert.equal(step(false, 'shell', 1), 'compile')
	assert.equal(step(false, 'dev', -1), 'compile')
	assert.equal(step(false, 'compile', 1), 'dev')
})

test('a hidden active tab steps from its place in the full strip order to the nearest visible tab', () => {
	// compile sits between shell and dev inside the collapsed Build folder.
	assert.equal(step(true, 'compile', 1), 'dev')
	assert.equal(step(true, 'compile', -1), 'shell')
	// logs is the last member of the collapsed Review folder, before api.
	assert.equal(step(true, 'tests', 1), 'api')
	assert.equal(step(true, 'logs', -1), 'dev')
})

test('a parked or missing active tab enters at the first (next) or last (previous) visible tab', () => {
	assert.equal(step(true, 'parked', 1), 'shell')
	assert.equal(step(true, 'parked', -1), 'api')
	assert.equal(step(true, null, 1), 'shell')
	assert.equal(step(true, null, -1), 'api')
})

test('cycling is not limited to the nine numbered tabs', () => {
	const many = composeTabGroups({
		tabs: Array.from({ length: 12 }, (_, i) => tab(`t${i + 1}`)),
		groups: [],
		activeTabId: 't9',
	}).strip
	assert.equal(adjacentVisibleTabId(many, 't9', 1), 't10')
	assert.equal(adjacentVisibleTabId(many, 't1', -1), 't12')
})

test('with no visible tab nothing is selected; a sole visible tab returns itself', () => {
	const folded = composeTabGroups({
		tabs: [tab('a', 'g'), tab('b', 'g')],
		groups: [group('g', true)],
		activeTabId: 'a',
	}).strip
	assert.equal(adjacentVisibleTabId(folded, 'a', 1), null)
	assert.equal(adjacentVisibleTabId(folded, null, -1), null)
	assert.equal(adjacentVisibleTabId([], null, 1), null)
	const lone = composeTabGroups({
		tabs: [tab('solo'), tab('a', 'g')],
		groups: [group('g', true)],
		activeTabId: 'solo',
	}).strip
	assert.equal(adjacentVisibleTabId(lone, 'solo', 1), 'solo')
	assert.equal(adjacentVisibleTabId(lone, 'a', -1), 'solo')
})

test('previous/next tab reuse the strip visibility instead of walking every tab', () => {
	const workspace = read('app/src/renderer/terminal-workspace.ts')
	assert.match(workspace, /adjacentVisibleTabId\(tabGroupComposition\(\)\.strip, activeId, direction\)/)
	assert.doesNotMatch(workspace, /tabs\[\(current \+ delta/)
})

test('the shortcut handler and the strip digits share the one numbering function', () => {
	const workspace = read('app/src/renderer/terminal-workspace.ts')
	assert.match(workspace, /tabNumberSlot\(tabNumberSlots\(tabGroupComposition\(\)\.strip\), index\)/)
	assert.match(workspace, /function refreshTabNumbers[\s\S]*?tabNumberSlots\(strip\)/)
	// No flat walk over every strip tab remains: a hidden collapsed member is never selectable by number.
	assert.doesNotMatch(workspace, /tabs\[index - 1\]/)
	assert.doesNotMatch(workspace, /tabNumbers\?:/)
})
