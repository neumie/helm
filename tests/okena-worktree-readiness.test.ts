import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import type { OkenaClient, OkenaLayoutNode, OkenaState } from '../src/extensions/okena/client.js'
import { OkenaSolver } from '../src/extensions/okena/solver.js'
import { OkenaWorktreeManager } from '../src/extensions/okena/worktree.js'
import { PlanWorkspace } from '../src/plan/workspace.js'
import { errorPhase } from '../src/util/errors.js'

/**
 * Okena >= 0.36 creates worktrees OPTIMISTICALLY: `create_worktree` registers
 * the row (`is_creating`, no layout, no PTY) and answers `{ pending: true }`
 * before the background `git worktree add` finishes. With `wait: true` it
 * answers only once the checkout exists and the worktree's terminal runs.
 * Older daemons reject `wait` (their ActionRequest denies unknown fields).
 */
interface FakeOkenaOptions {
	/** Okena that predates the `wait` flag rejects it as an unknown field. */
	supportsWait?: boolean
	/** getState() polls the optimistic checkout needs before it completes. */
	completeAfterPolls?: number
	/** Background checkout fails: Okena rolls the optimistic row back. */
	rollBack?: boolean
}

function initRepo(prefix: string): string {
	const repoPath = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
	execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' })
	execFileSync(
		'git',
		['-c', 'user.name=Helm Test', '-c', 'user.email=helm@example.test', 'commit', '--allow-empty', '-m', 'init'],
		{ cwd: repoPath, stdio: 'ignore' },
	)
	// A local bare origin keeps branch/remote preflights offline and definitive.
	execFileSync('git', ['init', '--bare', '-b', 'main', `${repoPath}-origin`], { stdio: 'ignore' })
	execFileSync('git', ['remote', 'add', 'origin', `${repoPath}-origin`], { cwd: repoPath, stdio: 'ignore' })
	execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repoPath, stdio: 'ignore' })
	return repoPath
}

function fakeOptimisticOkena(repoPath: string, options: FakeOkenaOptions = {}) {
	const supportsWait = options.supportsWait ?? true
	const completeAfterPolls = options.completeAfterPolls ?? 2
	const actions: Record<string, unknown>[] = []
	const commands: Array<{ terminalId: string; command: string }> = []
	const projects: OkenaState['projects'] = [{ id: 'parent-project', name: 'Repo', path: repoPath, layout: null }]
	let pendingCheckout: { branch: string; path: string; createBranch: boolean; polls: number } | null = null

	const checkout = (branch: string, path: string, createBranch: boolean) => {
		mkdirSync(dirname(path), { recursive: true })
		execFileSync('git', createBranch ? ['worktree', 'add', '-b', branch, path] : ['worktree', 'add', path, branch], {
			cwd: repoPath,
			stdio: 'ignore',
		})
		const row = projects.find(project => project.id === 'wt-project')
		if (row) {
			row.is_creating = false
			row.layout = { type: 'terminal', terminal_id: 'wt-terminal' } satisfies OkenaLayoutNode
		}
	}

	const client = {
		getState: async (): Promise<OkenaState> => {
			if (pendingCheckout && ++pendingCheckout.polls >= completeAfterPolls) {
				const { branch, path, createBranch } = pendingCheckout
				pendingCheckout = null
				if (options.rollBack)
					projects.splice(
						projects.findIndex(project => project.id === 'wt-project'),
						1,
					)
				else checkout(branch, path, createBranch)
			}
			return structuredClone({ projects })
		},
		action: async (payload: Record<string, unknown>) => {
			if (payload.action === 'create_worktree') {
				if ('wait' in payload && !supportsWait) {
					throw new Error(
						'Okena action failed (422): Failed to deserialize the JSON body into the target type: unknown field `wait`, expected one of `project_id`, `branch`, `create_branch`',
					)
				}
				actions.push(payload)
				const branch = payload.branch as string
				const path = `${repoPath}-wt/${branch.replace(/\//g, '-')}`
				projects.push({
					id: 'wt-project',
					name: branch,
					path,
					layout: null,
					is_creating: true,
					worktree_info: { parent_project_id: 'parent-project' },
				})
				if (payload.wait === true) {
					if (options.rollBack) {
						projects.pop()
						throw new Error('Okena action failed (500): fatal: invalid reference')
					}
					checkout(branch, path, payload.create_branch === true)
					return { project_id: 'wt-project', path, pending: false, terminal_id: 'wt-terminal' }
				}
				pendingCheckout = { branch, path, createBranch: payload.create_branch === true, polls: 0 }
				return { project_id: 'wt-project', path, pending: true }
			}
			actions.push(payload)
			return {}
		},
		runCommand: async (terminalId: string, command: string) => {
			commands.push({ terminalId, command })
		},
	} as unknown as OkenaClient

	return { client, actions, commands, projects }
}

