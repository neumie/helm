// Pure GitHub → Signals mapping: the two Signals GraphQL responses (see github-source.ts) become one
// observation per `owner/repo#N`, merging every reason (review request, foreign comments/reviews on
// Jakub's PRs, failed CI, mentions). No IO; the store bounds and sanitizes again before persisting.

import { oneLine } from '../agent-dock/text.js'
import { SIGNAL_LIMITS, type SignalKind, type SignalObservation } from './contract.js'

// ---------- raw GraphQL shapes (everything optional: this is parsed JSON, never trusted) ----------

export interface GhActor {
	__typename?: string | null
	login?: string | null
}

export interface GhComment {
	id?: string | null
	author?: GhActor | null
	createdAt?: string | null
	bodyText?: string | null
	url?: string | null
}

export interface GhReview {
	id?: string | null
	author?: GhActor | null
	state?: string | null
	submittedAt?: string | null
	bodyText?: string | null
	url?: string | null
}

export interface GhReviewer {
	__typename?: string | null
	login?: string | null
	slug?: string | null
}

export interface GhTimelineItem {
	__typename?: string | null
	createdAt?: string | null
	actor?: GhActor | null
	requestedReviewer?: GhReviewer | null
}

export interface GhCheckContext {
	__typename?: string | null
	name?: string | null
	status?: string | null
	conclusion?: string | null
	completedAt?: string | null
	context?: string | null
	state?: string | null
	createdAt?: string | null
}

export interface GhCommit {
	oid?: string | null
	committedDate?: string | null
	statusCheckRollup?: {
		state?: string | null
		contexts?: { totalCount?: number | null; nodes?: (GhCheckContext | null)[] | null } | null
	} | null
}

/** A search node: PullRequest or Issue (an empty object when no fragment matched). */
export interface GhNode {
	__typename?: string | null
	id?: string | null
	number?: number | null
	title?: string | null
	url?: string | null
	isDraft?: boolean | null
	headRefName?: string | null
	updatedAt?: string | null
	repository?: { nameWithOwner?: string | null } | null
	author?: GhActor | null
	timelineItems?: { nodes?: (GhTimelineItem | null)[] | null } | null
	comments?: { totalCount?: number | null; nodes?: (GhComment | null)[] | null } | null
	reviews?: { totalCount?: number | null; nodes?: (GhReview | null)[] | null } | null
	reviewThreads?: {
		totalCount?: number | null
		nodes?: ({ isResolved?: boolean | null; comments?: { nodes?: (GhComment | null)[] | null } | null } | null)[] | null
	} | null
	commits?: { nodes?: ({ commit?: GhCommit | null } | null)[] | null } | null
}

export interface GhSearch {
	issueCount?: number | null
	nodes?: (GhNode | null)[] | null
}

/** `data` of the SignalsPrs query. */
export interface GithubPrsData {
	viewer?: { login?: string | null } | null
	reviewRequested?: GhSearch | null
	mine?: GhSearch | null
}

/** `data` of the SignalsMentions query. */
export interface GithubMentionsData {
	mentions?: GhSearch | null
}

// ---------- mapping ----------

export const GITHUB_GONE_REASON = 'no longer open or requested'

type GithubReasonKind = Extract<SignalKind, 'review' | 'comments' | 'ci' | 'mention'>

/** Fixed order for `reasons` and the activity key; also the tie-break priority (lower wins). */
const REASON_ORDER: readonly GithubReasonKind[] = ['review', 'comments', 'ci', 'mention']
const TIE_PRIORITY: Record<GithubReasonKind, number> = { ci: 0, comments: 1, review: 2, mention: 3 }

const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const FAILING_STATUS_STATES = new Set(['FAILURE', 'ERROR'])
const FAILING_ROLLUP_STATES = new Set(['FAILURE', 'ERROR'])

