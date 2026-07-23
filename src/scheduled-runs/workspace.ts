import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type { HelmConfig, ProjectConfig } from '../config.js'
import { createWorktree, excludeHelmFiles } from '../worktree/manager.js'
import type { ScheduleDefinition } from './schema.js'

export interface ScheduledWorkspaceInput {
	profileId: string
	profileRoot: string
	runId: string
	scheduleId: string
	definition: ScheduleDefinition
	config: HelmConfig
	enabledProjects: readonly string[]
}

export interface ScheduledWorkspace {
	runDir: string
	cwd: string
	worktreePath: string | null
	branchName: string | null
}

function opaquePart(value: string, length = 12): string {
	return createHash('sha256').update(value).digest('hex').slice(0, length)
}

function requireOpaqueRunId(value: string): void {
	if (!/^[a-zA-Z0-9-]{1,120}$/.test(value)) throw new Error('Invalid scheduled run identity')
}

function assertInside(parent: string, candidate: string): void {
	const rel = relative(parent, candidate)
	if (rel === '' || rel.startsWith('..') || rel.includes('../')) throw new Error('Scheduled path escaped its owner directory')
}

async function requireRealDirectory(path: string): Promise<string> {
	const stats = await lstat(path)
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Scheduled workspace must be a real directory')
	return realpath(path)
}

function configuredProject(config: HelmConfig, target: Extract<ScheduleDefinition['target'], { kind: 'project' }>): ProjectConfig {
	const project = config.projects.find(candidate => candidate.slug === target.projectSlug)
	if (!project) throw new Error('Scheduled project is not configured')
	return project
}

/** Prepares a profile-captured private system cwd or an isolated configured-project worktree. */
export async function prepareScheduledWorkspace(input: ScheduledWorkspaceInput): Promise<ScheduledWorkspace> {
	requireOpaqueRunId(input.runId)
	const profileRoot = resolve(input.profileRoot)
	const runDir = join(profileRoot, 'scheduled-runs', input.runId)
	assertInside(profileRoot, runDir)
	await mkdir(runDir, { recursive: true, mode: 0o700 })
	if (input.definition.target.kind === 'system') {
		const cwd = join(runDir, 'workspace')
		await mkdir(cwd, { recursive: true, mode: 0o700 })
		return { runDir, cwd: await requireRealDirectory(cwd), worktreePath: null, branchName: null }
	}

	if (!input.enabledProjects.includes(input.definition.target.projectSlug)) {
		throw new Error('Scheduled project is not enabled for this profile')
	}
	const project = configuredProject(input.config, input.definition.target)
	const repoPath = await requireRealDirectory(project.repoPath)
	const branchName = `helm/scheduled/${opaquePart(input.scheduleId, 10)}/${opaquePart(input.runId, 10)}`
	const worktreeBase = join(runDir, 'worktrees')
	const worktreePath = await createWorktree(
		repoPath,
		input.definition.target.baseRef ?? project.baseBranch,
		branchName,
		worktreeBase,
	)
	const realWorktree = await requireRealDirectory(worktreePath)
	if (realWorktree === repoPath) throw new Error('Scheduled project worktree cannot be the canonical checkout')
	assertInside(await realpath(worktreeBase), realWorktree)
	await excludeHelmFiles(realWorktree)
	return { runDir, cwd: realWorktree, worktreePath: realWorktree, branchName }
}

export function scheduledWorktreeBranch(scheduleId: string, runId: string): string {
	return `helm/scheduled/${opaquePart(scheduleId, 10)}/${opaquePart(runId, 10)}`
}

export function scheduledRunDirectory(profileRoot: string, runId: string): string {
	requireOpaqueRunId(runId)
	const root = resolve(profileRoot)
	const runDir = join(root, 'scheduled-runs', runId)
	assertInside(root, runDir)
	return runDir
}

export function scheduledWorkspaceDisplayName(worktreePath: string): string {
	return basename(worktreePath)
}
