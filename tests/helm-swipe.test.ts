// SwipeTracker — the pure gesture core behind helm's two-finger swipe-back
// (helm/src/renderer/sidebar/swipe.ts; spec in docs/design-system.md §3.10).
// helm/package.json has no `type: module`, so tsx loads it as CJS —
// default-import + destructure, same pattern as the other helm tests.

import assert from 'node:assert/strict'
import test from 'node:test'
import swipeModule from '../app/src/renderer/sidebar/swipe.ts'

type SwipeModule = typeof import('../app/src/renderer/sidebar/swipe.ts')
const { SwipeTracker, SWIPE_COMMIT_FRACTION, SWIPE_FLICK_VELOCITY, SWIPE_MIN_FLICK_TRAVEL_PX } =
	swipeModule as SwipeModule

const WIDTH = 340
const yes = () => true
const no = () => false

test('back gesture (negative deltaX) starts and accumulates progress', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(-20, 2, 0, yes), 'started')
	assert.equal(tracker.feed(-30, 0, 16, yes), 'tracking')
	assert.equal(tracker.progressPx, 50)
	assert.ok(tracker.tracking)
})

test('drag past half the pane width commits', () => {
	const tracker = new SwipeTracker(WIDTH)
	tracker.feed(-40, 0, 0, yes)
	for (let i = 1; i <= 5; i++) tracker.feed(-40, 0, i * 16, yes)
	assert.ok(tracker.fraction >= SWIPE_COMMIT_FRACTION)
	assert.ok(tracker.shouldCommit())
})

test('short slow drag springs back (no commit)', () => {
	const tracker = new SwipeTracker(WIDTH)
	tracker.feed(-10, 0, 0, yes)
	tracker.feed(-10, 0, 200, yes) // 0.05 px/ms — far below flick velocity
	assert.ok(tracker.fraction < SWIPE_COMMIT_FRACTION)
	assert.equal(tracker.shouldCommit(), false)
})

test('fast flick commits even below half width', () => {
	const tracker = new SwipeTracker(WIDTH)
	tracker.feed(-10, 0, 0, yes)
	// ~5 px/ms of back motion, total travel past the minimum but below half width
	for (let i = 1; i <= 3; i++) tracker.feed(-40, 0, i * 8, yes)
	assert.ok(tracker.progressPx >= SWIPE_MIN_FLICK_TRAVEL_PX)
	assert.ok(tracker.fraction < SWIPE_COMMIT_FRACTION)
	assert.ok(tracker.shouldCommit())
})

test('a twitch below the minimum flick travel never commits', () => {
	const tracker = new SwipeTracker(WIDTH)
	tracker.feed(-10, 0, 0, yes)
	tracker.feed(-20, 0, 4, yes) // violent velocity, negligible travel
	assert.ok(tracker.progressPx < SWIPE_MIN_FLICK_TRAVEL_PX)
	assert.equal(tracker.shouldCommit(), false)
	assert.ok(SWIPE_FLICK_VELOCITY > 0)
})

test('vertical-dominant first event rejects the whole gesture', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(-5, 40, 0, yes), 'ignored')
	// later horizontal motion in the same gesture stays ignored
	assert.equal(tracker.feed(-60, 0, 16, yes), 'ignored')
	assert.equal(tracker.tracking, false)
	assert.equal(tracker.shouldCommit(), false)
})

test('forward-content pan (positive deltaX) rejects the gesture', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(30, 0, 0, yes), 'ignored')
	assert.equal(tracker.feed(-30, 0, 16, yes), 'ignored')
})

test('a consumer at gesture start (scrollable ancestor / nothing to pop) rejects', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(-30, 0, 0, no), 'ignored')
	// the gesture cannot re-qualify mid-flight even if the consumer freed up
	assert.equal(tracker.feed(-30, 0, 16, yes), 'ignored')
})

test('progress clamps to the pane width and to zero', () => {
	const tracker = new SwipeTracker(WIDTH)
	tracker.feed(-300, 0, 0, yes)
	tracker.feed(-300, 0, 16, yes)
	assert.equal(tracker.progressPx, WIDTH)
	assert.equal(tracker.fraction, 1)
	// dragging back past the origin clamps at 0
	tracker.feed(900, 0, 32, yes)
	assert.equal(tracker.progressPx, 0)
})
