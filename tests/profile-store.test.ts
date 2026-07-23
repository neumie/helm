import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProfileStore } from '../src/profiles/store.js'

function withRoot(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'helm-profiles-'))
	try {
		run(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

test('profile store keeps the shared database at root and moves Work filesystem resources', () =>
	withRoot(root => {
		writeFileSync(join(root, 'helm.db'), 'database')
		writeFileSync(join(root, 'helm.db-wal'), 'wal')
		writeFileSync(join(root, 'helm.db-shm'), 'shm')
		mkdirSync(join(root, 'attachments', 'item-1'), { recursive: true })
		writeFileSync(join(root, 'attachments', 'item-1', 'proof.txt'), 'proof')
		mkdirSync(join(root, 'logs'), { recursive: true })
		writeFileSync(join(root, 'logs', 'item-1.log'), 'run log')

		const store = new ProfileStore(root, ['jvs', 'vault'])
		const state = store.getState()
		const runtime = store.activeRuntime()

		assert.equal(state.activeProfileId, 'work')
		assert.equal(state.generation, 1)
		assert.deepEqual(state.profiles, [
			{
				id: 'work',
				name: 'Work',
				createdAt: state.profiles[0]?.createdAt,
				enabledProjects: ['jvs', 'vault'],
				archivedAt: null,
			},
		])
		assert.equal(readFileSync(runtime.dbPath, 'utf8'), 'database')
		assert.equal(readFileSync(`${runtime.dbPath}-wal`, 'utf8'), 'wal')
		assert.equal(readFileSync(`${runtime.dbPath}-shm`, 'utf8'), 'shm')
		assert.equal(readFileSync(join(runtime.attachmentsDir, 'item-1', 'proof.txt'), 'utf8'), 'proof')
		assert.equal(readFileSync(join(runtime.logsDir, 'item-1.log'), 'utf8'), 'run log')
		assert.equal(existsSync(join(root, 'helm.db')), true)
		assert.equal(existsSync(join(root, 'attachments')), false)
		assert.equal(existsSync(join(root, 'logs')), false)
	}))

test('profiles are unlimited named records with stable safe ids, project choices, and archive restore', () =>
	withRoot(root => {
		const store = new ProfileStore(root, ['work-project'])
		const personal = store.create('Personal', [])
		const client = store.create('Client A', ['jvs', 'jvs', 'vault'])

		assert.match(personal.id, /^profile-[a-f0-9]{12}$/)
		assert.notEqual(client.id, personal.id)
		assert.deepEqual(client.enabledProjects, ['jvs', 'vault'])
		assert.throws(() => store.create(' personal '), /already exists/)
		const pathLikeName = store.create('../escape')
		assert.match(pathLikeName.id, /^profile-[a-f0-9]{12}$/)
		assert.equal(store.runtimeFor(pathLikeName.id).rootDir.endsWith(pathLikeName.id), true)
		assert.equal(store.update(personal.id, { name: 'Home', enabledProjects: ['personal'] }).name, 'Home')

		const activated = store.activate(personal.id)
		assert.equal(activated.activeProfileId, personal.id)
		assert.equal(activated.generation, 2)
		assert.throws(() => store.archive(personal.id), /active profile/)
		assert.ok(store.archive(client.id).archivedAt)
		assert.throws(() => store.activate(client.id), /Archived profiles/)
		assert.equal(store.restore(client.id).archivedAt, null)

		const reloaded = new ProfileStore(root)
		assert.equal(reloaded.activeProfile().id, personal.id)
		assert.equal(reloaded.getState().profiles.length, 4)
	}))

test('profile bootstrap leaves a legacy per-profile database for the shared importer', () =>
	withRoot(root => {
		mkdirSync(join(root, 'profiles', 'work'), { recursive: true })
		writeFileSync(join(root, 'profiles', 'work', 'helm.db'), 'already moved')
		mkdirSync(join(root, 'attachments'), { recursive: true })
		writeFileSync(join(root, 'attachments', 'proof.txt'), 'proof')

		const store = new ProfileStore(root, [])
		assert.equal(existsSync(store.activeRuntime().dbPath), false)
		assert.equal(readFileSync(join(root, 'profiles', 'work', 'helm.db'), 'utf8'), 'already moved')
		assert.equal(readFileSync(join(store.activeRuntime().attachmentsDir, 'proof.txt'), 'utf8'), 'proof')
	}))

test('failed registry persistence rolls in-memory profile mutations back', () =>
	withRoot(root => {
		const store = new ProfileStore(root, ['helm'])
		const profile = store.create('Personal')
		const internals = store as unknown as { writeState: () => void }
		internals.writeState = () => {
			throw new Error('disk full')
		}
		assert.throws(() => store.update(profile.id, { name: 'Changed' }), /disk full/)
		assert.equal(store.getState().profiles.find(candidate => candidate.id === profile.id)?.name, 'Personal')
		assert.throws(() => store.activate(profile.id), /disk full/)
		assert.equal(store.activeProfile().id, 'work')
	}))

test('profile registry corruption fails closed instead of creating an empty replacement', () =>
	withRoot(root => {
		writeFileSync(join(root, 'profiles.json'), '{not-json')
		assert.throws(() => new ProfileStore(root), /Could not load profile registry/)
		assert.equal(readFileSync(join(root, 'profiles.json'), 'utf8'), '{not-json')
	}))
