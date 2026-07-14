import assert from 'node:assert/strict'
import test from 'node:test'
import dragModule from '../app/src/renderer/tab-drag.ts'

type DragModule = typeof import('../app/src/renderer/tab-drag.ts')
const {
	dragThresholdExceeded,
	moveToInsertionIndex,
	pointInExpandedRect,
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
