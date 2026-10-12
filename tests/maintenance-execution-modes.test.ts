import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import type { OkenaClient } from '../src/extensions/okena/client.js'
import { OkenaSpawner } from '../src/extensions/okena/spawner.js'
import type { OkenaWorktreeManager } from '../src/extensions/okena/worktree.js'
import type { PlanningSessionParams } from '../src/spawner/spawner.js'

for (const workspaceMode of ['main', 'worktree', undefined] as const) {
	test(`Okena planning uses explicit mode, not existing path: ${workspaceMode ?? 'default'}`, async t => {
		const root = mkdtempSync(join(tmpdir(), 'helm-plan-mode-'))
		t.after(() => rmSync(root, { recursive: true, force: true }))
		const config = configSchema.parse({
			provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'fixture' },
			projects: [{ slug: 'helm', repoPath: root, baseBranch: 'main' }],
		})
		const calls: unknown[][] = []
		const worktrees = {
			ensureMainRepoProject: async (...args: unknown[]) => {
				calls.push(['main', ...args])
				return { wtProjectId: 'project', worktreePath: root }
			},
			ensureWorktreeProject: async (...args: unknown[]) => {
				calls.push(['worktree', ...args])
				// Model the manager's canonical-path refusal; never reinterpret it as Main.
				throw new Error('Worktree cannot reuse canonical checkout')
			},
			findPlanTerminal: async () => 'existing-plan',
			createTerminal: async () => {
				throw new Error('must reuse planning terminal')
			},
		} as unknown as OkenaWorktreeManager
		const client = {
			action: async () => ({}),
			runCommand: async () => {
				throw new Error('must not launch into existing terminal')
			},
		} as unknown as OkenaClient
		const params: PlanningSessionParams = {
			projectConfig: config.projects[0],
			workspaceMode,
			existingWorktreePath: root,
			branchName: 'fix/fixture',
			planDirName: 'fixture',
			taskTitle: 'Fixture',
			itemId: 'fixture',
			canonicalContext: { title: 'Fixture' },
			onWorktreeReady: () => ({ title: 'Fixture' }),
			solverConfig: config.solver,
		}
		const operation = new OkenaSpawner(client, worktrees).startPlanningSession(params)
		if (workspaceMode === 'main') {
			assert.equal((await operation).worktreePath, root)
			assert.deepEqual(calls, [['main', root]])
		} else {
			await assert.rejects(operation, /cannot reuse canonical checkout/)
			assert.deepEqual(calls, [['worktree', root, 'main', 'fix/fixture', root]])
		}
	})
}
