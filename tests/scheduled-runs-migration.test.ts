import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DB } from '../src/db/client.js'
import { ScheduleCommands } from '../src/scheduled-runs/commands.js'

test('scheduled migrations create profile-owned tables, active timeout uniqueness, and nullable adoption state', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-migration-'))
	try {
		const path = join(root, 'helm.db')
		const db = new DB(path, 'alpha')
		db.close()
		const raw = new Database(path)
		assert.equal(
			(raw.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
			30,
		)
		for (const table of ['scheduled_schedules', 'scheduled_runs']) {
			assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
		}
		const activeIndex = raw
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_scheduled_runs_one_active'")
			.get() as { sql: string }
		assert.match(activeIndex.sql, /timeout_requested/)
		const columns = raw.prepare("PRAGMA table_info('scheduled_runs')").all() as Array<{ name: string; notnull: number }>
		assert.equal(columns.find(row => row.name === 'pending_terminal_intent')?.notnull, 0)
		assert.equal(columns.find(row => row.name === 'attention_adoption')?.notnull, 0)
		raw.close()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('migration 30 preserves populated v29 runs with null adoption state', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-migration-'))
	const path = join(root, 'helm.db')
	try {
		const db = new DB(path, 'alpha')
		const commands = new ScheduleCommands(db.schedules)
		const schedule = commands.create({
			name: 'Existing schedule',
			enabled: true,
			cron: '0 1 * * *',
			cadenceKind: 'daily',
			timezone: 'UTC',
			definition: {
				prompt: 'Review the repository.',
				target: { kind: 'project', projectSlug: 'helm' },
				agent: 'claude',
				maximumRuntimeMinutes: 120,
			},
		})
		const run = commands.claimOccurrence(schedule.id, schedule.revision, null, {
			scheduleId: schedule.id,
			scheduleRevision: schedule.revision,
			scheduledFor: '2030-01-01T01:00:00.000Z',
			localCivilSlot: '2030-01-01 01:00',
			utcOffsetMinutes: 0,
			slotKey: 'existing-v29',
			definitionSnapshot: schedule.definition,
			sessionId: 'sr-existing-v29',
		})
		db.close()

		const v29 = new Database(path)
		v29.exec('ALTER TABLE scheduled_runs DROP COLUMN attention_adoption')
		v29.prepare('DELETE FROM schema_version WHERE version = 30').run()
		v29.close()

		const migrated = new DB(path, 'alpha')
		const preserved = migrated.schedules.requireRun(run.id)
		assert.equal(preserved.state, 'admitted')
		assert.equal(preserved.attentionAdoption, null)
		migrated.close()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
