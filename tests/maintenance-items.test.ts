import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import type { DeployState, ItemRecord } from '../src/items/schema.js'
import { ItemStore } from '../src/items/store.js'
import { PlanningApplication } from '../src/plan/application.js'
import type { TaskProvider } from '../src/providers/provider.js'
import { Drainer } from '../src/queue/drainer.js'
import type { Solver } from '../src/solver/solver.js'
import type { Spawner } from '../src/spawner/spawner.js'

const config = configSchema.parse({
	provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'test' },
	projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
})
const profileB = 'profile-aaaaaaaaaaaa'
const plan = { worktreePath: '/tmp/maintenance-plan', branchName: 'feat/plan', planDirName: 'plan', spawner: 'default' }
const deploy: DeployState = {
	merged: true,
	mergedAt: '2026-01-01T00:00:00.000Z',
	mergeSha: 'abc',
	checkedAt: '2026-01-01T00:00:00.000Z',
	deployments: [],
}

function withDb(run: (db: DB) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'helm-maint-items-'))
	const db = new DB(join(root, 'helm.db'))
	try {
		run(db)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
}

function solve(commands: ItemCommands): ItemRecord {
	return commands.createSolveItem({ title: 'transaction fixture', projectSlug: 'helm' })
}
function running(commands: ItemCommands): ItemRecord {
	return commands.startItem(solve(commands).id)
}
function failed(commands: ItemCommands): ItemRecord {
	return commands.failItem(running(commands).id, 'fixture failure', 'solve')
}
function review(commands: ItemCommands): ItemRecord {
	return commands.completeSolveItem(running(commands).id, { ...plan, resultSummary: 'completed' })
}
function loop(commands: ItemCommands): ItemRecord {
	return commands.startItem(commands.createLoopItem({ title: 'loop', projectSlug: 'helm', prdPath: 'prd.md' }).id)
}
function inbox(commands: ItemCommands): ItemRecord {
	return commands.createSolveItem({
		title: 'source',
		projectSlug: 'helm',
		source: { provider: 'test', externalId: '1' },
	})
}

type Transition = {
	name: string
	setup: (commands: ItemCommands) => ItemRecord
	act: (commands: ItemCommands, item: ItemRecord) => unknown
}
const transitions: Transition[] = [
	{ name: 'approveItem', setup: inbox, act: (c, i) => c.approveItem(i.id) },
	{ name: 'rejectItem', setup: inbox, act: (c, i) => c.rejectItem(i.id) },
	{ name: 'startItem', setup: solve, act: (c, i) => c.startItem(i.id) },
	{ name: 'retryItem', setup: failed, act: (c, i) => c.retryItem(i.id) },
	{ name: 'cancelQueuedItem', setup: solve, act: (c, i) => c.cancelQueuedItem(i.id) },
	{ name: 'cancelProcessingItem', setup: running, act: (c, i) => c.cancelProcessingItem(i.id, 'cancel', 'solve') },
	{ name: 'failItem', setup: running, act: (c, i) => c.failItem(i.id, 'failure', 'solve') },
	{
		name: 'reconcileFailedSolve',
		setup: running,
		act: (c, i) => c.reconcileFailedSolve(i.id, { message: 'failure', phase: 'solve' }),
	},
	{ name: 'reopenItem', setup: failed, act: (c, i) => c.reopenItem(i.id) },
	{
		name: 'completeSolveItem',
		setup: running,
		act: (c, i) => c.completeSolveItem(i.id, { ...plan, resultSummary: 'done' }),
	},
	{ name: 'recordAlmanacRunId', setup: loop, act: (c, i) => c.recordAlmanacRunId(i.id, 'run-1') },
	{ name: 'completeLoopItem', setup: loop, act: (c, i) => c.completeLoopItem(i.id, { resultSummary: 'done' }) },
	{
		name: 'recordDispatchPr',
		setup: review,
		act: (c, i) => c.recordDispatchPr(i.id, { prUrl: 'https://example.test/pr/1' }),
	},
	{ name: 'recordDeployState', setup: review, act: (c, i) => c.recordDeployState(i.id, deploy) },
	{ name: 'setItemStatus', setup: solve, act: (c, i) => c.setItemStatus(i.id, 'active') },
	{ name: 'markItemMerged', setup: review, act: (c, i) => c.markItemMerged(i.id) },
	{ name: 'beginPlanning', setup: solve, act: (c, i) => c.beginPlanning(i.id) },
	{
		name: 'abortPlanning',
		setup: c => c.beginPlanning(solve(c).id),
		act: (c, i) => c.abortPlanning(i.id, { ...i, status: 'ready', workMode: null }),
	},
	{
		name: 'recordPlanPrepared',
		setup: c => c.beginPlanning(solve(c).id),
		act: (c, i) => c.recordPlanPrepared(i.id, plan),
	},
	{
		name: 'assignItem',
		setup: c => c.createSolveItem({ title: 'unassigned', projectSlug: null }),
		act: (c, i) => c.assignItem(i.id, { projectSlug: 'helm' }),
	},
	{
		name: 'linkSourceTask',
		setup: c =>
			c.createSolveItem({
				title: 'captured',
				projectSlug: 'helm',
				source: { provider: 'Email', externalId: 'email' },
				capturedContext: { title: 'captured' },
			}),
		act: (c, i) => c.linkSourceTask(i.id, { provider: 'Contember', externalId: 'task' }),
	},
]

