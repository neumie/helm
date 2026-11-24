import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import {
	type GithubIssue,
	type GithubRepo,
	type IssueClient,
	IssueUnavailableError,
	classifyGhError,
	repoSlug,
} from '../github/issues.js'
import {
	closeComment,
	issueBody,
	issueTitle,
	itemIssueMarker,
	pullRequestComment,
	runCancelledComment,
	runFailureComment,
	runResultComment,
	runStartComment,
	sourceIssueMarker,
	withClosingReference,
} from '../github/item-issue-text.js'
import type { TaskContext } from '../providers/provider.js'
import type { SolverResult } from '../solver/result-schema.js'
import { isCancellation, taskCancelled } from '../util/errors.js'
import { log } from '../util/logger.js'
import { isItemAssigned } from './assignment.js'
import { ItemCommands } from './commands.js'
import type { ItemGithubIssue, ItemRecord } from './schema.js'

/** Linking the issue happens on the run's start path; never hold the run longer than this. */
const BEGIN_BUDGET_MS = 45_000

/** What the solve prompt needs to know about the run's issue. */
export interface RunIssue {
	number: number
	url: string
	/** How a PR in the same repository refers to it, e.g. `#12`. */
	reference: string
}

export interface BeginRunInput {
	commands: ItemCommands
	item: ItemRecord
	/** Local checkout of the project; its `origin` remote names the GitHub repository. */
	repoPath: string
	/** The task as Helm will solve it (no project knowledge: the issue is visible to the repo's readers). */
	task: TaskContext
	run: { agent: string; model?: string | null; workspace: string; branchName?: string | null }
	signal?: AbortSignal
}

function repoOf(issue: ItemGithubIssue): GithubRepo {
	return { owner: issue.owner, name: issue.repo }
}

function runIssue(issue: { number: number; url: string }): RunIssue {
	return { number: issue.number, url: issue.url, reference: `#${issue.number}` }
}

