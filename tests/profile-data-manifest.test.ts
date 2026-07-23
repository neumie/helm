import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DB } from '../src/db/client.js'
import { ProfileStore } from '../src/profiles/store.js'

const manifestScript = join(process.cwd(), 'scripts', 'profile-data-manifest.mjs')

function sha256(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function createItem(db: DB, title: string) {
	return db.items.create({
		kind: 'solve',
		status: 'ready',
		projectSlug: 'helm',
		title,
		baseRef: 'main',
		payload: { kind: 'solve', prompt: title },
	})
}

function createDataset() {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-manifest-'))
	const profiles = new ProfileStore(root)
	const personal = profiles.create('Personal')
	const archived = profiles.create('Archive')
	profiles.archive(archived.id)
	profiles.activate(personal.id)

	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const workItem = createItem(db, 'Work item')
		db.items.insertEvent(workItem.id, 'work_event')
		db.updatePollState('helm', '2026-01-01T00:00:00.000Z', 'work-poll')

		const personalDb = db.forProfile(personal.id)
		const personalItem = createItem(personalDb, 'Personal item')
		personalDb.items.insertEvent(personalItem.id, 'personal_event')
		personalDb.items.insertEvent(personalItem.id, 'personal_follow_up')
		personalDb.updatePollState('helm', '2026-01-02T00:00:00.000Z', 'personal-poll')
	} finally {
		db.close()
	}
	mkdirSync(join(root, 'profiles', personal.id, 'attachments'), { recursive: true })
	writeFileSync(join(root, 'profiles', personal.id, 'attachments', 'note.txt'), 'captured note')
	return { root, personal, archived }
}

function readManifest(root: string) {
	return JSON.parse(execFileSync(process.execPath, [manifestScript, root], { encoding: 'utf8' })) as {
		logical: {
			generation: number
			activeProfileId: string
			profileIds: string[]
			profiles: { id: string; itemCount: number; eventCount: number; pollCount: number }[]
		}
		files: { path: string; sha256: string }[]
	}
}

test('profile data manifest reports stable shared-DB counts and every managed file without writes', () => {
	const { root, personal, archived } = createDataset()
	try {
		const databaseHashBefore = sha256(join(root, 'helm.db'))
		const manifest = readManifest(root)

		assert.equal(manifest.logical.generation, 2)
		assert.equal(manifest.logical.activeProfileId, personal.id)
		assert.deepEqual(manifest.logical.profileIds, ['work', personal.id, archived.id])
		assert.deepEqual(manifest.logical.profiles, [
			{ id: 'work', itemCount: 1, eventCount: 1, pollCount: 1 },
			{ id: personal.id, itemCount: 1, eventCount: 2, pollCount: 1 },
			{ id: archived.id, itemCount: 0, eventCount: 0, pollCount: 0 },
		])
		assert.deepEqual(
			manifest.files.map(file => file.path),
			['helm.db', 'profiles.json', `profiles/${personal.id}/attachments/note.txt`],
		)
		assert.equal(manifest.files[0]?.sha256, databaseHashBefore)
		assert.equal(manifest.files[1]?.sha256, sha256(join(root, 'profiles.json')))
		assert.equal(manifest.files[2]?.sha256, sha256(join(root, 'profiles', personal.id, 'attachments', 'note.txt')))
		assert.equal(sha256(join(root, 'helm.db')), databaseHashBefore)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('profile data manifest rejects a database with foreign-key violations', () => {
	const { root } = createDataset()
	try {
		const database = new Database(join(root, 'helm.db'))
		try {
			database.pragma('foreign_keys = OFF')
			database
				.prepare(
					`INSERT INTO item_events (profile_id, item_id, event_type, payload, created_at)
					 VALUES ('work', 'missing-item', 'invalid_event', NULL, '2026-01-03T00:00:00.000Z')`,
				)
				.run()
		} finally {
			database.close()
		}

		const result = spawnSync(process.execPath, [manifestScript, root], { encoding: 'utf8' })
		assert.equal(result.status, 1)
		assert.match(result.stderr, /foreign_key_check returned 1 row/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
