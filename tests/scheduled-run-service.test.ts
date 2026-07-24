import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import type { ProfileRuntime } from '../src/profiles/store.js'
import type { Drainer } from '../src/queue/drainer.js'
import { ScheduleCommands } from '../src/scheduled-runs/commands.js'
import type { ScheduledRunRecord } from '../src/scheduled-runs/schema.js'
import { ScheduledRunService, type ScheduledRunServiceDeps } from '../src/scheduled-runs/service.js'
import { scheduledSessionId, scheduledSocketPath } from '../src/scheduled-runs/session-path.js'

const definition = {
	prompt: 'Review the repository.',
	target: { kind: 'project' as const, projectSlug: 'helm' },
	agent: 'claude' as const,
	maximumRuntimeMinutes: 120,
}
const scheduleInput = {
	name: 'Nightly review',
	enabled: true,
	cron: '0 1 * * *',
	cadenceKind: 'daily' as const,
	timezone: 'UTC',
	definition,
}
const config = {
	scheduledRuns: { enabled: true },
	server: { host: '127.0.0.1', port: 7474 },
	solver: { agent: 'claude' },
} as unknown as HelmConfig

function runInput(schedule: { id: string; revision: number }, slotKey: string) {
	return {
		scheduleId: schedule.id,
		scheduleRevision: schedule.revision,
		scheduledFor: '2030-01-01T01:00:00.000Z',
		localCivilSlot: '2030-01-01 01:00',
		utcOffsetMinutes: 0,
		slotKey,
		definitionSnapshot: definition,
		sessionId: `sr-${slotKey}`,
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(next => {
		resolve = next
	})
	return { promise, resolve }
}

function fakeDrainer() {
	const reservations = new Set<string>()
	let reserveCalls = 0
	let releaseCalls = 0
	return {
		reservations,
		get reserveCalls() {
			return reserveCalls
		},
		get releaseCalls() {
			return releaseCalls
		},
		reserveExternalSolve(id: string) {
			reserveCalls++
			if (reservations.has(id)) return true
			if (reservations.size >= 1) return false
			reservations.add(id)
			return true
		},
		releaseExternalSolve(id: string) {
			releaseCalls++
			return reservations.delete(id)
		},
	}
}

test('claimOccurrence atomically records overlap skips and advances cadence before the active index', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const schedule = commands.create(scheduleInput)
		const first = commands.claimOccurrence(
			schedule.id,
			schedule.revision,
			'2030-01-02T01:00:00.000Z',
			runInput(schedule, 'slot-1'),
		)
		const advanced = db.schedules.require(schedule.id)
		const skipped = commands.claimOccurrence(
			schedule.id,
			advanced.revision,
			'2030-01-03T01:00:00.000Z',
			runInput(advanced, 'slot-2'),
		)
		assert.equal(first.state, 'admitted')
		assert.equal(skipped.state, 'skipped_overlap')
		assert.ok(skipped.closedAt)
		assert.equal(db.schedules.require(schedule.id).nextRunAt, '2030-01-03T01:00:00.000Z')

		const manual = commands.claimManualOccurrence(
			schedule.id,
			db.schedules.require(schedule.id).revision,
			runInput(db.schedules.require(schedule.id), 'manual-1'),
		)
		assert.equal(manual.state, 'skipped_overlap')
		assert.equal(db.schedules.require(schedule.id).nextRunAt, '2030-01-03T01:00:00.000Z')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('runNow applies the same durable overlap policy without attempting workspace admission', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const schedule = commands.create(scheduleInput)
		commands.claimOccurrence(schedule.id, schedule.revision, '2030-01-02T01:00:00.000Z', runInput(schedule, 'active'))
		const drainer = fakeDrainer()
		const service = new ScheduledRunService(config, db, drainer as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => true,
		})
		const skipped = await service.runNow('work', schedule.id)
		assert.equal(skipped.state, 'skipped_overlap')
		assert.equal(drainer.reservations.size, 0)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

async function listenSocket(path: string): Promise<net.Server> {
	mkdirSync(dirname(path), { recursive: true })
	const server = net.createServer()
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(path, resolve)
	})
	return server
}

