import assert from 'node:assert/strict'
import test from 'node:test'
import actionModule from '../app/src/renderer/sidebar/detail-actions.ts'

type ActionModule = typeof import('../app/src/renderer/sidebar/detail-actions.ts')
const { lifecycleActionPlan, lifecycleActionPresentation, manualStatusOptions } = actionModule as ActionModule

const retry = { id: 'retry', label: 'Retry', tone: 'primary' } as const
const start = { id: 'start', label: 'Start', tone: 'primary' } as const

test('review and human-active Items promote Set as done', () => {
	assert.deepEqual(lifecycleActionPlan('review', [retry]), {
		markDone: true,
		primary: null,
		rest: [retry],
	})
	assert.deepEqual(lifecycleActionPlan('active', []), {
		markDone: true,
		primary: null,
		rest: [],
	})
})

test('other Item statuses preserve server-owned primary action', () => {
	assert.deepEqual(lifecycleActionPlan('ready', [start]), {
		markDone: false,
		primary: start,
		rest: [],
	})
})

test('bottom actions use concise labels and semantic icons', () => {
	assert.deepEqual(lifecycleActionPresentation('approve', 'Approve', 'solve'), {
		label: 'Approve and queue',
		icon: 'queue',
	})
	assert.deepEqual(lifecycleActionPresentation('start', 'Start', 'solve'), { label: 'Start agent', icon: 'play' })
	assert.deepEqual(lifecycleActionPresentation('start', 'Start', 'loop'), { label: 'Start loop', icon: 'play' })
	assert.deepEqual(lifecycleActionPresentation('retry', 'Retry', 'solve'), { label: 'Queue retry', icon: 'retry' })
	assert.deepEqual(lifecycleActionPresentation('retry', 'Retry', 'loop'), { label: 'Queue loop retry', icon: 'retry' })
	assert.deepEqual(lifecycleActionPresentation('cancel', 'Cancel', 'solve'), { label: 'Cancel run', icon: 'stop' })
	assert.deepEqual(lifecycleActionPresentation('reject', 'Reject', 'solve'), { label: 'Reject', icon: 'close' })
	assert.deepEqual(lifecycleActionPresentation('reopen', 'Move to review', 'solve'), {
		label: 'Move to review',
		icon: 'return',
	})
})

test('manual status control exposes every non-running lifecycle state', () => {
	assert.deepEqual(
		manualStatusOptions('ready').map(option => option.status),
		['inbox', 'ready', 'active', 'review', 'done', 'failed', 'cancelled'],
	)
	assert.deepEqual(manualStatusOptions('running'), [])
})
