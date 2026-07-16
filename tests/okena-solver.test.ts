import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import type { OkenaClient } from '../src/extensions/okena/client.js'
import { inspectItemOkenaWorkspace, openItemInOkena } from '../src/extensions/okena/item-opener.js'
import { OkenaSolver } from '../src/extensions/okena/solver.js'
import {
	type OkenaWorktreeManager,
	createOkenaWorktreeForBranch,
	prepareExistingOkenaBranch,
} from '../src/extensions/okena/worktree.js'
import { errorPhase } from '../src/util/errors.js'

test('openItemInOkena ignores stale hook terminals and marks the live pane for attention', async () => {
	const worktreePath = mkdtempSync(join(tmpdir(), 'helm-okena-open-existing-'))
	const actions: Record<string, unknown>[] = []
	const client = {
		isAvailable: async () => true,
		getState: async () => ({
			projects: [
				{ id: 'parent-project', name: 'JVS', path: '/repo' },
				{
					id: 'project-1',
					name: 'fix/existing',
					path: worktreePath,
					layout: { type: 'terminal', terminal_id: 'terminal-live' },
					terminal_names: { 'terminal-stale-hook': 'on_worktree_create', 'terminal-live': 'plan' },
					worktree_info: { parent_project_id: 'parent-project' },
				},
			],
		}),
		action: async (payload: Record<string, unknown>) => {
			actions.push(payload)
			return {}
		},
	} as unknown as OkenaClient
	const config = configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
		projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
		solver: { type: 'okena', agent: 'claude' },
	})

	try {
		const preview = await inspectItemOkenaWorkspace(
			{
				projectConfig: config.projects[0],
				workspaceMode: 'worktree',
				baseRef: 'main',
				branchName: 'fix/existing',
				existingWorktreePath: worktreePath,
			},
			{ client },
		)
		assert.equal(preview.state, 'open')
		assert.equal(preview.label, 'Focus open workspace')

		const result = await openItemInOkena(
			{
				projectConfig: config.projects[0],
				workspaceMode: 'worktree',
				baseRef: 'main',
				branchName: 'fix/existing',
				existingWorktreePath: worktreePath,
			},
			{ client, activateApp: async () => true },
		)
		assert.deepEqual(result, {
			worktreePath,
			projectId: 'project-1',
			terminalId: 'terminal-live',
			createdWorkspace: false,
			focused: true,
			notified: true,
			activated: true,
		})
		assert.deepEqual(actions, [
			{ action: 'focus_terminal', project_id: 'project-1', terminal_id: 'terminal-live', window: 'main' },
			{ action: 'send_text', terminal_id: 'terminal-live', text: '\u0007' },
		])
	} finally {
		rmSync(worktreePath, { recursive: true, force: true })
	}
})

test('openItemInOkena waits for a registered worktree terminal to become visible', async () => {
	const worktreePath = mkdtempSync(join(tmpdir(), 'helm-okena-open-register-'))
	const actions: Record<string, unknown>[] = []
	let registered = false
	const parent = { id: 'parent-project', name: 'JVS', path: '/repo' }
	const child = {
		id: 'project-2',
		name: 'fix/register',
		path: worktreePath,
		worktree_info: { parent_project_id: 'parent-project' },
		layout: { type: 'terminal', terminal_id: 'terminal-2', minimized: false, detached: false },
	}
	const client = {
		isAvailable: async () => true,
		getState: async () => ({ projects: registered ? [parent, child] : [parent] }),
		action: async (payload: Record<string, unknown>) => {
			actions.push(payload)
			if (payload.action === 'add_discovered_worktree') {
				registered = true
				return { project_id: 'project-2', terminal_id: null }
			}
			return {}
		},
	} as unknown as OkenaClient
	const config = configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
		projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
		solver: { type: 'okena', agent: 'claude' },
	})

	try {
		const result = await openItemInOkena(
			{
				projectConfig: config.projects[0],
				workspaceMode: 'worktree',
				baseRef: 'main',
				branchName: 'fix/register',
				existingWorktreePath: worktreePath,
			},
			{ client, activateApp: async () => false },
		)
		assert.equal(result.projectId, 'project-2')
		assert.equal(result.terminalId, 'terminal-2')
		assert.equal(result.focused, true)
		assert.equal(result.notified, false)
		assert.equal(result.activated, false)
		assert.deepEqual(actions, [
			{
				action: 'add_discovered_worktree',
				parent_project_id: 'parent-project',
				worktree_path: worktreePath,
				branch: 'fix/register',
			},
			{ action: 'focus_terminal', project_id: 'project-2', terminal_id: 'terminal-2', window: 'main' },
		])
	} finally {
		rmSync(worktreePath, { recursive: true, force: true })
	}
})

