import assert from 'node:assert/strict'
import test from 'node:test'
import actionModule from '../app/src/renderer/sidebar/detail-actions.ts'

type ActionModule = typeof import('../app/src/renderer/sidebar/detail-actions.ts')
const { lifecycleActionPlan } = actionModule as ActionModule

const retry = { id: 'retry', label: 'Retry', tone: 'primary' } as const
const start = { id: 'start', label: 'Start', tone: 'primary' } as const

test('review Item promotes Mark done and moves Retry into overflow', () => {
	assert.deepEqual(lifecycleActionPlan('review', [retry]), {
		markDone: true,
		primary: null,
		rest: [retry],
	})
})

test('other Item statuses preserve server-owned primary action', () => {
	assert.deepEqual(lifecycleActionPlan('ready', [start]), {
		markDone: false,
		primary: start,
		rest: [],
	})
})