function createRunningRun(db: DB, commands: ScheduleCommands, name: string) {
	const schedule = commands.create({ ...scheduleInput, name })
	const admitted = commands.claimOccurrence(schedule.id, schedule.revision, null, runInput(schedule, `running-${name}`))
	const preparing = commands.beginPreparing(admitted.id, admitted.revision)
	const launching = commands.beginLaunching(preparing.id, preparing.revision)
	return commands.markRunning(launching.id, launching.revision)
}

function createRecoverableRun(
	db: DB,
	commands: ScheduleCommands,
	name: string,
	state: 'needs_attention' | 'reported_quiet' | 'running',
	runtime: Partial<
		Pick<
			ScheduledRunRecord,
			'processFingerprint' | 'cwd' | 'worktreePath' | 'branchName' | 'runDir' | 'socketDescriptor'
		>
	> = {},
) {
	const schedule = commands.create({ ...scheduleInput, name })
	const id = randomUUID()
	return db.schedules.createRun({
		...runInput(schedule, `recover-${id}`),
		...runtime,
		id,
		sessionId: scheduledSessionId(id),
		state,
	})
}

test('startup restoration fails closed when capacity-one reservation cannot be restored', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	const socketRoot = mkdtempSync('/tmp/helm-sched-test-')
	const previousSocketRoot = process.env.HELM_SCHEDULED_SOCKET_DIR
	process.env.HELM_SCHEDULED_SOCKET_DIR = socketRoot
	let server: net.Server | undefined
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const run = createRecoverableRun(db, commands, 'Live restore', 'running')
		server = await listenSocket(scheduledSocketPath('work', run.sessionId))
		const drainer = fakeDrainer()
		assert.equal(drainer.reserveExternalSolve('item-already-admitted'), true)
		const service = new ScheduledRunService(config, db, drainer as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => true,
		})
		await assert.rejects(service.start(), /could not reserve solve capacity/)
		assert.equal(drainer.reservations.has(run.id), false)
		assert.deepEqual(await service.tick(), { processed: 0, admitted: 0, skipped: 0 })
		await assert.rejects(service.runNow('work', run.scheduleId), /requires a live resident lease/)
	} finally {
		await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
		if (previousSocketRoot === undefined) process.env.HELM_SCHEDULED_SOCKET_DIR = undefined
		else process.env.HELM_SCHEDULED_SOCKET_DIR = previousSocketRoot
		rmSync(socketRoot, { recursive: true, force: true })
		rmSync(root, { recursive: true, force: true })
	}
})

test('concurrent scheduled starts share one restoration pass', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	const socketRoot = mkdtempSync('/tmp/helm-sched-test-')
	const previousSocketRoot = process.env.HELM_SCHEDULED_SOCKET_DIR
	process.env.HELM_SCHEDULED_SOCKET_DIR = socketRoot
	let server: net.Server | undefined
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const run = createRecoverableRun(db, commands, 'Live restore', 'running')
		server = await listenSocket(scheduledSocketPath('work', run.sessionId))
		const drainer = fakeDrainer()
		const service = new ScheduledRunService(config, db, drainer as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => false,
		})
		await Promise.all([service.start(), service.start()])
		assert.equal(drainer.reserveCalls, 1)
		assert.deepEqual([...drainer.reservations], [run.id])
		await service.stop()
	} finally {
		await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
		if (previousSocketRoot === undefined) process.env.HELM_SCHEDULED_SOCKET_DIR = undefined
		else process.env.HELM_SCHEDULED_SOCKET_DIR = previousSocketRoot
		rmSync(socketRoot, { recursive: true, force: true })
		rmSync(root, { recursive: true, force: true })
	}
})

test('startup restoration clears a failed reservation when that run closes during reconciliation', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	const socketRoot = mkdtempSync('/tmp/helm-sched-test-')
	const previousSocketRoot = process.env.HELM_SCHEDULED_SOCKET_DIR
	process.env.HELM_SCHEDULED_SOCKET_DIR = socketRoot
	let server: net.Server | undefined
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const run = createRecoverableRun(db, commands, 'Closing restore', 'reported_quiet', {
			processFingerprint: JSON.stringify({ pid: 1, processGroupId: 1, sessionId: 1 }),
			runDir: root,
		})
		server = await listenSocket(scheduledSocketPath('work', run.sessionId))
		const drainer = fakeDrainer()
		assert.equal(drainer.reserveExternalSolve('item-already-admitted'), true)
		const service = new ScheduledRunService(config, db, drainer as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => false,
			supervisor: { teardown: async () => 'closed' } as unknown as ScheduledRunServiceDeps['supervisor'],
		})
		await service.start()
		assert.equal(db.schedules.requireRun(run.id).state, 'closed_quiet')
		assert.equal(drainer.reservations.has(run.id), false)
		await service.stop()
	} finally {
		await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
		if (previousSocketRoot === undefined) process.env.HELM_SCHEDULED_SOCKET_DIR = undefined
		else process.env.HELM_SCHEDULED_SOCKET_DIR = previousSocketRoot
		rmSync(socketRoot, { recursive: true, force: true })
		rmSync(root, { recursive: true, force: true })
	}
})

