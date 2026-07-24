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
import type { DtachSupervisor } from '../src/scheduled-runs/dtach-supervisor.js'
import { ScheduledRunService } from '../src/scheduled-runs/service.js'
import { scheduledSessionId } from '../src/scheduled-runs/session-path.js'
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
		sessionId: scheduledSessionId(`adoption-${suffix}`),
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
						expiresAt: new Date(Date.now() + 30_000).toISOString(),
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

test('service reserves only after attestation, burns grants on descriptor attach, and rolls back failures', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-adoption-service-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const schedule = commands.create(scheduleInput)
		let run = commands.claimOccurrence(schedule.id, schedule.revision, null, {
			scheduleId: schedule.id,
			scheduleRevision: schedule.revision,
			scheduledFor: '2030-01-01T01:00:00.000Z',
			localCivilSlot: '2030-01-01 service',
			utcOffsetMinutes: 0,
			slotKey: 'service',
			definitionSnapshot: schedule.definition,
			sessionId: scheduledSessionId('service-adoption'),
		})
		run = commands.beginPreparing(run.id, run.revision)
		run = commands.beginLaunching(run.id, run.revision)
		run = commands.markRunning(run.id, run.revision)
		run = commands.recordRuntime(run.id, run.revision, {
			processFingerprint: JSON.stringify({
				pid: 42,
				processGroupId: 42,
				sessionId: 42,
				startedAt: '2030-01-01T00:00:00.000Z',
				executable: '/usr/bin/dtach',
				socketHolder: {
					pid: 42,
					processGroupId: 42,
					sessionId: 42,
					startedAt: '2030-01-01T00:00:00.000Z',
					executable: '/usr/bin/dtach',
				},
			}),
			cwd: null,
			worktreePath: null,
			branchName: null,
			runDir: null,
			socketDescriptor: null,
		})
		run = commands.report(run.id, run.revision, 'needs_attention', 'choose a target')
		let attestations = 0
		const supervisor = {
			attestLiveSession: async () => {
				attestations++
				return {
					state: 'verified' as const,
					socketPath: '/tmp/helm-sched-test/work/sr.sock',
					identity: JSON.parse(run.processFingerprint as string),
				}
			},
		} as unknown as DtachSupervisor
		let grantNow = Date.now()
		const grants = new AttentionAdoptionGrantManager(30_000, () => grantNow)
		let serviceNow = new Date(grantNow)
		const service = new ScheduledRunService(
			{ scheduledRuns: { enabled: true, systemTargetsEnabled: false } } as never,
			db,
			{ reserveExternalSolve: () => true, releaseExternalSolve: () => true } as never,
			{
				profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as never],
				hasResidentLease: () => true,
				supervisor,
				adoptionGrants: grants,
				now: () => serviceNow,
			},
		)
		const identity = { adoptionId: randomUUID(), adopter: randomUUID() }
		const reservation = await service.reserveAttentionAdoption('work', run.id, run.revision, identity)
		assert.equal(reservation.run.attentionAdoption?.state, 'reserved')
		await assert.rejects(
			service.reserveAttentionAdoption('work', run.id, reservation.run.revision, identity),
			/already active/,
		)
		assert.equal(db.schedules.requireRun(run.id).attentionAdoption?.state, 'reserved')
		const descriptor = await service.attachAttentionDescriptor(
			'work',
			run.id,
			reservation.run.revision,
			identity,
			reservation.grant.capability,
		)
		assert.deepEqual(descriptor, {
			socketPath: '/tmp/helm-sched-test/work/sr.sock',
			mode: 'attach-existing',
			redraw: 'winch',
		})
		grantNow += 60_000
		serviceNow = new Date(grantNow)
		await service.reconcile()
		assert.equal(db.schedules.requireRun(run.id).attentionAdoption?.state, 'reserved')
		await assert.rejects(
			service.attachAttentionDescriptor(
				'work',
				run.id,
				reservation.run.revision,
				identity,
				reservation.grant.capability,
			),
			/unavailable/,
		)
		const completed = service.completeAttentionAdoption('work', run.id, reservation.run.revision, identity, true)
		assert.equal(completed.attentionAdoption?.state, 'completed')
		const laterRevision = commands.recordRuntime(completed.id, completed.revision, {
			processFingerprint: completed.processFingerprint,
			cwd: completed.cwd,
			worktreePath: completed.worktreePath,
			branchName: completed.branchName,
			runDir: completed.runDir,
			socketDescriptor: completed.socketDescriptor,
		})
		assert.deepEqual(
			await service.restoreCompletedAttentionDescriptor('work', laterRevision.id, reservation.run.revision, identity),
			{ socketPath: '/tmp/helm-sched-test/work/sr.sock', mode: 'attach-existing', redraw: 'winch' },
		)
		assert.equal(attestations, 4)

		let duplicateRace = attentionRun(commands, 'duplicate-race')
		duplicateRace = commands.recordRuntime(duplicateRace.id, duplicateRace.revision, {
			processFingerprint: run.processFingerprint,
			cwd: null,
			worktreePath: null,
			branchName: null,
			runDir: null,
			socketDescriptor: null,
		})
		let releaseFirst!: () => void
		let firstEntered!: () => void
		const firstGate = new Promise<void>(resolve => {
			releaseFirst = resolve
		})
		const firstSeen = new Promise<void>(resolve => {
			firstEntered = resolve
		})
		let duplicateAttestations = 0
		const duplicateService = new ScheduledRunService(
			{ scheduledRuns: { enabled: true, systemTargetsEnabled: false } } as never,
			db,
			{ reserveExternalSolve: () => true, releaseExternalSolve: () => true } as never,
			{
				profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as never],
				hasResidentLease: () => true,
				supervisor: {
					attestLiveSession: async () => {
						duplicateAttestations++
						if (duplicateAttestations === 1) {
							firstEntered()
							await firstGate
						}
						return { state: 'verified' as const, socketPath: '/tmp/existing', identity: {} }
					},
				} as unknown as DtachSupervisor,
			},
		)
		const duplicateIdentity = { adoptionId: randomUUID(), adopter: randomUUID() }
		const firstReservation = duplicateService.reserveAttentionAdoption(
			'work',
			duplicateRace.id,
			duplicateRace.revision,
			duplicateIdentity,
		)
		await firstSeen
		const winningReservation = await duplicateService.reserveAttentionAdoption(
			'work',
			duplicateRace.id,
			db.schedules.requireRun(duplicateRace.id).revision,
			duplicateIdentity,
		)
		releaseFirst()
		await assert.rejects(firstReservation, /already active/)
		await duplicateService.attachAttentionDescriptor(
			'work',
			duplicateRace.id,
			winningReservation.run.revision,
			duplicateIdentity,
			winningReservation.grant.capability,
		)
		assert.equal(db.schedules.requireRun(duplicateRace.id).attentionAdoption?.state, 'reserved')
		duplicateService.completeAttentionAdoption(
			'work',
			duplicateRace.id,
			winningReservation.run.revision,
			duplicateIdentity,
			true,
		)

		const failed = attentionRun(commands, 'service-failure')
		const failedIdentity = { adoptionId: randomUUID(), adopter: randomUUID() }
		const failingService = new ScheduledRunService(
			{ scheduledRuns: { enabled: true, systemTargetsEnabled: false } } as never,
			db,
			{ reserveExternalSolve: () => true, releaseExternalSolve: () => true } as never,
			{
				profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as never],
				hasResidentLease: () => true,
				supervisor: { attestLiveSession: async () => ({ state: 'mismatch' as const }) } as unknown as DtachSupervisor,
			},
		)
		await assert.rejects(
			failingService.reserveAttentionAdoption('work', failed.id, failed.revision, failedIdentity),
			/cannot be attested/,
		)
		assert.equal(db.schedules.requireRun(failed.id).attentionAdoption?.state, 'rolled_back')

		const restart = attentionRun(commands, 'restart-service')
		const restartIdentity = { adoptionId: randomUUID(), adopter: randomUUID() }
		const reservedForRestart = commands.reserveAttentionAdoption(restart.id, restart.revision, restartIdentity)
		const restartService = new ScheduledRunService(
			{ scheduledRuns: { enabled: true, systemTargetsEnabled: false } } as never,
			db,
			{ reserveExternalSolve: () => true, releaseExternalSolve: () => true } as never,
			{
				profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as never],
				hasResidentLease: () => true,
			},
		)
		const starting = restartService.start()
		assert.equal(db.schedules.requireRun(reservedForRestart.id).attentionAdoption?.state, 'rolled_back')
		await starting
		await restartService.stop()

		const expiring = attentionRun(commands, 'expiry-service')
		const expiryIdentity = { adoptionId: randomUUID(), adopter: randomUUID() }
		const reservedForExpiry = commands.reserveAttentionAdoption(expiring.id, expiring.revision, expiryIdentity)
		const expiryService = new ScheduledRunService(
			{ scheduledRuns: { enabled: true, systemTargetsEnabled: false } } as never,
			db,
			{ reserveExternalSolve: () => true, releaseExternalSolve: () => true } as never,
			{
				profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as never],
				hasResidentLease: () => true,
				now: () => new Date(Date.now() + 60_000),
			},
		)
		await expiryService.reconcile()
		assert.equal(db.schedules.requireRun(reservedForExpiry.id).attentionAdoption?.state, 'rolled_back')

		let stopping = attentionRun(commands, 'stop-service')
		stopping = commands.recordRuntime(stopping.id, stopping.revision, {
			processFingerprint: run.processFingerprint,
			cwd: null,
			worktreePath: null,
			branchName: null,
			runDir: null,
			socketDescriptor: null,
		})
		const stoppingIdentity = { adoptionId: randomUUID(), adopter: randomUUID() }
		let releaseAttestation!: () => void
		let markEntered!: () => void
		const entered = new Promise<void>(resolve => {
			markEntered = resolve
		})
		const attestationGate = new Promise<void>(resolve => {
			releaseAttestation = resolve
		})
		const stoppingService = new ScheduledRunService(
			{ scheduledRuns: { enabled: true, systemTargetsEnabled: false } } as never,
			db,
			{ reserveExternalSolve: () => true, releaseExternalSolve: () => true } as never,
			{
				profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as never],
				hasResidentLease: () => true,
				supervisor: {
					attestLiveSession: async () => {
						markEntered()
						await attestationGate
						return { state: 'verified' as const, socketPath: '/tmp/existing', identity: {} }
					},
				} as unknown as DtachSupervisor,
			},
		)
		const pendingReservation = stoppingService.reserveAttentionAdoption(
			'work',
			stopping.id,
			stopping.revision,
			stoppingIdentity,
		)
		await entered
		let stopFinished = false
		const stoppingPromise = stoppingService.stop().then(() => {
			stopFinished = true
		})
		await Promise.resolve()
		assert.equal(stopFinished, false)
		releaseAttestation()
		await pendingReservation
		await stoppingPromise
		await assert.rejects(
			stoppingService.reserveAttentionAdoption(
				'work',
				stopping.id,
				db.schedules.requireRun(stopping.id).revision,
				stoppingIdentity,
			),
			/unavailable/,
		)
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