for (const transition of transitions) {
	test(`${transition.name} rolls back its row and event on event-write failure`, () =>
		withDb(db => {
			const commands = new ItemCommands(db.items, config)
			const item = transition.setup(commands)
			const before = db.items.get(item.id)
			const events = db.items.getEvents(item.id)
			const original = db.items.insertEvent.bind(db.items)
			db.items.insertEvent = (...args) => {
				original(...args)
				throw new Error('injected event failure')
			}
			try {
				assert.throws(() => transition.act(commands, item), /injected event failure/)
			} finally {
				db.items.insertEvent = original
			}
			assert.deepEqual(db.items.get(item.id), before)
			assert.deepEqual(db.items.getEvents(item.id), events)
			assert.doesNotThrow(() => transition.act(commands, item))
		}))
}

test('recordDeployState rolls back earlier milestone events when a later milestone fails', () =>
	withDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = review(commands)
		const before = db.items.getEvents(item.id)
		const next: DeployState = {
			...deploy,
			deployments: [{ environment: 'production', state: 'success', url: null, updatedAt: deploy.checkedAt }],
		}
		const original = db.items.insertEvent.bind(db.items)
		db.items.insertEvent = (...args) => {
			original(...args)
			if (args[1] === 'deploy_succeeded') throw new Error('later milestone failed')
		}
		try {
			assert.throws(() => commands.recordDeployState(item.id, next), /later milestone failed/)
		} finally {
			db.items.insertEvent = original
		}
		assert.equal(db.items.get(item.id)?.deployState, null)
		assert.deepEqual(db.items.getEvents(item.id), before)
		commands.recordDeployState(item.id, next)
		commands.recordDeployState(item.id, next)
		assert.equal(db.items.countEvents(item.id, 'deploy_merged'), 1)
		assert.equal(db.items.countEvents(item.id, 'deploy_succeeded'), 1)
	}))

for (const kind of ['solve', 'loop'] as const) {
	test(`create ${kind} siblings rolls back all inserts on a later failure`, () =>
		withDb(db => {
			const commands = new ItemCommands(db.items, config)
			const original = db.items.create.bind(db.items)
			let count = 0
			db.items.create = input => {
				const item = original(input)
				if (++count === 2) throw new Error('second insert failed')
				return item
			}
			try {
				assert.throws(
					() =>
						kind === 'solve'
							? commands.createSolveItems({ title: 'siblings', projectSlug: 'helm', parallelism: 3 })
							: commands.createLoopItems({ title: 'siblings', projectSlug: 'helm', prdPath: 'prd.md', parallelism: 3 }),
					/second insert failed/,
				)
			} finally {
				db.items.create = original
			}
			assert.deepEqual(db.items.list(), [])
		}))
}

