import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { DEPLOY_MAX_DEPLOYMENTS_PER_PR, DeployWatcher, fetchDeployState } from '../src/github/deploy-watcher.js'
import { ItemCommands } from '../src/items/commands.js'
import { PlanStatusWatcher } from '../src/plan/status-watcher.js'
import { ProfileStore } from '../src/profiles/store.js'

const config: HelmConfig = {
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
	github: { createPrs: false, postComments: false, prPrefix: '[Helm]', trackDeployments: true, deployPollSeconds: 120 },
}

let nextPrNumber = 100
function createShippedItem(db: DB, title: string) {
	const commands = new ItemCommands(db.items, config)
	const item = commands.createSolveItem({ title, projectSlug: 'helm', prompt: title })
	commands.setItemStatus(item.id, 'review')
	return commands.recordDispatchPr(item.id, { prUrl: `https://github.com/neumie/helm/pull/${nextPrNumber++}` })
}

function createPlannedItem(db: DB, title: string, worktreePath: string) {
	const commands = new ItemCommands(db.items, config)
	const item = commands.createSolveItem({ title, projectSlug: 'helm', prompt: title })
	commands.beginPlanning(item.id)
	mkdirSync(join(worktreePath, 'docs', 'plans', title), { recursive: true })
	return commands.recordPlanPrepared(item.id, {
		worktreePath,
		branchName: `helm/item/${title}`,
		planDirName: title,
		spawner: 'default',
	})
}

