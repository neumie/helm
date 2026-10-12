import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { OkenaClient } from '../src/extensions/okena/client.js'
import { OkenaSolver } from '../src/extensions/okena/solver.js'
import { OkenaSpawner } from '../src/extensions/okena/spawner.js'
import type { OkenaWorktreeManager } from '../src/extensions/okena/worktree.js'
import { ItemCommands } from '../src/items/commands.js'
import { Drainer } from '../src/queue/drainer.js'

const config = configSchema.parse({
	provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'fixture' },
	projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}

for (const transition of [
	'unchanged',
	'cancelled',
	'done',
	'review',
	'new-failure',
	'new-success',
	'replacement',
	'manual-retry',
	'status-roundtrip',
	'stopped',
] as const) {
	test(`Drainer automatic retry binds its failed attempt: ${transition}`, t => {
		t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 })
		const root = mkdtempSync(join(tmpdir(), 'helm-retry-'))
		const db = new DB(join(root, 'helm.db'))
		const commands = new ItemCommands(db.items, config)
		const drainer = new Drainer(config, db, {} as never, {} as never)
		try {
			drainer.start() // Default pause prevents the test from launching a process.
			const item = commands.createSolveItem({ projectSlug: 'helm', title: 'Retry fixture' })
			commands.startItem(item.id)
			commands.failItem(item.id, 'network unavailable', 'poll')
			// Exercise the real completion scheduling seam without invoking an agent.
			const completion = drainer as unknown as { maybeScheduleRetry(id: string, db: DB): void }
			completion.maybeScheduleRetry(item.id, db)
			if (transition === 'cancelled' || transition === 'done' || transition === 'review') {
				commands.setItemStatus(item.id, transition)
			} else if (transition === 'new-failure' || transition === 'new-success' || transition === 'replacement') {
				commands.retryItem(item.id)
				commands.startItem(item.id)
				if (transition === 'new-success') {
					commands.completeSolveItem(item.id, {
						worktreePath: '/fixture',
						branchName: 'fix/fixture',
						planDirName: 'fixture',
						resultSummary: 'Keep this newer result',
					})
					commands.recordDispatchPr(item.id, { prUrl: 'https://github.com/fixture/repo/pull/1' })
				} else {
					commands.failItem(item.id, 'network unavailable', 'poll')
					if (transition === 'replacement') completion.maybeScheduleRetry(item.id, db)
				}
			} else if (transition === 'manual-retry') {
				drainer.retryItem(item.id)
			} else if (transition === 'status-roundtrip') {
				commands.setItemStatus(item.id, 'done')
				commands.setItemStatus(item.id, 'failed')
			} else if (transition === 'stopped') drainer.stop()
			const before = db.items.get(item.id)
			const retries = db.items.countEvents(item.id, 'item_retried')
			t.mock.timers.tick(30_000)
			if (transition === 'unchanged') {
				assert.equal(db.items.get(item.id)?.status, 'ready')
				assert.equal(db.items.countEvents(item.id, 'item_retried'), retries + 1)
			} else {
				assert.deepEqual(db.items.get(item.id), before)
				assert.equal(db.items.countEvents(item.id, 'item_retried'), retries)
				if (transition === 'replacement') {
					t.mock.timers.tick(30_000)
					assert.equal(db.items.get(item.id)?.status, 'ready')
					assert.equal(db.items.countEvents(item.id, 'item_retried'), retries + 1)
				}
			}
		} finally {
			drainer.stop()
			db.close()
			rmSync(root, { recursive: true, force: true })
		}
	})
}

