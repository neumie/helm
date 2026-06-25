import { execFileSync, execSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { log } from '../util/logger.js'

const VIGIL_EXCLUDE_PATTERNS = ['.vigil-*', '.mcp.json']

function gitRefExists(repoPath: string, ref: string): boolean {
	try {
		execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoPath, stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

/** True if a local branch with this name already exists in the repo. */
export function localBranchExists(repoPath: string, branchName: string): boolean {
	return gitRefExists(repoPath, `refs/heads/${branchName}`)
}

/**
 * True if the branch exists on origin — checks the fetched remote-tracking ref
 * first (fast) then falls back to an authoritative `git ls-remote` (covers a
 * remote branch never fetched locally). A network/no-origin failure is treated as
 * "absent" so this can't block naming.
 */
export function remoteBranchExists(repoPath: string, branchName: string): boolean {
	if (gitRefExists(repoPath, `refs/remotes/origin/${branchName}`)) return true
	try {
		execFileSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branchName], { cwd: repoPath, stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

export function resolveWorktreeStartPoint(repoPath: string, baseRef: string): string {
	try {
		execFileSync('git', ['fetch', 'origin', baseRef], { cwd: repoPath, stdio: 'pipe' })
	} catch {
		log.warn('worktree', `Could not fetch origin/${baseRef}, using local`)
	}

	const remoteRef = baseRef.startsWith('origin/') ? baseRef : `origin/${baseRef}`
	if (gitRefExists(repoPath, remoteRef)) return remoteRef
	if (gitRefExists(repoPath, baseRef)) return baseRef
	return baseRef
}

export function createWorktree(
	repoPath: string,
	baseBranch: string,
	branchName: string,
	worktreeBaseDir?: string,
): string {
	const startPoint = resolveWorktreeStartPoint(repoPath, baseBranch)

	const worktreeDir = worktreeBaseDir ?? join(dirname(repoPath), `${basename(repoPath)}-worktrees`)
	if (!existsSync(worktreeDir)) {
		mkdirSync(worktreeDir, { recursive: true })
	}

	const worktreePath = join(worktreeDir, branchName.replace(/\//g, '-'))

	if (existsSync(worktreePath)) {
		log.warn('worktree', `Worktree path already exists: ${worktreePath}, removing first`)
		try {
			execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, stdio: 'pipe' })
		} catch {
			// May not be a worktree, just a directory
		}
	}

	execFileSync('git', ['worktree', 'add', '-B', branchName, worktreePath, startPoint], {
		cwd: repoPath,
		stdio: 'pipe',
	})

	log.success('worktree', `Created worktree at ${worktreePath} (branch: ${branchName})`)
	return worktreePath
}

/**
 * Add vigil temp file patterns to the worktree's git exclude so they're invisible to git.
 * Uses $GIT_DIR/info/exclude which is per-worktree and never committed.
 */
export function excludeVigilFiles(worktreePath: string): void {
	try {
		const gitDir = execSync('git rev-parse --git-dir', {
			cwd: worktreePath,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
		const excludePath = join(worktreePath, gitDir, 'info', 'exclude')
		mkdirSync(join(worktreePath, gitDir, 'info'), { recursive: true })
		appendFileSync(excludePath, `\n# Vigil temp files\n${VIGIL_EXCLUDE_PATTERNS.join('\n')}\n`)
	} catch {
		log.warn('worktree', 'Could not write git exclude patterns')
	}
}

export function pushBranch(worktreePath: string, branchName: string): void {
	try {
		execSync(`git push -u origin "${branchName}"`, { cwd: worktreePath, stdio: 'pipe' })
		log.success('worktree', `Pushed branch ${branchName}`)
	} catch {
		// Branch may have been renamed (e.g. by /almanac:ship) or already pushed
		const currentBranch = getCurrentBranch(worktreePath)
		if (currentBranch && currentBranch !== branchName) {
			log.info('worktree', `Branch was renamed to ${currentBranch}, pushing that instead`)
			execSync(`git push -u origin "${currentBranch}"`, { cwd: worktreePath, stdio: 'pipe' })
			log.success('worktree', `Pushed branch ${currentBranch}`)
			return
		}
		// Check if there's simply nothing to push (Claude already pushed)
		if (currentBranch && isBranchOnRemote(worktreePath, currentBranch)) {
			log.info('worktree', `Branch ${currentBranch} already exists on remote, skipping push`)
			return
		}
		throw new Error(`Failed to push branch ${branchName} — refspec not found and no remote branch detected`)
	}
}

function getCurrentBranch(cwd: string): string | null {
	try {
		return execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim() || null
	} catch {
		return null
	}
}

function isBranchOnRemote(cwd: string, branch: string): boolean {
	try {
		execSync(`git ls-remote --exit-code origin "refs/heads/${branch}"`, { cwd, stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}