test('registered profiles include archived tenants and observers retain profile scope across activation', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-observers-'))
	const profiles = new ProfileStore(root, ['helm'])
	const inactive = profiles.create('Inactive')
	const archived = profiles.create('Archived')
	profiles.archive(archived.id)
	const db = new DB(join(root, 'helm.db'), () => profiles.activeProfile().id)
	try {
		assert.deepEqual(profiles.registeredProfileIds(), ['work', inactive.id, archived.id])
		const work = createShippedItem(db.forProfile('work'), 'work')
		const inactiveItem = createShippedItem(db.forProfile(inactive.id), 'inactive')
		const archivedItem = createShippedItem(db.forProfile(archived.id), 'archived')
		let release: (() => void) | undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let calls = 0
		const watcher = new DeployWatcher(
			config,
			db,
			{
				fetchDeployState: async () => {
					calls += 1
					await gate
					return {
						merged: false,
						mergedAt: null,
						mergeSha: null,
						deployments: [],
						checkedAt: '2026-01-01T00:00:00.000Z',
					}
				},
			},
			() => [...profiles.registeredProfileIds(), inactive.id],
		)
		const tick = watcher.pollOnce()
		await Promise.resolve()
		profiles.activate(inactive.id)
		release?.()
		await tick
		assert.equal(calls, 3, 'duplicate supplied profile IDs are observed once')
		assert.ok(db.forProfile('work').items.get(work.id)?.deployState)
		assert.ok(db.forProfile(inactive.id).items.get(inactiveItem.id)?.deployState)
		assert.ok(db.forProfile(archived.id).items.get(archivedItem.id)?.deployState)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('plan observer visits inactive and archived profiles with one fetch per project', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-plan-observers-'))
	const profiles = new ProfileStore(root, ['helm'])
	const inactive = profiles.create('Inactive')
	const archived = profiles.create('Archived')
	profiles.archive(archived.id)
	const db = new DB(join(root, 'helm.db'), () => profiles.activeProfile().id)
	try {
		const worktree = (id: string) => join(root, 'trees', id)
		const work = createPlannedItem(db.forProfile('work'), 'work-plan', worktree('work'))
		const idle = createPlannedItem(db.forProfile(inactive.id), 'idle-plan', worktree('idle'))
		const old = createPlannedItem(db.forProfile(archived.id), 'old-plan', worktree('old'))
		let fetches = 0
		const watcher = new PlanStatusWatcher(
			config,
			db,
			{
				fetchGithubQueues: async () => {
					fetches += 1
					return new Map()
				},
			},
			() => profiles.registeredProfileIds(),
		)
		await watcher.pollOnce()
		assert.equal(fetches, 1)
		for (const [profileId, item] of [
			['work', work],
			[inactive.id, idle],
			[archived.id, old],
		] as const) {
			assert.equal(db.forProfile(profileId).items.get(item.id)?.planStatus?.stage, 'planning')
		}
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('plan project budget rotates deferred projects onto the next tick', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-plan-project-budget-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const projects = Array.from({ length: 30 }, (_, index) => ({
			slug: `project-${index}`,
			repoPath: `/repo/${index}`,
			baseBranch: 'main',
		}))
		const manyConfig = { ...config, projects }
		const items = projects.map((project, index) => {
			const commands = new ItemCommands(db.items, manyConfig)
			const item = commands.createSolveItem({ title: `plan-${index}`, projectSlug: project.slug, prompt: 'x' })
			commands.beginPlanning(item.id)
			const worktree = join(root, 'trees', String(index))
			mkdirSync(join(worktree, 'docs', 'plans', `plan-${index}`), { recursive: true })
			return commands.recordPlanPrepared(item.id, {
				worktreePath: worktree,
				branchName: `helm/item/${index}`,
				planDirName: `plan-${index}`,
				spawner: 'default',
			})
		})
		const fetched = new Set<string>()
		let active = 0
		let maximum = 0
		let release: (() => void) | undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		const watcher = new PlanStatusWatcher(manyConfig, db, {
			fetchGithubQueues: async repoPath => {
				fetched.add(repoPath)
				active += 1
				maximum = Math.max(maximum, active)
				await gate
				active -= 1
				return new Map()
			},
		})
		const firstTick = watcher.pollOnce()
		while (active < 4) await Promise.resolve()
		assert.equal(maximum, 4)
		release?.()
		await firstTick
		assert.equal(fetched.size, 25)
		assert.equal(items.filter(item => db.items.get(item.id)?.planStatus === null).length, 5)
		await watcher.pollOnce()
		assert.equal(fetched.size, 30)
		assert.equal(items.filter(item => db.items.get(item.id)?.planStatus === null).length, 0)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('plan watcher selects no more than 400 items per tick', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-plan-item-ceiling-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		for (let index = 0; index < 401; index += 1)
			createPlannedItem(db, `bulk-${index}`, join(root, 'trees', String(index)))
		const watcher = new PlanStatusWatcher(config, db, { fetchGithubQueues: async () => new Map() })
		await watcher.pollOnce()
		const watched = db.items.listPlanWatchable(500).filter(item => item.planStatus !== null)
		assert.equal(watched.length, 400)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('21 deployment statuses accumulate across bounded calls and return only a complete state', async () => {
	const deployments = Array.from({ length: DEPLOY_MAX_DEPLOYMENTS_PER_PR + 1 }, (_, index) => ({
		id: index + 1,
		environment: `env-${index + 1}`,
	}))
	const progress = { statuses: new Map(), incomplete: false }
	let statusCalls = 0
	const command = async (_file: 'gh', args: string[]) => {
		if (args[0] === 'pr') return JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'sha' } })
		if (args[1]?.includes('/deployments?')) return JSON.stringify(deployments)
		statusCalls += 1
		return JSON.stringify([{ state: 'success' }])
	}
	const first = await fetchDeployState('https://github.com/neumie/helm/pull/1', '2026-01-01T00:00:00.000Z', {
		progress,
		command,
	})
	assert.equal(first, null)
	assert.equal(progress.incomplete, true)
	assert.equal(statusCalls, DEPLOY_MAX_DEPLOYMENTS_PER_PR)
	const second = await fetchDeployState('https://github.com/neumie/helm/pull/1', '2026-01-01T00:00:01.000Z', {
		progress,
		command,
	})
	assert.equal(second?.deployments.length, DEPLOY_MAX_DEPLOYMENTS_PER_PR + 1)
	assert.equal(progress.incomplete, false)
})

test('101 deployments paginate, preserve failed status progress, and never return a partial state', async () => {
	const deployments = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, environment: `env-${index + 1}` }))
	const progress = { statuses: new Map(), incomplete: false }
	let failStatus21 = true
	let listPages = 0
	const command = async (_file: 'gh', args: string[]) => {
		if (args[0] === 'pr') return JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'sha' } })
		if (args[1]?.includes('/deployments?')) {
			listPages += 1
			return JSON.stringify(args[1].includes('&page=1') ? deployments.slice(0, 100) : deployments.slice(100))
		}
		if (args[1]?.includes('/deployments/21/') && failStatus21) throw new Error('temporary gh failure')
		return JSON.stringify([{ state: 'success' }])
	}
	const first = await fetchDeployState('https://github.com/neumie/helm/pull/2', '2026-01-01T00:00:00.000Z', {
		progress,
		command,
	})
	assert.equal(first, null)
	assert.equal(progress.statuses.size, 20)
	assert.equal(listPages, 2)
	const failed = await fetchDeployState('https://github.com/neumie/helm/pull/2', '2026-01-01T00:00:01.000Z', {
		progress,
		command,
	})
	assert.equal(failed, null)
	assert.equal(progress.statuses.size, 20, 'a failed status must not become a pending replacement')
	failStatus21 = false
	let result: Awaited<ReturnType<typeof fetchDeployState>> = null
	for (let tick = 0; tick < 5 && !result; tick += 1)
		result = await fetchDeployState('https://github.com/neumie/helm/pull/2', `2026-01-01T00:00:1${tick}.000Z`, {
			progress,
			command,
		})
	assert.equal(result?.deployments.length, 101)
	assert.equal(progress.incomplete, false)
	assert.equal(listPages, 2, 'complete paginated discovery is retained while status work continues')
})