test('startup restoration pages past 500 recoverable rows to reserve the 501st live run', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	const socketRoot = mkdtempSync('/tmp/helm-sched-test-')
	const previousSocketRoot = process.env.HELM_SCHEDULED_SOCKET_DIR
	process.env.HELM_SCHEDULED_SOCKET_DIR = socketRoot
	let server: net.Server | undefined
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		for (let index = 0; index < 500; index++)
			createRecoverableRun(db, commands, `Attention ${index}`, 'needs_attention')
		const live = createRecoverableRun(db, commands, '501st live restore', 'running')
		server = await listenSocket(scheduledSocketPath('work', live.sessionId))
		const drainer = fakeDrainer()
		const service = new ScheduledRunService(config, db, drainer as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => false,
		})
		await service.start()
		assert.deepEqual([...drainer.reservations], [live.id])
		await service.stop()
	} finally {
		await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
		if (previousSocketRoot === undefined) process.env.HELM_SCHEDULED_SOCKET_DIR = undefined
		else process.env.HELM_SCHEDULED_SOCKET_DIR = previousSocketRoot
		rmSync(socketRoot, { recursive: true, force: true })
		rmSync(root, { recursive: true, force: true })
	}
})

test('quiet report wins over a later cancel while teardown is pending', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		let running = createRunningRun(db, commands, 'Quiet wins')
		running = commands.recordRuntime(running.id, running.revision, {
			processFingerprint: JSON.stringify({ pid: 1, processGroupId: 1, sessionId: 1 }),
			cwd: root,
			worktreePath: null,
			branchName: null,
			runDir: root,
			socketDescriptor: null,
		})
		const teardown = deferred<'closed'>()
		let teardownCalls = 0
		const service = new ScheduledRunService(config, db, fakeDrainer() as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => true,
			supervisor: {
				teardown: async () => {
					teardownCalls++
					return teardown.promise
				},
			} as unknown as ScheduledRunServiceDeps['supervisor'],
		})

		const quiet = service.report('work', running.id, 'quiet', 'done')
		assert.equal(db.schedules.requireRun(running.id).state, 'closing')
		assert.equal(teardownCalls, 1)
		await assert.rejects(service.cancel('work', running.id), /conflicting terminal intent/)
		teardown.resolve('closed')
		assert.equal((await quiet).state, 'closed_quiet')
		assert.equal(teardownCalls, 1)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('concurrent identical quiet reports share one per-run teardown', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		let running = createRunningRun(db, commands, 'Duplicate quiet')
		running = commands.recordRuntime(running.id, running.revision, {
			processFingerprint: JSON.stringify({ pid: 1, processGroupId: 1, sessionId: 1 }),
			cwd: root,
			worktreePath: null,
			branchName: null,
			runDir: root,
			socketDescriptor: null,
		})
		const teardown = deferred<'closed'>()
		let teardownCalls = 0
		const service = new ScheduledRunService(config, db, fakeDrainer() as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => true,
			supervisor: {
				teardown: async () => {
					teardownCalls++
					return teardown.promise
				},
			} as unknown as ScheduledRunServiceDeps['supervisor'],
		})

		const first = service.report('work', running.id, 'quiet', 'done')
		const second = service.report('work', running.id, 'quiet', 'done')
		assert.equal(teardownCalls, 1)
		teardown.resolve('closed')
		const [firstResult, secondResult] = await Promise.all([first, second])
		assert.equal(firstResult.state, 'closed_quiet')
		assert.equal(secondResult.state, 'closed_quiet')
		assert.equal(teardownCalls, 1)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('stop closes reconciliation admission before awaiting its current pass', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	const socketRoot = mkdtempSync('/tmp/helm-sched-test-')
	const previousSocketRoot = process.env.HELM_SCHEDULED_SOCKET_DIR
	process.env.HELM_SCHEDULED_SOCKET_DIR = socketRoot
	let server: net.Server | undefined
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const run = createRecoverableRun(db, commands, 'Stop reconciliation', 'reported_quiet', {
			processFingerprint: JSON.stringify({ pid: 1, processGroupId: 1, sessionId: 1 }),
			runDir: root,
		})
		server = await listenSocket(scheduledSocketPath('work', run.sessionId))
		const teardownStarted = deferred<void>()
		const teardown = deferred<'closed'>()
		let profileReads = 0
		const service = new ScheduledRunService(config, db, fakeDrainer() as unknown as Drainer, {
			profiles: () => {
				profileReads++
				return [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime]
			},
			hasResidentLease: () => false,
			supervisor: {
				teardown: async () => {
					teardownStarted.resolve()
					return teardown.promise
				},
			} as unknown as ScheduledRunServiceDeps['supervisor'],
		})

		const reconciling = service.reconcile()
		await teardownStarted.promise
		const stopping = service.stop()
		await service.reconcile()
		assert.equal(profileReads, 1)
		teardown.resolve('closed')
		await Promise.all([reconciling, stopping])
		await service.reconcile()
		assert.equal(profileReads, 1)
	} finally {
		await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
		if (previousSocketRoot === undefined) process.env.HELM_SCHEDULED_SOCKET_DIR = undefined
		else process.env.HELM_SCHEDULED_SOCKET_DIR = previousSocketRoot
		rmSync(socketRoot, { recursive: true, force: true })
		rmSync(root, { recursive: true, force: true })
	}
})

