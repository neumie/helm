import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HelmConfig, ProjectConfig } from '../config.js'
import type { ProfileRuntime } from '../profiles/store.js'
import { createWorktree, excludeHelmFiles } from '../worktree/manager.js'
import type { ScheduleDefinition } from './schema.js'

export interface ScheduledWorkspaceInput {
	/** Captured before asynchronous admission; never resolve this from mutable active profile state. */
	profileRuntime: ProfileRuntime
	runId: string
	scheduleId: string
	definition: ScheduleDefinition
	config: HelmConfig
}

export interface ScheduledWorkspace {
	runDir: string
	cwd: string
	worktreePath: string | null
	branchName: string | null
}

interface DirectoryIdentity {
	path: string
	device: number
	inode: number
}

function opaquePart(value: string, length = 12): string {
	return createHash('sha256').update(value).digest('hex').slice(0, length)
}

function requireOpaqueRunId(value: string): void {
	if (!/^[a-zA-Z0-9-]{1,120}$/.test(value)) throw new Error('Invalid scheduled run identity')
}

function assertInside(parent: string, candidate: string): void {
	const rel = relative(parent, candidate)
	if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
		throw new Error('Scheduled path escaped its owner directory')
	}
}

function assertNotInside(parent: string, candidate: string): void {
	const rel = relative(parent, candidate)
	if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) {
		throw new Error('Scheduled project repository cannot be inside its run directory')
	}
}

async function inspectRealDirectory(path: string, label: string): Promise<DirectoryIdentity> {
	const stats = await lstat(path)
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
	const owner = process.getuid?.()
	if (owner !== undefined && stats.uid !== owner) throw new Error(`${label} must be owned by the daemon user`)
	return { path: await realpath(path), device: stats.dev, inode: stats.ino }
}

async function assertUnchangedDirectory(identity: DirectoryIdentity, label: string): Promise<void> {
	const current = await inspectRealDirectory(identity.path, label)
	if (current.path !== identity.path || current.device !== identity.device || current.inode !== identity.inode) {
		throw new Error(`${label} was replaced while preparing scheduled workspace`)
	}
}

async function ensureOwnedDirectory(
	parent: DirectoryIdentity,
	name: string,
	label: string,
): Promise<DirectoryIdentity> {
	const path = join(parent.path, name)
	assertInside(parent.path, path)
	try {
		await mkdir(path, { mode: 0o700 })
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
	}
	const stats = await lstat(path)
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
	await chmod(path, 0o700)
	const owned = await inspectRealDirectory(path, label)
	assertInside(parent.path, owned.path)
	return owned
}

async function assertAbsentOwnedPath(parent: DirectoryIdentity, name: string, label: string): Promise<string> {
	const path = join(parent.path, name)
	assertInside(parent.path, path)
	try {
		await lstat(path)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return path
		throw err
	}
	throw new Error(`${label} already exists`)
}

function configuredProject(
	config: HelmConfig,
	target: Extract<ScheduleDefinition['target'], { kind: 'project' }>,
): ProjectConfig {
	const project = config.projects.find(candidate => candidate.slug === target.projectSlug)
	if (!project) throw new Error('Scheduled project is not configured')
	return project
}

/** Prepares a profile-captured private system cwd or an isolated configured-project worktree. */
export async function prepareScheduledWorkspace(input: ScheduledWorkspaceInput): Promise<ScheduledWorkspace> {
	requireOpaqueRunId(input.runId)
	const profile = input.profileRuntime.profile
	if (!profile.id) throw new Error('Scheduled workspace requires a captured profile identity')
	const profileRoot = await inspectRealDirectory(resolve(input.profileRuntime.rootDir), 'Scheduled profile root')
	const scheduledRoot = await ensureOwnedDirectory(profileRoot, 'scheduled-runs', 'Scheduled run root')
	const runDir = await ensureOwnedDirectory(scheduledRoot, input.runId, 'Scheduled run directory')

	if (input.definition.target.kind === 'system') {
		const workspace = await ensureOwnedDirectory(runDir, 'workspace', 'Scheduled system workspace')
		await assertUnchangedDirectory(profileRoot, 'Scheduled profile root')
		await assertUnchangedDirectory(runDir, 'Scheduled run directory')
		assertInside(profileRoot.path, workspace.path)
		assertInside(runDir.path, workspace.path)
		return { runDir: runDir.path, cwd: workspace.path, worktreePath: null, branchName: null }
	}

	if (!profile.enabledProjects.includes(input.definition.target.projectSlug)) {
		throw new Error('Scheduled project is not enabled for this profile')
	}
	const project = configuredProject(input.config, input.definition.target)
	const repository = await inspectRealDirectory(resolve(project.repoPath), 'Scheduled project repository')
	assertNotInside(runDir.path, repository.path)
	const branchName = scheduledWorktreeBranch(input.scheduleId, input.runId)
	const worktreeBase = await ensureOwnedDirectory(runDir, 'worktrees', 'Scheduled worktree base')
	const expectedWorktreePath = await assertAbsentOwnedPath(
		worktreeBase,
		branchName.replace(/\//g, '-'),
		'Scheduled project worktree',
	)
	if (repository.path === expectedWorktreePath) {
		throw new Error('Scheduled project worktree cannot be the canonical checkout')
	}
	assertInside(profileRoot.path, worktreeBase.path)
	assertInside(runDir.path, worktreeBase.path)

	const worktreePath = await createWorktree(
		repository.path,
		input.definition.target.baseRef ?? project.baseBranch,
		branchName,
		worktreeBase.path,
	)
	await assertUnchangedDirectory(profileRoot, 'Scheduled profile root')
	await assertUnchangedDirectory(runDir, 'Scheduled run directory')
	await assertUnchangedDirectory(worktreeBase, 'Scheduled worktree base')
	await assertUnchangedDirectory(repository, 'Scheduled project repository')
	const worktree = await inspectRealDirectory(worktreePath, 'Scheduled project worktree')
	if (worktree.path !== resolve(expectedWorktreePath) || worktree.path === repository.path) {
		throw new Error('Scheduled project worktree cannot be the canonical checkout')
	}
	assertInside(profileRoot.path, worktree.path)
	assertInside(runDir.path, worktree.path)
	assertInside(worktreeBase.path, worktree.path)
	await excludeHelmFiles(worktree.path)
	return { runDir: runDir.path, cwd: worktree.path, worktreePath: worktree.path, branchName }
}

export function scheduledWorktreeBranch(scheduleId: string, runId: string): string {
	return `helm/scheduled/${opaquePart(scheduleId, 10)}/${opaquePart(runId, 10)}`
}

export function scheduledRunDirectory(profileRuntime: ProfileRuntime, runId: string): string {
	requireOpaqueRunId(runId)
	const root = resolve(profileRuntime.rootDir)
	const runDir = join(root, 'scheduled-runs', runId)
	assertInside(root, runDir)
	return runDir
}

export function scheduledWorkspaceDisplayName(worktreePath: string): string {
	return basename(worktreePath)
}
