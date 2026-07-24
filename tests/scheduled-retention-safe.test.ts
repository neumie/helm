import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import type { ProfileRuntime } from '../src/profiles/store.js'
import type { Drainer } from '../src/queue/drainer.js'
import { ScheduleCommands } from '../src/scheduled-runs/commands.js'
import {
	defaultScheduledWorkspaceCleaner,
	isScheduledRunTerminalState,
	terminalRunsToPrune,
} from '../src/scheduled-runs/retention.js'
import type { ScheduledRunRecord, ScheduledRunState } from '../src/scheduled-runs/schema.js'
import { ScheduledRunService } from '../src/scheduled-runs/service.js'
import type { ScheduleStore } from '../src/scheduled-runs/store.js'

const definition = {
	prompt: 'Review the repository.',
	target: { kind: 'project' as const, projectSlug: 'helm' },
	agent: 'claude' as const,
	maximumRuntimeMinutes: 120,
}
const config = {
	scheduledRuns: { enabled: true },
	server: { host: '127.0.0.1', port: 7474 },
	solver: { agent: 'claude' },
} as unknown as HelmConfig
const oldClosedAt = '2020-01-01T00:00:00.000Z'

function fakeRun(
	id: string,
	state: ScheduledRunState,
	scheduleId = 'schedule',
	closedAt = oldClosedAt,
): ScheduledRunRecord {
	return { id, state, scheduleId, closedAt } as ScheduledRunRecord
}

function fakeStore(runs: ScheduledRunRecord[]): ScheduleStore {
	return { listTerminalRuns: () => runs } as unknown as ScheduleStore
}

function createTerminalRun(db: DB, index: number, runDir: string | null = null) {
	const commands = new ScheduleCommands(db.schedules)
	const schedule = commands.create({
		name: `Retention ${index}`,
		enabled: true,
		cron: '0 1 * * *',
		cadenceKind: 'daily',
		timezone: 'UTC',
		definition,
	})
	return db.schedules.createRun({
		id: `retention-${index}`,
		scheduleId: schedule.id,
		scheduleRevision: schedule.revision,
		scheduledFor: oldClosedAt,
		localCivilSlot: '2020-01-01 00:00',
		utcOffsetMinutes: 0,
		slotKey: `retention-${index}`,
		definitionSnapshot: definition,
		state: 'failed',
		sessionId: `sr-retention-${index}`,
		closedAt: oldClosedAt,
		runDir,
	})
}

function fakeDrainer(): Drainer {
	return {
		reserveExternalSolve: () => true,
		releaseExternalSolve: () => true,
	} as unknown as Drainer
}

test('terminal predicate excludes every recoverable state and includes every terminal state', () => {
	const recoverable: ScheduledRunState[] = [
		'admitted',
		'preparing',
		'launching',
		'running',
		'reported_quiet',
		'closing',
		'needs_attention',
		'cancel_requested',
		'timeout_requested',
		'quarantined',
	]
	const terminal: ScheduledRunState[] = [
		'closed_quiet',
		'cancelled',
		'timed_out',
		'failed',
		'interrupted',
		'session_lost',
		'skipped_overlap',
		'skipped_misfire',
		'skipped_profile_archived',
		'skipped_project_disabled',
		'skipped_capacity',
	]
	for (const state of recoverable) assert.equal(isScheduledRunTerminalState(state), false, state)
	for (const state of terminal) assert.equal(isScheduledRunTerminalState(state), true, state)
})

test('retention re-filters store output and enforces schedule and profile bounds', () => {
	const recoverable = fakeRun('timeout', 'timeout_requested')
	const perSchedule = Array.from({ length: 201 }, (_, index) =>
		fakeRun(`per-${index}`, 'failed', 'one-schedule', new Date(Date.UTC(2035, 0, 1, 0, 0, index)).toISOString()),
	)
	assert.deepEqual(
		terminalRunsToPrune(fakeStore([recoverable, ...perSchedule]), new Date('2035-01-02T00:00:00.000Z')).map(
			item => item.id,
		),
		['per-0'],
	)
	const perProfile = Array.from({ length: 2_001 }, (_, index) =>
		fakeRun(
			`profile-${index}`,
			'failed',
			`schedule-${index}`,
			new Date(Date.UTC(2035, 0, 1, 0, 0, index)).toISOString(),
		),
	)
	assert.deepEqual(
		terminalRunsToPrune(fakeStore(perProfile), new Date('2035-01-02T00:00:00.000Z')).map(item => item.id),
		['profile-0'],
	)
})

test('the default workspace cleaner is inert', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-retention-'))
	const runDir = join(root, 'scheduled-runs', 'run')
	try {
		mkdirSync(runDir, { recursive: true })
		writeFileSync(join(runDir, 'marker'), 'preserved')
		assert.deepEqual(
			await defaultScheduledWorkspaceCleaner.cleanup({
				profileId: 'work',
				profileRoot: root,
				runId: 'run',
				expectedRunDir: runDir,
				closedAt: oldClosedAt,
			}),
			{ status: 'retained', reason: 'disabled' },
		)
		assert.equal(await readFile(join(runDir, 'marker'), 'utf8'), 'preserved')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('service prunes terminal metadata even when the default cleaner retains its workspace', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-retention-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const runDir = join(root, 'scheduled-runs', 'retained')
		mkdirSync(runDir, { recursive: true })
		const terminal = createTerminalRun(db, 1, runDir)
		const service = new ScheduledRunService(config, db, fakeDrainer(), {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => false,
		})
		await service.reconcile()
		assert.equal(db.schedules.getRun(terminal.id), null)
		assert.equal((await stat(runDir)).isDirectory(), true)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('service retention work is capped at fifty terminal rows per profile', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-retention-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		for (let index = 0; index < 51; index++) createTerminalRun(db, index)
		const service = new ScheduledRunService(config, db, fakeDrainer(), {
			profiles: () => [{ profile: { id: 'work', archivedAt: null }, rootDir: root } as unknown as ProfileRuntime],
			hasResidentLease: () => false,
		})
		await service.reconcile()
		assert.equal(db.schedules.listTerminalRuns(100).length, 1)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('store does not return timeout-requested runs as terminal history', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-retention-'))
	try {
		const db = new DB(join(root, 'helm.db'), 'work')
		const commands = new ScheduleCommands(db.schedules)
		const schedule = commands.create({
			name: 'Timeout request',
			enabled: true,
			cron: '0 1 * * *',
			cadenceKind: 'daily',
			timezone: 'UTC',
			definition,
		})
		db.schedules.createRun({
			id: 'timeout-requested',
			scheduleId: schedule.id,
			scheduleRevision: schedule.revision,
			scheduledFor: oldClosedAt,
			localCivilSlot: '2020-01-01 00:00',
			utcOffsetMinutes: 0,
			slotKey: 'timeout-requested',
			definitionSnapshot: definition,
			state: 'timeout_requested',
			sessionId: 'sr-timeout-requested',
			closedAt: oldClosedAt,
		})
		assert.deepEqual(db.schedules.listTerminalRuns(), [])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