test('timeout is durable first-writer state and identical quiet retries converge after closure', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const schedule = commands.create(scheduleInput)
		const admitted = commands.claimOccurrence(schedule.id, schedule.revision, null, runInput(schedule, 'timeout'))
		let running = commands.markRunning(
			commands.beginLaunching(commands.beginPreparing(admitted.id, admitted.revision).id, admitted.revision + 1).id,
			admitted.revision + 2,
		)
		const requested = commands.requestTimeout(running.id, running.revision)
		assert.equal(requested.state, 'timeout_requested')
		assert.throws(() => commands.report(requested.id, requested.revision, 'quiet', 'done'), /Only a running/)
		assert.throws(() => commands.requestCancel(requested.id, requested.revision), /conflicting terminal intent/)
		assert.equal(commands.markTimedOut(requested.id, requested.revision).state, 'timed_out')

		const quietSchedule = commands.create({ ...scheduleInput, name: 'Quiet retry' })
		const quietAdmitted = commands.claimOccurrence(
			quietSchedule.id,
			quietSchedule.revision,
			null,
			runInput(quietSchedule, 'quiet'),
		)
		running = commands.markRunning(
			commands.beginLaunching(
				commands.beginPreparing(quietAdmitted.id, quietAdmitted.revision).id,
				quietAdmitted.revision + 1,
			).id,
			quietAdmitted.revision + 2,
		)
		running = commands.recordRuntime(running.id, running.revision, {
			processFingerprint: JSON.stringify({ pid: 1, processGroupId: 1, sessionId: 1 }),
			cwd: root,
			worktreePath: null,
			branchName: null,
			runDir: root,
			socketDescriptor: null,
		})
		const drainer = fakeDrainer()
		const service = new ScheduledRunService(config, db, drainer as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => true,
			supervisor: { teardown: async () => 'closed' } as unknown as ScheduledRunServiceDeps['supervisor'],
		})
		const closed = await service.report('work', running.id, 'quiet', 'done')
		assert.equal(closed.state, 'closed_quiet')
		assert.equal((await service.report('work', running.id, 'quiet', 'done')).state, 'closed_quiet')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('reconciliation resolves quarantined quiet, cancel, and timeout by their durable intent after a crash', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const toQuarantined = (intent: 'quiet' | 'cancel' | 'timeout') => {
			let run = createRecoverableRun(db, commands, `Crash ${intent}`, 'running')
			if (intent === 'quiet') {
				run = commands.report(run.id, run.revision, 'quiet', 'done')
				run = commands.beginClose(run.id, run.revision)
			} else if (intent === 'cancel') run = commands.requestCancel(run.id, run.revision)
			else run = commands.requestTimeout(run.id, run.revision)
			return commands.markQuarantined(run.id, run.revision, 'ownership unknown before teardown')
		}
		const quiet = toQuarantined('quiet')
		const cancelled = toQuarantined('cancel')
		const timedOut = toQuarantined('timeout')
		const drainer = fakeDrainer()
		const service = new ScheduledRunService(config, db, drainer as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => false,
		})
		await service.start()
		for (const [run, expected] of [
			[quiet, 'closed_quiet'],
			[cancelled, 'cancelled'],
			[timedOut, 'timed_out'],
		] as const) {
			const resolved = db.schedules.requireRun(run.id)
			assert.equal(resolved.state, expected)
			assert.equal(resolved.pendingTerminalIntent, null)
		}
		assert.equal(drainer.releaseCalls, 3)
		await service.stop()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('startup materializes legacy request-state intent and resolves a partial quiet claim exactly', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const legacyQuietRunning = createRecoverableRun(db, commands, 'Legacy quiet', 'running')
		const legacyQuiet = db.schedules.transitionRun(
			legacyQuietRunning.id,
			legacyQuietRunning.revision,
			'reported_quiet',
			{
				reportedAt: new Date().toISOString(),
				reportKind: 'quiet',
				reportSummary: 'done before migration',
			},
		)
		const legacyCancelRunning = createRecoverableRun(db, commands, 'Legacy cancel', 'running')
		const legacyCancel = db.schedules.transitionRun(
			legacyCancelRunning.id,
			legacyCancelRunning.revision,
			'cancel_requested',
		)
		const legacyTimeoutRunning = createRecoverableRun(db, commands, 'Legacy timeout', 'running')
		const legacyTimeout = db.schedules.transitionRun(
			legacyTimeoutRunning.id,
			legacyTimeoutRunning.revision,
			'timeout_requested',
		)
		const partialQuietRunning = createRecoverableRun(db, commands, 'Partial quiet', 'running')
		const partialQuiet = db.schedules.claimPendingTerminalIntent(
			partialQuietRunning.id,
			partialQuietRunning.revision,
			'quiet',
		)
		const drainer = fakeDrainer()
		const service = new ScheduledRunService(config, db, drainer as unknown as Drainer, {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => false,
		})

		await service.start()

		for (const [run, expected] of [
			[legacyQuiet, 'closed_quiet'],
			[legacyCancel, 'cancelled'],
			[legacyTimeout, 'timed_out'],
			[partialQuiet, 'closed_quiet'],
		] as const) {
			const resolved = db.schedules.requireRun(run.id)
			assert.equal(resolved.state, expected)
			assert.equal(resolved.pendingTerminalIntent, null)
		}
		assert.equal(drainer.releaseCalls, 4)
		await service.stop()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('startup tick durably disables a persisted due system schedule after system targets are turned off', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-service-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const systemDefinition = {
			...definition,
			target: { kind: 'system' as const, riskAcknowledgement: 'broad-host-access' as const },
		}
		const commandsWhenEnabled = new ScheduleCommands(db.schedules, true)
		const created = commandsWhenEnabled.create({ ...scheduleInput, definition: systemDefinition })
		const due = db.schedules.advanceNextRun(created.id, created.revision, '2000-01-01T00:00:00.000Z')
		const drainer = fakeDrainer()
		const service = new ScheduledRunService(
			{
				...config,
				scheduledRuns: { enabled: true, systemTargetsEnabled: false },
			} as HelmConfig,
			db,
			drainer as unknown as Drainer,
			{
				profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
				hasResidentLease: () => true,
			},
		)

		await service.start()
		assert.deepEqual(await service.tick(), { processed: 1, admitted: 0, skipped: 1 })
		const schedule = db.schedules.require(due.id)
		const [run] = db.schedules.listRuns(schedule.id)
		assert.equal(schedule.enabled, false)
		assert.equal(schedule.disabledReason, 'system_targets_disabled')
		assert.notEqual(schedule.nextRunAt, '2000-01-01T00:00:00.000Z')
		assert.equal(run.state, 'skipped_system_targets_disabled')
		assert.ok(run.closedAt)
		assert.equal(drainer.reservations.size, 0)
		assert.deepEqual(await service.tick(), { processed: 0, admitted: 0, skipped: 0 })
		await service.stop()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
