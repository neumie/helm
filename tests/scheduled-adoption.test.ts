import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DB } from '../src/db/client.js'
import { AttentionAdoptionGrantManager } from '../src/scheduled-runs/adoption-grants.js'
import { ScheduleCommands } from '../src/scheduled-runs/commands.js'
import { toScheduledRunContract } from '../src/scheduled-runs/contract.js'
import { ScheduleRevisionConflictError } from '../src/scheduled-runs/store.js'

const scheduleInput = {
	name: 'Adoption test',
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

function attentionRun(commands: ScheduleCommands, suffix: string) {
	const schedule = commands.create({ ...scheduleInput, name: `${scheduleInput.name} ${suffix}` })
	const admitted = commands.claimOccurrence(schedule.id, schedule.revision, '2030-01-02T01:00:00.000Z', {
		scheduleId: schedule.id,
		scheduleRevision: schedule.revision,
		scheduledFor: '2030-01-01T01:00:00.000Z',
		localCivilSlot: `2030-01-01 ${suffix}`,
		utcOffsetMinutes: 0,
		slotKey: suffix,
		definitionSnapshot: schedule.definition,
		sessionId: `sr-adoption-${suffix}`,
	})
	const preparing = commands.beginPreparing(admitted.id, admitted.revision)
	const launching = commands.beginLaunching(preparing.id, preparing.revision)
	const running = commands.markRunning(launching.id, launching.revision)
	return commands.report(running.id, running.revision, 'needs_attention', 'Choose a target')
}

test('attention adoption is tenant/revision guarded, idempotent by identity, and redacted', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-adoption-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'alpha')
		const commands = new ScheduleCommands(db.schedules)
		const attention = attentionRun(commands, 'reserve')
		const identity = { adoptionId: randomUUID(), adopter: randomUUID() }
		assert.throws(
			() =>
				new ScheduleCommands(db.forProfile('beta').schedules).reserveAttentionAdoption(
					attention.id,
					attention.revision,
					identity,
				),
			/Scheduled run not found/,
		)
		assert.throws(
			() => commands.reserveAttentionAdoption(attention.id, attention.revision + 1, identity),
			ScheduleRevisionConflictError,
		)
		const reserved = commands.reserveAttentionAdoption(attention.id, attention.revision, identity)
		assert.equal(reserved.attentionAdoption?.state, 'reserved')
		assert.equal(
			commands.reserveAttentionAdoption(attention.id, attention.revision, identity).revision,
			reserved.revision,
		)
		assert.throws(
			() =>
				commands.reserveAttentionAdoption(attention.id, reserved.revision, {
					adoptionId: randomUUID(),
					adopter: randomUUID(),
				}),
			/another attempt/,
		)
		assert.throws(() => commands.requestCancel(reserved.id, reserved.revision), /actively reserved/)
		const contract = toScheduledRunContract(reserved)
		assert.equal(contract.sessionAvailability, 'unavailable')
		for (const forbidden of [
			'attentionAdoption',
			'adoptionId',
			'adopter',
			'reservedAt',
			'completedAt',
			'rolledBackAt',
			'reason',
		])
			assert.equal(forbidden in contract, false)

		const cancelling = attentionRun(commands, 'cancel-first')
		const cancelClaimed = db.schedules.claimPendingTerminalIntent(cancelling.id, cancelling.revision, 'cancel')
		assert.equal(toScheduledRunContract(cancelClaimed).sessionAvailability, 'unavailable')
		assert.throws(
			() =>
				commands.reserveAttentionAdoption(cancelClaimed.id, cancelClaimed.revision, {
					adoptionId: randomUUID(),
					adopter: randomUUID(),
				}),
			/terminal teardown intent/,
		)
		assert.throws(
			() =>
				db.schedules.updateAttentionAdoption(
					cancelClaimed.id,
					cancelClaimed.revision,
					{
						state: 'reserved',
						adoptionId: randomUUID(),
						adopter: randomUUID(),
						reservedAt: new Date().toISOString(),
					},
					null,
					true,
				),
			ScheduleRevisionConflictError,
		)

		const corrupt = attentionRun(commands, 'reserved-then-cancelled')
		const corruptIdentity = { adoptionId: randomUUID(), adopter: randomUUID() }
		const corruptReserved = commands.reserveAttentionAdoption(corrupt.id, corrupt.revision, corruptIdentity)
		const corruptCancel = db.schedules.claimPendingTerminalIntent(corrupt.id, corruptReserved.revision, 'cancel')
		const released = commands.rollbackAttentionAdoption(
			corruptCancel.id,
			corruptCancel.revision,
			corruptIdentity,
			'client',
		)
		assert.equal(released.attentionAdoption?.state, 'rolled_back')
		assert.equal(released.pendingTerminalIntent, 'cancel')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('attention adoption completion resolves terminal atomically; rollback never resolves and permits a new attempt', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-adoption-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'alpha')
		const commands = new ScheduleCommands(db.schedules)
		const first = attentionRun(commands, 'complete')
		const identity = { adoptionId: randomUUID(), adopter: randomUUID() }
		const reserved = commands.reserveAttentionAdoption(first.id, first.revision, identity)
		let now = 1_000
		const grants = new AttentionAdoptionGrantManager(10, () => now)
		assert.throws(
			() =>
				commands.completeAttentionAdoption(
					reserved.id,
					reserved.revision,
					{ adoptionId: identity.adoptionId, adopter: randomUUID() },
					grants,
					true,
				),
			/reservation does not match/,
		)
		assert.throws(
			() => commands.completeAttentionAdoption(reserved.id, reserved.revision, identity, grants, true),
			/not redeemed/,
		)
		const grant = grants.issue({
			profileId: reserved.profileId,
			runId: reserved.id,
			revision: reserved.revision,
			...identity,
		})
		assert.equal(
			grants.redeem(
				{ profileId: reserved.profileId, runId: reserved.id, revision: reserved.revision, ...identity },
				grant.capability,
			),
			true,
		)
		now += 10
		const complete = commands.completeAttentionAdoption(reserved.id, reserved.revision, identity, grants, true)
		assert.equal(complete.attentionAdoption?.state, 'completed')
		assert.ok(complete.terminalResolvedAt)
		assert.equal(
			commands.completeAttentionAdoption(complete.id, reserved.revision, identity, grants, true).revision,
			complete.revision,
		)
		assert.throws(
			() => commands.rollbackAttentionAdoption(complete.id, complete.revision, identity, 'client'),
			/already resolved/,
		)

		const second = attentionRun(commands, 'rollback')
		const abandoned = { adoptionId: randomUUID(), adopter: randomUUID() }
		const reservation = commands.reserveAttentionAdoption(second.id, second.revision, abandoned)
		const rolledBack = commands.rollbackAttentionAdoption(
			reservation.id,
			reservation.revision,
			abandoned,
			'attestation_failed',
		)
		assert.equal(rolledBack.attentionAdoption?.state, 'rolled_back')
		assert.equal(rolledBack.terminalResolvedAt, null)
		assert.equal(toScheduledRunContract(rolledBack).sessionAvailability, 'available')
		assert.equal(
			commands.rollbackAttentionAdoption(rolledBack.id, reservation.revision, abandoned, 'attestation_failed').revision,
			rolledBack.revision,
		)
		const retry = commands.reserveAttentionAdoption(rolledBack.id, rolledBack.revision, {
			adoptionId: randomUUID(),
			adopter: randomUUID(),
		})
		assert.equal(retry.attentionAdoption?.state, 'reserved')
		assert.equal(commands.recoverAttentionAdoption(retry.id).attentionAdoption?.state, 'rolled_back')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('migration 30 accepts null adoption rows and rejects malformed persisted adoption JSON', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-adoption-'))
	const path = join(root, 'helm.db')
	try {
		const db = new DB(path, 'alpha')
		const commands = new ScheduleCommands(db.schedules)
		const attention = attentionRun(commands, 'malformed')
		assert.equal(db.schedules.requireRun(attention.id).attentionAdoption, null)
		db.close()
		const raw = new Database(path)
		raw.prepare("UPDATE scheduled_runs SET attention_adoption = '{bad json' WHERE id = ?").run(attention.id)
		raw.close()
		const reopened = new DB(path, 'alpha')
		assert.throws(() => reopened.schedules.requireRun(attention.id), /attention_adoption is invalid JSON/)
		reopened.close()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
