import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
// @ts-expect-error -- app is CommonJS under tsx; runtime exports arrive on the default object.
import profilesModule from '../app/src/profiles.ts'
// @ts-expect-error -- app is CommonJS under tsx; runtime exports arrive on the default object.
import sessionsModule from '../app/src/sessions.ts'
import type { ProfilesState } from '../app/src/shared-helm.ts'

const { AppProfileStore } = profilesModule as typeof import('../app/src/profiles.ts')
const { configureSessionProfile, socketDir, socketPath } = sessionsModule as typeof import('../app/src/sessions.ts')

function withDirs(run: (userData: string, sockets: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-app-profiles-'))
	const userData = path.join(root, 'user-data')
	const sockets = path.join(root, 'sockets')
	fs.mkdirSync(userData, { recursive: true })
	const previous = process.env.HELM_SOCKET_DIR
	process.env.HELM_SOCKET_DIR = sockets
	try {
		run(userData, sockets)
	} finally {
		configureSessionProfile('work')
		process.env.HELM_SOCKET_DIR = previous
		fs.rmSync(root, { recursive: true, force: true })
	}
}

test('app profile cache migrates existing terminal registry and buffers into Work only', () =>
	withDirs(userData => {
		fs.writeFileSync(path.join(userData, 'sessions.json'), '{"session-a":{}}')
		fs.mkdirSync(path.join(userData, 'buffers'), { recursive: true })
		fs.writeFileSync(path.join(userData, 'buffers', 'session-a.bin'), 'screen')

		const store = new AppProfileStore(userData)
		const workDir = store.profileDir('work')
		assert.equal(fs.readFileSync(path.join(workDir, 'sessions.json'), 'utf8'), '{"session-a":{}}')
		assert.equal(fs.readFileSync(path.join(workDir, 'buffers', 'session-a.bin'), 'utf8'), 'screen')
		assert.equal(fs.existsSync(path.join(userData, 'sessions.json')), false)
		assert.equal(fs.existsSync(path.join(userData, 'buffers')), false)
	}))

test('app profile migration fails closed when legacy and Work terminal data collide', () =>
	withDirs(userData => {
		fs.writeFileSync(path.join(userData, 'sessions.json'), '{}')
		fs.mkdirSync(path.join(userData, 'profiles', 'work'), { recursive: true })
		fs.writeFileSync(path.join(userData, 'profiles', 'work', 'sessions.json'), '{}')
		assert.throws(() => new AppProfileStore(userData), /both paths exist/)
	}))

test('app profile cache corruption fails closed instead of opening Work sessions', () =>
	withDirs(userData => {
		fs.writeFileSync(path.join(userData, 'profile-cache.json'), '{not-json')
		assert.throws(() => new AppProfileStore(userData), /Could not load app profile cache/)
	}))

test('app profile state follows daemon identity while profile data paths use opaque ids', () =>
	withDirs(userData => {
		const store = new AppProfileStore(userData)
		const state: ProfilesState = {
			version: 1,
			generation: 2,
			activeProfileId: 'profile-0123456789ab',
			profiles: [
				store.activeProfile(),
				{
					id: 'profile-0123456789ab',
					name: '../Personal',
					createdAt: new Date().toISOString(),
					enabledProjects: [],
					archivedAt: null,
				},
			],
		}
		store.applyDaemonState(state)
		assert.equal(store.activeProfile().name, '../Personal')
		assert.equal(store.profileDir().endsWith('profile-0123456789ab'), true)
		assert.equal(store.profileDir().includes('../Personal'), false)
	}))

test('daemon-confirmed app profile identity survives a cache write failure in memory', () =>
	withDirs(userData => {
		const store = new AppProfileStore(userData)
		const internals = store as unknown as { writeState: () => void }
		internals.writeState = () => {
			throw new Error('disk full')
		}
		assert.throws(
			() =>
				store.applyDaemonState({
					version: 1,
					generation: 2,
					activeProfileId: 'profile-0123456789ab',
					profiles: [
						store.activeProfile(),
						{
							id: 'profile-0123456789ab',
							name: 'Personal',
							createdAt: new Date().toISOString(),
							enabledProjects: [],
							archivedAt: null,
						},
					],
				}),
			/disk full/,
		)
		assert.equal(store.activeProfileId(), 'profile-0123456789ab')
	}))

test('dtach sockets are isolated per profile while Work retains the legacy socket pool', () =>
	withDirs((_userData, sockets) => {
		configureSessionProfile('work')
		assert.equal(socketDir(), sockets)
		assert.equal(socketPath('session-a'), path.join(sockets, 'session-a.sock'))

		configureSessionProfile('profile-0123456789ab')
		assert.equal(socketDir(), path.join(sockets, 'profiles', 'profile-0123456789ab'))
		assert.equal(socketPath('session-a'), path.join(sockets, 'profiles', 'profile-0123456789ab', 'session-a.sock'))
		assert.throws(() => configureSessionProfile('../escape'), /invalid profile id/)
	}))
