import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SolverWorkspace } from '../solver/workspace.js'
import { phaseError } from '../util/errors.js'
import { log } from '../util/logger.js'
import { sameFilesystemPath } from '../util/path-identity.js'

// All git operations here are async on purpose: several of them hit the network
// (fetch, ls-remote, push) or check out a full tree (worktree add), and the
// daemon runs them on its only event loop. A sync exec here freezes every HTTP
// route (dashboard + extension) for the duration. Never reintroduce
// execSync/execFileSync in this module.
const execFileAsync = promisify(execFile)

// `.vigil-*` stays in the list on purpose: worktrees created before the
// vigil → helm rename still contain old `.vigil-prompt.txt` / `.vigil-attachments/`
// artifacts, and they must stay invisible to git.
const HELM_EXCLUDE_PATTERNS = ['.helm-*', '.vigil-*', '.mcp.json']

// Async exec means the event loop no longer serializes the daemon's git child
// processes: two concurrent solves in ONE repo would interleave `git fetch` /
// `git worktree add` / `checkout --detach` and contend on git's ref/index
// locks (the loser silently degrades to a stale base or a transient failure).
// Serialize mutating repo-level git ops per repoPath instead.
const repoLocks = new Map<string, Promise<unknown>>()

export function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
	const prev = repoLocks.get(repoPath) ?? Promise.resolve()
	const run = prev.then(fn, fn)
	repoLocks.set(
		repoPath,
		run.catch(() => {}),
	)
	return run
}

async function gitRefExists(repoPath: string, ref: string): Promise<boolean> {
	try {
		await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoPath })
		return true
	} catch {
		return false
	}
}

/** True if a local branch with this name already exists in the repo. */
export async function localBranchExists(repoPath: string, branchName: string): Promise<boolean> {
	return gitRefExists(repoPath, `refs/heads/${branchName}`)
}

export interface BranchWorktreeRegistration {
	path: string
	exists: boolean
}

/** Git's linked-worktree registration for a local branch, including stale paths. */
export async function worktreeRegistrationForBranch(
	repoPath: string,
	branchName: string,
): Promise<BranchWorktreeRegistration | null> {
	try {
		const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain', '-z'], {
			cwd: repoPath,
			timeout: 10_000,
		})
		const branchRef = `branch refs/heads/${branchName}`
		for (const block of stdout.split('\0\0')) {
			const lines = block.split('\0')
			if (!lines.includes(branchRef)) continue
			const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
			if (path) return { path, exists: existsSync(path) }
		}
	} catch {
		// Preview/reuse discovery is best-effort; ordinary branch logic remains.
	}
	return null
}

/** Existing on-disk linked worktree that currently checks out this branch. */
export async function worktreePathForBranch(repoPath: string, branchName: string): Promise<string | null> {
	const registration = await worktreeRegistrationForBranch(repoPath, branchName)
	return registration?.exists ? registration.path : null
}

/** Read-only execution/planning fence; Main never inherits a linked-worktree path. */
export async function assertWorkspaceReuse(
	repoPath: string,
	branchName: string,
	worktreePath: string,
	mode: SolverWorkspace = 'worktree',
): Promise<void> {
	const guidance = 'Preserve planning files, then re-plan in the selected workspace mode before retrying.'
	const canonical = sameFilesystemPath(repoPath, worktreePath)
	if (mode === 'main') {
		if (!canonical || !existsSync(repoPath))
			throw phaseError('worktree', `Main execution requires the canonical project checkout. ${guidance}`)
		return
	}
	if (canonical)
		throw phaseError('worktree', `Worktree execution cannot reuse the canonical project checkout. ${guidance}`)
	try {
		const registration = await worktreeRegistrationForBranch(repoPath, branchName)
		if (!registration?.exists || !sameFilesystemPath(registration.path, worktreePath))
			throw new Error('Missing exact branch registration')
		const gitPath = async (cwd: string, arg: string) => {
			const { stdout } = await execFileAsync('git', ['rev-parse', arg], { cwd, timeout: 10_000 })
			return realpathSync.native(resolve(cwd, stdout.trim()))
		}
		const root = await gitPath(worktreePath, '--show-toplevel')
		if (root !== realpathSync.native(worktreePath)) throw new Error('Not a worktree root')
		if ((await gitPath(repoPath, '--git-common-dir')) !== (await gitPath(worktreePath, '--git-common-dir')))
			throw new Error('Different repository')
		if ((await getCurrentBranch(worktreePath)) !== branchName) throw new Error('Different branch')
	} catch {
		throw phaseError(
			'worktree',
			`Stored path is not an active Git worktree for the exact project and branch ${branchName}: ${worktreePath}. ${guidance}`,
		)
	}
}

export type RemoteBranchStatus = 'exists' | 'absent' | 'unavailable'

/** Read-only origin lookup that distinguishes absence from network/auth failure. */
export async function inspectRemoteBranch(
	repoPath: string,
	branchName: string,
	timeout = 5_000,
): Promise<RemoteBranchStatus> {
	if (await gitRefExists(repoPath, `refs/remotes/origin/${branchName}`)) return 'exists'
	try {
		await execFileAsync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branchName], {
			cwd: repoPath,
			timeout,
		})
		return 'exists'
	} catch (err) {
		return (err as { code?: number }).code === 2 ? 'absent' : 'unavailable'
	}
}

