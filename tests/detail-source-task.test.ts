import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { createDetailSourceTaskReader } from '../src/items/context.js'
import type { ItemRecord } from '../src/items/schema.js'
import type { TaskContext, TaskProvider } from '../src/providers/provider.js'
import { apiRoutes } from '../src/server/routes/api.js'

const config = {
	provider: {
		type: 'contember',
		apiBaseUrl: 'https://example.test',
		projectSlug: 'helm',
		apiToken: 'token',
		statuses: ['new'],
	},
	projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
	polling: { intervalSeconds: 60 },
	solver: {
		type: 'default',
		agent: 'claude',
		workspace: 'worktree',
		concurrency: 2,
		loopConcurrency: 1,
		timeoutMinutes: 30,
		branchNaming: { enabled: false },
		displayName: { enabled: false },
		triage: { enabled: false },
		modelGuidance: {},
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
} as HelmConfig

function sourceItem(externalId: string, capturedContext: TaskContext | null = null): ItemRecord {
	return {
		profileId: 'work',
		capturedContext,
		source: capturedContext ? { provider: 'Email', externalId } : { provider: 'Contember', externalId },
	} as ItemRecord
}

test('detail source-task reads reuse one provider call until the minute expires', async () => {
	let now = 1_000
	let calls = 0
	const read = createDetailSourceTaskReader(
		{
			getTaskContext: async () => {
				calls += 1
				return { title: `read ${calls}` }
			},
		} as TaskProvider,
		{ now: () => now, ttlMs: 60_000 },
	)
	const item = sourceItem('task-1')

	assert.equal((await read(item))?.title, 'read 1')
	now += 59_000
	assert.equal((await read(item))?.title, 'read 1')
	assert.equal(calls, 1)

	now += 1_000
	assert.equal((await read(item))?.title, 'read 2')
	assert.equal(calls, 2)
})

test('a failed detail source-task read is not retried on the next tick', async () => {
	let calls = 0
	const read = createDetailSourceTaskReader(
		{
			getTaskContext: async () => {
				calls += 1
				throw new Error('down')
			},
		} as TaskProvider,
		{ now: () => 0, ttlMs: 60_000 },
	)
	const item = sourceItem('task-down')

	await assert.rejects(read(item), /down/)
	assert.equal(await read(item), null)
	assert.equal(calls, 1)
})

test('captured detail context never calls the provider', async () => {
	const read = createDetailSourceTaskReader({
		getTaskContext: async () => {
			throw new Error('provider must not be called')
		},
	} as TaskProvider)
	const item = sourceItem('email:1', { title: 'Frozen email' })
	assert.equal((await read(item))?.title, 'Frozen email')
})

test('GET /items/:id does not ask the provider again while the detail cache is fresh', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-detail-source-'))
	const db = new DB(join(dir, 'helm.db'))
	try {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Stored summary',
			projectSlug: 'helm',
			prompt: 'Do the work.',
			source: { provider: 'Contember', externalId: 'task-detail-cache' },
		})
		let calls = 0
		const api = apiRoutes({
			config,
			configPath: 'helm.config.json',
			db,
			queue: { wake: () => undefined } as never,
			poller: { pollOnce: async () => undefined } as never,
			provider: {
				name: 'Contember',
				pollNewTasks: async () => [],
				getTaskContext: async (externalId: string) => {
					calls += 1
					assert.equal(externalId, 'task-detail-cache')
					return { title: 'Live task', description: 'From ClientCare.' }
				},
				resolveTaskSummary: async () => null,
				postComment: async () => null,
			} as never,
			spawner: { name: 'default', startPlanningSession: async () => ({}) } as never,
			enricher: { enqueue: () => undefined } as never,
			inspectItemOkenaWorkspace: async () => null,
		})

		const first = await api.request(`/items/${item.id}`)
		const second = await api.request(`/items/${item.id}`)
		assert.equal(first.status, 200)
		assert.equal(second.status, 200)
		const firstBody = (await first.json()) as { data: { sourceTask: TaskContext | null } }
		const secondBody = (await second.json()) as { data: { sourceTask: TaskContext | null } }
		assert.equal(firstBody.data.sourceTask?.title, 'Live task')
		assert.equal(secondBody.data.sourceTask?.description, 'From ClientCare.')
		assert.equal(calls, 1)
	} finally {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	}
})
