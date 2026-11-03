import assert from 'node:assert/strict'
import test from 'node:test'
import dragModule from '../app/src/renderer/tab-drag.ts'

type DragModule = typeof import('../app/src/renderer/tab-drag.ts')
const {
	dragThresholdExceeded,
	groupDropInsertionIndex,
	insertBlockAtUnitIndex,
	moveToInsertionIndex,
	pointInExpandedRect,
	pointerOnGroupHeaderEdge,
	stripDropInsertionIndex,
	tabDropInsertionIndex,
	tabStripAutoScrollDelta,
} = dragModule as DragModule

test('tab midpoint chooses before or after insertion slot', () => {
	assert.equal(tabDropInsertionIndex(2, 109, 100, 20), 2)
	assert.equal(tabDropInsertionIndex(2, 110, 100, 20), 3)
})

test('moving right accounts for removal before insertion', () => {
	assert.deepEqual(moveToInsertionIndex(['a', 'b', 'c', 'd'], 'a', 3), ['b', 'c', 'a', 'd'])
})

test('group block moves between individual ungrouped strip units', () => {
	const units = [['plain-a'], ['plain-b'], ['group-b-1', 'group-b-2']]
	assert.deepEqual(insertBlockAtUnitIndex(units, ['group-a-1', 'group-a-2'], 1), [
		'plain-a',
		'group-a-1',
		'group-a-2',
		'plain-b',
		'group-b-1',
		'group-b-2',
	])
	assert.deepEqual(insertBlockAtUnitIndex(units, ['group-a-1', 'group-a-2'], 99), [
		'plain-a',
		'plain-b',
		'group-b-1',
		'group-b-2',
		'group-a-1',
		'group-a-2',
	])
})

test('moving left and to strip edges preserves every tab once', () => {
	assert.deepEqual(moveToInsertionIndex(['a', 'b', 'c'], 'c', 1), ['a', 'c', 'b'])
	assert.deepEqual(moveToInsertionIndex(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b'])
	assert.deepEqual(moveToInsertionIndex(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a'])
})

test('same slot and unknown item are stable copies', () => {
	const items = ['a', 'b', 'c']
	assert.deepEqual(moveToInsertionIndex(items, 'b', 2), items)
	assert.deepEqual(moveToInsertionIndex(items, 'missing', 1), items)
})

test('group drop maps a peer-relative slot into flat tab order', () => {
	const a = { id: 'a', groupId: 'one' }
	const b = { id: 'b', groupId: 'one' }
	const c = { id: 'c', groupId: 'two' }
	const d = { id: 'd', groupId: 'two' }
	const items = [a, b, c, d]
	assert.equal(groupDropInsertionIndex(items, a, 'two', 1, 0), 3)
	assert.deepEqual(moveToInsertionIndex(items, a, groupDropInsertionIndex(items, a, 'two', 0, 0)), [b, a, c, d])
	assert.equal(groupDropInsertionIndex(items, a, null, 0, 3), 3)
})

test('leading strip gutter is an explicit first-position drop target', () => {
	const tabs = [
		{ left: 100, width: 60 },
		{ left: 164, width: 80 },
	]
	assert.equal(stripDropInsertionIndex(88, tabs), 0)
	assert.equal(stripDropInsertionIndex(112, tabs), 0)
	assert.equal(stripDropInsertionIndex(150, tabs), 1)
	assert.equal(stripDropInsertionIndex(260, tabs), 2)
})

test('strip edges auto-scroll only when more tabs exist in that direction', () => {
	assert.equal(tabStripAutoScrollDelta(105, { left: 100, width: 300 }, 40, 700, 300), -12)
	assert.equal(tabStripAutoScrollDelta(395, { left: 100, width: 300 }, 40, 700, 300), 12)
	assert.equal(tabStripAutoScrollDelta(105, { left: 100, width: 300 }, 0, 700, 300), 0)
	assert.equal(tabStripAutoScrollDelta(395, { left: 100, width: 300 }, 400, 700, 300), 0)
	assert.equal(tabStripAutoScrollDelta(250, { left: 100, width: 300 }, 40, 700, 300), 0)
})

test('pointer drag waits for a five-pixel intent threshold', () => {
	assert.equal(dragThresholdExceeded(100, 20, 103, 23), false)
	assert.equal(dragThresholdExceeded(100, 20, 104, 23), true)
})

test('magnetic background target uses a quiet expanded hit area', () => {
	const target = { left: 200, top: 10, width: 28, height: 28 }
	assert.equal(pointInExpandedRect(194, 20, target, 8), true)
	assert.equal(pointInExpandedRect(190, 20, target, 8), false)
	assert.equal(pointInExpandedRect(210, 45, target, 8), true)
})

test('folder header edges drop beside the folder; the middle joins it', () => {
	const collapsed = { left: 100, width: 96 } // quarter = 24 → clamped to 16
	assert.equal(pointerOnGroupHeaderEdge(100, collapsed, true), true)
	assert.equal(pointerOnGroupHeaderEdge(115, collapsed, true), true)
	assert.equal(pointerOnGroupHeaderEdge(116, collapsed, true), false)
	assert.equal(pointerOnGroupHeaderEdge(148, collapsed, true), false)
	assert.equal(pointerOnGroupHeaderEdge(179, collapsed, true), false)
	assert.equal(pointerOnGroupHeaderEdge(180, collapsed, true), true)
	// An expanded header only owns the leading edge: past it come its own members.
	assert.equal(pointerOnGroupHeaderEdge(180, collapsed, false), false)
	assert.equal(pointerOnGroupHeaderEdge(110, collapsed, false), true)
	// A narrow header keeps a 6px edge on each side and a joinable middle.
	const narrow = { left: 0, width: 20 }
	assert.equal(pointerOnGroupHeaderEdge(5, narrow, true), true)
	assert.equal(pointerOnGroupHeaderEdge(10, narrow, true), false)
	assert.equal(pointerOnGroupHeaderEdge(14, narrow, true), true)
})
