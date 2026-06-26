import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { ItemStore } from '../items/store.js'
import type { PollState } from '../types.js'
import { MIGRATIONS } from './schema.js'

export class DB {
	private db: Database.Database
	readonly items: ItemStore

	constructor(dbPath?: string) {
		const path = dbPath ?? resolve(process.cwd(), 'vigil.db')
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

	close(): void {
		this.db.close()
	}
}
