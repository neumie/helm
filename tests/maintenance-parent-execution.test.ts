import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
import { phaseError, taskCancelled } from '../src/util/errors.js'
import { createWorktree } from '../src/worktree/manager.js'

const exec = promisify(execFile)
const sameRealPath = (left: string, right: string) => realpathSync(left) === realpathSync(right)
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

/** The agent's result goes to Helm's run state (cwd-relative here: no profile runtime). */
function writeRunResult(resultPath: string): void {
	mkdirSync(dirname(resultPath), { recursive: true })
	writeFileSync(resultPath, JSON.stringify({ summary: 'done' }))
}

async function gitStatus(cwd: string): Promise<string> {
	return (await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd })).stdout
}

/** A Main plan as the Plan route leaves it in the canonical checkout. */
function writeMainPlan(repo: string, planDirName: string): string {
	const dir = join(repo, 'docs', 'plans', planDirName)
	mkdirSync(join(dir, 'issues'), { recursive: true })
	writeFileSync(join(dir, 'prd.md'), '# Plan written in Main\n')
	writeFileSync(join(dir, 'issues', '01-first.md'), '---\nstatus: ready-for-agent\n---\n# First\n')
	writeFileSync(join(dir, 'solver-result.json'), '{"summary":"result of an earlier Main attempt"}')
	writeFileSync(join(dir, '.planning-prompt.txt'), 'planning prompt')
	return dir
}

for (const kind of ['solve', 'loop'] as const) {
	test(`a ${kind} planned in Main runs in Worktree in its own worktree with the plan copied`, async () => {
		const f = await setup()
		const oldCwd = process.cwd()
		try {
			process.chdir(f.root)
			const item =
				kind === 'solve'
					? f.commands.createSolveItem({ title: 'Fixture', projectSlug: 'fixture' })
					: f.commands.createLoopItem({ title: 'Fixture', projectSlug: 'fixture', prdPath: 'prd.md' })
			f.commands.beginPlanning(item.id)
			// A legacy Main plan that also kept the checkout's branch (here the base branch).
			f.commands.recordPlanPrepared(item.id, {
				worktreePath: f.repo,
				branchName: 'main',
				planDirName: 'fixture',
				spawner: 'default',
			})
			f.commands.setItemStatus(item.id, 'ready')
			const planDir = writeMainPlan(f.repo, 'fixture')
			const statusBefore = await gitStatus(f.repo)
			const headBefore = (await exec('git', ['rev-parse', 'HEAD'], { cwd: f.repo })).stdout
			let ranIn: string | null = null
			let ranOn: string | null = null
			if (kind === 'solve') {
				const solver: Solver = {
					async solve(params) {
						assert.equal(params.existingWorktreePath, undefined)
						assert.equal(params.workspaceMode, 'worktree')
						const worktree = await createWorktree(f.repo, 'main', params.branchName, join(f.root, 'worktrees'))
						params.onWorktreeReady(worktree)
						ranIn = worktree
						ranOn = params.branchName
						assert.equal(readFileSync(join(worktree, 'docs/plans/fixture/prd.md'), 'utf8'), '# Plan written in Main\n')
						assert.ok(existsSync(join(worktree, 'docs/plans/fixture/issues/01-first.md')))
						assert.equal(existsSync(join(worktree, 'docs/plans/fixture/solver-result.json')), false)
						assert.equal(existsSync(join(worktree, 'docs/plans/fixture/.planning-prompt.txt')), false)
						writeRunResult(params.resultPath)
						return { worktreePath: worktree, branchName: params.branchName, outcome: { exitCode: 0, events: [] } }
					},
				}
				await processSolveItem(item.id, f.config, f.db, provider, solver)
			} else {
				const runner: LoopRunner = {
					async runLoop(params) {
						ranIn = params.worktreePath
						ranOn = params.branchName
						assert.equal(
							readFileSync(join(params.worktreePath, 'docs/plans/fixture/prd.md'), 'utf8'),
							'# Plan written in Main\n',
						)
						assert.ok(existsSync(join(params.worktreePath, 'docs/plans/fixture/issues/01-first.md')))
						assert.equal(existsSync(join(params.worktreePath, 'docs/plans/fixture/solver-result.json')), false)
						return { runId: 'fixture-run' }
					},
				}
				await processLoopItem(item.id, f.config, f.db, runner)
			}
			const after = f.commands.getItem(item.id)
			assert.equal(after?.errorMessage, null)
			assert.equal(after?.status, kind === 'solve' ? 'review' : 'done')
			assert.ok(ranIn)
			assert.equal(sameRealPath(ranIn, f.repo), false)
			assert.notEqual(ranOn, 'main')
			assert.equal(after?.branchName, ranOn)
			assert.equal(sameRealPath(after?.worktreePath ?? '', ranIn), true)
			assert.equal((await exec('git', ['branch', '--show-current'], { cwd: ranIn })).stdout.trim(), ranOn)
			// The canonical checkout is read, never changed.
			assert.equal(await gitStatus(f.repo), statusBefore)
			assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: f.repo })).stdout, headBefore)
			assert.equal(
				readFileSync(join(planDir, 'solver-result.json'), 'utf8'),
				'{"summary":"result of an earlier Main attempt"}',
			)
		} finally {
			process.chdir(oldCwd)
			f.cleanup()
		}
	})
}

