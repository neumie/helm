// GitHub Signals reader: two read-only `gh api graphql` calls per poll (review requests + my open
// PRs with activity/CI, then mentions), mapped by github-map.ts. Async exec only (the daemon has one
// event loop), injectable runner for tests, never a token on argv or in logs.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { oneLine } from '../agent-dock/text.js'
import type { HelmConfig } from '../config.js'
import { SIGNAL_LIMITS, type SignalSourceStatus } from './contract.js'
import {
	GITHUB_GONE_REASON,
	type GithubMentionsData,
	type GithubPrsData,
	mapGithubSignals,
	searchComplete,
} from './github-map.js'
import type { SignalReader } from './watcher.js'

/** What one reader poll yields (the watcher persists it unless the tick was aborted). */
export type SignalSourceRead = Awaited<ReturnType<SignalReader['read']>>

export interface SignalCommandOptions {
	signal?: AbortSignal
	timeout: number
	maxBuffer: number
	env: NodeJS.ProcessEnv
}

/**
 * execFile-shaped seam. Resolves with stdout/stderr on exit 0; rejects like `execFile` otherwise
 * (an error carrying `code`, `stdout`, `stderr`, `killed`).
 */
export type SignalCommandRunner = (
	file: string,
	args: string[],
	options: SignalCommandOptions,
) => Promise<{ stdout: string; stderr: string }>

const execFileAsync = promisify(execFile)

export const defaultSignalCommandRunner: SignalCommandRunner = async (file, args, options) => {
	const { stdout, stderr } = await execFileAsync(file, args, { ...options, encoding: 'utf8' })
	return { stdout, stderr }
}

/** What a rejected execFile carries. */
export interface CommandFailure {
	code?: unknown
	killed?: unknown
	signal?: unknown
	name?: unknown
	stdout?: unknown
	stderr?: unknown
}

export function commandFailure(error: unknown): CommandFailure {
	return error !== null && typeof error === 'object' ? (error as CommandFailure) : {}
}

export function isAbort(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || commandFailure(error).name === 'AbortError'
}

/** First non-empty line of a command's stderr, one line and bounded. */
export function firstLine(text: unknown): string {
	if (typeof text !== 'string') return ''
	const line = text.split(/\r?\n/).find(part => part.trim() !== '') ?? ''
	return oneLine(line, SIGNAL_LIMITS.detail)
}

export const GITHUB_PAGE_SIZE = 20
export const GITHUB_ACTIVITY_DEPTH = 5
const GH_TIMEOUT_MS = 30_000
const GH_MAX_BUFFER = 8 * 1024 * 1024

export const SIGNALS_PRS_QUERY = `query SignalsPrs($reviewQ: String!, $mineQ: String!, $n: Int!, $c: Int!) {
  viewer { login }
  rateLimit { cost remaining resetAt }
  reviewRequested: search(type: ISSUE, query: $reviewQ, first: $n) {
    issueCount
    nodes { ...PrHead ...PrRequest }
  }
  mine: search(type: ISSUE, query: $mineQ, first: $n) {
    issueCount
    nodes { ...PrHead ...PrActivity ...PrChecks }
  }
}
fragment PrHead on PullRequest {
  id number title url isDraft headRefName updatedAt
  repository { nameWithOwner }
  author { __typename login }
}
fragment PrRequest on PullRequest {
  timelineItems(last: 5, itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT]) {
    nodes {
      __typename
      ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
      ... on ReviewRequestRemovedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
    }
  }
}
fragment PrActivity on PullRequest {
  comments(last: $c) { totalCount nodes { id author { __typename login } createdAt bodyText url } }
  reviews(last: $c) { totalCount nodes { id author { __typename login } state submittedAt bodyText url } }
  reviewThreads(last: $c) { totalCount nodes { isResolved comments(last: 1) { nodes { id author { __typename login } createdAt bodyText path url } } } }
}
fragment PrChecks on PullRequest {
  commits(last: 1) {
    nodes { commit { oid committedDate statusCheckRollup {
      state
      contexts(first: 25) { totalCount nodes {
        __typename
        ... on CheckRun { name status conclusion completedAt detailsUrl }
        ... on StatusContext { context state createdAt targetUrl }
      } }
    } } }
  }
}
`

