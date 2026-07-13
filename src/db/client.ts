import { existsSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { ItemStore } from '../items/store.js'
import type { PollState } from '../types.js'
import { MIGRATIONS } from './schema.js'

/**
 * One-way identity migration: helm.db is the DB name, but an existing install
 * has vigil.db (legacy name). If helm.db is missing and vigil.db exists next to
 * it (the daemon cwd), rename the file (plus -wal/-shm siblings) BEFORE opening
 * so existing state keeps working under the new name. When BOTH files exist,
 * nothing is migrated — that needs a human decision, so warn loudly instead of
 * silently leaving a stale vigil.db behind.
 *
 * Exported for tests (runs against any dir, opens no DB).
 */
export function migrateLegacyDbFile(helmPath: string): void {
	const legacyPath = join(dirname(helmPath), 'vigil.db')
	if (!existsSync(legacyPath)) return
	if (existsSync(helmPath)) {
		console.warn(
			`[helm] Legacy ${legacyPath} present but ${helmPath} already exists — not migrating; delete or merge the legacy vigil.db manually.`,
		)
		return
	}
	console.warn(`[helm] Renaming legacy DB ${legacyPath} -> ${helmPath}`)
	renameSync(legacyPath, helmPath)
	for (const suffix of ['-wal', '-shm']) {
		if (existsSync(`${legacyPath}${suffix}`)) renameSync(`${legacyPath}${suffix}`, `${helmPath}${suffix}`)
	}
}

export class DB {
	private db: Database.Database
	readonly items: ItemStore

	constructor(dbPath?: string) {
		const path = dbPath ?? resolve(process.cwd(), 'helm.db')
		if (!dbPath) migrateLegacyDbFile(path)
		this.db = new Database(path)
		this.db.pragma('journal_mode = WAL')
		this.db.pragma('foreign_keys = ON')
		this.migrate()
		this.items = new ItemStore(this.db)
	}

	private migrate() {
		const currentVersion = this.getCurrentVersion()
		for (const migration of MIGRATIONS) {
			if (migration.version > currentVersion) {
				this.db.exec(migration.sql)
				this.db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(migration.version)
			}
		}
	}

	private getCurrentVersion(): number {
		try {
			const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number } | undefined
			return row?.v ?? 0
		} catch {
			return 0
		}
	}

	// Poll state — the provider watermark used by the Poller.
	getPollState(projectSlug: string): PollState | null {
		const row = this.db.prepare('SELECT * FROM poll_state WHERE project_slug = ?').get(projectSlug) as
			| Record<string, unknown>
			| undefined
		if (!row) return null
		return {
			projectSlug: row.project_slug as string,
			lastPollAt: row.last_poll_at as string,
			lastTaskSeen: (row.last_task_seen as string) ?? null,
		}
	}

	updatePollState(projectSlug: string, lastPollAt: string, lastTaskSeen: string | null): void {
		this.db
			.prepare('INSERT OR REPLACE INTO poll_state (project_slug, last_poll_at, last_task_seen) VALUES (?, ?, ?)')
			.run(projectSlug, lastPollAt, lastTaskSeen)
	}

	// Daemon key/value state that survives restarts (e.g. Drainer paused flag).
	getAppState(key: string): string | null {
		const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined
		return row?.value ?? null
	}

	setAppState(key: string, value: string): void {
		this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run(key, value)
	}

	close(): void {
		this.db.close()
	}
}
