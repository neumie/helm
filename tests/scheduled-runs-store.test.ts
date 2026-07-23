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
	nextRunAt: next,
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
			reportTokenHash: 'secret-hash',
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
			'Please choose a deployment target.',
		)
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
