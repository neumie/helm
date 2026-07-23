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
		const watcher = new PlanStatusWatcher(manyConfig, db, {
			fetchGithubQueues: async repoPath => {
				fetched.add(repoPath)
				return new Map()
			},
		})
		await watcher.pollOnce()
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
