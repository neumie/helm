import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareScheduledWorkspace, scheduledWorktreeBranch } from '../src/scheduled-runs/workspace.js'

test('system scheduled targets always receive a private profile run directory, not caller cwd', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-workspace-'))
	try {
		const workspace = await prepareScheduledWorkspace({
			profileId: 'work', profileRoot: root, runId: 'run-123', scheduleId: 'schedule-123',
			definition: {
				prompt: 'Inspect safely', target: { kind: 'system', riskAcknowledgement: 'broad-host-access' }, agent: 'claude', maximumRuntimeMinutes: 30,
			},
			config: { projects: [] } as never, enabledProjects: [],
		})
		assert.equal(workspace.worktreePath, null)
		assert.equal(workspace.branchName, null)
		assert.equal(workspace.cwd, join(await realpath(root), 'scheduled-runs', 'run-123', 'workspace'))
		assert.ok((await stat(workspace.cwd)).isDirectory())
		assert.match(scheduledWorktreeBranch('schedule-123', 'run-123'), /^helm\/scheduled\/[a-f0-9]{10}\/[a-f0-9]{10}$/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('project targets reject a profile-disabled configured project before creating a worktree', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-workspace-'))
	try {
		await assert.rejects(
			prepareScheduledWorkspace({
				profileId: 'work', profileRoot: root, runId: 'run-abc', scheduleId: 'schedule-abc',
				definition: {
					prompt: 'Inspect', target: { kind: 'project', projectSlug: 'project' }, agent: 'claude', maximumRuntimeMinutes: 30,
				},
				config: { projects: [{ slug: 'project', repoPath: root, baseBranch: 'main' }] } as never, enabledProjects: [],
			}),
			/not enabled for this profile/, 
		)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