test('latest planning outcome beyond display history controls Start, including timestamp ties and tenant isolation', t =>
	withDb(db => {
		t.mock.method(Date.prototype, 'toISOString', () => '2026-01-01T00:00:00.000Z')
		const commands = new ItemCommands(db.items, config)
		const app = new PlanningApplication(config, commands, {} as TaskProvider, {} as Spawner, async () => {
			throw new Error('unused')
		})
		const item = commands.beginPlanning(solve(commands).id)
		commands.recordPlanPrepared(item.id, plan)
		for (let index = 0; index < 110; index++) commands.recordEvent(item.id, 'fixture_activity')
		const display = db.items.getEvents(item.id)
		commands.abortPlanning(item.id, item)
		assert.equal(db.items.latestPlanningOutcome(item.id), 'planning_failed')
		assert.throws(() => app.assertStartAllowed(item.id), /incomplete/)
		assert.equal(db.forProfile(profileB).items.latestPlanningOutcome(item.id), null)
		commands.beginPlanning(item.id)
		commands.recordPlanPrepared(item.id, plan)
		assert.equal(db.items.latestPlanningOutcome(item.id), 'plan_prepared')
		assert.doesNotThrow(() => app.assertStartAllowed(item.id))
		assert.equal(display.length, 100)
		assert.deepEqual(db.items.getEvents(item.id), display)
	}))

test('recovery failure after the first page rolls back every row and event, and remains retryable', () =>
	withDb(db => {
		const commands = new ItemCommands(db.items, config)
		const items = Array.from({ length: 52 }, () => running(commands))
		const original = db.items.insertEvent.bind(db.items)
		let count = 0
		db.items.insertEvent = (...args) => {
			original(...args)
			if (args[1] === 'item_recovered' && ++count === 51) throw new Error('second page failed')
		}
		try {
			assert.throws(() => commands.recoverStaleProcessingItems(), /second page failed/)
		} finally {
			db.items.insertEvent = original
		}
		for (const item of items) {
			assert.deepEqual(db.items.get(item.id), item)
			assert.equal(db.items.countEvents(item.id, 'item_recovered'), 0)
		}
		assert.equal(commands.recoverStaleProcessingItems().length, 52)
		assert.deepEqual(commands.recoverStaleProcessingItems(), [])
	}))

test('paused Drainer recovers more than 50 stale Items of each kind in every profile', () =>
	withDb(db => {
		const tenants = ['work', profileB].map(profileId => {
			const store = db.forProfile(profileId).items
			const commands = new ItemCommands(store, config)
			return {
				store,
				items: [
					...Array.from({ length: 52 }, () => running(commands)),
					...Array.from({ length: 52 }, () => loop(commands)),
				],
			}
		})
		db.setAppState('drainer_paused', 'true')
		const drainer = new Drainer(config, db, {} as TaskProvider, {} as Solver, undefined, () => ['work', profileB])
		try {
			drainer.start()
			assert.equal(drainer.isPaused(), true)
			for (const { store, items } of tenants) {
				for (const item of items) {
					assert.equal(store.get(item.id)?.status, 'ready')
					assert.equal(store.countEvents(item.id, 'item_recovered'), 1)
				}
				assert.deepEqual(store.listProcessingByKind('solve'), [])
				assert.deepEqual(store.listProcessingByKind('loop'), [])
			}
		} finally {
			drainer.stop()
		}
	}))

for (const registeredProfiles of [false, true]) {
	test(`failed Drainer recovery is not marked complete (${registeredProfiles ? 'registered' : 'current'} profile)`, t =>
		withDb(db => {
			const commands = new ItemCommands(db.items, config)
			const item = running(commands)
			const original = ItemStore.prototype.insertEvent
			let fail = true
			t.mock.method(
				ItemStore.prototype,
				'insertEvent',
				function (this: ItemStore, ...args: Parameters<ItemStore['insertEvent']>) {
					original.apply(this, args)
					if (args[1] === 'item_recovered' && fail) {
						fail = false
						throw new Error('recovery unavailable')
					}
				},
			)
			db.setAppState('drainer_paused', 'true')
			const drainer = new Drainer(
				config,
				db,
				{} as TaskProvider,
				{} as Solver,
				undefined,
				registeredProfiles ? () => ['work'] : undefined,
			)
			try {
				assert.throws(() => drainer.start(), /recovery unavailable/)
				assert.equal(db.items.get(item.id)?.status, 'running')
				assert.equal(db.items.countEvents(item.id, 'item_recovered'), 0)
				drainer.start()
				assert.equal(db.items.get(item.id)?.status, 'ready')
				assert.equal(db.items.countEvents(item.id, 'item_recovered'), 1)
			} finally {
				drainer.stop()
			}
		}))
}