const fastReadiness = { readyTimeoutMs: 1_000, readyPollMs: 1, sleep: async () => {} }

function cleanup(repoPath: string) {
	rmSync(`${repoPath}-wt`, { recursive: true, force: true })
	rmSync(`${repoPath}-origin`, { recursive: true, force: true })
	rmSync(repoPath, { recursive: true, force: true })
}

test('first Start waits for an optimistic Okena worktree before validating it', async () => {
	const repoPath = initRepo('helm-okena-optimistic-')
	const okena = fakeOptimisticOkena(repoPath)
	try {
		const ensured = await new OkenaWorktreeManager(okena.client, fastReadiness).ensureWorktreeProject(
			repoPath,
			'main',
			'feat/first-press',
			undefined,
		)
		assert.equal(ensured.worktreePath, `${repoPath}-wt/feat-first-press`)
		assert.ok(existsSync(join(ensured.worktreePath, '.git')))
		assert.equal(ensured.wtProjectId, 'wt-project')
		assert.equal(ensured.autoTerminalId, 'wt-terminal')
		const creates = okena.actions.filter(action => action.action === 'create_worktree')
		assert.equal(creates.length, 1)
		assert.equal(creates[0].wait, true)
	} finally {
		cleanup(repoPath)
	}
})

test('Okena without the wait flag: Helm polls the pending worktree until its terminal runs', async () => {
	const repoPath = initRepo('helm-okena-legacy-pending-')
	const okena = fakeOptimisticOkena(repoPath, { supportsWait: false, completeAfterPolls: 3 })
	try {
		const ensured = await new OkenaWorktreeManager(okena.client, fastReadiness).ensureWorktreeProject(
			repoPath,
			'main',
			'feat/legacy-pending',
			undefined,
		)
		assert.ok(existsSync(join(ensured.worktreePath, '.git')))
		assert.equal(ensured.autoTerminalId, 'wt-terminal')
		const creates = okena.actions.filter(action => action.action === 'create_worktree')
		assert.equal(creates.length, 1, 'the rejected wait request must not turn into a second accepted create')
		assert.equal('wait' in creates[0], false)
	} finally {
		cleanup(repoPath)
	}
})

test('a pending Okena worktree that never becomes ready fails Start with a bounded, clear error', async () => {
	const repoPath = initRepo('helm-okena-never-ready-')
	const okena = fakeOptimisticOkena(repoPath, { supportsWait: false, completeAfterPolls: Number.POSITIVE_INFINITY })
	let clock = 0
	try {
		await assert.rejects(
			new OkenaWorktreeManager(okena.client, {
				readyTimeoutMs: 5_000,
				readyPollMs: 1_000,
				now: () => clock,
				sleep: async ms => {
					clock += ms
				},
			}).ensureWorktreeProject(repoPath, 'main', 'feat/never-ready', undefined),
			err => {
				assert(err instanceof Error)
				assert.equal(errorPhase(err), 'worktree')
				assert.match(err.message, /not ready after 5s/)
				assert.match(err.message, /feat\/never-ready/)
				return true
			},
		)
		assert.ok(clock >= 5_000 && clock <= 6_000, `bounded wait, waited ${clock}ms`)
		assert.equal(okena.actions.filter(action => action.action === 'create_worktree').length, 1)
	} finally {
		cleanup(repoPath)
	}
})

