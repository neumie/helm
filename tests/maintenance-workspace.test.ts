import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { configSchema } from '../src/config.js'
import type { OkenaClient } from '../src/extensions/okena/client.js'
import { OkenaWorktreeManager } from '../src/extensions/okena/worktree.js'
import { DefaultSolver } from '../src/solver/default-solver.js'
import { DefaultSpawner } from '../src/spawner/default-spawner.js'
import type { PlanningSessionParams } from '../src/spawner/spawner.js'
import { assertWorkspaceReuse, createWorktree } from '../src/worktree/manager.js'

const exec = promisify(execFile)
async function git(cwd: string, ...args: string[]) {
	return (await exec('git', args, { cwd })).stdout.trim()
}
async function fixture() {
	const root = mkdtempSync('/tmp/helm-wt-')
	const repo = join(root, 'repo')
	mkdirSync(repo)
	await git(repo, 'init', '-b', 'main')
	await git(repo, 'config', 'user.name', 'Fixture')
	await git(repo, 'config', 'user.email', 'fixture@example.test')
	writeFileSync(join(repo, 'tracked.txt'), 'base\n')
	await git(repo, 'add', '.')
	await git(repo, 'commit', '-m', 'base')
	return {
		root,
		repo,
		destination: join(root, 'worktrees'),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	}
}

test('createWorktree reuses exact dirty registration without removing bytes or resetting tip', async () => {
	const f = await fixture()
	try {
		const path = join(f.root, 'existing\nworktree')
		await git(f.repo, 'worktree', 'add', '-b', 'task', path)
		writeFileSync(join(path, 'tracked.txt'), 'ahead\n')
		await git(path, 'commit', '-am', 'ahead')
		const tip = await git(path, 'rev-parse', 'HEAD')
		writeFileSync(join(path, 'tracked.txt'), 'dirty\n')
		writeFileSync(join(path, 'untracked.txt'), 'keep\n')
		assert.equal(await createWorktree(f.repo, 'main', 'task', f.destination), realpathSync(path))
		assert.equal(await git(path, 'rev-parse', 'HEAD'), tip)
		assert.equal(readFileSync(join(path, 'tracked.txt'), 'utf8'), 'dirty\n')
		assert.equal(readFileSync(join(path, 'untracked.txt'), 'utf8'), 'keep\n')
	} finally {
		f.cleanup()
	}
})

test('createWorktree attaches retained ahead branch without -B reset', async () => {
	const f = await fixture()
	try {
		await git(f.repo, 'checkout', '-b', 'task')
		writeFileSync(join(f.repo, 'tracked.txt'), 'ahead\n')
		await git(f.repo, 'commit', '-am', 'ahead')
		const tip = await git(f.repo, 'rev-parse', 'HEAD')
		await git(f.repo, 'checkout', 'main')
		const path = await createWorktree(f.repo, 'main', 'task', f.destination)
		assert.equal(await git(path, 'rev-parse', 'HEAD'), tip)
		assert.equal(readFileSync(join(path, 'tracked.txt'), 'utf8'), 'ahead\n')
	} finally {
		f.cleanup()
	}
})

test('stale registered worktree refuses automatic cleanup while retaining branch and registration', async () => {
	const f = await fixture()
	try {
		const stale = join(f.root, 'stale')
		await git(f.repo, 'worktree', 'add', '-b', 'task', stale)
		writeFileSync(join(stale, 'tracked.txt'), 'ahead')
		await git(stale, 'commit', '-am', 'ahead')
		const tip = await git(stale, 'rev-parse', 'HEAD')
		rmSync(stale, { recursive: true })
		const before = await git(f.repo, 'worktree', 'list', '--porcelain')
		mkdirSync(join(f.destination, 'task'), { recursive: true })
		writeFileSync(join(f.destination, 'task', 'sentinel'), 'keep')
		await assert.rejects(createWorktree(f.repo, 'main', 'task', f.destination), /stale registration explicitly/)
		assert.equal(await git(f.repo, 'rev-parse', 'task'), tip)
		assert.equal(await git(f.repo, 'worktree', 'list', '--porcelain'), before)
		assert.equal(readFileSync(join(f.destination, 'task', 'sentinel'), 'utf8'), 'keep')
	} finally {
		f.cleanup()
	}
})

test('createWorktree refuses occupied and dangling destinations unchanged', async () => {
	const f = await fixture()
	try {
		const occupied = join(f.destination, 'task')
		mkdirSync(occupied, { recursive: true })
		writeFileSync(join(occupied, 'sentinel'), 'keep')
		await assert.rejects(createWorktree(f.repo, 'main', 'task', f.destination), /occupied/)
		assert.equal(readFileSync(join(occupied, 'sentinel'), 'utf8'), 'keep')
		symlinkSync(join(f.root, 'missing'), join(f.destination, 'other'))
		await assert.rejects(createWorktree(f.repo, 'main', 'other', f.destination), /occupied/)
		assert.equal(await git(f.repo, 'branch', '--list', 'task', 'other'), '')
	} finally {
		f.cleanup()
	}
})

