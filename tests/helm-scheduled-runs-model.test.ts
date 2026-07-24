import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error -- app modules load as CJS under the root tsx test runner.
import scheduledModelModule from '../app/src/renderer/sidebar/scheduled-runs-model.ts'

type ScheduledModel = typeof import('../app/src/renderer/sidebar/scheduled-runs-model.ts')
const { canCancelScheduledRun, isFiveFieldCron, isIanaTimezone, scheduledRunStateLabel } =
	scheduledModelModule as ScheduledModel

test('scheduled editor preflights only strict five-field cron expressions', () => {
	assert.equal(isFiveFieldCron('0 9 * * 1-5'), true)
	assert.equal(isFiveFieldCron('@daily'), false)
	assert.equal(isFiveFieldCron('0 9 * *'), false)
})

test('scheduled editor accepts explicit IANA timezones and readable run states', () => {
	assert.equal(isIanaTimezone('America/New_York'), true)
	assert.equal(isIanaTimezone('UTC'), true)
	assert.equal(isIanaTimezone('local'), false)
	assert.equal(scheduledRunStateLabel('needs_attention'), 'needs attention')
	for (const state of [
		'admitted',
		'preparing',
		'launching',
		'running',
		'needs_attention',
		'cancel_requested',
		'quarantined',
	] as const)
		assert.equal(canCancelScheduledRun(state), true, state)
	assert.equal(canCancelScheduledRun('closed_quiet'), false)
})
