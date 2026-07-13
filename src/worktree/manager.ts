import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { log } from '../util/logger.js'

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

/**
 * True if the branch exists on origin — checks the fetched remote-tracking ref
 * first (fast) then falls back to an authoritative `git ls-remote` (covers a
 * remote branch never fetched locally). A network/no-origin failure is treated as
 * "absent" so this can't block naming.
 */
export async function remoteBranchExists(repoPath: string, branchName: string): Promise<boolean> {
	if (await gitRefExists(repoPath, `refs/remotes/origin/${branchName}`)) return true
	try {
		await execFileAsync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branchName], { cwd: repoPath })
		return true
	} catch {
		return false
	}
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
	const startPoint = await resolveWorktreeStartPoint(repoPath, baseBranch)

	const worktreeDir = worktreeBaseDir ?? join(dirname(repoPath), `${basename(repoPath)}-worktrees`)
	if (!existsSync(worktreeDir)) {
		mkdirSync(worktreeDir, { recursive: true })
	}

	const worktreePath = join(worktreeDir, branchName.replace(/\//g, '-'))

	if (existsSync(worktreePath)) {
		log.warn('worktree', `Worktree path already exists: ${worktreePath}, removing first`)
		try {
			await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath })
		} catch {
			// May not be a worktree, just a directory
		}
	}

	await execFileAsync('git', ['worktree', 'add', '-B', branchName, worktreePath, startPoint], {
		cwd: repoPath,
	})

	log.success('worktree', `Created worktree at ${worktreePath} (branch: ${branchName})`)
	return worktreePath
}

/**
 * Add helm temp file patterns to the worktree's git exclude so they're invisible to git.
 * Uses $GIT_DIR/info/exclude which is per-worktree and never committed.
 */
export async function excludeHelmFiles(worktreePath: string): Promise<void> {
	try {
		const { stdout } = await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: worktreePath })
		const gitDir = stdout.trim()
		const excludePath = join(worktreePath, gitDir, 'info', 'exclude')
		mkdirSync(join(worktreePath, gitDir, 'info'), { recursive: true })
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
