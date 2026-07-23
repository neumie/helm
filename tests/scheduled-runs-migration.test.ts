import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DB } from '../src/db/client.js'

test('scheduled migrations create profile-owned tables and include timeout in durable active uniqueness', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-migration-'))
	try {
		const path = join(root, 'helm.db')
		const db = new DB(path, 'alpha')
		db.close()
		const raw = new Database(path)
		assert.equal(
			(raw.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
			28,
		)
		for (const table of ['scheduled_schedules', 'scheduled_runs']) {
			assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
		}
		const activeIndex = raw
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_scheduled_runs_one_active'")
			.get() as { sql: string }
		assert.match(activeIndex.sql, /timeout_requested/)
		raw.close()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