export const SIGNALS_MENTIONS_QUERY = `query SignalsMentions($mentionQ: String!, $n: Int!, $c: Int!) {
  rateLimit { cost remaining resetAt }
  mentions: search(type: ISSUE, query: $mentionQ, first: $n) {
    issueCount
    nodes {
      __typename
      ... on Issue { id number title url updatedAt repository { nameWithOwner } author { __typename login }
        comments(last: $c) { totalCount nodes { id author { __typename login } createdAt bodyText url } } }
      ... on PullRequest { id number title url isDraft headRefName updatedAt repository { nameWithOwner } author { __typename login }
        comments(last: $c) { totalCount nodes { id author { __typename login } createdAt bodyText url } } }
    }
  }
}
`

export const REVIEW_SEARCH = 'is:pr is:open review-requested:@me archived:false sort:updated-desc'
export const MINE_SEARCH = 'is:pr is:open author:@me archived:false sort:updated-desc'

/** Mentions of the viewer on open issues/PRs updated within the last `days` (UTC date). */
export function mentionSearch(now: Date, days: number): string {
	const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
	return `mentions:@me is:open archived:false updated:>=${since} sort:updated-desc`
}

type QueryOutcome<T> =
	| { kind: 'ok'; data: T }
	| { kind: 'partial'; data: T | null; message: string }
	| { kind: 'failed'; status: Exclude<SignalSourceStatus, 'ok' | 'disabled'>; detail: string }
	| { kind: 'aborted' }

interface GraphqlResponse<T> {
	data?: T | null
	errors?: { message?: unknown }[] | null
}

function parseGraphql<T>(stdout: unknown): GraphqlResponse<T> | null {
	if (typeof stdout !== 'string' || stdout.trim() === '') return null
	try {
		const parsed: unknown = JSON.parse(stdout)
		return parsed !== null && typeof parsed === 'object' ? (parsed as GraphqlResponse<T>) : null
	} catch {
		return null
	}
}

function firstGraphqlError(response: GraphqlResponse<unknown>): string | null {
	if (!Array.isArray(response.errors) || response.errors.length === 0) return null
	const message = response.errors[0]?.message
	const text = typeof message === 'string' && message.trim() !== '' ? message : 'GitHub returned an error'
	return oneLine(`GitHub: ${text}`, SIGNAL_LIMITS.detail)
}

function fromResponse<T>(response: GraphqlResponse<T>): QueryOutcome<T> | null {
	const error = firstGraphqlError(response)
	const data = response.data && typeof response.data === 'object' ? response.data : null
	if (error) return { kind: 'partial', data, message: error }
	if (data) return { kind: 'ok', data }
	return null
}

/** Health for a gh failure that left no usable JSON. */
function classifyGhFailure(failure: CommandFailure): {
	status: 'unavailable' | 'needs_permission' | 'error'
	detail: string
} {
	if (failure.code === 'ENOENT') return { status: 'unavailable', detail: 'gh is not installed' }
	const stderr = typeof failure.stderr === 'string' ? failure.stderr : ''
	if (/gh auth login|not logged/i.test(stderr)) return { status: 'needs_permission', detail: 'Run gh auth login' }
	if (failure.killed === true || failure.code === 'ETIMEDOUT')
		return { status: 'error', detail: 'gh did not answer in time' }
	const line = firstLine(stderr)
	return { status: 'error', detail: line ? oneLine(`gh failed: ${line}`, SIGNAL_LIMITS.detail) : 'gh failed' }
}

