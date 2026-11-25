import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import {
	OkenaClient,
	type OkenaLayoutNode,
	type OkenaState,
	waitForShellOutput,
} from '../src/extensions/okena/client.js'
import { OkenaSolver } from '../src/extensions/okena/solver.js'
import { OkenaWorktreeManager, createOkenaWorktreeForBranch } from '../src/extensions/okena/worktree.js'
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
	const resultPath = join(`${repoPath}-results`, 'item-1', 'solver-result.json')
	;(okena.client as unknown as { runCommand: OkenaClient['runCommand'] }).runCommand = async (terminalId, command) => {
		okena.commands.push({ terminalId, command })
		mkdirSync(dirname(resultPath), { recursive: true })
		writeFileSync(resultPath, JSON.stringify({ summary: 'done' }))
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
			resultPath,
			canonicalContext: { title: 'First start' },
			onWorktreeReady: () => ({ title: 'First start' }),
			taskId: 'item-1',
			taskTitle: 'First start',
			solverConfig: config.solver,
			workspaceMode: 'worktree',
		})
		assert.equal(result.worktreePath, `${repoPath}-wt/fix-first-start`)
		assert.equal(
			existsSync(join(result.worktreePath, 'docs/plans', planDirName, 'solver-result.json')),
			false,
			'nothing is written into the repository',
		)
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
		rmSync(`${repoPath}-results`, { recursive: true, force: true })
	}
})

test('a create_worktree wait that times out on the opposite-mode retry still fails with the bounded message', async () => {
	const calls: Array<{ createBranch: unknown; startedAt: number }> = []
	const startedAt = Date.now()
	const client = {
		action: async (payload: Record<string, unknown>, opts: { signal?: AbortSignal } = {}) => {
			calls.push({ createBranch: payload.create_branch, startedAt: Date.now() - startedAt })
			if (calls.length === 1) {
				// Branch appeared between the preflight and Okena's git call.
				await new Promise(resolve => setTimeout(resolve, 30))
				throw new Error('Okena action failed (400): {"error":"fatal: a branch named \'feat/race\' already exists"}')
			}
			// The retry's checkout never finishes inside the budget.
			return new Promise((_, reject) => {
				const signal = opts.signal
				if (!signal) return reject(new Error('wait request sent without a timeout signal'))
				signal.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
		},
	} as unknown as OkenaClient
	await assert.rejects(
		createOkenaWorktreeForBranch(client, 'parent-project', 'feat/race', async () => false, { waitTimeoutMs: 80 }),
		err => {
			assert(err instanceof Error)
			assert.equal(errorPhase(err), 'worktree')
			assert.notEqual(err.name, 'AbortError', 'a timeout must not be classified as a user cancellation')
			assert.match(err.message, /feat\/race was not ready after/)
			return true
		},
	)
	assert.deepEqual(
		calls.map(call => call.createBranch),
		[true, false],
	)
	assert.ok(Date.now() - startedAt < 160, 'the retry shares the first attempt budget instead of restarting it')
})

test('a fresh terminal waits for the shell to draw its prompt before ctrl_c and the agent command', async () => {
	const screens = ['', '', 'jakub@mac feat-x %']
	const sent: string[] = []
	const client = new OkenaClient('/nonexistent/okena-config')
	;(client as unknown as { action: (payload: Record<string, unknown>) => Promise<unknown> }).action = async payload => {
		sent.push(payload.action as string)
		if (payload.action === 'read_content') return { content: screens.shift() ?? 'jakub@mac feat-x %' }
		return {}
	}
	await client.runCommand('wt-terminal', 'claude', { freshTerminal: true })
	assert.deepEqual(sent, ['read_content', 'read_content', 'read_content', 'send_special_key', 'run_command'])
})

test('shell readiness wait is bounded and tolerates unreadable terminals', async () => {
	let clock = 0
	let reads = 0
	const ready = await waitForShellOutput(
		{
			action: async () => {
				reads++
				if (reads % 2) throw new Error('terminal not found')
				return { content: '   \n  ' }
			},
		} as unknown as Pick<OkenaClient, 'action'>,
		'wt-terminal',
		{
			timeoutMs: 2_000,
			pollMs: 250,
			now: () => clock,
			sleep: async ms => {
				clock += ms
			},
		},
	)
	assert.equal(ready, false)
	assert.ok(clock >= 2_000 && clock <= 2_250, `bounded wait, waited ${clock}ms`)

	const aborted = new AbortController()
	aborted.abort()
	await assert.rejects(
		waitForShellOutput({ action: async () => ({ content: '' }) } as unknown as Pick<OkenaClient, 'action'>, 't', {
			signal: aborted.signal,
		}),
		/cancel/i,
	)
})

test('Start surfaces a create_worktree wait timeout as the bounded worktree message, not a wrapped abort', async () => {
	const repoPath = initRepo('helm-okena-wait-timeout-')
	const creates: Record<string, unknown>[] = []
	const client = {
		getState: async (): Promise<OkenaState> => ({
			projects: [{ id: 'parent-project', name: 'Repo', path: repoPath, layout: null }],
		}),
		action: async (payload: Record<string, unknown>, opts: { signal?: AbortSignal } = {}) => {
			if (payload.action !== 'create_worktree') return {}
			creates.push(payload)
			return new Promise((_, reject) => {
				if (opts.signal?.aborted) return reject(opts.signal.reason)
				opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true })
			})
		},
	} as unknown as OkenaClient
	try {
		await assert.rejects(
			new OkenaWorktreeManager(client, { readyTimeoutMs: 60 }).ensureWorktreeProject(
				repoPath,
				'main',
				'feat/slow-checkout',
				undefined,
			),
			err => {
				assert(err instanceof Error)
				assert.equal(errorPhase(err), 'worktree')
				assert.match(err.message, /^Okena worktree for feat\/slow-checkout was not ready after 0s\./)
				return true
			},
		)
		assert.equal(creates.length, 1, 'a timed-out wait never re-sends create')
	} finally {
		cleanup(repoPath)
	}
})