interface Reason {
	kind: GithubReasonKind
	/** Normalized ISO time of the activity. */
	time: string
	actor: string | null
	head: string
	/** Comment/event id or CI fingerprint, for the activity key. */
	id: string
}

interface ThreadAcc {
	nameWithOwner: string
	number: number
	title: string
	url: string | null
	branch: string | null
	reasons: Map<GithubReasonKind, Reason>
}

/** Normalized ISO time, or null when missing/unparseable. */
function isoTime(value: string | null | undefined): string | null {
	if (typeof value !== 'string' || value === '') return null
	const ms = Date.parse(value)
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function later(a: string, b: string): boolean {
	return Date.parse(a) > Date.parse(b)
}

function login(actor: GhActor | null | undefined): string | null {
	return typeof actor?.login === 'string' && actor.login !== '' ? actor.login : null
}

function isBot(actor: GhActor | null | undefined): boolean {
	return actor?.__typename === 'Bot'
}

function sameLogin(a: string | null, b: string): boolean {
	return a !== null && a.toLowerCase() === b.toLowerCase()
}

function clean(text: string, max: number): string {
	return oneLine(text, max)
}

function withActor(text: string, actor: string | null): string {
	return actor ? `${text} · ${clean(actor, SIGNAL_LIMITS.actor)}` : text
}

function nodesOf<T>(list: { nodes?: (T | null)[] | null } | null | undefined): T[] {
	return (list?.nodes ?? []).filter((node): node is T => node != null && typeof node === 'object')
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Identity fields of a search node, or null when the node is not a PR/issue we can key. */
function identity(node: GhNode): { nameWithOwner: string; number: number } | null {
	const nameWithOwner = node.repository?.nameWithOwner
	if (typeof nameWithOwner !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner)) return null
	if (typeof node.number !== 'number' || !Number.isSafeInteger(node.number) || node.number <= 0) return null
	return { nameWithOwner, number: node.number }
}

function reviewReason(node: GhNode, viewer: string): Reason {
	const requests = nodesOf(node.timelineItems).filter(item => isoTime(item.createdAt) !== null)
	const newest = (items: GhTimelineItem[]) =>
		items.reduce<GhTimelineItem | null>(
			(best, item) => (best === null || later(item.createdAt as string, best.createdAt as string) ? item : best),
			null,
		)
	const forViewer = newest(
		requests.filter(
			item =>
				item.__typename === 'ReviewRequestedEvent' &&
				item.requestedReviewer?.__typename === 'User' &&
				sameLogin(item.requestedReviewer.login ?? null, viewer),
		),
	)
	const event = forViewer ?? newest(requests)
	const time = isoTime(event?.createdAt) ?? isoTime(node.updatedAt) ?? new Date(0).toISOString()
	const actor = login(event?.actor) ?? login(node.author)
	const head = withActor('review requested', actor) + (node.isDraft ? ' · draft' : '')
	return { kind: 'review', time, actor, head, id: node.id ?? `${time}` }
}

interface ActivityItem {
	id: string
	time: string
	actor: string | null
	review: string | null
}

function commentsReason(node: GhNode, viewer: string): Reason | null {
	const items: (ActivityItem & { author: GhActor | null | undefined })[] = []
	for (const comment of nodesOf(node.comments)) {
		const time = isoTime(comment.createdAt)
		if (time)
			items.push({ id: comment.id ?? time, time, actor: login(comment.author), author: comment.author, review: null })
	}
	for (const review of nodesOf(node.reviews)) {
		const time = isoTime(review.submittedAt)
		if (!time || review.state === 'PENDING') continue
		if (review.state === 'COMMENTED' && (review.bodyText ?? '').trim() === '') continue
		items.push({
			id: review.id ?? time,
			time,
			actor: login(review.author),
			author: review.author,
			review: review.state ?? null,
		})
	}
	for (const thread of nodesOf(node.reviewThreads)) {
		for (const comment of nodesOf(thread.comments)) {
			const time = isoTime(comment.createdAt)
			if (time)
				items.push({ id: comment.id ?? time, time, actor: login(comment.author), author: comment.author, review: null })
		}
	}
	const own = items.filter(item => sameLogin(item.actor, viewer))
	const ownLatest = own.reduce<string | null>(
		(max, item) => (max === null || later(item.time, max) ? item.time : max),
		null,
	)
	// Ghosts (null author) count as foreign; bots never do.
	const counted = items
		.filter(item => !sameLogin(item.actor, viewer) && !isBot(item.author))
		.filter(item => ownLatest === null || later(item.time, ownLatest))
		.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
	const newest = counted[0]
	if (!newest) return null
	const latestReview = counted.find(item => item.review !== null)
	const verdict =
		latestReview?.review === 'CHANGES_REQUESTED'
			? 'changes requested'
			: latestReview?.review === 'APPROVED'
				? 'approved'
				: null
	// The head names one person; the actor is that person.
	const actor = verdict && latestReview ? latestReview.actor : newest.actor
	const head = withActor(verdict ?? `${counted.length} ${counted.length === 1 ? 'comment' : 'comments'}`, actor)
	return { kind: 'comments', time: newest.time, actor, head, id: newest.id }
}

function ciReason(node: GhNode): Reason | null {
	const commit = nodesOf(node.commits)[0]?.commit
	const rollup = commit?.statusCheckRollup
	if (!rollup || !FAILING_ROLLUP_STATES.has(rollup.state ?? '')) return null
	const failing: { name: string; time: string | null }[] = []
	for (const context of nodesOf(rollup.contexts)) {
		if (context.__typename === 'CheckRun' && FAILING_CONCLUSIONS.has(context.conclusion ?? '') && context.name) {
			failing.push({ name: context.name, time: isoTime(context.completedAt) })
		} else if (
			context.__typename === 'StatusContext' &&
			FAILING_STATUS_STATES.has(context.state ?? '') &&
			context.context
		) {
			failing.push({ name: context.context, time: isoTime(context.createdAt) })
		}
	}
	const names = [...new Set(failing.map(item => clean(item.name, 80)))]
	const shown = names.slice(0, 2)
	const hidden = names.length - shown.length
	const head = shown.length > 0 ? `CI failing · ${shown.join(', ')}${hidden > 0 ? ` +${hidden}` : ''}` : 'CI failing'
	const failTime = failing
		.map(item => item.time)
		.filter((time): time is string => time !== null)
		.reduce<string | null>((max, time) => (max === null || later(time, max) ? time : max), null)
	const time = failTime ?? isoTime(commit?.committedDate) ?? isoTime(node.updatedAt) ?? new Date(0).toISOString()
	const fingerprint = `ci:${commit?.oid ?? ''}:${[...names].sort().join(',')}`
	return { kind: 'ci', time, actor: null, head, id: fingerprint }
}

function mentionReason(node: GhNode, viewer: string): Reason {
	const pattern = new RegExp(`(^|\\W)@${escapeRegExp(viewer)}\\b`, 'i')
	let match: { id: string; time: string; actor: string | null } | null = null
	for (const comment of nodesOf(node.comments)) {
		const time = isoTime(comment.createdAt)
		const actor = login(comment.author)
		if (!time || sameLogin(actor, viewer) || !pattern.test(comment.bodyText ?? '')) continue
		if (match === null || later(time, match.time)) match = { id: comment.id ?? time, time, actor }
	}
	if (match)
		return { kind: 'mention', ...match, head: `mentioned by ${clean(match.actor ?? 'ghost', SIGNAL_LIMITS.actor)}` }
	const time = isoTime(node.updatedAt) ?? new Date(0).toISOString()
	return { kind: 'mention', time, actor: null, head: 'mentioned you', id: node.id ?? time }
}

function accumulate(threads: Map<string, ThreadAcc>, node: GhNode, reasons: (Reason | null)[]): void {
	const id = identity(node)
	const present = reasons.filter((reason): reason is Reason => reason !== null)
	if (!id || present.length === 0) return
	const key = `github:${id.nameWithOwner.toLowerCase()}#${id.number}`
	let thread = threads.get(key)
	if (!thread) {
		thread = {
			nameWithOwner: id.nameWithOwner,
			number: id.number,
			title: clean(node.title ?? '', SIGNAL_LIMITS.title),
			url: typeof node.url === 'string' && node.url.startsWith('https://') ? node.url : null,
			branch: typeof node.headRefName === 'string' && node.headRefName !== '' ? node.headRefName : null,
			reasons: new Map(),
		}
		threads.set(key, thread)
	} else {
		if (!thread.branch && typeof node.headRefName === 'string' && node.headRefName !== '')
			thread.branch = node.headRefName
		if (!thread.url && typeof node.url === 'string' && node.url.startsWith('https://')) thread.url = node.url
		if (!thread.title && node.title) thread.title = clean(node.title, SIGNAL_LIMITS.title)
	}
	for (const reason of present) {
		const prior = thread.reasons.get(reason.kind)
		if (!prior || later(reason.time, prior.time)) thread.reasons.set(reason.kind, reason)
	}
}

function primary(reasons: Reason[]): Reason {
	return reasons.reduce((best, reason) => {
		const diff = Date.parse(reason.time) - Date.parse(best.time)
		if (diff > 0) return reason
		if (diff === 0 && TIE_PRIORITY[reason.kind] < TIE_PRIORITY[best.kind]) return reason
		return best
	})
}

/**
 * One observation per PR/issue across the review-requested, my-open-PRs and mentions searches.
 * `viewer` is the authenticated login (from the PRs query); activity by the viewer never counts.
 */
export function mapGithubSignals(
	raw: { prs: GithubPrsData | null; mentions: GithubMentionsData | null },
	options: { viewer: string },
): SignalObservation[] {
	const viewer = options.viewer
	const threads = new Map<string, ThreadAcc>()
	for (const node of nodesOf(raw.prs?.reviewRequested)) accumulate(threads, node, [reviewReason(node, viewer)])
	for (const node of nodesOf(raw.prs?.mine)) accumulate(threads, node, [commentsReason(node, viewer), ciReason(node)])
	for (const node of nodesOf(raw.mentions?.mentions)) accumulate(threads, node, [mentionReason(node, viewer)])

	const observations: SignalObservation[] = []
	for (const [threadKey, thread] of threads) {
		const reasons = REASON_ORDER.map(kind => thread.reasons.get(kind)).filter(
			(reason): reason is Reason => reason !== undefined,
		)
		const main = primary(reasons)
		const repoName = thread.nameWithOwner.split('/')[1]
		observations.push({
			threadKey,
			source: 'github',
			kind: main.kind,
			reasons: reasons.map(reason => reason.kind),
			ref: `${repoName}#${thread.number}`,
			fullRef: `${thread.nameWithOwner}#${thread.number}`,
			title: thread.title,
			head: clean(main.head, SIGNAL_LIMITS.head),
			actor: main.actor ? clean(main.actor, SIGNAL_LIMITS.actor) : null,
			url: thread.url,
			repo: thread.nameWithOwner,
			number: thread.number,
			branch: thread.branch,
			activityKey: reasons.map(reason => `${reason.kind}:${reason.time}:${reason.id}`).join('|'),
			lastActivityAt: reasons.reduce((max, reason) => (later(reason.time, max) ? reason.time : max), reasons[0].time),
		})
	}
	return observations
}

/** Whether a search listed everything it matched (no page truncation). */
export function searchComplete(search: GhSearch | null | undefined, pageSize: number): boolean {
	return typeof search?.issueCount === 'number' && search.issueCount <= pageSize
}
