import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { migrateConnection } from '../src/db/client.js'
import { MIGRATIONS } from '../src/db/schema.js'

function seedBefore(db: Database.Database, version: number): void {
	for (const migration of MIGRATIONS) {
		if (migration.version >= version) break
		// Historical fixture setup only; production upgrades use migrateConnection.
		db.exec(migration.sql)
		db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
	}
	db.pragma('foreign_keys = ON')
	db.exec(`
		INSERT INTO items (id, profile_id, kind, status, project_slug, title, base_ref, payload, created_at, updated_at)
		VALUES ('item', 'work', 'solve', 'ready', 'project', 'Retained title', 'main', '{}', '2026-01-01', '2026-01-01');
		INSERT INTO item_events (profile_id, item_id, event_type, payload, created_at)
		VALUES ('work', 'item', 'item_created', '{"retained":true}', '2026-01-01');
	`)
	if (version === 34) {
		db.exec(`
			INSERT INTO item_knowledge_snapshots
			(id, profile_id, item_id, project_slug, purpose, sequence, query, context, manifest, created_at)
			VALUES ('snapshot', 'work', 'item', 'project', 'solve', 1, 'query', 'Exact evidence', '[]', '2026-01-01');
			INSERT INTO knowledge_candidate_outbox
			(id, profile_id, item_id, project_slug, snapshot_id, idempotency_key, candidates, state, created_at, updated_at)
			VALUES ('pending', 'work', 'item', 'project', 'snapshot', 'key-pending', '[{"title":"Keep me"}]', 'pending', '2026-01-01', '2026-01-01');
			INSERT INTO knowledge_candidate_outbox
			(id, profile_id, item_id, project_slug, snapshot_id, idempotency_key, candidates, state, receipt, created_at, updated_at)
			VALUES ('delivered', 'work', 'item', 'project', 'snapshot', 'key-delivered', '[]', 'delivered', 'saved-receipt', '2026-01-01', '2026-01-01');
		`)
	}
}

function snapshot(db: Database.Database): unknown {
	const hasKnowledge = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'item_knowledge_snapshots'").get()
	return {
		schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
		items: db.prepare('SELECT * FROM items ORDER BY rowid').all(),
		events: db.prepare('SELECT * FROM item_events ORDER BY rowid').all(),
		versions: db.prepare('SELECT * FROM schema_version ORDER BY version').all(),
		sequences: db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
		snapshots: hasKnowledge ? db.prepare('SELECT * FROM item_knowledge_snapshots ORDER BY rowid').all() : [],
		outbox: hasKnowledge ? db.prepare('SELECT * FROM knowledge_candidate_outbox ORDER BY rowid').all() : [],
	}
}

for (const version of [31, 34]) {
	for (const failure of ['sql', 'version'] as const) {
		test(`migration ${version} rolls back ${failure} failure and retries after reopening`, t => {
			const root = mkdtempSync(join(tmpdir(), 'helm-migration-'))
			const path = join(root, 'helm.db')
			let db = new Database(path)
			try {
				seedBefore(db, version)
				if (failure === 'version') {
					db.exec(
						version === 31
							? "CREATE TRIGGER refuse_version BEFORE INSERT ON schema_version WHEN NEW.version = 31 BEGIN SELECT RAISE(ABORT, 'injected marker failure'); END;"
							: "CREATE TRIGGER refuse_version BEFORE INSERT ON schema_version WHEN NEW.version = 34 BEGIN SELECT RAISE(ABORT, 'injected marker failure'); END;",
					)
				}
				const before = snapshot(db)
				const item = db.prepare('SELECT * FROM items').get() as Record<string, unknown>
				const events = db.prepare('SELECT * FROM item_events').all()
				const migration = MIGRATIONS.find(entry => entry.version === version)
				assert.ok(migration)
				const exec = db.exec.bind(db)
				const mocked = t.mock.method(db, 'exec', (sql: string) => {
					if (failure === 'sql' && sql === migration.sql) {
						const partial = version === 31 ? sql.split('DROP TABLE items;')[0] : sql.split(';')[0]
						return exec(`${partial}; SELECT * FROM injected_missing_table;`)
					}
					return exec(sql)
				})
				assert.throws(() => migrateConnection(db), /injected/)
				assert.equal(db.inTransaction, false)
				assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
				assert.deepEqual(snapshot(db), before)
				mocked.mock.restore()
				db.close()
				db = new Database(path)
				db.pragma('foreign_keys = ON')
				assert.deepEqual(snapshot(db), before)
				if (failure === 'version') db.exec('DROP TRIGGER refuse_version')
				migrateConnection(db)
				assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
				assert.deepEqual(db.pragma('foreign_key_check'), [])
				assert.deepEqual(db.prepare('SELECT * FROM items').get(), { ...item, knowledge_snapshot_id: null })
				assert.deepEqual(db.prepare('SELECT * FROM item_events').all(), events)
				assert.throws(() => db.prepare("UPDATE item_events SET item_id = 'missing'").run(), /FOREIGN KEY/)
				assert.equal(
					(db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v,
					MIGRATIONS.at(-1)?.version,
				)
				if (version === 34) {
					assert.deepEqual(db.prepare('SELECT context, provider_id FROM item_knowledge_snapshots').get(), {
						context: 'Exact evidence',
						provider_id: null,
					})
					assert.deepEqual(
						db
							.prepare(
								'SELECT id, state, candidates, receipt, last_error_code FROM knowledge_candidate_outbox ORDER BY id',
							)
							.all(),
						[
							{
								id: 'delivered',
								state: 'delivered',
								candidates: '[]',
								receipt: '{"legacyReceipt":"saved-receipt"}',
								last_error_code: null,
							},
							{
								id: 'pending',
								state: 'blocked',
								candidates: '[{"title":"Keep me"}]',
								receipt: null,
								last_error_code: 'legacy-target-unbound',
							},
						],
					)
					assert.throws(
						() => db.prepare("UPDATE knowledge_candidate_outbox SET snapshot_id = 'missing'").run(),
						/FOREIGN KEY/,
					)
				}
				const migrated = snapshot(db)
				migrateConnection(db)
				assert.deepEqual(snapshot(db), migrated)
			} finally {
				if (db.open) db.close()
				rmSync(root, { recursive: true, force: true })
			}
		})
	}
}

test('migration 31 refuses invalid foreign keys before publishing its version', t => {
	const db = new Database(':memory:')
	try {
		seedBefore(db, 31)
		const before = snapshot(db)
		const migration = MIGRATIONS.find(entry => entry.version === 31)
		assert.ok(migration)
		const exec = db.exec.bind(db)
		t.mock.method(db, 'exec', (sql: string) => {
			exec(sql)
			if (sql === migration.sql) exec("UPDATE item_events SET item_id = 'missing'")
			return db
		})
		assert.throws(() => migrateConnection(db), /Migration 31 foreign-key validation failed/)
		assert.equal(db.inTransaction, false)
		assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
		assert.deepEqual(snapshot(db), before)
	} finally {
		db.close()
	}
})

test('migration runner refuses an enclosing transaction without changing foreign keys', () => {
	const db = new Database(':memory:')
	try {
		seedBefore(db, 31)
		const before = snapshot(db)
		db.transaction(() => {
			assert.throws(() => migrateConnection(db), /idle SQLite connection/)
			assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
			assert.deepEqual(snapshot(db), before)
		})()
	} finally {
		db.close()
	}
})
