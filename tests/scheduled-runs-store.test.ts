import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DB } from '../src/db/client.js'
import { ScheduleCommands } from '../src/scheduled-runs/commands.js'
import { toScheduledRunContract, toScheduledScheduleContract } from '../src/scheduled-runs/contract.js'
import { ScheduleRevisionConflictError } from '../src/scheduled-runs/store.js'

const next = '2030-01-01T01:00:00.000Z'
const scheduleInput = {
	name: 'Nightly review',
	enabled: true,
	cron: '0 1 * * *',
	cadenceKind: 'daily' as const,
	timezone: 'UTC',
	definition: {
		prompt: 'Review the repository.',
		target: { kind: 'project' as const, projectSlug: 'helm' },
		agent: 'claude' as const,
		maximumRuntimeMinutes: 120,
	},
}

test('scheduled stores are profile-bound, revision guarded, and hide sensitive persistence fields', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-store-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'alpha')
		const alpha = new ScheduleCommands(db.schedules)
		const beta = new ScheduleCommands(db.forProfile('beta').schedules)
		const schedule = alpha.create(scheduleInput)
		assert.equal(beta.update(schedule.id, schedule.revision, scheduleInput), undefined, 'unreachable')
	} catch (error) {
		assert.match(String(error), /Scheduled definition not found/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('occurrence identity, active overlap, reports, and safe contracts are guarded', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-store-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'alpha')
		const commands = new ScheduleCommands(db.schedules)
		const schedule = commands.create(scheduleInput)
		assert.throws(
			() => commands.update(schedule.id, schedule.revision + 1, scheduleInput),
			ScheduleRevisionConflictError,
		)
		const run = commands.claimOccurrence(schedule.id, schedule.revision, '2030-01-02T01:00:00.000Z', {
			scheduleId: schedule.id,
			scheduleRevision: schedule.revision,
			scheduledFor: next,
			localCivilSlot: '2030-01-01 01:00',
			utcOffsetMinutes: 0,
			slotKey: '2030-01-01T01:00',
			definitionSnapshot: schedule.definition,
			sessionId: 'sr-one',
			socketDescriptor: '/private/socket',
			reportTokenHash: 'a'.repeat(64),
			cwd: '/private/cwd',
			runDir: '/private/run',
		})
		assert.throws(
			() =>
				commands.claimOccurrence(schedule.id, schedule.revision + 1, '2030-01-03T01:00:00.000Z', {
					...run,
					scheduleId: schedule.id,
					scheduleRevision: schedule.revision + 1,
					slotKey: run.slotKey,
					definitionSnapshot: schedule.definition,
				}),
			/Occurrence already claimed|not enabled|revision conflict/,
		)
		const preparing = commands.beginPreparing(run.id, run.revision)
		const launching = commands.beginLaunching(preparing.id, preparing.revision)
		const running = commands.markRunning(launching.id, launching.revision)
		const attention = commands.report(
			running.id,
			running.revision,
			'needs_attention',
			'\u001b[31mPlease choose a deployment target.\u001b[0m\u202e',
		)
		assert.equal(attention.reportSummary, 'Please choose a deployment target.')
		assert.equal(
			commands.report(attention.id, attention.revision, 'needs_attention', 'Please choose a deployment target.').id,
			attention.id,
		)
		assert.throws(() => commands.report(attention.id, attention.revision, 'quiet', 'different'), /conflicting report/)
		const contract = toScheduledRunContract(attention)
		assert.equal(contract.sessionAvailability, 'available')
		for (const forbidden of ['socketDescriptor', 'reportTokenHash', 'cwd', 'runDir', 'diagnosticDetail'])
			assert.equal(forbidden in contract, false)
		const scheduleContract = toScheduledScheduleContract(schedule)
		assert.equal('definition' in scheduleContract, false)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('ScheduleCommands canonicalize recurrence and reject invalid or caller-owned cadence state', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-store-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'alpha')
		const commands = new ScheduleCommands(db.schedules)
		const schedule = commands.create({ ...scheduleInput, cron: '0   1 * * *' })
		assert.equal(schedule.cron, '0 1 * * *')
		assert.notEqual(schedule.nextRunAt, next)
		for (const invalid of [
			{ ...scheduleInput, cron: '99 99 * * *' },
			{ ...scheduleInput, timezone: 'Not/A_Timezone' },
			{ ...scheduleInput, nextRunAt: next },
		]) {
			assert.throws(() => commands.create(invalid))
		}
		assert.equal(db.schedules.list().length, 1)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('scheduled command validation rejects raw hashes and oversized UTF-8 writes atomically', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-store-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'alpha')
		const commands = new ScheduleCommands(db.schedules)
		assert.throws(() =>
			commands.create({ ...scheduleInput, definition: { ...scheduleInput.definition, prompt: '😀'.repeat(16_385) } }),
		)
		assert.equal(db.schedules.list().length, 0)

		const schedule = commands.create(scheduleInput)
		assert.throws(() =>
			commands.claimOccurrence(schedule.id, schedule.revision, next, {
				scheduleId: schedule.id,
				scheduleRevision: schedule.revision,
				scheduledFor: next,
				localCivilSlot: '2030-01-01 01:00',
				utcOffsetMinutes: 0,
				slotKey: 'raw-token',
				definitionSnapshot: schedule.definition,
				sessionId: 'sr-raw-token',
				reportTokenHash: 'raw-bearer-token',
			}),
		)
		assert.equal(db.schedules.listRuns(schedule.id).length, 0)
		assert.equal(db.schedules.require(schedule.id).revision, schedule.revision)

		const run = commands.claimOccurrence(schedule.id, schedule.revision, next, {
			scheduleId: schedule.id,
			scheduleRevision: schedule.revision,
			scheduledFor: next,
			localCivilSlot: '2030-01-01 01:00',
			utcOffsetMinutes: 0,
			slotKey: 'bounded-writes',
			definitionSnapshot: schedule.definition,
			sessionId: 'sr-bounded-writes',
			reportTokenHash: 'b'.repeat(64),
		})
		const preparing = commands.beginPreparing(run.id, run.revision)
		const launching = commands.beginLaunching(preparing.id, preparing.revision)
		const running = commands.markRunning(launching.id, launching.revision)
		assert.throws(
			() => commands.report(running.id, running.revision, 'quiet', '\u001b]8;;https://bad\u0007\u202e'),
			/visible text/,
		)
		assert.deepEqual(db.schedules.requireRun(running.id), running)
		assert.throws(() => commands.report(running.id, running.revision, 'quiet', '😀'.repeat(251)))
		assert.deepEqual(db.schedules.requireRun(running.id), running)
		assert.throws(() => commands.markFailed(running.id, running.revision, '😀'.repeat(65_537)))
		assert.deepEqual(db.schedules.requireRun(running.id), running)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('ScheduleCommands protect reported, closing, attention, and quarantined runs from timeout', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-store-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'alpha')
		const commands = new ScheduleCommands(db.schedules)
		const makeRun = (slotKey: string) => {
			const schedule = commands.create({ ...scheduleInput, name: slotKey })
			const current = db.schedules.require(schedule.id)
			return commands.claimOccurrence(schedule.id, current.revision, next, {
				scheduleId: schedule.id,
				scheduleRevision: current.revision,
				scheduledFor: next,
				localCivilSlot: `2030-01-01 ${slotKey}`,
				utcOffsetMinutes: 0,
				slotKey,
				definitionSnapshot: current.definition,
				sessionId: `sr-${slotKey}`,
			})
		}
		const toRunning = (slotKey: string) => {
			const admitted = makeRun(slotKey)
			return commands.markRunning(
				commands.beginLaunching(commands.beginPreparing(admitted.id, admitted.revision).id, admitted.revision + 1).id,
				admitted.revision + 2,
			)
		}
		const quiet = commands.report(toRunning('reported-quiet').id, 3, 'quiet', 'done')
		const closingSource = commands.report(toRunning('closing').id, 3, 'quiet', 'done')
		const closing = commands.beginClose(closingSource.id, closingSource.revision)
		const attentionRunning = toRunning('attention')
		const attention = commands.report(attentionRunning.id, attentionRunning.revision, 'needs_attention', 'choose')
		const quarantinedRunning = toRunning('quarantined')
		const quarantined = db.schedules.transitionRun(quarantinedRunning.id, quarantinedRunning.revision, 'quarantined')
		for (const protectedRun of [quiet, closing, attention, quarantined]) {
			assert.throws(() => commands.markTimedOut(protectedRun.id, protectedRun.revision), /unreported/)
			assert.equal(db.schedules.requireRun(protectedRun.id).state, protectedRun.state)
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('strict target schemas reject system cwd and project/system runtime violations', async () => {
	const { scheduleCreateSchema } = await import('../src/scheduled-runs/schema.js')
	assert.equal(
		scheduleCreateSchema.safeParse({
			...scheduleInput,
			definition: {
				...scheduleInput.definition,
				target: { kind: 'system', riskAcknowledgement: 'broad-host-access', cwd: '/tmp' },
			},
		}).success,
		false,
	)
	assert.equal(
		scheduleCreateSchema.safeParse({
			...scheduleInput,
			definition: {
				...scheduleInput.definition,
				target: { kind: 'system', riskAcknowledgement: 'broad-host-access' },
				maximumRuntimeMinutes: 121,
			},
		}).success,
		false,
	)
})
