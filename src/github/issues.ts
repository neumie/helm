import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A GitHub repository, as `gh -R owner/name` addresses it. */
export interface GithubRepo {
	owner: string
	name: string
}

export type GithubIssueState = 'open' | 'closed'

export interface GithubIssue {
	number: number
	url: string
	state: GithubIssueState
}

export type IssueCloseReason = 'completed' | 'not planned'

/**
 * Why Helm could not track a run on a GitHub issue. Every reason is a normal,
 * expected situation (a repo without a GitHub remote, a machine without `gh`),
 * so the run goes on and keeps its result in Helm's own state only.
 */
export type IssueUnavailableReason =
	| 'no-github-remote'
	| 'gh-missing'
	| 'gh-auth'
	| 'issues-disabled'
	| 'repo-not-found'
	| 'public-repo'
	| 'failed'

const REASON_TEXT: Record<IssueUnavailableReason, string> = {
	'no-github-remote': 'the project has no GitHub remote (origin)',
	'gh-missing': 'the GitHub CLI (gh) is not installed',
	'gh-auth': 'the GitHub CLI is not logged in (run `gh auth login`)',
	'issues-disabled': 'issues are disabled on the GitHub repository',
	'repo-not-found': 'the GitHub repository was not found or is not accessible',
	'public-repo': 'the GitHub repository is public; task text is only filed on private repositories',
	failed: 'the GitHub CLI failed',
}

export class IssueUnavailableError extends Error {
	readonly reason: IssueUnavailableReason

	constructor(reason: IssueUnavailableReason, detail?: string) {
		super(detail ? `${REASON_TEXT[reason]}: ${detail}` : REASON_TEXT[reason])
		this.name = 'IssueUnavailableError'
		this.reason = reason
	}
}

/**
 * The GitHub issue operations Helm needs to track a run. The production client
 * shells out to `gh`; tests use an in-memory fake. Every method may throw
 * {@link IssueUnavailableError}; callers treat issue tracking as best effort.
 */
export interface IssueClient {
	/**
	 * The GitHub repository behind a local checkout's `origin` remote, once it is
	 * known to be private (or internal) with issues enabled. Task text may come
	 * from clients and untrusted senders, so a public repository is refused.
	 */
	repoFor(repoPath: string, signal?: AbortSignal): Promise<GithubRepo>
	/**
	 * An issue authored by the authenticated gh user whose body contains `marker`
	 * exactly; `state: 'open'` skips closed ones. Issues by anyone else are never
	 * adopted: a marker is plain text any repository user can copy.
	 */
	find(repo: GithubRepo, marker: string, state: 'open' | 'all', signal?: AbortSignal): Promise<GithubIssue | null>
	create(repo: GithubRepo, issue: { title: string; body: string }, signal?: AbortSignal): Promise<GithubIssue>
	view(repo: GithubRepo, number: number, signal?: AbortSignal): Promise<GithubIssue>
	comment(repo: GithubRepo, number: number, body: string, signal?: AbortSignal): Promise<void>
	close(repo: GithubRepo, number: number, reason: IssueCloseReason, signal?: AbortSignal): Promise<void>
	reopen(repo: GithubRepo, number: number, signal?: AbortSignal): Promise<void>
	/** Body of a pull request, addressed by its URL. */
	pullRequestBody(prUrl: string, signal?: AbortSignal): Promise<string>
	editPullRequestBody(prUrl: string, body: string, signal?: AbortSignal): Promise<void>
}

const NAME = /^[A-Za-z0-9_.-]+$/

/**
 * Parse a git remote URL that points at github.com. Accepts the https, scp-like
 * ssh (`git@github.com:o/r.git`) and `ssh://` forms. Anything else is null:
 * Helm only files issues on github.com.
 */
export function parseGithubRemote(url: string): GithubRepo | null {
	const trimmed = url.trim()
	const match =
		/^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed) ??
		/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed)
	if (!match) return null
	const [, owner, name] = match
	if (!owner || !name || !NAME.test(owner) || !NAME.test(name)) return null
	return { owner, name }
}

