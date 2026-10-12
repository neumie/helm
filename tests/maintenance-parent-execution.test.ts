import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { PlanningApplication, PlanningError } from '../src/plan/application.js'
import type { TaskProvider } from '../src/providers/provider.js'
import type { LoopRunner } from '../src/queue/loop-runner.js'
import { processLoopItem, processSolveItem } from '../src/queue/worker.js'
import type { Solver } from '../src/solver/solver.js'
import type { Spawner } from '../src/spawner/spawner.js'
import { taskCancelled } from '../src/util/errors.js'
import { createWorktree } from '../src/worktree/manager.js'

const exec = promisify(execFile)
const provider: TaskProvider = {
	name: 'fixture',
	async pollNewTasks() {
		return []
	},
	async getTaskContext() {
		return null
	},
	async resolveTaskSummary() {
		return null
	},
	async postComment() {
		return null
	},
}

async function setup() {
	const root = mkdtempSync('/tmp/hm-pex-')
	const repo = join(root, 'repo')
	mkdirSync(repo)
	const git = (...args: string[]) => exec('git', args, { cwd: repo })
	await git('init', '-b', 'main')
	await git('config', 'user.name', 'Fixture')
	await git('config', 'user.email', 'fixture@example.test')
	writeFileSync(join(repo, 'tracked'), 'base')
	await git('add', 'tracked')
	await git('commit', '-m', 'base')
	const config = configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'fixture', apiToken: 'fixture' },
		projects: [{ slug: 'fixture', repoPath: repo, baseBranch: 'main' }],
		solver: { displayName: { enabled: false }, branchNaming: { enabled: false }, triage: { enabled: false } },
		github: { createPrs: false, postComments: false },
	})
	const db = new DB(join(root, 'test.db'))
	const commands = new ItemCommands(db.items, config)
	return {
		root,
		repo,
		config,
		db,
		commands,
		cleanup() {
			db.close()
			rmSync(root, { recursive: true, force: true })
		},
	}
}

for (const state of ['OPEN', 'MERGED', 'CLOSED'] as const) {
	test(`failure reconciliation runs gh in the owning worktree and filters PR state ${state}`, async () => {
		const f = await setup()
		const oldCwd = process.cwd()
		const oldPath = process.env.PATH
		try {
			process.chdir(f.root) // All worker logs/artifacts are disposable, never the live daemon root.
			const worktree = await createWorktree(f.repo, 'main', 'fix/fixture', join(f.root, 'worktrees'))
			writeFileSync(join(worktree, 'tracked'), 'ahead')
			await exec('git', ['commit', '-am', 'ahead'], { cwd: worktree })
			const item = f.commands.createSolveItem({ title: 'Fixture', projectSlug: 'fixture' })
			f.commands.beginPlanning(item.id)
			f.commands.recordPlanPrepared(item.id, {
				worktreePath: worktree,
				branchName: 'fix/fixture',
				planDirName: 'fixture',
				spawner: 'default',
			})
			const bin = join(f.root, 'bin')
			mkdirSync(bin)
			const trace = join(f.root, 'gh-call.json')
			const prUrl = 'https://github.com/fixture/owning-repo/pull/1'
			writeFileSync(
				join(bin, 'gh'),
				`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}));\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ state, url: prUrl }))});\n`,
				{ mode: 0o700 },
			)
			process.env.PATH = `${bin}:${oldPath ?? ''}`
			const solver: Solver = {
				async solve(params) {
					params.onWorktreeReady(worktree)
					return { worktreePath: worktree, branchName: params.branchName, outcome: { exitCode: 1, events: [] } }
				},
			}
			await processSolveItem(item.id, f.config, f.db, provider, solver)
			assert.equal(f.commands.getItem(item.id)?.status, 'review')
			assert.equal(f.commands.getItem(item.id)?.prUrl, state === 'CLOSED' ? null : prUrl)
			assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), {
				cwd: realpathSync(worktree),
				args: ['pr', 'view', 'fix/fixture', '--json', 'url,state'],
			})
		} finally {
			process.chdir(oldCwd)
			if (oldPath === undefined) Reflect.deleteProperty(process.env, 'PATH')
			else process.env.PATH = oldPath
			f.cleanup()
		}
	})
}

for (const kind of ['solve', 'loop'] as const) {
	test(`a retained Main path cannot enter ${kind} Worktree execution`, async () => {
		const f = await setup()
		const oldCwd = process.cwd()
		try {
			process.chdir(f.root)
			const item =
				kind === 'solve'
					? f.commands.createSolveItem({ title: 'Fixture', projectSlug: 'fixture' })
					: f.commands.createLoopItem({ title: 'Fixture', projectSlug: 'fixture', prdPath: 'prd.md' })
			f.commands.beginPlanning(item.id)
			f.commands.recordPlanPrepared(item.id, {
				worktreePath: f.repo,
				branchName: 'main',
				planDirName: 'fixture',
				spawner: 'default',
			})
			const before = readFileSync(join(f.repo, 'tracked'), 'utf8')
			if (kind === 'solve') {
				const solver: Solver = {
					async solve() {
						assert.fail('An isolated solve must not consume the Main checkout')
					},
				}
				await processSolveItem(item.id, f.config, f.db, provider, solver)
			} else {
				const runner: LoopRunner = {
					async runLoop() {
						assert.fail('An isolated loop must not consume the Main checkout')
					},
				}
				await processLoopItem(item.id, f.config, f.db, runner)
			}
			assert.equal(f.commands.getItem(item.id)?.status, 'failed')
			assert.equal(f.commands.getItem(item.id)?.errorPhase, 'worktree')
			assert.match(f.commands.getItem(item.id)?.errorMessage ?? '', /canonical project checkout/)
			assert.equal(readFileSync(join(f.repo, 'tracked'), 'utf8'), before)
		} finally {
			process.chdir(oldCwd)
			f.cleanup()
		}
	})
}

for (const evidence of ['own-literal', 'inherited', 'getter'] as const) {
	test(`cancelled pre-readiness planning accepts only own literal session evidence: ${evidence}`, async () => {
		const f = await setup()
		try {
			const item = f.commands.createSolveItem({ title: 'Fixture', projectSlug: 'fixture' })
			const controller = new AbortController()
			let getterCalls = 0
			const spawner: Spawner = {
				name: 'default',
				async startPlanningSession(params) {
					assert.equal(params.workspaceMode, 'worktree')
					controller.abort()
					const error = taskCancelled()
					if (evidence === 'own-literal') Object.defineProperty(error, 'sessionMayExist', { value: true })
					else if (evidence === 'inherited')
						Object.setPrototypeOf(error, Object.assign(Object.create(Error.prototype), { sessionMayExist: true }))
					else
						Object.defineProperty(error, 'sessionMayExist', {
							get() {
								getterCalls++
								return true
							},
						})
					throw error
				},
			}
			const app = new PlanningApplication(f.config, f.commands, provider, spawner, async () => {
				assert.fail('No adapter replacement')
			})
			await assert.rejects(app.prepare({ itemId: item.id, signal: controller.signal }), error => {
				assert.ok(error instanceof PlanningError)
				assert.equal(error.code, 'cancelled')
				assert.equal(error.sessionMayExist, evidence === 'own-literal')
				return true
			})
			assert.equal(getterCalls, 0)
			assert.equal(f.commands.getItem(item.id)?.worktreePath, null)
			assert.equal(f.commands.getItem(item.id)?.status, 'ready')
			assert.equal(existsSync(join(f.repo, 'docs', 'plans')), false)
		} finally {
			f.cleanup()
		}
	})
}