test('reuse fences canonical aliases, wrong branch/repo, subdirectories and substituted registration', async () => {
	const f = await fixture()
	const other = await fixture()
	try {
		const path = join(f.root, 'task')
		await git(f.repo, 'worktree', 'add', '-b', 'task', path)
		const alias = join(f.root, 'canonical-alias')
		symlinkSync(f.repo, alias)
		for (const canonical of [f.repo, alias]) {
			await assert.rejects(assertWorkspaceReuse(f.repo, 'main', canonical), /canonical project checkout/)
			await assertWorkspaceReuse(f.repo, 'ignored', canonical, 'main')
		}
		await assertWorkspaceReuse(f.repo, 'task', path)
		await assert.rejects(assertWorkspaceReuse(f.repo, 'wrong', path), /exact project and branch/)
		await assert.rejects(assertWorkspaceReuse(other.repo, 'task', path), /exact project and branch/)
		mkdirSync(join(path, 'sub'))
		await assert.rejects(assertWorkspaceReuse(f.repo, 'task', join(path, 'sub')), /exact project and branch/)
		await assert.rejects(assertWorkspaceReuse(f.repo, 'task', path, 'main'), /canonical project checkout/)
		// Keep Git's original registration but substitute a different on-disk repository.
		rmSync(path, { recursive: true })
		symlinkSync(other.repo, path)
		await assert.rejects(assertWorkspaceReuse(f.repo, 'task', path), /exact project and branch/)
	} finally {
		f.cleanup()
		other.cleanup()
	}
})

function planning(repo: string): PlanningSessionParams {
	const config = configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'test', apiToken: 'fixture' },
		projects: [{ slug: 'test', repoPath: repo, baseBranch: 'main' }],
	})
	return {
		projectConfig: config.projects[0],
		itemId: 'fixture',
		branchName: 'task',
		planDirName: 'fixture',
		taskTitle: 'Fixture',
		canonicalContext: { title: 'Fixture' },
		onWorktreeReady: () => ({ title: 'Fixture' }),
		solverConfig: config.solver,
		existingWorktreePath: repo,
	}
}

test('DefaultSpawner requires explicit Main and preserves canonical branch and dirty bytes', async () => {
	const f = await fixture()
	try {
		const params = planning(f.repo)
		let ready = 0
		params.onWorktreeReady = () => {
			ready++
			return params.canonicalContext
		}
		writeFileSync(join(f.repo, 'tracked.txt'), 'dirty')
		const spawner = new DefaultSpawner()
		await assert.rejects(spawner.startPlanningSession(params), /canonical project checkout/)
		assert.equal(ready, 0)
		await spawner.startPlanningSession({ ...params, workspaceMode: 'main' })
		assert.equal(ready, 1)
		assert.equal(await git(f.repo, 'branch', '--show-current'), 'main')
		assert.equal(readFileSync(join(f.repo, 'tracked.txt'), 'utf8'), 'dirty')
	} finally {
		f.cleanup()
	}
})

test('DefaultSolver refuses canonical aliases before readiness or agent invocation', async () => {
	const f = await fixture()
	try {
		const params = planning(f.repo)
		const alias = join(f.root, 'alias')
		symlinkSync(f.repo, alias)
		await assert.rejects(
			new DefaultSolver().solve({
				projectConfig: params.projectConfig,
				solverConfig: params.solverConfig,
				canonicalContext: params.canonicalContext,
				taskId: 'fixture',
				taskTitle: 'Fixture',
				branchName: 'task',
				planDirName: 'fixture',
				workspaceMode: 'worktree',
				existingWorktreePath: alias,
				onWorktreeReady: () => {
					assert.fail('readiness must not run')
				},
			}),
			/canonical project checkout/,
		)
	} finally {
		f.cleanup()
	}
})

test('Okena parent membership cannot bypass exact Git reuse attestation', async () => {
	const f = await fixture()
	try {
		const path = join(f.root, 'task')
		await git(f.repo, 'worktree', 'add', '-b', 'task', path)
		const client = {
			getState: async () => ({
				projects: [
					{ id: 'parent', path: f.repo },
					{ id: 'child', path, worktree_info: { parent_project_id: 'parent' } },
				],
			}),
			action: async () => {
				assert.fail('must not create/register a worktree')
			},
		} as unknown as OkenaClient
		const manager = new OkenaWorktreeManager(client)
		assert.equal((await manager.ensureWorktreeProject(f.repo, 'main', 'task', path)).wtProjectId, 'child')
		await assert.rejects(manager.ensureWorktreeProject(f.repo, 'main', 'wrong', path), /exact project and branch/)
		assert.equal((await manager.ensureWorktreeProject(f.repo, 'main', 'ignored', f.repo, 'main')).wtProjectId, 'parent')
	} finally {
		f.cleanup()
	}
})