export function repoSlug(repo: GithubRepo): string {
	return `${repo.owner}/${repo.name}`
}

/** Issue number from a `https://github.com/o/r/issues/N` URL. */
export function issueNumberFromUrl(url: string): number | null {
	const match = /\/issues\/(\d+)\/?$/.exec(url.trim())
	return match ? Number.parseInt(match[1] ?? '', 10) : null
}

function issueState(value: unknown): GithubIssueState {
	return typeof value === 'string' && value.toUpperCase() === 'OPEN' ? 'open' : 'closed'
}

export interface GhRunOptions {
	cwd?: string
	/** Written to stdin (used with `--body-file -`, so bodies never land on argv). */
	input?: string
	signal?: AbortSignal
	timeoutMs?: number
}

/** `gh` runner seam: resolves stdout on exit 0, rejects with `{ code, stderr }` otherwise. */
export type GhRunner = (args: string[], options: GhRunOptions) => Promise<string>

const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
const DEFAULT_TIMEOUT_MS = 20_000

export const runGh: GhRunner = (args, options) =>
	new Promise((resolve, reject) => {
		const child = spawn('gh', args, {
			cwd: options.cwd,
			env: { ...process.env, ...GH_ENV },
			signal: options.signal,
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		child.stdout.setEncoding('utf8').on('data', chunk => {
			stdout += chunk
		})
		child.stderr.setEncoding('utf8').on('data', chunk => {
			stderr += chunk
		})
		child.on('error', error => reject(Object.assign(error, { stderr })))
		child.on('close', code => {
			if (code === 0) resolve(stdout)
			else reject(Object.assign(new Error(`gh ${args[0]} ${args[1] ?? ''} exited ${code}`), { code, stderr }))
		})
		child.stdin.on('error', () => {
			// A child that exits before reading stdin reports through `close`.
		})
		child.stdin.end(options.input ?? '')
	})

/** Map a failed `gh` call onto the reasons the operator can act on. */
export function classifyGhError(error: unknown): IssueUnavailableError {
	if (error instanceof IssueUnavailableError) return error
	const err = error as { code?: unknown; stderr?: unknown; message?: unknown }
	if (err?.code === 'ENOENT') return new IssueUnavailableError('gh-missing')
	const stderr = typeof err?.stderr === 'string' ? err.stderr : ''
	const text = `${stderr}\n${typeof err?.message === 'string' ? err.message : ''}`
	const detail = stderr.trim().split('\n').at(-1)?.slice(0, 300) || undefined
	if (/gh auth login|not logged|authentication|bad credentials|HTTP 401/i.test(text))
		return new IssueUnavailableError('gh-auth', detail)
	if (/disabled issues|issues are disabled/i.test(text)) return new IssueUnavailableError('issues-disabled', detail)
	if (/could not resolve to a repository|HTTP 404|repository not found/i.test(text))
		return new IssueUnavailableError('repo-not-found', detail)
	return new IssueUnavailableError('failed', detail)
}

/** Production {@link IssueClient} over the GitHub CLI. */
export class GhIssueClient implements IssueClient {
	constructor(private readonly gh: GhRunner = runGh) {}

	private async run(args: string[], options: GhRunOptions = {}): Promise<string> {
		try {
			return await this.gh(args, options)
		} catch (error) {
			if (options.signal?.aborted) throw error
			throw classifyGhError(error)
		}
	}

	async repoFor(repoPath: string, signal?: AbortSignal): Promise<GithubRepo> {
		let url: string
		try {
			const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
				timeout: 10_000,
				signal,
			})
			url = stdout
		} catch (error) {
			if (signal?.aborted) throw error
			throw new IssueUnavailableError('no-github-remote')
		}
		const repo = parseGithubRemote(url)
		if (!repo) throw new IssueUnavailableError('no-github-remote')
		const stdout = await this.run(['repo', 'view', repoSlug(repo), '--json', 'visibility,hasIssuesEnabled'], { signal })
		const info = JSON.parse(stdout) as { visibility?: unknown; hasIssuesEnabled?: unknown }
		const visibility = typeof info.visibility === 'string' ? info.visibility.toUpperCase() : ''
		if (visibility !== 'PRIVATE' && visibility !== 'INTERNAL') throw new IssueUnavailableError('public-repo')
		if (info.hasIssuesEnabled === false) throw new IssueUnavailableError('issues-disabled')
		return repo
	}

	async find(
		repo: GithubRepo,
		marker: string,
		state: 'open' | 'all',
		signal?: AbortSignal,
	): Promise<GithubIssue | null> {
		const token = marker.replace(/^<!--\s*|\s*-->$/g, '').replace(/"/g, '')
		const stdout = await this.run(
			[
				'issue',
				'list',
				'-R',
				repoSlug(repo),
				'--state',
				state,
				'--author',
				'@me',
				'--search',
				`"${token}" in:body`,
				'--json',
				'number,url,state,body',
				'--limit',
				'30',
			],
			{ signal },
		)
		const issues: unknown = JSON.parse(stdout || '[]')
		if (!Array.isArray(issues)) return null
		for (const issue of issues) {
			if (
				issue &&
				typeof issue === 'object' &&
				typeof issue.body === 'string' &&
				issue.body.includes(marker) &&
				typeof issue.number === 'number' &&
				typeof issue.url === 'string'
			) {
				return { number: issue.number, url: issue.url, state: issueState(issue.state) }
			}
		}
		return null
	}

	async create(repo: GithubRepo, issue: { title: string; body: string }, signal?: AbortSignal): Promise<GithubIssue> {
		const stdout = await this.run(
			['issue', 'create', '-R', repoSlug(repo), '--title', issue.title, '--body-file', '-'],
			{ input: issue.body, signal },
		)
		const url = stdout.trim().split('\n').at(-1)?.trim() ?? ''
		const number = issueNumberFromUrl(url)
		if (number === null) throw new IssueUnavailableError('failed', `unexpected gh issue create output: ${url}`)
		return { number, url, state: 'open' }
	}

	async view(repo: GithubRepo, number: number, signal?: AbortSignal): Promise<GithubIssue> {
		const stdout = await this.run(
			['issue', 'view', String(number), '-R', repoSlug(repo), '--json', 'number,url,state'],
			{
				signal,
			},
		)
		const issue = JSON.parse(stdout) as { number?: unknown; url?: unknown; state?: unknown }
		if (typeof issue.url !== 'string') throw new IssueUnavailableError('failed', 'unexpected gh issue view output')
		return { number, url: issue.url, state: issueState(issue.state) }
	}

	async comment(repo: GithubRepo, number: number, body: string, signal?: AbortSignal): Promise<void> {
		await this.run(['issue', 'comment', String(number), '-R', repoSlug(repo), '--body-file', '-'], {
			input: body,
			signal,
		})
	}

	async close(repo: GithubRepo, number: number, reason: IssueCloseReason, signal?: AbortSignal): Promise<void> {
		await this.run(['issue', 'close', String(number), '-R', repoSlug(repo), '--reason', reason], { signal })
	}

	async reopen(repo: GithubRepo, number: number, signal?: AbortSignal): Promise<void> {
		await this.run(['issue', 'reopen', String(number), '-R', repoSlug(repo)], { signal })
	}

	async pullRequestBody(prUrl: string, signal?: AbortSignal): Promise<string> {
		const stdout = await this.run(['pr', 'view', prUrl, '--json', 'body'], { signal })
		const pr = JSON.parse(stdout) as { body?: unknown }
		return typeof pr.body === 'string' ? pr.body : ''
	}

	async editPullRequestBody(prUrl: string, body: string, signal?: AbortSignal): Promise<void> {
		await this.run(['pr', 'edit', prUrl, '--body-file', '-'], { input: body, signal })
	}
}