test('Okena workspace preview distinguishes local, remote, and new branches', async () => {
	const client = {
		isAvailable: async () => true,
		getState: async () => ({ projects: [{ id: 'parent-project', name: 'JVS', path: '/repo' }] }),
	} as unknown as OkenaClient
	const config = configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
		projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
		solver: { type: 'okena', agent: 'claude' },
	})
	const params = {
		projectConfig: config.projects[0],
		workspaceMode: 'worktree' as const,
		baseRef: 'main',
		branchName: 'feat/preview',
	}

	for (const [source, state, label] of [
		['local', 'local', 'Open local branch'],
		['remote', 'remote', 'Fetch & open remote branch'],
		['new', 'create', 'Create branch & workspace'],
		['unavailable', 'unavailable', 'Remote branch check unavailable'],
	] as const) {
		const preview = await inspectItemOkenaWorkspace(params, {
			client,
			inspectBranchSource: async () => source,
		})
		assert.equal(preview.state, state)
		assert.equal(preview.label, label)
	}
})

test('Okena remote branch preparation fetches and creates a local tracking branch', async () => {
	const commands: string[][] = []
	let localChecks = 0
	const prepared = await prepareExistingOkenaBranch('/repo', 'feat/remote', {
		localBranchExists: async () => {
			localChecks += 1
			return false
		},
		inspectRemoteBranch: async () => 'exists',
		worktreeRegistrationForBranch: async () => null,
		execGit: async args => {
			commands.push(args)
		},
	})

	assert.equal(prepared, true)
	assert.equal(localChecks, 3)
	assert.deepEqual(commands, [
		['fetch', 'origin', '+refs/heads/feat/remote:refs/remotes/origin/feat/remote'],
		['branch', '--track', 'feat/remote', 'refs/remotes/origin/feat/remote'],
	])
})

test('Okena branch preparation prunes a stale linked-worktree registration', async () => {
	const commands: string[][] = []
	const prepared = await prepareExistingOkenaBranch('/repo', 'feat/stale', {
		localBranchExists: async () => true,
		inspectRemoteBranch: async () => 'absent',
		worktreeRegistrationForBranch: async () => ({ path: '/missing/worktree', exists: false }),
		execGit: async args => {
			commands.push(args)
		},
	})
	assert.equal(prepared, true)
	assert.deepEqual(commands, [['worktree', 'prune']])
})

test('Okena worktree creation reuses an existing branch without a noisy create attempt', async () => {
	const actions: Record<string, unknown>[] = []
	const client = {
		action: async (payload: Record<string, unknown>) => {
			actions.push(payload)
			return { project_id: 'worktree-project', terminal_id: null, path: '/repo-wt/existing' }
		},
	} as unknown as OkenaClient

	const result = await createOkenaWorktreeForBranch(client, 'parent-project', 'feat/existing', async () => true)
	assert.equal(result.path, '/repo-wt/existing')
	assert.deepEqual(actions, [
		{
			action: 'create_worktree',
			project_id: 'parent-project',
			branch: 'feat/existing',
			create_branch: false,
		},
	])
})

test('OkenaSolver fails promptly when its execution workspace disappears', async () => {
	const worktreePath = mkdtempSync(join(tmpdir(), 'helm-okena-vanished-'))
	const client = {
		action: async () => ({}),
		runCommand: async () => {
			rmSync(worktreePath, { recursive: true, force: true })
		},
	} as unknown as OkenaClient
	const worktrees = {
		ensureWorktreeProject: async () => ({
			wtProjectId: 'project-1',
			worktreePath,
			autoTerminalId: 'terminal-1',
		}),
	} as unknown as OkenaWorktreeManager
	const solver = new OkenaSolver(client, worktrees)
	const config = configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
		projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
		solver: { type: 'okena', agent: 'claude' },
	})

	try {
		await assert.rejects(
			solver.solve({
				projectConfig: config.projects[0],
				branchName: 'fix/missing-workspace',
				planDirName: '2026-07-15-missing-workspace',
				taskContext: { title: 'Missing workspace' },
				taskId: 'item-1',
				taskTitle: 'Missing workspace',
				solverConfig: config.solver,
				workspaceMode: 'worktree',
			}),
			err => {
				assert(err instanceof Error)
				assert.match(err.message, /workspace disappeared/i)
				assert.equal(errorPhase(err), 'solve')
				return true
			},
		)
	} finally {
		rmSync(worktreePath, { recursive: true, force: true })
	}
})