/** Best-effort boolean used by branch naming, where lookup failure must degrade. */
export async function remoteBranchExists(repoPath: string, branchName: string): Promise<boolean> {
	return (await inspectRemoteBranch(repoPath, branchName)) === 'exists'
}

export async function resolveWorktreeStartPoint(repoPath: string, baseRef: string): Promise<string> {
	try {
		await execFileAsync('git', ['fetch', 'origin', baseRef], { cwd: repoPath })
	} catch {
		log.warn('worktree', `Could not fetch origin/${baseRef}, using local`)
	}

	const remoteRef = baseRef.startsWith('origin/') ? baseRef : `origin/${baseRef}`
	if (await gitRefExists(repoPath, remoteRef)) return remoteRef
	if (await gitRefExists(repoPath, baseRef)) return baseRef
	return baseRef
}

export function createWorktree(
	repoPath: string,
	baseBranch: string,
	branchName: string,
	worktreeBaseDir?: string,
): Promise<string> {
	return withRepoLock(repoPath, () => createWorktreeLocked(repoPath, baseBranch, branchName, worktreeBaseDir))
}

async function createWorktreeLocked(
	repoPath: string,
	baseBranch: string,
	branchName: string,
	worktreeBaseDir?: string,
): Promise<string> {
	const registration = await worktreeRegistrationForBranch(repoPath, branchName)
	if (registration?.exists) {
		await assertWorkspaceReuse(repoPath, branchName, registration.path)
		return registration.path
	}

	if (registration) {
		throw phaseError(
			'worktree',
			`Git retains a missing worktree registration for ${branchName}: ${registration.path}. Preserve the branch and any files, resolve the stale registration explicitly with Git, then retry.`,
		)
	}

	const worktreeDir = worktreeBaseDir ?? join(dirname(repoPath), `${basename(repoPath)}-worktrees`)
	const worktreePath = join(worktreeDir, branchName.replace(/\//g, '-'))
	// lstat also catches dangling symlinks. Never remove an unexpected occupant.
	try {
		lstatSync(worktreePath)
		throw phaseError(
			'worktree',
			`Worktree destination is occupied: ${worktreePath}. Preserve its files and re-plan or choose another worktree directory before retrying.`,
		)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	const retainedBranch = await localBranchExists(repoPath, branchName)
	const startPoint = retainedBranch ? undefined : await resolveWorktreeStartPoint(repoPath, baseBranch)
	mkdirSync(worktreeDir, { recursive: true })
	await execFileAsync(
		'git',
		retainedBranch
			? ['worktree', 'add', worktreePath, branchName]
			: ['worktree', 'add', '-b', branchName, worktreePath, startPoint as string],
		{ cwd: repoPath },
	)
	await assertWorkspaceReuse(repoPath, branchName, worktreePath)

	log.success('worktree', `Created worktree at ${worktreePath} (branch: ${branchName})`)
	return worktreePath
}

/**
 * Add helm temp file patterns to the worktree's git exclude so they're invisible to git.
 * Uses Git's resolved repository-local info/exclude path and never commits it.
 */
export async function excludeHelmFiles(worktreePath: string): Promise<void> {
	try {
		const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: worktreePath })
		const reportedPath = stdout.trim()
		const excludePath = isAbsolute(reportedPath) ? reportedPath : resolve(worktreePath, reportedPath)
		mkdirSync(dirname(excludePath), { recursive: true })
		appendFileSync(excludePath, `\n# Helm temp files\n${HELM_EXCLUDE_PATTERNS.join('\n')}\n`)
	} catch {
		log.warn('worktree', 'Could not write git exclude patterns')
	}
}

export async function pushBranch(worktreePath: string, branchName: string): Promise<void> {
	try {
		await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd: worktreePath })
		log.success('worktree', `Pushed branch ${branchName}`)
	} catch {
		// Branch may have been renamed (e.g. by /almanac:ship) or already pushed
		const currentBranch = await getCurrentBranch(worktreePath)
		if (currentBranch && currentBranch !== branchName) {
			log.info('worktree', `Branch was renamed to ${currentBranch}, pushing that instead`)
			await execFileAsync('git', ['push', '-u', 'origin', currentBranch], { cwd: worktreePath })
			log.success('worktree', `Pushed branch ${currentBranch}`)
			return
		}
		// Check if there's simply nothing to push (Claude already pushed)
		if (currentBranch && (await isBranchOnRemote(worktreePath, currentBranch))) {
			log.info('worktree', `Branch ${currentBranch} already exists on remote, skipping push`)
			return
		}
		throw new Error(`Failed to push branch ${branchName} — refspec not found and no remote branch detected`)
	}
}

/** Branch currently checked out at `cwd` (null when detached or not a repo). */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd })
		return stdout.trim() || null
	} catch {
		return null
	}
}

async function isBranchOnRemote(cwd: string, branch: string): Promise<boolean> {
	try {
		await execFileAsync('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], { cwd })
		return true
	} catch {
		return false
	}
}