test('a pending Okena worktree that Okena rolls back fails Start instead of hanging', async () => {
	const repoPath = initRepo('helm-okena-rollback-')
	const okena = fakeOptimisticOkena(repoPath, { supportsWait: false, rollBack: true })
	try {
		await assert.rejects(
			new OkenaWorktreeManager(okena.client, fastReadiness).ensureWorktreeProject(
				repoPath,
				'main',
				'feat/rolled-back',
				undefined,
			),
			err => {
				assert(err instanceof Error)
				assert.equal(errorPhase(err), 'worktree')
				assert.match(err.message, /rolled back/)
				return true
			},
		)
	} finally {
		cleanup(repoPath)
	}
})

test('Start during a still-creating Okena worktree waits for it instead of splitting a dead pane', async () => {
	const repoPath = initRepo('helm-okena-still-creating-')
	const worktreePath = `${repoPath}-wt/feat-still-creating`
	execFileSync('git', ['worktree', 'add', '-b', 'feat/still-creating', worktreePath], {
		cwd: repoPath,
		stdio: 'ignore',
	})
	const projects: OkenaState['projects'] = [
		{ id: 'parent-project', name: 'Repo', path: repoPath, layout: null },
		{
			id: 'wt-project',
			name: 'feat/still-creating',
			path: worktreePath,
			layout: null,
			is_creating: true,
			worktree_info: { parent_project_id: 'parent-project' },
		},
	]
	let polls = 0
	const client = {
		getState: async () => {
			if (++polls === 3) {
				projects[1].is_creating = false
				projects[1].layout = { type: 'terminal', terminal_id: 'wt-terminal' }
			}
			return structuredClone({ projects })
		},
		action: async () => {
			throw new Error('must not create or register another worktree')
		},
	} as unknown as OkenaClient
	try {
		const ensured = await new OkenaWorktreeManager(client, fastReadiness).ensureWorktreeProject(
			repoPath,
			'main',
			'feat/still-creating',
			undefined,
		)
		assert.equal(ensured.wtProjectId, 'wt-project')
		assert.ok(polls >= 3, 'returned only after Okena finished creating the worktree')
	} finally {
		cleanup(repoPath)
	}
})

test('OkenaSolver launches the agent exactly once in the new worktree terminal on the first Start', async () => {
	const repoPath = initRepo('helm-okena-first-start-')
	const okena = fakeOptimisticOkena(repoPath)
	const planDirName = '2026-11-04-first-start'
	;(okena.client as unknown as { runCommand: OkenaClient['runCommand'] }).runCommand = async (terminalId, command) => {
		okena.commands.push({ terminalId, command })
		const workspace = new PlanWorkspace(`${repoPath}-wt/fix-first-start`, planDirName)
		mkdirSync(dirname(workspace.resultPath), { recursive: true })
		writeFileSync(workspace.resultPath, JSON.stringify({ summary: 'done' }))
	}
	const config = configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
		projects: [{ slug: 'helm', repoPath, baseBranch: 'main' }],
		solver: { type: 'okena', agent: 'claude' },
	})
	const solver = new OkenaSolver(okena.client, new OkenaWorktreeManager(okena.client, fastReadiness))
	try {
		const result = await solver.solve({
			projectConfig: config.projects[0],
			branchName: 'fix/first-start',
			planDirName,
			canonicalContext: { title: 'First start' },
			onWorktreeReady: () => ({ title: 'First start' }),
			taskId: 'item-1',
			taskTitle: 'First start',
			solverConfig: config.solver,
			workspaceMode: 'worktree',
		})
		assert.equal(result.worktreePath, `${repoPath}-wt/fix-first-start`)
		assert.equal(okena.commands.length, 1)
		assert.equal(okena.commands[0].terminalId, 'wt-terminal')
		assert.match(okena.commands[0].command, /claude/)
		assert.equal(
			okena.actions.some(action => action.action === 'split_terminal' || action.action === 'create_terminal'),
			false,
			'the worktree terminal Okena spawned is used; no second pane is created',
		)
	} finally {
		cleanup(repoPath)
	}
})
