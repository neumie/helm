import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
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
		const branchRoot = mkdtempSync(join(tmpdir(), 'helm-planning-branch-'))
		try {
			const wrongBranch = await expectLaunchFailure(async params => {
				params.onWorktreeReady(branchRoot)
				return { worktreePath: branchRoot, branchName: `${params.branchName}-wrong`, hint: 'branch mismatch' }
			})
			assert.equal(wrongBranch.sessionMayExist, true)
		} finally {
			rmSync(branchRoot, { recursive: true, force: true })
		}
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

test('Plan claims exclude a concurrent Plan and Start, while a Start that arrives first excludes Plan', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-arrival-'))
	const workspace = mkdtempSync(join(tmpdir(), 'helm-planning-arrival-worktree-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	let release: (() => void) | undefined
	const blockingSpawner = new ContractSpawner(
		params =>
			new Promise(resolve => {
				release = () => {
					params.onWorktreeReady(workspace)
					resolve({ worktreePath: workspace, branchName: params.branchName, hint: 'ready' })
				}
			}),
	)
	try {
		const item = commands.createSolveItem({ title: 'Arrival', projectSlug: 'helm', prompt: 'Arrival' })
		const app = new PlanningApplication(config, commands, provider, blockingSpawner, async () => blockingSpawner)
		const first = app.prepare({ itemId: item.id })
		await new Promise(resolve => setImmediate(resolve))
		await assert.rejects(
			app.prepare({ itemId: item.id }),
			(value: unknown) => value instanceof PlanningError && value.code === 'planning_conflict',
		)
		assert.throws(() => app.assertStartAllowed(item.id), /incomplete/i)
		release?.()
		await first

		const startFirst = commands.createSolveItem({ title: 'Started', projectSlug: 'helm', prompt: 'Started' })
		commands.startItem(startFirst.id)
		await assert.rejects(
			app.prepare({ itemId: startFirst.id }),
			(value: unknown) => value instanceof PlanningError && value.code === 'not_plannable',
		)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
		rmSync(workspace, { recursive: true, force: true })
	}
})

test('a Drainer candidate captured before Plan cannot start after the synchronous planning claim', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-drainer-race-'))
	const workspace = mkdtempSync(join(tmpdir(), 'helm-planning-drainer-worktree-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	let release: (() => void) | undefined
	try {
		const item = commands.createSolveItem({ title: 'Drainer race', projectSlug: 'helm', prompt: 'Race' })
		const staleCandidate = commands.getItem(item.id)
		assert.equal(staleCandidate?.status, 'ready')
		if (!staleCandidate) throw new Error('Expected a Drainer candidate')
		const spawner = new ContractSpawner(
			params =>
				new Promise(resolve => {
					release = () => {
						params.onWorktreeReady(workspace)
						resolve({ worktreePath: workspace, branchName: params.branchName, hint: 'ready' })
					}
				}),
		)
		const app = new PlanningApplication(config, commands, provider, spawner, async () => spawner)
		const planning = app.prepare({ itemId: item.id })
		await new Promise(resolve => setImmediate(resolve))
		assert.throws(() => commands.startItem(staleCandidate.id), /Only ready, Inbox, or active planned Items/)
		release?.()
		await planning
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
		rmSync(workspace, { recursive: true, force: true })
	}
})

test('Main and Worktree planning recognize filesystem aliases without reusing the canonical checkout', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-alias-'))
	const repo = mkdtempSync(join(tmpdir(), 'helm-planning-repo-'))
	const repoAlias = `${repo}-alias`
	const worktree = mkdtempSync(join(tmpdir(), 'helm-planning-worktree-'))
	symlinkSync(repo, repoAlias)
	const aliasConfig = { ...config, projects: [{ ...config.projects[0], repoPath: repo }] }
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, aliasConfig)
	const observed: Array<{ existing?: string; branch: string }> = []
	const spawner = new ContractSpawner(async params => {
		observed.push({ existing: params.existingWorktreePath, branch: params.branchName })
		const path = params.solverConfig.workspace === 'main' ? repoAlias : worktree
		params.onWorktreeReady(path)
		return { worktreePath: path, branchName: params.branchName, hint: 'ready' }
	})
	try {
		const mainToWorktree = commands.createSolveItem({ title: 'Main alias', projectSlug: 'helm', prompt: 'Main alias' })
		commands.beginPlanning(mainToWorktree.id)
		commands.recordPlanPrepared(mainToWorktree.id, {
			worktreePath: repoAlias,
			branchName: null,
			planDirName: 'main-alias',
			spawner: 'default',
		})
		const app = new PlanningApplication(aliasConfig, commands, provider, spawner, async () => spawner)
		await app.prepare({ itemId: mainToWorktree.id, solverWorkspace: 'worktree' })
		assert.equal(observed[0]?.existing, undefined)
		assert.equal(commands.getItem(mainToWorktree.id)?.worktreePath, worktree)
		assert.notEqual(commands.getItem(mainToWorktree.id)?.branchName, null)

		const worktreeToMain = commands.createSolveItem({
			title: 'Worktree alias',
			projectSlug: 'helm',
			prompt: 'Worktree alias',
		})
		commands.beginPlanning(worktreeToMain.id)
		commands.recordPlanPrepared(worktreeToMain.id, {
			worktreePath: worktree,
			branchName: 'feat/worktree-alias',
			planDirName: 'worktree-alias',
			spawner: 'default',
		})
		await app.prepare({ itemId: worktreeToMain.id, solverWorkspace: 'main' })
		assert.equal(observed[1]?.existing, repo)
		assert.equal(commands.getItem(worktreeToMain.id)?.branchName, null)
		assert.equal(commands.getItem(worktreeToMain.id)?.worktreePath, repoAlias)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
		rmSync(repoAlias, { force: true })
		rmSync(repo, { recursive: true, force: true })
		rmSync(worktree, { recursive: true, force: true })
	}
})