test('an Item run in Main and recovered gets its own worktree when retried in Worktree', async () => {
	const f = await setup()
	const oldCwd = process.cwd()
	try {
		process.chdir(f.root)
		const item = f.commands.createSolveItem({ title: 'Fixture', projectSlug: 'fixture' })
		// The stranded production state: a Main run recorded the checkout as its
		// workspace (branchless), then a daemon restart recovered it to Queue.
		f.commands.setSolveItemWorkspace(item.id, 'main')
		f.commands.startItem(item.id)
		f.commands.recordExecutionWorkspaceIdentity(item.id, {
			worktreePath: f.repo,
			planDirName: 'fixture',
			branchName: null,
		})
		f.commands.recoverStaleProcessingItems()
		f.commands.setSolveItemWorkspace(item.id, 'worktree')
		const stray = join(f.repo, 'docs', 'plans', 'fixture')
		mkdirSync(stray, { recursive: true })
		writeFileSync(join(stray, 'notes.md'), 'left by the Main agent')
		const statusBefore = await gitStatus(f.repo)
		let ranIn: string | null = null
		const solver: Solver = {
			async solve(params) {
				assert.equal(params.existingWorktreePath, undefined)
				const worktree = await createWorktree(f.repo, 'main', params.branchName, join(f.root, 'worktrees'))
				params.onWorktreeReady(worktree)
				ranIn = worktree
				// Not a plan: nothing from the checkout's plan dir comes along.
				assert.equal(existsSync(join(worktree, 'docs/plans/fixture/notes.md')), false)
				writeRunResult(params.resultPath)
				return { worktreePath: worktree, branchName: params.branchName, outcome: { exitCode: 0, events: [] } }
			},
		}
		await processSolveItem(item.id, f.config, f.db, provider, solver)
		const after = f.commands.getItem(item.id)
		assert.equal(after?.errorMessage, null)
		assert.equal(after?.status, 'review')
		assert.ok(ranIn)
		assert.equal(sameRealPath(after?.worktreePath ?? '', ranIn), true)
		assert.match(after?.branchName ?? '', /^helm\/item\//)
		assert.equal(await gitStatus(f.repo), statusBefore)
	} finally {
		process.chdir(oldCwd)
		f.cleanup()
	}
})

test('a Main plan survives a failed Worktree attempt: the retry reuses its branch and still gets the plan', async () => {
	const f = await setup()
	const oldCwd = process.cwd()
	try {
		process.chdir(f.root)
		const config = configSchema.parse({ ...f.config, solver: { ...f.config.solver, branchNaming: { enabled: true } } })
		const commands = new ItemCommands(f.db.items, config)
		const item = commands.createSolveItem({ title: 'Fixture', projectSlug: 'fixture' })
		commands.beginPlanning(item.id)
		commands.recordPlanPrepared(item.id, {
			worktreePath: f.repo,
			branchName: null,
			planDirName: 'fixture',
			spawner: 'default',
		})
		commands.setItemStatus(item.id, 'ready')
		writeMainPlan(f.repo, 'fixture')
		let names = 0
		const deps = {
			workspaceName: {
				// A model that answers differently each time, as real ones may.
				runOneShot: async () => `feat/email-terms-${++names}`,
				branchExists: async () => false,
			},
		}
		const created: string[] = []
		const failing: Solver = {
			async solve(params) {
				created.push(await createWorktree(f.repo, 'main', params.branchName, join(f.root, 'worktrees')))
				throw phaseError('worktree', 'Okena did not show the worktree in time')
			},
		}
		await processSolveItem(item.id, config, f.db, provider, failing, undefined, deps)
		const failed = commands.getItem(item.id)
		assert.equal(failed?.status, 'failed')
		assert.equal(failed?.planDirName, 'fixture')
		assert.equal(failed?.branchName, 'feat/email-terms-1')

		commands.retryItem(item.id)
		let ranIn: string | null = null
		const solver: Solver = {
			async solve(params) {
				assert.equal(params.branchName, 'feat/email-terms-1')
				assert.equal(params.planDirName, 'fixture')
				const worktree = await createWorktree(f.repo, 'main', params.branchName, join(f.root, 'worktrees'))
				params.onWorktreeReady(worktree)
				ranIn = worktree
				assert.equal(readFileSync(join(worktree, 'docs/plans/fixture/prd.md'), 'utf8'), '# Plan written in Main\n')
				writeRunResult(params.resultPath)
				return { worktreePath: worktree, branchName: params.branchName, outcome: { exitCode: 0, events: [] } }
			},
		}
		await processSolveItem(item.id, config, f.db, provider, solver, undefined, deps)
		assert.equal(commands.getItem(item.id)?.status, 'review')
		assert.ok(ranIn)
		assert.equal(sameRealPath(ranIn, created[0] ?? ''), true)
	} finally {
		process.chdir(oldCwd)
		f.cleanup()
	}
})

test('a Worktree run failing before its worktree exists is not reconciled against the checkout', async () => {
	const f = await setup()
	const oldCwd = process.cwd()
	try {
		process.chdir(f.root)
		const item = f.commands.createSolveItem({ title: 'Fixture', projectSlug: 'fixture' })
		f.commands.setSolveItemWorkspace(item.id, 'main')
		f.commands.startItem(item.id)
		f.commands.recordExecutionWorkspaceIdentity(item.id, {
			worktreePath: f.repo,
			planDirName: 'fixture',
			branchName: null,
		})
		f.commands.recoverStaleProcessingItems()
		f.commands.setSolveItemWorkspace(item.id, 'worktree')
		// The checkout sits on the Main agent's branch, ahead of base.
		await exec('git', ['checkout', '-b', 'agent/main-run'], { cwd: f.repo })
		writeFileSync(join(f.repo, 'tracked'), 'main run work')
		await exec('git', ['commit', '-am', 'main run work'], { cwd: f.repo })
		const solver: Solver = {
			async solve() {
				throw new Error('Okena state failed (401)')
			},
		}
		await processSolveItem(item.id, f.config, f.db, provider, solver)
		const after = f.commands.getItem(item.id)
		assert.equal(after?.status, 'failed')
		assert.equal(after?.runOutcome, 'errored')
	} finally {
		process.chdir(oldCwd)
		f.cleanup()
	}
})

test('a Main run keeps the canonical checkout when Workspace stays Main', async () => {
	const f = await setup()
	const oldCwd = process.cwd()
	try {
		process.chdir(f.root)
		const item = f.commands.createSolveItem({ title: 'Fixture', projectSlug: 'fixture' })
		f.commands.setSolveItemWorkspace(item.id, 'main')
		let ranIn: string | null = null
		const solver: Solver = {
			async solve(params) {
				assert.equal(params.workspaceMode, 'main')
				params.onWorktreeReady(f.repo)
				ranIn = f.repo
				return { worktreePath: f.repo, branchName: params.branchName, outcome: { exitCode: 1, events: [] } }
			},
		}
		await processSolveItem(item.id, f.config, f.db, provider, solver)
		assert.equal(ranIn, f.repo)
		assert.equal(sameRealPath(f.commands.getItem(item.id)?.worktreePath ?? '', f.repo), true)
		assert.equal(f.commands.getItem(item.id)?.branchName, null)
	} finally {
		process.chdir(oldCwd)
		f.cleanup()
	}
})

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
