import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ProfileStore } from '../src/profiles/store.js'
import type { DaemonControl } from '../src/server/restart.js'
import { apiRoutes } from '../src/server/routes/api.js'

const config: HelmConfig = {
	provider: {
		type: 'contember',
		apiBaseUrl: 'https://example.test',
		projectSlug: 'helm',
		apiToken: 'token',
		statuses: ['new'],
	},
	projects: [
		{ slug: 'work', repoPath: '/work', baseBranch: 'main' },
		{ slug: 'personal', repoPath: '/personal', baseBranch: 'main' },
	],
	polling: { intervalSeconds: 60 },
	solver: {
		type: 'default',
		agent: 'claude',
		workspace: 'worktree',
		modelGuidance: {},
		concurrency: 2,
		timeoutMinutes: 30,
		branchNaming: { enabled: false },
		displayName: { enabled: false },
		triage: { enabled: false },
	},
	spawner: { name: 'default' },
	server: { port: 7474, host: 'localhost' },
	github: {
		createPrs: false,
		postComments: false,
		prPrefix: '[Helm]',
		trackDeployments: false,
		deployPollSeconds: 120,
	},
}

function withProfileApi(
	activeRuns: number,
	run: (ctx: { api: ReturnType<typeof apiRoutes>; store: ProfileStore; exits: () => number }) => Promise<void>,
) {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-api-'))
	const store = new ProfileStore(
		root,
		config.projects.map(project => project.slug),
	)
	const runtime = store.activeRuntime()
	const db = new DB(runtime.dbPath, () => store.activeProfile().id)
	const configPath = join(root, 'helm.config.json')
	writeFileSync(configPath, JSON.stringify(config), 'utf8')
	let exitCount = 0
	const control: DaemonControl = {
		isManaged: () => true,
		exit: () => {
			exitCount += 1
		},
		restartDelayMs: 0,
	}
	const queue = {
		getStatus: () => ({ paused: false, pending: 0, active: activeRuns, maxConcurrency: 2, activeTasks: [] }),
		quiesce: () => activeRuns === 0,
		unquiesce: () => undefined,
		isQuiescing: () => false,
		profileChanged: () => undefined,
	}
	const api = apiRoutes(
		config,
		configPath,
		db,
		queue as never,
		{ pollOnce: async () => undefined, profileChanged: () => undefined } as never,
		{
			name: 'fake',
			pollNewTasks: async () => [],
			getTaskContext: async () => null,
			resolveTaskSummary: async () => null,
			postComment: async () => undefined,
		} as never,
		{ name: 'fake', startPlanningSession: async () => ({}) } as never,
		{ enqueue() {}, backfill() {} } as never,
		undefined,
		undefined,
		control,
		undefined,
		undefined,
		{ store, runtime: () => store.activeRuntime() },
	)
	return run({ api, store, exits: () => exitCount }).finally(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})
}

test('profile API exposes active identity, creates named profiles, and stores project choices', async () => {
	await withProfileApi(0, async ({ api }) => {
		const status = (await (await api.request('/status')).json()) as {
			data: { profile: { id: string; name: string; enabledProjects: string[] }; profileGeneration: number }
		}
		assert.equal(status.data.profile.name, 'Work')
		assert.deepEqual(status.data.profile.enabledProjects, ['personal', 'work'])
		assert.equal(status.data.profileGeneration, 1)

		const createdRes = await api.request('/profiles', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Personal', enabledProjects: ['personal'] }),
		})
		assert.equal(createdRes.status, 201)
		const created = (await createdRes.json()) as { data: { profile: { id: string; enabledProjects: string[] } } }
		assert.deepEqual(created.data.profile.enabledProjects, ['personal'])

		const updatedRes = await api.request(`/profiles/${created.data.profile.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Home', enabledProjects: [] }),
		})
		assert.equal(updatedRes.status, 200)
		const updated = (await updatedRes.json()) as { data: { profile: { name: string; enabledProjects: string[] } } }
		assert.equal(updated.data.profile.name, 'Home')
		assert.deepEqual(updated.data.profile.enabledProjects, [])
	})
})

test('profile API rejects project slugs outside shared config', async () => {
	await withProfileApi(0, async ({ api }) => {
		const response = await api.request('/profiles', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Unknown', enabledProjects: ['missing'] }),
		})
		assert.equal(response.status, 400)
	})
})

test('updating the active profile applies immediately without restarting the daemon', async () => {
	await withProfileApi(0, async ({ api, store, exits }) => {
		const response = await api.request('/profiles/work', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Primary', enabledProjects: ['work'] }),
		})
		assert.equal(response.status, 200)
		assert.equal(store.activeProfile().name, 'Primary')
		assert.equal(exits(), 0)
	})
})

test('profile activation stays available while another profile has an active run', async () => {
	await withProfileApi(1, async ({ api, store, exits }) => {
		const profile = store.create('Personal')
		const res = await api.request(`/profiles/${profile.id}/activate`, { method: 'POST' })
		assert.equal(res.status, 200)
		assert.equal(store.activeProfile().id, profile.id)
		assert.equal(exits(), 0)
	})
})

test('profile activation commits one generation without a daemon restart', async () => {
	await withProfileApi(0, async ({ api, store, exits }) => {
		const profile = store.create('Personal')
		const res = await api.request(`/profiles/${profile.id}/activate`, { method: 'POST' })
		assert.equal(res.status, 200)
		const body = (await res.json()) as { data: { state: { activeProfileId: string; generation: number } } }
		assert.equal(body.data.state.activeProfileId, profile.id)
		assert.equal(body.data.state.generation, 2)
		assert.equal(store.activeProfile().id, profile.id)
		assert.equal(exits(), 0)
	})
})

test('active profiles cannot be archived; archived profiles disappear from switching until restored', async () => {
	await withProfileApi(0, async ({ api, store }) => {
		const activeArchive = await api.request('/profiles/work/archive', { method: 'POST' })
		assert.equal(activeArchive.status, 400)

		const profile = store.create('Personal')
		assert.equal((await api.request(`/profiles/${profile.id}/archive`, { method: 'POST' })).status, 200)
		assert.ok(store.getState().profiles.find(candidate => candidate.id === profile.id)?.archivedAt)
		assert.equal((await api.request(`/profiles/${profile.id}/activate`, { method: 'POST' })).status, 400)
		assert.equal((await api.request(`/profiles/${profile.id}/restore`, { method: 'POST' })).status, 200)
		assert.equal(store.getState().profiles.find(candidate => candidate.id === profile.id)?.archivedAt, null)
	})
})
