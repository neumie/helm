import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DB, migrateProfileDatabasesToShared } from '../src/db/client.js'
import { Drainer } from '../src/queue/drainer.js'

const PROFILE_B = 'profile-aaaaaaaaaaaa'

function createSolve(db: DB, title: string, externalId?: string) {
	return db.items.create({
		kind: 'solve',
		status: 'ready',
		projectSlug: 'helm',
		title,
		baseRef: 'main',
		...(externalId ? { source: { provider: 'test', externalId } } : {}),
		payload: { kind: 'solve', prompt: title },
	})
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

test('legacy per-profile databases merge into one shared database without changing sources', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-db-import-'))
	try {
		const sources = ['work', PROFILE_B].map(profileId => {
			const directory = join(root, 'profiles', profileId)
			mkdirSync(directory, { recursive: true })
			const dbPath = join(directory, 'helm.db')
			const source = new DB(dbPath, profileId)
			const item = createSolve(source, profileId)
			source.items.insertEvent(item.id, `${profileId}_event`)
			source.updatePollState('helm', new Date().toISOString(), `${profileId}_cursor`)
			source.close()
			return { profileId, dbPath }
		})

		const sharedPath = join(root, 'helm.db')
		migrateProfileDatabasesToShared(sharedPath, sources, 'work')
		const shared = new DB(sharedPath, 'work')
		try {
			assert.deepEqual(
				shared.items.list().map(item => item.title),
				['work'],
			)
			assert.equal(shared.getPollState('helm')?.lastTaskSeen, 'work_cursor')
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