/** `owner/repo` of a `https://github.com/owner/repo/pull/N` URL. */
function pullRequestRepo(prUrl: string): string | null {
	const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec(prUrl)
	return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

/**
 * Tracks a solve Item's runs on a GitHub issue in the project's repository:
 * the task is the issue body, each run's start, result, pull request and
 * failure are comments, and the issue closes with the merged PR (`Closes #N`)
 * or when Helm finishes the Item without one.
 *
 * Best effort by design. A repository without a GitHub remote, a machine
 * without `gh`, or a GitHub outage never fails a run: Helm records why
 * (`issue_unavailable`) and the run's result stays in Helm's own state.
 * Operations on one Item are serialized so comments land in order.
 */
export class ItemIssues {
	private readonly chains = new Map<string, Promise<unknown>>()

	constructor(private readonly client: IssueClient) {}

	private serialize<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(itemId) ?? Promise.resolve()
		const run = previous.then(fn, fn)
		const tail = run.then(
			() => undefined,
			() => undefined,
		)
		this.chains.set(itemId, tail)
		void tail.then(() => {
			if (this.chains.get(itemId) === tail) this.chains.delete(itemId)
		})
		return run
	}

	/**
	 * Find, reopen or create the issue for a starting run and post the start
	 * comment. Returns null (and records why) when the run cannot be tracked on
	 * GitHub. Throws only when the run itself was cancelled.
	 */
	beginRun(input: BeginRunInput): Promise<RunIssue | null> {
		return this.serialize(input.item.id, () => this.begin(input))
	}

	private async begin(input: BeginRunInput): Promise<RunIssue | null> {
		const { commands, item } = input
		if (item.kind !== 'solve' || !isItemAssigned(item)) return null
		const budget = AbortSignal.timeout(BEGIN_BUDGET_MS)
		const signal = input.signal ? AbortSignal.any([input.signal, budget]) : budget
		try {
			const linked = await this.link(input, signal)
			commands.recordGithubIssue(item.id, linked.issue, linked.how)
			const attempt = Math.max(1, commands.countRunAttempts(item.id))
			await this.client.comment(linked.repo, linked.issue.number, runStartComment({ attempt, ...input.run }), signal)
			return runIssue(linked.issue)
		} catch (error) {
			if (input.signal?.aborted || isCancellation(error, input.signal)) throw taskCancelled()
			const unavailable = budget.aborted
				? new IssueUnavailableError('failed', 'GitHub did not answer in time')
				: classifyGhError(error)
			log.warn('issues', `Item ${item.id} runs without a GitHub issue: ${unavailable.message}`)
			try {
				commands.recordGithubIssueUnavailable(item.id, unavailable.reason, unavailable.message)
			} catch {
				// The Item is gone; nothing to record.
			}
			// A run linked before the failing comment still has its issue.
			const current = commands.getItem(item.id)?.githubIssue
			return current?.state === 'open' ? runIssue(current) : null
		}
	}

	private async link(
		input: BeginRunInput,
		signal: AbortSignal,
	): Promise<{
		repo: GithubRepo
		issue: { owner: string; repo: string; number: number; url: string }
		how: 'created' | 'found' | 'reopened' | 'kept'
	}> {
		const { item } = input
		const known = item.githubIssue ?? null
		const repo = known ? repoOf(known) : await this.client.repoFor(input.repoPath, signal)
		const withRepo = (issue: { number: number; url: string }) => ({
			owner: repo.owner,
			repo: repo.name,
			number: issue.number,
			url: issue.url,
		})
		const reopenIfClosed = async (issue: GithubIssue, how: 'found' | 'kept') => {
			if (issue.state === 'open') return { repo, issue: withRepo(issue), how }
			await this.client.reopen(repo, issue.number, signal)
			return { repo, issue: withRepo(issue), how: 'reopened' as const }
		}

		if (known) {
			try {
				return await reopenIfClosed(await this.client.view(repo, known.number, signal), 'kept')
			} catch (error) {
				// A deleted issue (or a transferred repository) gets a new one below.
				if (!(classifyGhError(error).reason === 'repo-not-found')) throw error
			}
		}

		const byItem = await this.client.find(repo, itemIssueMarker(item.id), 'all', signal)
		if (byItem) return reopenIfClosed(byItem, 'found')
		if (item.source && !item.capturedContext) {
			const bySource = await this.client.find(repo, sourceIssueMarker(item.source), 'open', signal)
			if (bySource) return { repo, issue: withRepo(bySource), how: 'found' }
		}
		const created = await this.client.create(
			repo,
			{
				title: issueTitle(item),
				body: issueBody({
					itemId: item.id,
					projectSlug: item.projectSlug ?? '',
					source: item.source && !item.capturedContext ? item.source : null,
					task: input.task,
				}),
			},
			signal,
		)
		return { repo, issue: withRepo(created), how: 'created' }
	}

	/** Post the run's result (summary, files, hidden JSON block) on its issue. */
	reportResult(commands: ItemCommands, itemId: string, result: SolverResult): Promise<void> {
		return this.serialize(itemId, async () => {
			const item = commands.getItem(itemId)
			const issue = item?.githubIssue
			if (!item || !issue) return
			await this.quietly(itemId, 'post the run result', () =>
				this.client.comment(
					repoOf(issue),
					issue.number,
					runResultComment({
						v: 1,
						itemId,
						attempt: Math.max(1, commands.countRunAttempts(itemId)),
						summary: result.summary,
						filesChanged: result.filesChanged,
						...(result.prTitle ? { prTitle: result.prTitle } : {}),
						...(result.prUrl ? { prUrl: result.prUrl } : {}),
						finishedAt: new Date().toISOString(),
					}),
				),
			)
		})
	}

	/**
	 * After dispatch: make sure the Item's pull request closes the issue on merge
	 * (an agent-shipped PR may lack `Closes #N`) and announce a PR Helm opened.
	 */
	reportPullRequest(commands: ItemCommands, itemId: string, opts: { announce: boolean }): Promise<void> {
		return this.serialize(itemId, async () => {
			const item = commands.getItem(itemId)
			const issue = item?.githubIssue
			if (!item?.prUrl || !issue) return
			const prUrl = item.prUrl
			const reference =
				pullRequestRepo(prUrl) === repoSlug(repoOf(issue)).toLowerCase()
					? `#${issue.number}`
					: `${repoSlug(repoOf(issue))}#${issue.number}`
			await this.quietly(itemId, 'link the pull request to its issue', async () => {
				const body = await this.client.pullRequestBody(prUrl)
				const next = withClosingReference(body, reference)
				if (next !== body) await this.client.editPullRequestBody(prUrl, next)
			})
			if (opts.announce) {
				await this.quietly(itemId, 'announce the pull request', () =>
					this.client.comment(repoOf(issue), issue.number, pullRequestComment(prUrl)),
				)
			}
		})
	}

	/** A failed or cancelled run: one comment. Failure keeps the issue open (retry is possible). */
	reportRunEnded(
		commands: ItemCommands,
		itemId: string,
		ended: { cancelled: true } | { cancelled: false; phase: string; message: string },
	): Promise<void> {
		return this.serialize(itemId, async () => {
			const item = commands.getItem(itemId)
			const issue = item?.githubIssue
			if (!item || !issue || issue.state !== 'open') return
			const attempt = Math.max(1, commands.countRunAttempts(itemId))
			const body = ended.cancelled
				? runCancelledComment(attempt)
				: runFailureComment({ attempt, phase: ended.phase, message: ended.message })
			await this.quietly(itemId, 'post the run outcome', () => this.client.comment(repoOf(issue), issue.number, body))
		}).then(() => this.settle(commands, itemId))
	}

	/**
	 * Close the issue of a finished Item: `done` closes it as completed (a merged
	 * PR has usually closed it already), `cancelled` as not planned. Other
	 * statuses leave it alone. Safe to call repeatedly.
	 */
	settle(commands: ItemCommands, itemId: string): Promise<void> {
		return this.serialize(itemId, async () => {
			const item = commands.getItem(itemId)
			const issue = item?.githubIssue
			if (!item || !issue || issue.state !== 'open') return
			if (item.status !== 'done' && item.status !== 'cancelled') return
			const repo = repoOf(issue)
			await this.quietly(itemId, 'close its issue', async () => {
				const current = await this.client.view(repo, issue.number)
				if (current.state === 'closed') {
					commands.recordGithubIssueClosed(itemId, item.status === 'done' ? 'completed' : 'not_planned', 'github')
					return
				}
				const kind = item.status === 'cancelled' ? 'cancelled' : item.deployState?.merged ? 'merged' : 'done'
				if (kind !== 'merged' || !item.prUrl) await this.client.comment(repo, issue.number, closeComment(kind))
				await this.client.close(repo, issue.number, item.status === 'done' ? 'completed' : 'not planned')
				commands.recordGithubIssueClosed(itemId, item.status === 'done' ? 'completed' : 'not_planned', 'helm')
			})
		})
	}

	/** Settle every finished Item whose issue Helm still records as open (startup / periodic catch-up). */
	async settleAll(commands: ItemCommands, items: ItemRecord[]): Promise<void> {
		for (const item of items) await this.settle(commands, item.id)
	}

	private async quietly(itemId: string, what: string, fn: () => Promise<void>): Promise<void> {
		try {
			await fn()
		} catch (error) {
			log.warn('issues', `Item ${itemId}: could not ${what}: ${classifyGhError(error).message}`)
		}
	}
}

