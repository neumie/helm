import assert from 'node:assert/strict'
import test from 'node:test'
import {
	MISSED_OCCURRENCE_COUNT_CAP,
	type ScheduledOccurrence,
	latestDueOccurrence,
	manualSlotKey,
	nextOccurrence,
	normalizeCadence,
	parseCron,
} from '../src/scheduled-runs/recurrence.js'

function at(iso: string): Date {
	return new Date(iso)
}

function next(cron: string, timezone: string, after: string): ScheduledOccurrence {
	const occurrence = nextOccurrence(cron, timezone, at(after))
	if (!occurrence) assert.fail('expected an occurrence')
	return occurrence
}

test('normalizes hourly, daily, and weekly presets while retaining cadence kind', () => {
	assert.deepEqual(normalizeCadence({ kind: 'hourly', minute: 7 }, 'UTC'), {
		cadenceKind: 'hourly',
		cron: '7 * * * *',
		timezone: 'UTC',
	})
	assert.equal(normalizeCadence({ kind: 'daily', hour: 9, minute: 5 }, 'Europe/Prague').cron, '5 9 * * *')
	assert.equal(
		normalizeCadence({ kind: 'weekly', weekday: 1, hour: 8, minute: 30 }, 'America/New_York').cron,
		'30 8 * * 1',
	)
})

test('enforces strict five-field numeric cron and a real occurrence within 400 days', () => {
	for (const invalid of ['@daily', '0 0 * * * *', '0 0 * * * 2027', '60 * * * *', '0 0 31 2 *', '0 0 * JAN *']) {
		assert.throws(() => normalizeCadence({ kind: 'cron', expression: invalid }, 'UTC'))
	}
	assert.equal(parseCron('0 0 * * 7').canonical, '0 0 * * 7')
	assert.throws(() => normalizeCadence({ kind: 'daily', hour: 24, minute: 0 }, 'UTC'))
	assert.throws(() => normalizeCadence({ kind: 'hourly', minute: 0 }, 'Not/A_Timezone'))
})

test('UTC occurrence retains stable wall-clock persistence fields', () => {
	const occurrence = next('15 10 * * *', 'UTC', '2025-01-01T10:14:59.000Z')
	assert.equal(occurrence.scheduledFor, '2025-01-01T10:15:00.000Z')
	assert.equal(occurrence.localCivil, '2025-01-01T10:15')
	assert.equal(occurrence.slotKey, '2025-01-01T10:15')
	assert.equal(occurrence.offsetMinutes, 0)
})

test('America/New_York spring gap is skipped rather than shifted', () => {
	const occurrence = next('30 2 * * *', 'America/New_York', '2025-03-08T08:00:00.000Z')
	assert.equal(occurrence.scheduledFor, '2025-03-10T06:30:00.000Z')
	assert.equal(occurrence.localCivil, '2025-03-10T02:30')
})

test('Europe/Prague spring gap is skipped rather than caught up', () => {
	const occurrence = next('30 2 * * *', 'Europe/Prague', '2025-03-29T03:00:00.000Z')
	assert.equal(occurrence.scheduledFor, '2025-03-31T00:30:00.000Z')
	assert.equal(occurrence.localCivil, '2025-03-31T02:30')
})

test('fall folds execute the first civil minute once in New York and Prague', () => {
	const ny = next('30 1 * * *', 'America/New_York', '2025-11-01T06:00:00.000Z')
	assert.equal(ny.scheduledFor, '2025-11-02T05:30:00.000Z')
	assert.equal(ny.offsetMinutes, -240)
	assert.equal(next('30 1 * * *', 'America/New_York', ny.scheduledFor).scheduledFor, '2025-11-03T06:30:00.000Z')

	const prague = next('30 2 * * *', 'Europe/Prague', '2025-10-25T01:00:00.000Z')
	assert.equal(prague.scheduledFor, '2025-10-26T00:30:00.000Z')
	assert.equal(prague.offsetMinutes, 120)
	assert.equal(next('30 2 * * *', 'Europe/Prague', prague.scheduledFor).scheduledFor, '2025-10-27T01:30:00.000Z')
})

test('latest-only policy admits the exact six-hour boundary and skips a stale latest occurrence', () => {
	const exact = latestDueOccurrence('0 * * * *', 'UTC', at('2025-01-01T06:00:00.000Z'), at('2025-01-01T12:00:00.000Z'))
	assert.ok(exact)
	assert.equal(exact.decision, 'run')
	assert.equal(exact.occurrence.scheduledFor, '2025-01-01T12:00:00.000Z')

	const stale = latestDueOccurrence('0 0 * * *', 'UTC', at('2025-01-01T00:00:00.000Z'), at('2025-01-01T06:00:01.000Z'))
	assert.ok(stale)
	assert.equal(stale.decision, 'skipped_misfire')
})

test('72-hour sleep selects only the latest slot and aggregates older misses', () => {
	const due = latestDueOccurrence('0 9 * * *', 'UTC', at('2025-01-01T09:00:00.000Z'), at('2025-01-04T09:05:00.000Z'))
	assert.ok(due)
	assert.equal(due.decision, 'run')
	assert.equal(due.occurrence.scheduledFor, '2025-01-04T09:00:00.000Z')
	assert.deepEqual(due.dropped, { count: 3, many: false })
})

test('multi-week downtime has bounded aggregate history and never forms a backlog', () => {
	const due = latestDueOccurrence('0 * * * *', 'UTC', at('2025-01-01T00:00:00.000Z'), at('2025-02-01T00:00:00.000Z'))
	assert.ok(due)
	assert.equal(due.occurrence.scheduledFor, '2025-02-01T00:00:00.000Z')
	assert.deepEqual(due.dropped, { count: MISSED_OCCURRENCE_COUNT_CAP, many: true })
})

test('forward and backward daemon clock movement cannot produce a future claim', () => {
	const forward = latestDueOccurrence(
		'0 * * * *',
		'UTC',
		at('2025-01-01T10:00:00.000Z'),
		at('2025-01-01T12:20:00.000Z'),
	)
	assert.ok(forward)
	assert.equal(forward.occurrence.scheduledFor, '2025-01-01T12:00:00.000Z')
	assert.equal(
		latestDueOccurrence('0 * * * *', 'UTC', at('2025-01-01T10:00:00.000Z'), at('2025-01-01T09:59:00.000Z')),
		null,
	)
})

test('edits calculate strictly after their edit instant, including an edit at fire time', () => {
	const occurrence = next('0 10 * * *', 'UTC', '2025-01-01T10:00:00.000Z')
	assert.equal(occurrence.scheduledFor, '2025-01-02T10:00:00.000Z')
})

test('two concurrent pure ticks resolve the same durable civil slot for one external claim', () => {
	const args: [string, string, Date, Date] = [
		'30 1 * * *',
		'America/New_York',
		at('2025-11-02T05:30:00.000Z'),
		at('2025-11-02T06:45:00.000Z'),
	]
	const first = latestDueOccurrence(...args)
	const second = latestDueOccurrence(...args)
	assert.ok(first && second)
	assert.equal(first.occurrence.slotKey, second.occurrence.slotKey)
	assert.equal(first.occurrence.scheduledFor, second.occurrence.scheduledFor)
})

test('manual runs use a namespace that cannot collide with civil occurrence slots', () => {
	assert.equal(manualSlotKey('run_01-abc'), 'manual:run_01-abc')
	assert.throws(() => manualSlotKey('not/a/run'))
})
