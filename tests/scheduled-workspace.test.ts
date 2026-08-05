import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import type { HelmConfig } from '../src/config.js'
import type { ProfileRuntime } from '../src/profiles/store.js'
import { prepareScheduledWorkspace, scheduledWorktreeBranch } from '../src/scheduled-runs/workspace.js'

const execFileAsync = promisify(execFile)

function profileRuntime(rootDir: string, enabledProjects: string[] = []): ProfileRuntime {
	return {
		profile: {
			id: 'work',
			name: 'Work',
			createdAt: '2026-01-01T00:00:00.000Z',
			enabledProjects,
			knowledgeBindings: [],
			archivedAt: null,
		},
		generation: 1,
		rootDir,
		dbPath: join(rootDir, 'helm.db'),
		attachmentsDir: join(rootDir, 'attachments'),
		logsDir: join(rootDir, 'logs'),
	}
}

function definition(
	target:
		| { kind: 'system'; riskAcknowledgement: 'broad-host-access' }
		| { kind: 'project'; projectSlug: string; baseRef?: string },
) {
	return { prompt: 'Inspect safely', target, agent: 'claude' as const, maximumRuntimeMinutes: 30 }
}

function config(projects: Array<{ slug: string; repoPath: string; baseBranch: string }>): HelmConfig {
	return { projects } as HelmConfig
}

