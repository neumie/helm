import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { ItemStore } from '../items/store.js'
import type { PollState } from '../types.js'
import { MIGRATIONS } from './schema.js'

/**
 * One-way identity migration retained for pre-profile installations. New
 * profile-aware startup calls this before importing legacy profile databases.
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

function currentVersion(db: Database.Database): number {
	try {
		const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number } | undefined
		return row?.v ?? 0
	} catch {
		return 0
	}
}

function migrateConnection(db: Database.Database): void {
	const version = currentVersion(db)
	for (const migration of MIGRATIONS) {
		if (migration.version <= version) continue
		db.exec(migration.sql)
		db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(migration.version)
	}
}

export interface LegacyProfileDatabase {
	profileId: string
	dbPath: string
}

/**
 * Merge the closed per-profile databases used by protocol 31 into one shared
 * root database. Sources stay untouched as rollback backups. The target is
 * built and validated under a temporary name, then atomically installed.
 */
export function migrateProfileDatabasesToShared(
	sharedPath: string,
	profiles: readonly LegacyProfileDatabase[],
	activeProfileId: string,
): void {
	if (existsSync(sharedPath)) return
	const sources = profiles.filter(profile => existsSync(profile.dbPath))
	if (sources.length === 0) return
	mkdirSync(dirname(sharedPath), { recursive: true })
	const temporaryPath = `${sharedPath}.${process.pid}.profiles-migration`
	rmSync(temporaryPath, { force: true })
	const target = new Database(temporaryPath)
	try {
		target.pragma('journal_mode = WAL')
		target.pragma('foreign_keys = ON')
		migrateConnection(target)
		for (const [index, source] of sources.entries()) {
			const alias = `legacy_${index}`
			target.prepare(`ATTACH DATABASE ? AS ${alias}`).run(source.dbPath)
			try {
				const versionRow = target.prepare(`SELECT MAX(version) AS v FROM ${alias}.schema_version`).get() as
					| { v: number }
					| undefined
				if ((versionRow?.v ?? 0) < 25) {
					throw new Error(`Profile ${source.profileId} database is too old to import safely`)
				}
				const importProfile = target.transaction(() => {
					const itemColumns = (target.prepare(`PRAGMA ${alias}.table_info(items)`).all() as { name: string }[])
						.map(column => column.name)
						.filter(name => name !== 'profile_id')
					const collision = target
						.prepare(`SELECT id FROM items WHERE id IN (SELECT id FROM ${alias}.items) LIMIT 1`)
						.get() as { id: string } | undefined
					if (collision) throw new Error(`Item id collision while importing profiles: ${collision.id}`)
					const quotedItems = itemColumns.map(name => `"${name}"`).join(', ')
					target
						.prepare(`INSERT INTO items (${quotedItems}, profile_id) SELECT ${quotedItems}, ? FROM ${alias}.items`)
						.run(source.profileId)
					target
						.prepare(
							`INSERT INTO item_events (profile_id, item_id, event_type, payload, created_at)
							 SELECT ?, item_id, event_type, payload, created_at FROM ${alias}.item_events ORDER BY id`,
						)
						.run(source.profileId)
					const pollColumns = target.prepare(`PRAGMA ${alias}.table_info(poll_state)`).all() as { name: string }[]
					const hasProfilePollState = pollColumns.some(column => column.name === 'profile_id')
					target
						.prepare(
							hasProfilePollState
								? `INSERT OR REPLACE INTO poll_state (profile_id, project_slug, last_poll_at, last_task_seen)
								   SELECT ?, project_slug, last_poll_at, last_task_seen FROM ${alias}.poll_state WHERE profile_id = ?`
								: `INSERT OR REPLACE INTO poll_state (profile_id, project_slug, last_poll_at, last_task_seen)
								   SELECT ?, project_slug, last_poll_at, last_task_seen FROM ${alias}.poll_state`,
						)
						.run(...(hasProfilePollState ? [source.profileId, source.profileId] : [source.profileId]))
					if (source.profileId === activeProfileId) {
						target.prepare(`INSERT OR REPLACE INTO app_state SELECT * FROM ${alias}.app_state`).run()
					}
				})
				importProfile()
			} finally {
				target.prepare(`DETACH DATABASE ${alias}`).run()
			}
		}
		const integrity = target.pragma('integrity_check') as { integrity_check: string }[]
		if (integrity.some(row => row.integrity_check !== 'ok'))
			throw new Error('Shared profile database integrity check failed')
		const foreignKeys = target.pragma('foreign_key_check') as unknown[]
		if (foreignKeys.length > 0) throw new Error('Shared profile database foreign-key validation failed')
		target.pragma('wal_checkpoint(TRUNCATE)')
		target.close()
		renameSync(temporaryPath, sharedPath)
	} catch (err) {
		if (target.open) target.close()
		rmSync(temporaryPath, { force: true })
		throw err
	}
}

type ProfileSelector = string | (() => string)

/** One SQLite connection with cheap profile-bound views over Item/poll state. */
export class DB {
	private readonly db: Database.Database
	private readonly ownsConnection: boolean
	readonly items: ItemStore

	constructor(
		dbPath?: string,
		private readonly profile: ProfileSelector = 'work',
		connection?: Database.Database,
		private readonly requestProfile = new AsyncLocalStorage<string>(),
	) {
		const path = dbPath ?? resolve(process.cwd(), 'helm.db')
		if (!dbPath && !connection) migrateLegacyDbFile(path)
		this.db = connection ?? new Database(path)
		this.ownsConnection = connection === undefined
		if (this.ownsConnection) {
			this.db.pragma('journal_mode = WAL')
			this.db.pragma('foreign_keys = ON')
			migrateConnection(this.db)
		}
		this.items = new ItemStore(this.db, () => this.profileId)
	}

	private get profileId(): string {
		if (typeof this.profile === 'string') return this.profile
		return this.requestProfile.getStore() ?? this.profile()
	}

	/** Profile captured by the current async request/job scope. */
	currentProfileId(): string {
		return this.profileId
	}

	/** Immutable tenant scope for an async job that must survive UI activation. */
	forProfile(profileId: string): DB {
		return new DB(undefined, profileId, this.db, this.requestProfile)
	}

	/** Capture one tenant for the complete async lifetime of an API request. */
	runInProfile<T>(profileId: string, operation: () => T): T {
		return this.requestProfile.run(profileId, operation)
	}

	getPollState(projectSlug: string): PollState | null {
		const row = this.db
			.prepare('SELECT * FROM poll_state WHERE profile_id = ? AND project_slug = ?')
			.get(this.profileId, projectSlug) as Record<string, unknown> | undefined
		if (!row) return null
		return {
			projectSlug: row.project_slug as string,
			lastPollAt: row.last_poll_at as string,
			lastTaskSeen: (row.last_task_seen as string) ?? null,
		}
	}

	updatePollState(projectSlug: string, lastPollAt: string, lastTaskSeen: string | null): void {
		this.db
			.prepare(
				'INSERT OR REPLACE INTO poll_state (profile_id, project_slug, last_poll_at, last_task_seen) VALUES (?, ?, ?, ?)',
			)
			.run(this.profileId, projectSlug, lastPollAt, lastTaskSeen)
	}

	// Daemon-global state (pause/restart safety), deliberately not tenant scoped.
	getAppState(key: string): string | null {
		const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined
		return row?.value ?? null
	}

	setAppState(key: string, value: string): void {
		this.db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run(key, value)
	}

	close(): void {
		if (this.ownsConnection) this.db.close()
	}
}