for (const kind of ['solve', 'plan'] as const) {
	for (const boundary of ['pre-aborted', 'workspace', 'lookup', 'close', 'create', 'rename'] as const) {
		if (kind === 'solve' && (boundary === 'lookup' || boundary === 'close')) continue
		test(`Okena ${kind} cancellation fences the next effect after ${boundary}`, async t => {
			const root = mkdtempSync(join(tmpdir(), 'helm-abort-'))
			t.after(() => rmSync(root, { recursive: true, force: true }))
			const controller = new AbortController()
			const reached = deferred<void>()
			const release = deferred<void>()
			const effects: string[] = []
			async function effect(name: string) {
				effects.push(name)
				if (name === boundary) {
					reached.resolve()
					await release.promise
				}
			}
			const worktrees = {
				ensureWorktreeProject: async () => {
					await effect('workspace')
					return { wtProjectId: 'project', worktreePath: root }
				},
				findPlanTerminal: async () => {
					await effect('lookup')
					return boundary === 'close' ? 'existing-plan' : null
				},
				createTerminal: async () => {
					await effect('create')
					return 'terminal'
				},
			} as unknown as OkenaWorktreeManager
			const client = {
				action: async (payload: { action: string }) => {
					await effect(payload.action === 'close_terminal' ? 'close' : 'rename')
					return {}
				},
				runCommand: async () => {
					effects.push('run')
				},
			} as unknown as OkenaClient
			if (boundary === 'pre-aborted') controller.abort()
			const params = {
				projectConfig: config.projects[0],
				branchName: 'fix/fixture',
				planDirName: 'fixture',
				taskTitle: 'Fixture',
				taskId: 'fixture',
				itemId: 'fixture',
				canonicalContext: { title: 'Fixture' },
				onWorktreeReady: () => {
					effects.push('ready')
					return { title: 'Fixture' }
				},
				solverConfig: config.solver,
				signal: controller.signal,
				replaceExistingSession: true,
			}
			const operation =
				kind === 'solve'
					? new OkenaSolver(client, worktrees).solve(params)
					: new OkenaSpawner(client, worktrees).startPlanningSession(params)
			const rejected = assert.rejects(operation, error => {
				assert.equal((error as Error).name, 'AbortError')
				if (kind === 'plan' && boundary === 'workspace') {
					assert.equal((error as Error & { sessionMayExist?: boolean }).sessionMayExist, true)
				}
				return true
			})
			if (boundary !== 'pre-aborted') {
				await reached.promise
				controller.abort()
				release.resolve()
			}
			await rejected
			if (boundary === 'pre-aborted') assert.deepEqual(effects, [])
			else assert.equal(effects.at(-1), boundary)
			assert.ok(!effects.includes('run'))
		})
	}
}

test('Okena runCommand aborts fresh-terminal settling before line clear or command', async () => {
	const actions: unknown[] = []
	const client = {
		action: async (payload: unknown) => {
			actions.push(payload)
		},
	} as unknown as OkenaClient
	const controller = new AbortController()
	const operation = OkenaClient.prototype.runCommand.call(client, 'terminal', 'fixture', {
		freshTerminal: true,
		signal: controller.signal,
	})
	const rejected = assert.rejects(operation, { name: 'AbortError' })
	controller.abort()
	await rejected
	assert.deepEqual(actions, [])
})

for (const actionSucceeds of [false, true]) {
	test(`Okena runCommand rechecks cancellation after delayed line-clear ${actionSucceeds ? 'success' : 'failure'}`, async () => {
		const controller = new AbortController()
		const reached = deferred<void>()
		const release = deferred<void>()
		const actions: string[] = []
		const client = {
			action: async (payload: { action: string }) => {
				actions.push(payload.action)
				reached.resolve()
				await release.promise
				if (!actionSucceeds) throw new Error('line clear unavailable')
			},
		} as unknown as OkenaClient
		const operation = OkenaClient.prototype.runCommand.call(client, 'terminal', 'fixture', {
			freshTerminal: true,
			signal: controller.signal,
		})
		const rejected = assert.rejects(operation, { name: 'AbortError' })
		await reached.promise
		controller.abort()
		release.resolve()
		await rejected
		assert.deepEqual(actions, ['send_special_key'])
	})
}

test('Okena runCommand keeps normal dispatch exactly once and refuses pre-aborted dispatch', async () => {
	const actions: unknown[] = []
	const client = {
		action: async (payload: unknown) => {
			actions.push(payload)
		},
	} as unknown as OkenaClient
	await OkenaClient.prototype.runCommand.call(client, 'terminal', 'fixture')
	assert.deepEqual(actions, [{ action: 'run_command', terminal_id: 'terminal', command: 'fixture' }])
	await assert.rejects(
		OkenaClient.prototype.runCommand.call(client, 'terminal', 'fixture', { signal: AbortSignal.abort() }),
		{ name: 'AbortError' },
	)
	assert.equal(actions.length, 1)
})
