import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { PlanningApplication, PlanningError } from '../src/plan/application.js'
import type { TaskProvider } from '../src/providers/provider.js'
import type { PlanningSessionResult, Spawner } from '../src/spawner/spawner.js'

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
		concurrency: 1,
		timeoutMinutes: 30,
		branchNaming: { enabled: false },
		displayName: { enabled: false },
		triage: { enabled: false },
		modelGuidance: {},
	},
	spawner: { name: 'default' },
	server: { port: 7474, host: 'localhost' },
	github: { createPrs: false, postComments: false, prPrefix: '[Helm]', trackDeployments: false, deployPollSeconds: 60 },
} as HelmConfig
const provider = {
	name: 'Contember',
	pollNewTasks: async () => [],
	getTaskContext: async () => null,
	resolveTaskSummary: async () => null,
	postComment: async () => null,
} as TaskProvider

class FailingAfterReadinessSpawner implements Spawner {
	readonly name = 'default'
	async startPlanningSession(params: Parameters<Spawner['startPlanningSession']>[0]): Promise<PlanningSessionResult> {
		params.onWorktreeReady(`/tmp/${params.itemId}`)
		throw new Error('adapter launch failed')
	}
}

test('failed re-plan blocks Start until a later plan_prepared, while a fresh failed Plan restores queue behavior', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-app-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	const app = new PlanningApplication(config, commands, provider, new FailingAfterReadinessSpawner(), async () => {
		throw new Error('unused')
	})
	try {
		const fresh = commands.createSolveItem({ title: 'fresh', projectSlug: 'helm', prompt: 'fresh' })
		await assert.rejects(app.prepare({ itemId: fresh.id }), PlanningError)
		assert.doesNotThrow(() => app.assertStartAllowed(fresh.id))
		assert.equal(commands.getItem(fresh.id)?.status, 'ready')

		const planned = commands.createSolveItem({ title: 'planned', projectSlug: 'helm', prompt: 'planned' })
		commands.beginPlanning(planned.id)
		commands.recordPlanPrepared(planned.id, {
			worktreePath: '/tmp/old-plan',
			branchName: 'feat/old',
			planDirName: 'old',
			spawner: 'default',
		})
		await assert.rejects(app.prepare({ itemId: planned.id }), PlanningError)
		assert.throws(() => app.assertStartAllowed(planned.id), /incomplete/i)
		assert.equal(commands.getItem(planned.id)?.plannedAt !== null, true)
		assert.equal(db.items.getEvents(planned.id).at(-1)?.eventType, 'planning_failed')
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})
