import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import type { OkenaClient } from '../src/extensions/okena/client.js'
import { OkenaSolver } from '../src/extensions/okena/solver.js'
import type { OkenaWorktreeManager } from '../src/extensions/okena/worktree.js'
import { errorPhase } from '../src/util/errors.js'

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