async function createGitRepository(root: string, name = 'repository'): Promise<string> {
	const repo = join(root, name)
	mkdirSync(repo, { recursive: true })
	await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repo })
	await execFileAsync('git', ['config', 'user.email', 'scheduled-test@example.test'], { cwd: repo })
	await execFileAsync('git', ['config', 'user.name', 'Scheduled Test'], { cwd: repo })
	writeFileSync(join(repo, 'README.md'), 'scheduled workspace fixture\n')
	await execFileAsync('git', ['add', 'README.md'], { cwd: repo })
	await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo })
	return repo
}

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-workspace-'))
	try {
		await fn(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

test('system scheduled targets receive a private captured-profile run directory', async () => {
	await withTempRoot(async root => {
		const workspace = await prepareScheduledWorkspace({
			profileRuntime: profileRuntime(root),
			runId: 'run-123',
			scheduleId: 'schedule-123',
			definition: definition({ kind: 'system', riskAcknowledgement: 'broad-host-access' }),
			config: config([]),
		})
		assert.equal(workspace.worktreePath, null)
		assert.equal(workspace.branchName, null)
		assert.equal(workspace.cwd, join(await realpath(root), 'scheduled-runs', 'run-123', 'workspace'))
		assert.equal((await stat(workspace.cwd)).mode & 0o777, 0o700)
		assert.match(scheduledWorktreeBranch('schedule-123', 'run-123'), /^helm\/scheduled\/[a-f0-9]{10}\/[a-f0-9]{10}$/)
	})
})

test('project scheduled targets create an isolated real-git worktree from the configured base', async () => {
	await withTempRoot(async root => {
		const repo = await createGitRepository(root)
		const workspace = await prepareScheduledWorkspace({
			profileRuntime: profileRuntime(root, ['project']),
			runId: 'run-git',
			scheduleId: 'schedule-git',
			definition: definition({ kind: 'project', projectSlug: 'project', baseRef: 'main' }),
			config: config([{ slug: 'project', repoPath: repo, baseBranch: 'missing-base' }]),
		})
		assert.notEqual(workspace.cwd, await realpath(repo))
		assert.equal(workspace.worktreePath, workspace.cwd)
		assert.equal(workspace.branchName, scheduledWorktreeBranch('schedule-git', 'run-git'))
		assert.match(workspace.cwd, /scheduled-runs\/run-git\/worktrees\//)
		const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: workspace.cwd })
		assert.equal(stdout.trim(), workspace.branchName)
	})
})

test('project targets reject disabled projects before creating a worktree', async () => {
	await withTempRoot(async root => {
		const repo = await createGitRepository(root)
		await assert.rejects(
			prepareScheduledWorkspace({
				profileRuntime: profileRuntime(root),
				runId: 'run-disabled',
				scheduleId: 'schedule-disabled',
				definition: definition({ kind: 'project', projectSlug: 'project' }),
				config: config([{ slug: 'project', repoPath: repo, baseBranch: 'main' }]),
			}),
			/not enabled for this profile/,
		)
	})
})

test('system workspaces reject a symlinked scheduled-runs root', async () => {
	await withTempRoot(async root => {
		const outside = mkdtempSync(join(tmpdir(), 'helm-scheduled-outside-'))
		try {
			symlinkSync(outside, join(root, 'scheduled-runs'))
			await assert.rejects(
				prepareScheduledWorkspace({
					profileRuntime: profileRuntime(root),
					runId: 'run-symlink',
					scheduleId: 'schedule-symlink',
					definition: definition({ kind: 'system', riskAcknowledgement: 'broad-host-access' }),
					config: config([]),
				}),
				/Scheduled run root must be a real directory/,
			)
		} finally {
			rmSync(outside, { recursive: true, force: true })
		}
	})
})

test('project workspaces reject symlinked worktree bases and repositories', async () => {
	await withTempRoot(async root => {
		const repo = await createGitRepository(root)
		const runRoot = join(root, 'scheduled-runs', 'run-base')
		mkdirSync(runRoot, { recursive: true, mode: 0o700 })
		const outside = mkdtempSync(join(tmpdir(), 'helm-scheduled-outside-'))
		try {
			symlinkSync(outside, join(runRoot, 'worktrees'))
			await assert.rejects(
				prepareScheduledWorkspace({
					profileRuntime: profileRuntime(root, ['project']),
					runId: 'run-base',
					scheduleId: 'schedule-base',
					definition: definition({ kind: 'project', projectSlug: 'project' }),
					config: config([{ slug: 'project', repoPath: repo, baseBranch: 'main' }]),
				}),
				/Scheduled worktree base must be a real directory/,
			)
			const linkedRepo = join(root, 'linked-repository')
			symlinkSync(repo, linkedRepo)
			await assert.rejects(
				prepareScheduledWorkspace({
					profileRuntime: profileRuntime(root, ['project']),
					runId: 'run-repo-link',
					scheduleId: 'schedule-repo-link',
					definition: definition({ kind: 'project', projectSlug: 'project' }),
					config: config([{ slug: 'project', repoPath: linkedRepo, baseBranch: 'main' }]),
				}),
				/Scheduled project repository must be a real directory/,
			)
		} finally {
			rmSync(outside, { recursive: true, force: true })
		}
	})
})

test('project workspaces reject a canonical checkout placed in the scheduled worktree location', async () => {
	await withTempRoot(async root => {
		const branch = scheduledWorktreeBranch('schedule-canonical', 'run-canonical').replace(/\//g, '-')
		const canonical = await createGitRepository(join(root, 'scheduled-runs', 'run-canonical', 'worktrees'), branch)
		await assert.rejects(
			prepareScheduledWorkspace({
				profileRuntime: profileRuntime(root, ['project']),
				runId: 'run-canonical',
				scheduleId: 'schedule-canonical',
				definition: definition({ kind: 'project', projectSlug: 'project' }),
				config: config([{ slug: 'project', repoPath: canonical, baseBranch: 'main' }]),
			}),
			/cannot be inside its run directory/,
		)
	})
})

test('project workspaces reject a repository replaced while git creates the isolated worktree', async () => {
	await withTempRoot(async root => {
		const repo = await createGitRepository(root)
		const hooks = join(root, 'hooks')
		mkdirSync(hooks)
		const replacement = `${repo}-replaced`
		const quote = (value: string) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`
		writeFileSync(
			join(hooks, 'post-checkout'),
			`#!/bin/sh\nmv ${quote(repo)} ${quote(replacement)}\nmkdir ${quote(repo)}\n`,
		)
		chmodSync(join(hooks, 'post-checkout'), 0o700)
		await execFileAsync('git', ['config', 'core.hooksPath', hooks], { cwd: repo })
		await assert.rejects(
			prepareScheduledWorkspace({
				profileRuntime: profileRuntime(root, ['project']),
				runId: 'run-replaced',
				scheduleId: 'schedule-replaced',
				definition: definition({ kind: 'project', projectSlug: 'project' }),
				config: config([{ slug: 'project', repoPath: repo, baseBranch: 'main' }]),
			}),
			/Scheduled project repository was replaced while preparing scheduled workspace/,
		)
	})
})