const SETTLE_INTERVAL_MS = 120_000

/**
 * Closes the issues of Items that finished outside a run: set done or
 * cancelled by hand, rejected, cancelled while queued, or merged (where
 * GitHub's `Closes #N` usually closed the issue already and Helm only records
 * it). Also retries a close that failed earlier. Non-overlapping ticks over
 * every registered profile; independent of the task sidebar watch.
 */
export class ItemIssueSettler {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running: Promise<void> | null = null
	private stopped = false

	constructor(
		private readonly issues: ItemIssues,
		private readonly config: HelmConfig,
		private readonly db: DB,
		private readonly profileIds: () => string[],
		private readonly intervalMs = SETTLE_INTERVAL_MS,
	) {}

	start(): void {
		this.stopped = false
		this.schedule(5_000)
	}

	async stop(): Promise<void> {
		this.stopped = true
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		await this.running
	}

	private schedule(delay: number): void {
		if (this.stopped) return
		this.timer = setTimeout(() => {
			this.timer = null
			this.running = this.tick().finally(() => {
				this.running = null
				this.schedule(this.intervalMs)
			})
		}, delay)
		this.timer.unref?.()
	}

	async tick(): Promise<void> {
		for (const profileId of this.profileIds()) {
			if (this.stopped) return
			const store = this.db.forProfile(profileId).items
			const commands = new ItemCommands(store, this.config)
			try {
				await this.issues.settleAll(commands, store.listOpenIssuesToSettle())
			} catch (error) {
				log.warn('issues', `Could not settle issues for profile ${profileId}`, error)
			}
		}
	}
}
