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

class ContractSpawner implements Spawner {
	readonly name = 'default'
	constructor(
		private readonly run: (params: Parameters<Spawner['startPlanningSession']>[0]) => Promise<PlanningSessionResult>,
	) {}
	startPlanningSession(params: Parameters<Spawner['startPlanningSession']>[0]) {
		return this.run(params)
	}
}

async function expectLaunchFailure(
	run: (params: Parameters<Spawner['startPlanningSession']>[0]) => Promise<PlanningSessionResult>,
): Promise<PlanningError> {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-contract-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	try {
		const item = commands.createSolveItem({ title: 'contract', projectSlug: 'helm', prompt: 'contract' })
		const app = new PlanningApplication(config, commands, provider, new ContractSpawner(run), async () => {
			throw new Error('unused')
		})
		let thrown: unknown
		try {
			await app.prepare({ itemId: item.id })
		} catch (error) {
			thrown = error
		}
		assert.ok(thrown instanceof PlanningError && thrown.code === 'launch_failed')
		return thrown
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
}

test('PlanningApplication enforces zero, double, and mismatched readiness callbacks', async () => {
	const zero = await expectLaunchFailure(async params => ({
		worktreePath: `/tmp/${params.itemId}-zero`,
		branchName: params.branchName,
		hint: 'zero',
	}))
	assert.equal(zero.sessionMayExist, true)

	const doubleRoot = mkdtempSync(join(tmpdir(), 'helm-planning-double-'))
	try {
		const double = await expectLaunchFailure(async params => {
			params.onWorktreeReady(doubleRoot)
			params.onWorktreeReady(doubleRoot)
			return { worktreePath: doubleRoot, branchName: params.branchName, hint: 'double' }
		})
		assert.equal(double.sessionMayExist, true)
	} finally {
		rmSync(doubleRoot, { recursive: true, force: true })
	}

	const callbackRoot = mkdtempSync(join(tmpdir(), 'helm-planning-callback-'))
	const returnedRoot = mkdtempSync(join(tmpdir(), 'helm-planning-returned-'))
	try {
		const mismatch = await expectLaunchFailure(async params => {
			params.onWorktreeReady(callbackRoot)
			return { worktreePath: returnedRoot, branchName: params.branchName, hint: 'mismatch' }
		})
		assert.equal(mismatch.sessionMayExist, true)
	} finally {
		rmSync(callbackRoot, { recursive: true, force: true })
		rmSync(returnedRoot, { recursive: true, force: true })
	}
})

test('PlanningApplication retains the origin profile commands across a deferred provider await', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-profile-'))
	let activeProfile = 'one'
	const db = new DB(join(root, 'helm.db'), () => activeProfile)
	const commands = new ItemCommands(db.items, config)
	let release: ((value: null) => void) | undefined
	const deferredProvider = {
		...provider,
		getTaskContext: () =>
			new Promise<null>(resolve => {
				release = resolve
			}),
	}
	try {
		const item = commands.createSolveItem({
			title: 'origin',
			projectSlug: 'helm',
			prompt: 'origin',
			source: { provider: 'Contember', externalId: 'origin' },
		})
		const app = new PlanningApplication(
			config,
			commands,
			deferredProvider,
			new FailingAfterReadinessSpawner(),
			async () => {
				throw new Error('unused')
			},
			undefined,
			profileId => new ItemCommands(db.forProfile(profileId).items, config),
		)
		const pending = app.prepare({ itemId: item.id })
		await new Promise(resolve => setImmediate(resolve))
		activeProfile = 'two'
		release?.(null)
		await assert.rejects(
			pending,
			(value: unknown) => value instanceof PlanningError && value.code === 'source_unavailable',
		)
		const origin = db.forProfile('one').items.get(item.id)
		assert.equal(origin?.status, 'inbox')
		assert.deepEqual(
			db
				.forProfile('one')
				.items.getEvents(item.id)
				.map(event => event.eventType),
			['planning_started', 'planning_failed'],
		)
		assert.equal(db.forProfile('two').items.get(item.id), null)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('Spawner adapter name errors are client errors while factory failures are launch failures', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-spawner-errors-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	try {
		const item = commands.createSolveItem({
			title: 'adapter',
			projectSlug: 'helm',
			prompt: 'adapter',
			spawner: 'missing',
		})
		const invalid = new PlanningApplication(
			config,
			commands,
			provider,
			new FailingAfterReadinessSpawner(),
			async () => {
				throw new Error('Spawner adapter not installed: missing')
			},
		)
		await assert.rejects(
			invalid.prepare({ itemId: item.id }),
			(value: unknown) => value instanceof PlanningError && value.code === 'invalid_spawner',
		)
		const factory = new PlanningApplication(
			config,
			commands,
			provider,
			new FailingAfterReadinessSpawner(),
			async () => {
				throw new Error('dynamic import exploded')
			},
		)
		await assert.rejects(
			factory.prepare({ itemId: item.id }),
			(value: unknown) => value instanceof PlanningError && value.code === 'launch_failed',
		)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})
