import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import type { OkenaClient } from '../src/extensions/okena/client.js'
import { openItemInOkena } from '../src/extensions/okena/item-opener.js'
import { OkenaSolver } from '../src/extensions/okena/solver.js'
import type { OkenaWorktreeManager } from '../src/extensions/okena/worktree.js'
import { errorPhase } from '../src/util/errors.js'

test('openItemInOkena focuses an existing Item terminal without sending input', async () => {
	const worktreePath = mkdtempSync(join(tmpdir(), 'helm-okena-open-existing-'))
	const actions: Record<string, unknown>[] = []
	const client = {
		isAvailable: async () => true,
		getState: async () => ({
			projects: [
				{ id: 'project-1', name: 'fix/existing', path: worktreePath, terminal_names: { 'terminal-1': 'plan' } },
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
			terminalId: 'terminal-1',
			createdWorkspace: false,
			activated: true,
		})
		assert.deepEqual(actions, [
			{ action: 'focus_terminal', project_id: 'project-1', terminal_id: 'terminal-1', window: 'main' },
		])
	} finally {
		rmSync(worktreePath, { recursive: true, force: true })
	}
})

test('openItemInOkena registers an existing non-Okena worktree before focusing it', async () => {
	const worktreePath = mkdtempSync(join(tmpdir(), 'helm-okena-open-register-'))
	const actions: Record<string, unknown>[] = []
	const client = {
		isAvailable: async () => true,
		getState: async () => ({ projects: [] }),
		action: async (payload: Record<string, unknown>) => {
			actions.push(payload)
			if (payload.action === 'add_project') return { project_id: 'project-2', terminal_ids: ['terminal-2'] }
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
		assert.equal(result.activated, false)
		assert.deepEqual(actions, [
			{ action: 'add_project', name: 'fix/register', path: worktreePath },
			{ action: 'focus_terminal', project_id: 'project-2', terminal_id: 'terminal-2', window: 'main' },
		])
	} finally {
		rmSync(worktreePath, { recursive: true, force: true })
	}
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
