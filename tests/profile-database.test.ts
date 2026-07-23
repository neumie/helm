import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DB, migrateProfileDatabasesToShared } from '../src/db/client.js'
import { Drainer } from '../src/queue/drainer.js'

const PROFILE_B = 'profile-aaaaaaaaaaaa'

function createSolve(db: DB, title: string, externalId?: string, id?: string) {
	return db.items.create({
		...(id ? { id } : {}),
		kind: 'solve',
		status: 'ready',
		projectSlug: 'helm',
		title,
		baseRef: 'main',
		...(externalId ? { source: { provider: 'test', externalId } } : {}),
		payload: { kind: 'solve', prompt: title },
	})
}

function migrationArtifacts(sharedPath: string): string[] {
	const temporaryPath = `${sharedPath}.${process.pid}.profiles-migration`
	return [sharedPath, temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`]
}

function assertNoMigrationTarget(sharedPath: string): void {
	for (const path of migrationArtifacts(sharedPath)) assert.equal(existsSync(path), false, `${path} should not exist`)
}

function digest(path: string): string | null {
	return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
}

function databaseSnapshot(path: string): Record<string, string | null> {
	return Object.fromEntries(['', '-wal', '-shm'].map(suffix => [suffix || 'database', digest(`${path}${suffix}`)]))
}

function sourceManifest(path: string): { items: number; events: number; polls: number } {
	const source = new Database(path, { readonly: true })
	try {
		return {
			items: (source.prepare('SELECT COUNT(*) AS count FROM items').get() as { count: number }).count,
			events: (source.prepare('SELECT COUNT(*) AS count FROM item_events').get() as { count: number }).count,
			polls: (source.prepare('SELECT COUNT(*) AS count FROM poll_state').get() as { count: number }).count,
		}
	} finally {
		source.close()
	}
}

function sharedManifest(
	sharedPath: string,
	profileIds: readonly string[],
): Record<string, { items: number; events: number; polls: number }> {
	const shared = new Database(sharedPath, { readonly: true })
	try {
		return Object.fromEntries(
			profileIds.map(profileId => [
				profileId,
				{
					items: (
						shared.prepare('SELECT COUNT(*) AS count FROM items WHERE profile_id = ?').get(profileId) as {
							count: number
						}
					).count,
					events: (
						shared.prepare('SELECT COUNT(*) AS count FROM item_events WHERE profile_id = ?').get(profileId) as {
							count: number
						}
					).count,
					polls: (
						shared.prepare('SELECT COUNT(*) AS count FROM poll_state WHERE profile_id = ?').get(profileId) as {
							count: number
						}
					).count,
				},
			]),
		)
	} finally {
		shared.close()
	}
}

function assertSharedIntegrity(sharedPath: string): void {
	const shared = new Database(sharedPath, { readonly: true })
	try {
		assert.deepEqual(shared.pragma('integrity_check'), [{ integrity_check: 'ok' }])
		assert.deepEqual(shared.pragma('foreign_key_check'), [])
	} finally {
		shared.close()
	}
}

function createLegacySource(root: string, profileId: string): { profileId: string; dbPath: string; db: DB } {
	const directory = join(root, 'profiles', profileId)
	mkdirSync(directory, { recursive: true })
	const dbPath = join(directory, 'helm.db')
	return { profileId, dbPath, db: new DB(dbPath, profileId) }
}

test('one database scopes Items, events, source dedup, and poll watermarks by profile', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-shared-profile-db-'))
	let active = 'work'
	const db = new DB(join(root, 'helm.db'), () => active)
	try {
		const workItem = createSolve(db, 'Work task', 'same-source')
		db.items.insertEvent(workItem.id, 'work_event')
		db.updatePollState('helm', '2026-01-01T00:00:00.000Z', 'work-cursor')

		active = PROFILE_B
		assert.equal(db.items.get(workItem.id), null)
		assert.equal(db.items.findBySourceExternalId('same-source'), null)
		const personalItem = createSolve(db, 'Personal task', 'same-source')
		db.items.insertEvent(personalItem.id, 'personal_event')
		db.updatePollState('helm', '2026-01-02T00:00:00.000Z', 'personal-cursor')

		assert.deepEqual(
			db.items.list().map(item => item.title),
			['Personal task'],
		)
		assert.deepEqual(
			db.items.getEvents(personalItem.id).map(event => event.eventType),
			['personal_event'],
		)
		assert.equal(db.getPollState('helm')?.lastTaskSeen, 'personal-cursor')

		active = 'work'
		assert.deepEqual(
			db.items.list().map(item => item.title),
			['Work task'],
		)
		assert.deepEqual(
			db.items.getEvents(workItem.id).map(event => event.eventType),
			['work_event'],
		)
		assert.equal(db.getPollState('helm')?.lastTaskSeen, 'work-cursor')
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('async request scope cannot be redirected by active-profile changes', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-request-scope-'))
	let active = 'work'
	const db = new DB(join(root, 'helm.db'), () => active)
	let release: (() => void) | undefined
	const gate = new Promise<void>(resolve => {
		release = resolve
	})
	try {
		const pending = db.runInProfile('work', async () => {
			await gate
			assert.equal(db.currentProfileId(), 'work')
			return createSolve(db, 'Started in Work')
		})
		active = PROFILE_B
		release?.()
		const created = await pending
		assert.equal(created.profileId, 'work')
		assert.equal(db.items.list().length, 0)
		assert.equal(db.forProfile('work').items.get(created.id)?.title, 'Started in Work')
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('stale-run recovery covers every profile in the shared database', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-recovery-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const workItem = db.items.create({
			kind: 'solve',
			status: 'running',
			projectSlug: 'helm',
			title: 'Stale Work run',
			baseRef: 'main',
			payload: { kind: 'solve', prompt: 'work' },
		})
		const personalDb = db.forProfile(PROFILE_B)
		const personalItem = personalDb.items.create({
			kind: 'solve',
			status: 'running',
			projectSlug: 'helm',
			title: 'Stale Personal run',
			baseRef: 'main',
			payload: { kind: 'solve', prompt: 'personal' },
		})
		db.setAppState('drainer_paused', 'true')
		const drainer = new Drainer(
			{ solver: { concurrency: 1 } } as never,
			db,
			{} as never,
			{} as never,
			undefined,
			() => ['work', PROFILE_B],
		)
		drainer.start()
		try {
			assert.equal(db.items.get(workItem.id)?.status, 'ready')
			assert.equal(personalDb.items.get(personalItem.id)?.status, 'ready')
		} finally {
			drainer.stop()
		}
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('legacy databases import atomically with active app state, profile-local watermarks, and matching manifests', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-db-import-'))
	try {
		const sources = ['work', PROFILE_B].map(profileId => {
			const source = createLegacySource(root, profileId)
			const item = createSolve(source.db, profileId)
			source.db.items.insertEvent(item.id, `${profileId}_event`)
			source.db.updatePollState('helm', new Date().toISOString(), `${profileId}_cursor`)
			source.db.setAppState('active_profile_value', profileId)
			source.db.setAppState(`only_${profileId}`, profileId)
			source.db.close()
			return { profileId: source.profileId, dbPath: source.dbPath }
		})
		const sourceSnapshots = new Map(sources.map(source => [source.dbPath, databaseSnapshot(source.dbPath)]))
		const expectedManifest = Object.fromEntries(
			sources.map(source => [source.profileId, sourceManifest(source.dbPath)]),
		)

		const sharedPath = join(root, 'helm.db')
		migrateProfileDatabasesToShared(sharedPath, sources, 'work')
		assertSharedIntegrity(sharedPath)
		assert.deepEqual(sharedManifest(sharedPath, ['work', PROFILE_B]), expectedManifest)
		for (const source of sources) assert.deepEqual(databaseSnapshot(source.dbPath), sourceSnapshots.get(source.dbPath))

		const shared = new DB(sharedPath, 'work')
		try {
			assert.deepEqual(
				shared.items.list().map(item => item.title),
				['work'],
			)
			assert.equal(shared.getPollState('helm')?.lastTaskSeen, 'work_cursor')
			assert.equal(shared.getAppState('active_profile_value'), 'work')
			assert.equal(shared.getAppState('only_work'), 'work')
			assert.equal(shared.getAppState(`only_${PROFILE_B}`), null)
			const personal = shared.forProfile(PROFILE_B)
			assert.deepEqual(
				personal.items.list().map(item => item.title),
				[PROFILE_B],
			)
			assert.equal(personal.getPollState('helm')?.lastTaskSeen, `${PROFILE_B}_cursor`)
			assert.equal(personal.items.getEvents(personal.items.list()[0].id).length, 1)
		} finally {
			shared.close()
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('duplicate IDs in the second source leave no target artifacts, preserve sources, and retry exactly once after correction', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-db-duplicate-'))
	try {
		const duplicateId = 'duplicate-item-id'
		const first = createLegacySource(root, 'work')
		const firstItem = createSolve(first.db, 'first', undefined, duplicateId)
		first.db.items.insertEvent(firstItem.id, 'first_event')
		first.db.close()
		const second = createLegacySource(root, PROFILE_B)
		const secondItem = createSolve(second.db, 'second', undefined, duplicateId)
		second.db.items.insertEvent(secondItem.id, 'second_event')
		second.db.close()
		const sources = [
			{ profileId: first.profileId, dbPath: first.dbPath },
			{ profileId: second.profileId, dbPath: second.dbPath },
		]
		const sourceSnapshots = new Map(sources.map(source => [source.dbPath, databaseSnapshot(source.dbPath)]))
		const sharedPath = join(root, 'helm.db')

		assert.throws(() => migrateProfileDatabasesToShared(sharedPath, sources, 'work'), /Item id collision/)
		assertNoMigrationTarget(sharedPath)
		for (const source of sources) assert.deepEqual(databaseSnapshot(source.dbPath), sourceSnapshots.get(source.dbPath))

		const correction = new Database(second.dbPath)
		correction.prepare('DELETE FROM item_events WHERE item_id = ?').run(duplicateId)
		correction.prepare('DELETE FROM items WHERE id = ?').run(duplicateId)
		correction.close()
		const corrected = new DB(second.dbPath, PROFILE_B)
		const correctedItem = createSolve(corrected, 'corrected second')
		corrected.items.insertEvent(correctedItem.id, 'corrected_second_event')
		corrected.close()

		migrateProfileDatabasesToShared(sharedPath, sources, 'work')
		const expectedManifest = Object.fromEntries(
			sources.map(source => [source.profileId, sourceManifest(source.dbPath)]),
		)
		assertSharedIntegrity(sharedPath)
		assert.deepEqual(sharedManifest(sharedPath, ['work', PROFILE_B]), expectedManifest)
		migrateProfileDatabasesToShared(sharedPath, sources, 'work')
		assert.deepEqual(sharedManifest(sharedPath, ['work', PROFILE_B]), expectedManifest)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('a source reporting schema version 24 fails atomically without touching sources', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-db-schema-'))
	try {
		const source = createLegacySource(root, 'work')
		createSolve(source.db, 'old schema source')
		source.db.close()
		const legacy = new Database(source.dbPath)
		legacy.prepare('DELETE FROM schema_version WHERE version > 24').run()
		legacy.close()
		const sharedPath = join(root, 'helm.db')
		const before = databaseSnapshot(source.dbPath)

		assert.throws(
			() =>
				migrateProfileDatabasesToShared(sharedPath, [{ profileId: source.profileId, dbPath: source.dbPath }], 'work'),
			/too old to import safely/,
		)
		assertNoMigrationTarget(sharedPath)
		assert.deepEqual(databaseSnapshot(source.dbPath), before)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('committed rows in a writer-closed WAL source are imported without changing source data files', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-db-wal-'))
	let reader: Database.Database | undefined
	try {
		const source = createLegacySource(root, 'work')
		reader = new Database(source.dbPath, { readonly: true })
		reader.exec('BEGIN')
		reader.prepare('SELECT COUNT(*) FROM items').get()
		const item = createSolve(source.db, 'WAL-backed source')
		source.db.items.insertEvent(item.id, 'wal_event')
		source.db.close()
		assert.equal(existsSync(`${source.dbPath}-wal`), true)
		const before = databaseSnapshot(source.dbPath)
		const sharedPath = join(root, 'helm.db')

		migrateProfileDatabasesToShared(sharedPath, [{ profileId: source.profileId, dbPath: source.dbPath }], 'work')
		assertSharedIntegrity(sharedPath)
		assert.deepEqual(sharedManifest(sharedPath, ['work']), { work: { items: 1, events: 1, polls: 0 } })
		const after = databaseSnapshot(source.dbPath)
		assert.equal(after.database, before.database)
		assert.equal(after['-wal'], before['-wal'])
		assert.notEqual(after['-shm'], null)
	} finally {
		reader?.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('a second-source attach failure cleans the staged target and a fresh retry installs one complete database', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-db-attach-failure-'))
	try {
		const first = createLegacySource(root, 'work')
		const firstItem = createSolve(first.db, 'first source')
		first.db.items.insertEvent(firstItem.id, 'first_event')
		first.db.close()
		const secondPath = join(root, 'profiles', PROFILE_B, 'helm.db')
		mkdirSync(secondPath, { recursive: true })
		const sharedPath = join(root, 'helm.db')
		const firstSnapshot = databaseSnapshot(first.dbPath)
		const sources = [
			{ profileId: first.profileId, dbPath: first.dbPath },
			{ profileId: PROFILE_B, dbPath: secondPath },
		]

		assert.throws(() => migrateProfileDatabasesToShared(sharedPath, sources, 'work'))
		assertNoMigrationTarget(sharedPath)
		assert.deepEqual(databaseSnapshot(first.dbPath), firstSnapshot)

		rmSync(secondPath, { recursive: true, force: true })
		const second = new DB(secondPath, PROFILE_B)
		const secondItem = createSolve(second, 'second source')
		second.items.insertEvent(secondItem.id, 'second_event')
		second.close()

		migrateProfileDatabasesToShared(sharedPath, sources, 'work')
		const expectedManifest = Object.fromEntries(
			sources.map(source => [source.profileId, sourceManifest(source.dbPath)]),
		)
		assertSharedIntegrity(sharedPath)
		assert.deepEqual(sharedManifest(sharedPath, ['work', PROFILE_B]), expectedManifest)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
