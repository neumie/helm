import {
	type GithubIssue,
	type GithubRepo,
	type IssueClient,
	type IssueCloseReason,
	IssueUnavailableError,
	repoSlug,
} from '../../src/github/issues.js'

export interface FakeIssue {
	repo: string
	number: number
	url: string
	title: string
	body: string
	state: 'open' | 'closed'
	closeReason: IssueCloseReason | null
	comments: string[]
}

/** In-memory GitHub for ItemIssues tests. Records every call; never touches the network. */
export class FakeIssueClient implements IssueClient {
	readonly issues: FakeIssue[] = []
	readonly calls: string[] = []
	readonly pullRequests = new Map<string, string>()
	/** Local checkout path → repository; a missing entry means "no GitHub remote". */
	readonly remotes = new Map<string, GithubRepo>()
	/** Make the next call of this method throw. */
	failNext: { method: string; error: unknown } | null = null
	/** Resolve calls only after this promise (to hold a call in flight). */
	gate: Promise<void> | null = null

	private async enter(method: string, signal?: AbortSignal): Promise<void> {
		this.calls.push(method)
		if (this.gate) await this.gate
		if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
		if (this.failNext?.method === method) {
			const { error } = this.failNext
			this.failNext = null
			throw error
		}
	}

	issue(number: number, repo = 'acme/app'): FakeIssue {
		const found = this.issues.find(issue => issue.number === number && issue.repo === repo)
		if (!found) throw new Error(`No fake issue ${repo}#${number}`)
		return found
	}

	async repoFor(repoPath: string, signal?: AbortSignal): Promise<GithubRepo> {
		await this.enter('repoFor', signal)
		const repo = this.remotes.get(repoPath)
		if (!repo) throw new IssueUnavailableError('no-github-remote')
		return repo
	}

	async find(repo: GithubRepo, marker: string, state: 'open' | 'all', signal?: AbortSignal) {
		await this.enter('find', signal)
		const found = this.issues.find(
			issue =>
				issue.repo === repoSlug(repo) && issue.body.includes(marker) && (state === 'all' || issue.state === 'open'),
		)
		return found ? this.view0(found) : null
	}

	async create(repo: GithubRepo, input: { title: string; body: string }, signal?: AbortSignal): Promise<GithubIssue> {
		await this.enter('create', signal)
		const number = this.issues.filter(issue => issue.repo === repoSlug(repo)).length + 1
		const issue: FakeIssue = {
			repo: repoSlug(repo),
			number,
			url: `https://github.com/${repoSlug(repo)}/issues/${number}`,
			title: input.title,
			body: input.body,
			state: 'open',
			closeReason: null,
			comments: [],
		}
		this.issues.push(issue)
		return this.view0(issue)
	}

	private view0(issue: FakeIssue): GithubIssue {
		return { number: issue.number, url: issue.url, state: issue.state }
	}

	async view(repo: GithubRepo, number: number, signal?: AbortSignal): Promise<GithubIssue> {
		await this.enter('view', signal)
		const issue = this.issues.find(entry => entry.repo === repoSlug(repo) && entry.number === number)
		if (!issue) throw new IssueUnavailableError('repo-not-found', 'Could not resolve to an issue')
		return this.view0(issue)
	}

	async comment(repo: GithubRepo, number: number, body: string, signal?: AbortSignal): Promise<void> {
		await this.enter('comment', signal)
		this.issue(number, repoSlug(repo)).comments.push(body)
	}

	async close(repo: GithubRepo, number: number, reason: IssueCloseReason, signal?: AbortSignal): Promise<void> {
		await this.enter('close', signal)
		const issue = this.issue(number, repoSlug(repo))
		issue.state = 'closed'
		issue.closeReason = reason
	}

	async reopen(repo: GithubRepo, number: number, signal?: AbortSignal): Promise<void> {
		await this.enter('reopen', signal)
		const issue = this.issue(number, repoSlug(repo))
		issue.state = 'open'
		issue.closeReason = null
	}

	async pullRequestBody(prUrl: string, signal?: AbortSignal): Promise<string> {
		await this.enter('pullRequestBody', signal)
		return this.pullRequests.get(prUrl) ?? ''
	}

	async editPullRequestBody(prUrl: string, body: string, signal?: AbortSignal): Promise<void> {
		await this.enter('editPullRequestBody', signal)
		this.pullRequests.set(prUrl, body)
	}
}