async function runQuery<T>(
	run: SignalCommandRunner,
	query: string,
	strings: Record<string, string>,
	signal: AbortSignal,
): Promise<QueryOutcome<T>> {
	if (signal.aborted) return { kind: 'aborted' }
	const args = ['api', 'graphql', '-f', `query=${query}`]
	for (const [name, value] of Object.entries(strings)) args.push('-f', `${name}=${value}`)
	args.push('-F', `n=${GITHUB_PAGE_SIZE}`, '-F', `c=${GITHUB_ACTIVITY_DEPTH}`)
	try {
		const { stdout } = await run('gh', args, {
			signal,
			timeout: GH_TIMEOUT_MS,
			maxBuffer: GH_MAX_BUFFER,
			env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
		})
		const response = parseGraphql<T>(stdout)
		const outcome = response ? fromResponse(response) : null
		return outcome ?? { kind: 'failed', status: 'error', detail: 'gh returned no data' }
	} catch (error) {
		if (isAbort(error, signal)) return { kind: 'aborted' }
		const failure = commandFailure(error)
		// gh exits non-zero when `errors[]` is present, but stdout still holds the partial data.
		const response = parseGraphql<T>(failure.stdout)
		const outcome = response ? fromResponse(response) : null
		if (outcome?.kind === 'partial') return outcome
		if (outcome?.kind === 'ok') return { kind: 'partial', data: outcome.data, message: 'gh exited with an error' }
		return { kind: 'failed', ...classifyGhFailure(failure) }
	}
}

const STATUS_RANK: Record<SignalSourceStatus, number> = {
	needs_permission: 4,
	unavailable: 3,
	error: 2,
	ok: 1,
	disabled: 0,
}

function worse(
	a: { status: SignalSourceStatus; detail: string | null },
	b: { status: SignalSourceStatus; detail: string | null },
): { status: SignalSourceStatus; detail: string | null } {
	return STATUS_RANK[b.status] > STATUS_RANK[a.status] ? b : a
}

function healthOf(outcome: QueryOutcome<unknown>): { status: SignalSourceStatus; detail: string | null } {
	if (outcome.kind === 'ok') return { status: 'ok', detail: null }
	if (outcome.kind === 'partial') return { status: 'error', detail: outcome.message }
	if (outcome.kind === 'failed') return { status: outcome.status, detail: outcome.detail }
	return { status: 'error', detail: 'Poll was cancelled' }
}

function dataOf<T>(outcome: QueryOutcome<T>): T | null {
	return outcome.kind === 'ok' || outcome.kind === 'partial' ? outcome.data : null
}

const CANCELLED: SignalSourceRead = { result: null, health: { status: 'error', detail: 'Poll was cancelled' } }

export interface GithubSignalReaderDeps {
	run?: SignalCommandRunner
	now?: () => Date
}

/** Reader for the Signals watcher's GitHub loop. */
export function createGithubSignalReader(config: HelmConfig, deps: GithubSignalReaderDeps = {}): SignalReader {
	const run = deps.run ?? defaultSignalCommandRunner
	const now = deps.now ?? (() => new Date())
	return {
		source: 'github',
		async read(signal) {
			const prs = await runQuery<GithubPrsData>(
				run,
				SIGNALS_PRS_QUERY,
				{ reviewQ: REVIEW_SEARCH, mineQ: MINE_SEARCH },
				signal,
			)
			if (prs.kind === 'aborted') return CANCELLED
			// Without the viewer login nothing can be attributed; skip the second call.
			const prsData = dataOf(prs)
			const viewer = prsData?.viewer?.login
			if (typeof viewer !== 'string' || viewer === '') {
				const health = healthOf(prs)
				return {
					result: null,
					health: health.status === 'ok' ? { status: 'error', detail: 'GitHub did not return the viewer' } : health,
				}
			}
			const mentions = await runQuery<GithubMentionsData>(
				run,
				SIGNALS_MENTIONS_QUERY,
				{ mentionQ: mentionSearch(now(), config.signals.github.mentionDays) },
				signal,
			)
			if (mentions.kind === 'aborted') return CANCELLED
			const mentionsData = dataOf(mentions)
			const complete =
				prs.kind === 'ok' &&
				mentions.kind === 'ok' &&
				searchComplete(prs.data.reviewRequested, GITHUB_PAGE_SIZE) &&
				searchComplete(prs.data.mine, GITHUB_PAGE_SIZE) &&
				searchComplete(mentions.data.mentions, GITHUB_PAGE_SIZE)
			return {
				result: {
					source: 'github',
					observations: mapGithubSignals({ prs: prsData, mentions: mentionsData }, { viewer }),
					complete,
					goneReason: GITHUB_GONE_REASON,
				},
				health: worse(healthOf(prs), healthOf(mentions)),
			}
		},
	}
}