test('merged multi-command deploy resumes from the exact 159/160 boundary without partial persistence', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-deploy-command-boundary-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const target = createShippedItem(db, 'target')
		for (let index = 0; index < 159; index += 1) createShippedItem(db, `filler-${index}`)
		const calls: string[][] = []
		const watcher = new DeployWatcher(config, db, {
			command: async (_file, args) => {
				calls.push(args)
				if (args[0] === 'pr')
					return JSON.stringify({
						state: args[2] === target.prUrl ? 'MERGED' : 'OPEN',
						mergeCommit: args[2] === target.prUrl ? { oid: 'target-sha' } : null,
					})
				if (args[1]?.includes('/deployments?'))
					return JSON.stringify([
						{ id: 1, environment: 'staging' },
						{ id: 2, environment: 'production' },
					])
				return JSON.stringify([{ state: 'success' }])
			},
		})

		await watcher.pollOnce()
		assert.equal(calls.length, 160, 'every production command, not candidate, consumes the shared budget')
		assert.equal(
			calls.findIndex(args => args[0] === 'pr' && args[2] === target.prUrl),
			159,
		)
		assert.equal(db.items.get(target.id)?.deployState, null, 'the partial observation is never persisted')

		await watcher.pollOnce()
		assert.equal(calls.length, 164, 'the deferred candidate gets a fresh budget on the next tick')
		assert.deepEqual(
			db.items.get(target.id)?.deployState?.deployments.map(deployment => deployment.environment),
			['staging', 'production'],
		)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('failed deploy status preserves prior state and never duplicates deploy success events', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-deploy-state-preservation-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const item = createShippedItem(db, 'preserve')
		const commands = new ItemCommands(db.items, config)
		const prior = {
			merged: true,
			mergedAt: '2026-01-01T00:00:00.000Z',
			mergeSha: 'sha',
			deployments: [{ environment: 'production', state: 'success', url: null, updatedAt: null }],
			checkedAt: '2026-01-01T00:00:00.000Z',
		}
		commands.recordDeployState(item.id, prior)
		let failStaging = true
		const watcher = new DeployWatcher(config, db, {
			command: async (_file, args) => {
				if (args[0] === 'pr') return JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'sha' } })
				if (args[1]?.includes('/deployments?'))
					return JSON.stringify([
						{ id: 1, environment: 'production' },
						{ id: 2, environment: 'staging' },
					])
				if (args[1]?.includes('/deployments/2/') && failStaging) throw new Error('transient status failure')
				return JSON.stringify([{ state: 'success' }])
			},
		})

		await watcher.pollOnce()
		assert.deepEqual(db.items.get(item.id)?.deployState, prior)
		assert.equal(db.items.getEvents(item.id).filter(event => event.eventType === 'deploy_succeeded').length, 1)

		failStaging = false
		await watcher.pollOnce()
		await watcher.pollOnce()
		assert.equal(db.items.getEvents(item.id).filter(event => event.eventType === 'deploy_succeeded').length, 2)
		assert.deepEqual(
			db.items.get(item.id)?.deployState?.deployments.map(deployment => deployment.environment),
			['production', 'staging'],
		)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('duplicate PR candidates share one production command observation per tick', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-deploy-pr-memo-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const first = createShippedItem(db, 'first')
		const second = createShippedItem(db, 'second')
		const commands = new ItemCommands(db.items, config)
		const prUrl = 'https://github.com/neumie/helm/pull/999'
		commands.recordDispatchPr(first.id, { prUrl, shippedByAgent: true })
		commands.recordDispatchPr(second.id, { prUrl, shippedByAgent: true })
		const calls: string[][] = []
		const watcher = new DeployWatcher(config, db, {
			command: async (_file, args) => {
				calls.push(args)
				if (args[0] === 'pr') return JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'shared-sha' } })
				if (args[1]?.includes('/deployments?')) return JSON.stringify([{ id: 1, environment: 'production' }])
				return JSON.stringify([{ state: 'success' }])
			},
		})

		await watcher.pollOnce()
		assert.equal(calls.length, 3, 'one PR view, deployment list, and status run for the shared PR')
		assert.ok(db.items.get(first.id)?.deployState)
		assert.ok(db.items.get(second.id)?.deployState)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('deploy poison no-result advances beyond the 160-candidate page', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-deploy-poison-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const items = Array.from({ length: 161 }, (_, index) => createShippedItem(db, `poison-${index}`))
		const called: string[] = []
		const watcher = new DeployWatcher(config, db, {
			fetchDeployState: async prUrl => {
				called.push(prUrl)
				return null
			},
		})
		await watcher.pollOnce()
		await watcher.pollOnce()
		assert.equal(called.length, 161)
		assert.ok(called.includes(items[160].prUrl as string), 'row 161 must not remain behind a handled no-result')
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('deploy first wave is profile-distinct and remote work never exceeds four', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-deploy-fair-'))
	const profiles = new ProfileStore(root, ['helm'])
	const ids = [profiles.activeProfile().id, profiles.create('B').id, profiles.create('C').id, profiles.create('D').id]
	const db = new DB(join(root, 'helm.db'), () => profiles.activeProfile().id)
	try {
		const byPr = new Map<string, string>()
		for (const profileId of ids) {
			for (let index = 0; index < 2; index += 1) {
				const item = createShippedItem(db.forProfile(profileId), `${profileId}-${index}`)
				byPr.set(item.prUrl as string, profileId)
			}
		}
		let release: (() => void) | undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let active = 0
		let maximum = 0
		const started: string[] = []
		const watcher = new DeployWatcher(
			config,
			db,
			{
				fetchDeployState: async prUrl => {
					started.push(byPr.get(prUrl) as string)
					active += 1
					maximum = Math.max(maximum, active)
					await gate
					active -= 1
					return null
				},
			},
			() => ids,
		)
		const tick = watcher.pollOnce()
		while (started.length < 4) await Promise.resolve()
		assert.deepEqual(new Set(started.slice(0, 4)), new Set(ids))
		assert.equal(maximum, 4)
		release?.()
		await tick
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('deploy enforces the 160-command candidate ceiling', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-deploy-ceiling-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		Array.from({ length: 161 }, (_, index) => createShippedItem(db, `ceiling-${index}`))
		let starts = 0
		const watcher = new DeployWatcher(config, db, {
			fetchDeployState: async () => {
				starts += 1
				return null
			},
		})
		await watcher.pollOnce()
		assert.equal(starts, 160)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('pre-aborted and post-stop observers admit no deploy or plan work', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-observer-admission-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		createShippedItem(db, 'deploy')
		const worktree = join(root, 'tree')
		createPlannedItem(db, 'plan', worktree)
		let deployCalls = 0
		let planCalls = 0
		const deploy = new DeployWatcher(config, db, {
			fetchDeployState: async () => {
				deployCalls += 1
				return null
			},
		})
		const plan = new PlanStatusWatcher(config, db, {
			fetchGithubQueues: async () => {
				planCalls += 1
				return new Map()
			},
		})
		const aborted = new AbortController()
		aborted.abort()
		await Promise.all([deploy.pollOnce(aborted.signal), plan.pollOnce(aborted.signal)])
		await Promise.all([deploy.stop(), plan.stop()])
		await Promise.all([deploy.pollOnce(), plan.pollOnce()])
		assert.equal(deployCalls, 0)
		assert.equal(planCalls, 0)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('plan stop drains an abort-ignoring pre-write barrier and suppresses persistence', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-plan-observer-stop-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const item = createPlannedItem(db, 'stop-plan', join(root, 'tree'))
		let release: (() => void) | undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let reachedBarrier = false
		const watcher = new PlanStatusWatcher(config, db, {
			fetchGithubQueues: async () => new Map(),
			beforeWrite: async () => {
				reachedBarrier = true
				await gate
			},
		})
		const tick = watcher.pollOnce()
		while (!reachedBarrier) await Promise.resolve()
		const firstStop = watcher.stop()
		const secondStop = watcher.stop()
		assert.equal(firstStop, secondStop)
		let drained = false
		void firstStop.then(() => {
			drained = true
		})
		await Promise.resolve()
		assert.equal(drained, false)
		release?.()
		await Promise.all([tick, firstStop])
		assert.equal(db.items.get(item.id)?.planStatus, null)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('watcher stop aborts admission, waits for an abort-ignoring dependency, and prevents its write', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-observer-stop-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const item = createShippedItem(db, 'stop')
		let release: (() => void) | undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let started = false
		const watcher = new DeployWatcher(config, db, {
			fetchDeployState: async () => {
				started = true
				await gate
				return { merged: false, mergedAt: null, mergeSha: null, deployments: [], checkedAt: '2026-01-01T00:00:00.000Z' }
			},
		})
		const tick = watcher.pollOnce()
		while (!started) await Promise.resolve()
		const firstStop = watcher.stop()
		const secondStop = watcher.stop()
		assert.equal(firstStop, secondStop)
		let drained = false
		void firstStop.then(() => {
			drained = true
		})
		await Promise.resolve()
		assert.equal(drained, false)
		release?.()
		await Promise.all([tick, firstStop])
		assert.equal(db.items.get(item.id)?.deployState, null)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})
