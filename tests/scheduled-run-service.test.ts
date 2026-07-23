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

function fakeDrainer() {
	const reservations = new Set<string>()
	let reserveCalls = 0
	return {
		reservations,
		get reserveCalls() {
			return reserveCalls
		},
		reserveExternalSolve(id: string) {
			reserveCalls++
			if (reservations.has(id)) return true
			if (reservations.size >= 1) return false
			reservations.add(id)
			return true
		},
		releaseExternalSolve(id: string) {
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

function createRecoverableRun(
	db: DB,
	commands: ScheduleCommands,
	name: string,
	state: 'needs_attention' | 'reported_quiet' | 'running',
	runtime: Partial<ReturnType<typeof runInput>> = {},
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
		assert.throws(() => commands.requestCancel(requested.id, requested.revision), /active/)
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