test('same-mode planning accepts a canonical adapter path for a live symlinked worktree', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-same-mode-alias-'))
	const worktree = mkdtempSync(join(tmpdir(), 'helm-planning-same-mode-worktree-'))
	const alias = `${worktree}-alias`
	symlinkSync(worktree, alias)
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	try {
		const item = commands.createSolveItem({ title: 'Same-mode alias', projectSlug: 'helm', prompt: 'alias' })
		commands.beginPlanning(item.id)
		commands.recordPlanPrepared(item.id, {
			worktreePath: alias,
			branchName: 'feat/same-mode-alias',
			planDirName: 'same-mode-alias',
			spawner: 'default',
		})
		commands.recordPlanningWorkspaceIdentity(
			item.id,
			{ worktreePath: worktree, branchName: 'feat/same-mode-alias', planDirName: 'same-mode-alias' },
			{
				expectedIdentity: {
					worktreePath: alias,
					branchName: 'feat/same-mode-alias',
					planDirName: 'same-mode-alias',
				},
				authorizedTransition: 'none',
			},
		)
		assert.equal(commands.getItem(item.id)?.worktreePath, worktree)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
		rmSync(alias, { force: true })
		rmSync(worktree, { recursive: true, force: true })
	}
})

test('late Spawner readiness callbacks are ignored after preparation has settled', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-late-'))
	const workspace = mkdtempSync(join(tmpdir(), 'helm-planning-late-worktree-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	let late: (() => void) | undefined
	try {
		const item = commands.createSolveItem({ title: 'Late', projectSlug: 'helm', prompt: 'Late' })
		const spawner = new ContractSpawner(async params => {
			params.onWorktreeReady(workspace)
			late = () => params.onWorktreeReady(workspace)
			return { worktreePath: workspace, branchName: params.branchName, hint: 'ready' }
		})
		const app = new PlanningApplication(config, commands, provider, spawner, async () => spawner)
		await app.prepare({ itemId: item.id })
		const eventsBefore = db.items.getEvents(item.id)
		assert.doesNotThrow(() => late?.())
		assert.deepEqual(db.items.getEvents(item.id), eventsBefore)
		assert.equal(commands.getItem(item.id)?.status, 'active')
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
		rmSync(workspace, { recursive: true, force: true })
	}
})

test('planning lifecycle row and event writes roll back together on event failures', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-planning-transaction-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	const originalInsertEvent = db.items.insertEvent.bind(db.items)
	const failEvents = () => {
		;(db.items as unknown as { insertEvent: typeof db.items.insertEvent }).insertEvent = () => {
			throw new Error('event write failed')
		}
	}
	const restoreEvents = () => {
		;(db.items as unknown as { insertEvent: typeof db.items.insertEvent }).insertEvent = originalInsertEvent
	}
	try {
		const begin = commands.createSolveItem({ title: 'begin rollback', projectSlug: 'helm', prompt: 'begin' })
		failEvents()
		assert.throws(() => commands.beginPlanning(begin.id), /event write failed/)
		restoreEvents()
		assert.equal(commands.getItem(begin.id)?.status, 'ready')
		assert.equal(db.items.getEvents(begin.id).length, 0)

		const abort = commands.createSolveItem({ title: 'abort rollback', projectSlug: 'helm', prompt: 'abort' })
		commands.beginPlanning(abort.id)
		failEvents()
		assert.throws(() => commands.abortPlanning(abort.id, abort), /event write failed/)
		restoreEvents()
		assert.equal(commands.getItem(abort.id)?.status, 'active')
		assert.equal(commands.getItem(abort.id)?.workMode, 'manual')
		assert.deepEqual(
			db.items.getEvents(abort.id).map(event => event.eventType),
			['planning_started'],
		)

		const prepared = commands.createSolveItem({ title: 'prepare rollback', projectSlug: 'helm', prompt: 'prepare' })
		commands.beginPlanning(prepared.id)
		failEvents()
		assert.throws(
			() =>
				commands.recordPlanPrepared(prepared.id, {
					worktreePath: '/tmp/prepare-rollback',
					branchName: 'feat/prepare-rollback',
					planDirName: 'prepare-rollback',
					spawner: 'default',
				}),
			/event write failed/,
		)
		restoreEvents()
		const afterPrepared = commands.getItem(prepared.id)
		assert.equal(afterPrepared?.plannedAt, null)
		assert.equal(afterPrepared?.worktreePath, null)
		assert.deepEqual(
			db.items.getEvents(prepared.id).map(event => event.eventType),
			['planning_started'],
		)
	} finally {
		restoreEvents()
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
