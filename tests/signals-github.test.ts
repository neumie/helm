import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import type { SignalObservation } from '../src/signals/contract.js'
import { type GithubMentionsData, type GithubPrsData, mapGithubSignals } from '../src/signals/github-map.js'
import {
	MINE_SEARCH,
	REVIEW_SEARCH,
	type SignalCommandRunner,
	createGithubSignalReader,
	mentionSearch,
} from '../src/signals/github-source.js'

function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(new URL(`./fixtures/signals/${name}`, import.meta.url), 'utf8')) as T
}

const prsResponse = fixture<{ data: GithubPrsData }>('github-prs.json')
const mentionsResponse = fixture<{ data: GithubMentionsData }>('github-mentions.json')

const config = { signals: { github: { enabled: true, pollSeconds: 120, mentionDays: 14 } } } as unknown as HelmConfig
const NOW = new Date('2026-01-15T10:00:00Z')

function byKey(observations: SignalObservation[]): Map<string, SignalObservation> {
	return new Map(observations.map(observation => [observation.threadKey, observation]))
}

function mapped(): Map<string, SignalObservation> {
	return byKey(mapGithubSignals({ prs: prsResponse.data, mentions: mentionsResponse.data }, { viewer: 'me-user' }))
}

test('maps one observation per PR/issue, merging reasons across searches', () => {
	const threads = mapped()
	assert.deepEqual([...threads.keys()].sort(), [
		'github:acme/api#7',
		'github:acme/app#12',
		'github:acme/app#30',
		'github:acme/docs#31',
		'github:acme/infra#44',
		'github:acme/web#3',
		'github:acme/web#4',
	])
	const widget = threads.get('github:acme/app#12')
	assert.ok(widget)
	assert.deepEqual(widget.reasons, ['review', 'mention'])
	assert.equal(widget.kind, 'review')
	assert.equal(widget.source, 'github')
	assert.equal(widget.ref, 'App#12')
	assert.equal(widget.fullRef, 'Acme/App#12')
	assert.equal(widget.repo, 'Acme/App')
	assert.equal(widget.number, 12)
	assert.equal(widget.branch, 'feat/widget')
	assert.equal(widget.url, 'https://github.com/acme/app/pull/12')
	assert.equal(widget.title, 'Add widget')
	assert.equal(widget.lastActivityAt, '2026-01-01T00:05:00.000Z')
	assert.equal(widget.activityKey, 'review:2026-01-01T00:05:00.000Z:PR_a|mention:2026-01-01T00:02:00.000Z:IC_10')
})

test('review request uses the viewer event, else the latest (team) event; drafts are marked', () => {
	const threads = mapped()
	const widget = threads.get('github:acme/app#12')
	assert.equal(widget?.head, 'review requested · alice')
	assert.equal(widget?.actor, 'alice')

	const team = threads.get('github:acme/infra#44')
	assert.equal(team?.kind, 'review')
	assert.equal(team?.head, 'review requested · frank · draft')
	assert.equal(team?.lastActivityAt, '2026-01-01T00:07:00.000Z')
})

test('review request without timeline events falls back to createdAt and the PR author', () => {
	const [observation] = mapGithubSignals(
		{
			prs: {
				reviewRequested: {
					issueCount: 1,
					nodes: [
						{
							id: 'PR_z',
							number: 1,
							title: 'T',
							url: 'https://github.com/o/r/pull/1',
							createdAt: '2026-01-01T00:00:00Z',
							updatedAt: '2026-01-02T00:00:00Z',
							repository: { nameWithOwner: 'o/r' },
							author: { __typename: 'User', login: 'ivy' },
							timelineItems: { nodes: [] },
						},
					],
				},
			},
			mentions: null,
		},
		{ viewer: 'me-user' },
	)
	assert.equal(observation.head, 'review requested · ivy')
	assert.equal(observation.lastActivityAt, '2026-01-01T00:00:00.000Z')
})

test('comments count only foreign activity newer than the viewer, latest review wins the head', () => {
	const fix = mapped().get('github:acme/api#7')
	assert.ok(fix)
	assert.deepEqual(fix.reasons, ['comments', 'ci'])
	assert.equal(fix.kind, 'comments')
	assert.equal(fix.head, 'changes requested · bob')
	assert.equal(fix.actor, 'bob')
	assert.equal(fix.lastActivityAt, '2026-01-01T00:16:00.000Z')

	// The viewer answered after the only foreign comment: nothing to show.
	assert.equal(mapped().has('github:acme/api#9'), false)
})

test('comment heads count items; bots are ignored, ghosts count as foreign', () => {
	const deps = mapped().get('github:acme/web#3')
	assert.ok(deps)
	assert.equal(deps.kind, 'comments')
	assert.equal(deps.head, '1 comment')
	assert.equal(deps.actor, null)
	assert.equal(deps.lastActivityAt, '2026-01-01T00:17:00.000Z')

	const [plain] = mapGithubSignals(
		{
			prs: {
				mine: {
					issueCount: 1,
					nodes: [
						{
							id: 'PR_y',
							number: 2,
							title: 'T',
							url: 'https://github.com/o/r/pull/2',
							updatedAt: '2026-01-02T00:00:00Z',
							repository: { nameWithOwner: 'o/r' },
							comments: {
								nodes: [
									{ id: 'c1', author: { __typename: 'User', login: 'jo' }, createdAt: '2026-01-02T00:01:00Z' },
									{ id: 'c2', author: { __typename: 'User', login: 'kim' }, createdAt: '2026-01-02T00:02:00Z' },
								],
							},
							reviews: {
								nodes: [
									{
										id: 'r1',
										author: { __typename: 'User', login: 'jo' },
										state: 'APPROVED',
										submittedAt: '2026-01-02T00:00:30Z',
									},
								],
							},
						},
					],
				},
			},
			mentions: null,
		},
		{ viewer: 'me-user' },
	)
	assert.equal(plain.head, 'approved · jo')
	assert.equal(plain.actor, 'jo')
	assert.equal(plain.lastActivityAt, '2026-01-02T00:02:00.000Z')
})

test('failed CI lists failing checks and fingerprints the head commit', () => {
	const fix = mapped().get('github:acme/api#7')
	assert.match(fix?.activityKey ?? '', /\|ci:2026-01-01T00:13:00\.000Z:ci:deadbeef:build,ci\/lint,e2e$/)

	const page = mapped().get('github:acme/web#4')
	assert.ok(page)
	assert.deepEqual(page.reasons, ['ci'])
	assert.equal(page.kind, 'ci')
	assert.equal(page.head, 'CI failing · lint')
	assert.equal(page.actor, null)
	assert.equal(page.lastActivityAt, '2026-01-01T00:30:00.000Z')
	assert.equal(page.activityKey, 'ci:2026-01-01T00:30:00.000Z:ci:feed42:lint')
})

test('CI head shows two names then +N; primary kind is the newest reason with ci winning ties', () => {
	const node = {
		id: 'PR_x',
		number: 5,
		title: 'T',
		url: 'https://github.com/o/r/pull/5',
		headRefName: 'b',
		updatedAt: '2026-01-02T00:00:00Z',
		repository: { nameWithOwner: 'o/r' },
		comments: {
			nodes: [{ id: 'c', author: { __typename: 'User', login: 'jo' }, createdAt: '2026-01-02T00:05:00Z' }],
		},
		commits: {
			nodes: [
				{
					commit: {
						oid: 'aa',
						committedDate: '2026-01-02T00:00:00Z',
						statusCheckRollup: {
							state: 'ERROR',
							contexts: {
								totalCount: 3,
								nodes: [
									{ __typename: 'CheckRun', name: 'zeta', conclusion: 'FAILURE', completedAt: '2026-01-02T00:05:00Z' },
									{ __typename: 'CheckRun', name: 'alpha', conclusion: 'CANCELLED', completedAt: null },
									{ __typename: 'StatusContext', context: 'mid', state: 'FAILURE', createdAt: '2026-01-02T00:01:00Z' },
								],
							},
						},
					},
				},
			],
		},
	}
	const [observation] = mapGithubSignals({ prs: { mine: { nodes: [node] } }, mentions: null }, { viewer: 'me' })
	assert.equal(observation.kind, 'ci')
	assert.equal(observation.head, 'CI failing · zeta, alpha +1')
	assert.match(observation.activityKey, /ci:aa:alpha,mid,zeta$/)
})

test('mentions match only foreign comments that @-mention the viewer, issues have no branch', () => {
	const threads = mapped()
	const crash = threads.get('github:acme/app#30')
	assert.ok(crash)
	assert.equal(crash.kind, 'mention')
	assert.equal(crash.head, 'mentioned by dave')
	assert.equal(crash.actor, 'dave')
	assert.equal(crash.branch, null)
	assert.equal(crash.lastActivityAt, '2026-01-01T00:35:00.000Z')

	const docs = threads.get('github:acme/docs#31')
	assert.equal(docs?.head, 'mentioned you')
	assert.equal(docs?.actor, null)
	// No mentioning comment in view: fixed to the node, never its updatedAt.
	assert.equal(docs?.lastActivityAt, '2025-12-31T08:00:00.000Z')
	assert.equal(docs?.activityKey, 'mention:2025-12-31T08:00:00.000Z:mention:I_31')
})

// The activity key is what the store compares to decide "new again"; none of these may move it.
test("the viewer's own activity and plain updates never move any reason's key or time", () => {
	const issue = (extra: { updatedAt: string; comments: unknown[] }) => ({
		__typename: 'Issue',
		id: 'I_m',
		number: 8,
		title: 'Body mentions me',
		url: 'https://github.com/o/r/issues/8',
		createdAt: '2026-01-01T00:00:00Z',
		repository: { nameWithOwner: 'o/r' },
		...extra,
		comments: { nodes: extra.comments },
	})
	const mention = (node: ReturnType<typeof issue>) =>
		mapGithubSignals({ prs: null, mentions: { mentions: { nodes: [node] } } } as never, { viewer: 'me' })[0]
	const before = mention(issue({ updatedAt: '2026-01-01T00:00:00Z', comments: [] }))
	// Jakub replies (and @-mentions himself), someone labels it: updatedAt moves, the key must not.
	const after = mention(
		issue({
			updatedAt: '2026-01-03T00:00:00Z',
			comments: [
				{
					id: 'own',
					author: { __typename: 'User', login: 'Me' },
					createdAt: '2026-01-03T00:00:00Z',
					bodyText: 'thanks @me',
				},
			],
		}),
	)
	assert.equal(after.activityKey, before.activityKey)
	assert.equal(after.lastActivityAt, before.lastActivityAt)
	assert.equal(before.lastActivityAt, '2026-01-01T00:00:00.000Z')

	// A foreign mention in view does move it.
	const foreign = mention(
		issue({
			updatedAt: '2026-01-04T00:00:00Z',
			comments: [
				{
					id: 'f',
					author: { __typename: 'User', login: 'kim' },
					createdAt: '2026-01-04T00:00:00Z',
					bodyText: '@me look',
				},
			],
		}),
	)
	assert.equal(foreign.lastActivityAt, '2026-01-04T00:00:00.000Z')

	// Review request: the viewer asking someone else for a review (team-requested PR) is not activity.
	const review = (events: unknown[], updatedAt: string) =>
		mapGithubSignals(
			{
				prs: {
					reviewRequested: {
						nodes: [
							{
								id: 'PR_r',
								number: 2,
								title: 'T',
								url: 'https://github.com/o/r/pull/2',
								createdAt: '2026-01-01T00:00:00Z',
								updatedAt,
								repository: { nameWithOwner: 'o/r' },
								author: { __typename: 'User', login: 'ann' },
								timelineItems: { nodes: events },
							},
						],
					},
				},
				mentions: null,
			} as never,
			{ viewer: 'me' },
		)[0]
	const team = {
		__typename: 'ReviewRequestedEvent',
		createdAt: '2026-01-01T01:00:00Z',
		actor: { login: 'ann' },
		requestedReviewer: { __typename: 'Team', slug: 'core' },
	}
	const reviewBefore = review([team], '2026-01-01T01:00:00Z')
	const reviewAfter = review(
		[
			team,
			{
				__typename: 'ReviewRequestedEvent',
				createdAt: '2026-01-02T00:00:00Z',
				actor: { login: 'ME' },
				requestedReviewer: { __typename: 'User', login: 'zed' },
			},
			{
				__typename: 'ReviewRequestRemovedEvent',
				createdAt: '2026-01-02T00:01:00Z',
				requestedReviewer: { __typename: 'User', login: 'zed' },
			},
		],
		'2026-01-02T00:01:00Z',
	)
	assert.equal(reviewAfter.activityKey, reviewBefore.activityKey)
	assert.equal(reviewAfter.lastActivityAt, '2026-01-01T01:00:00.000Z')
	assert.equal(reviewAfter.head, 'review requested · ann')

	// Comments on Jakub's PR: his own reply ends the reason rather than moving it.
	const mine = (comments: unknown[], updatedAt: string) =>
		mapGithubSignals(
			{
				prs: {
					mine: {
						nodes: [
							{
								id: 'PR_c',
								number: 3,
								title: 'T',
								url: 'https://github.com/o/r/pull/3',
								createdAt: '2026-01-01T00:00:00Z',
								updatedAt,
								repository: { nameWithOwner: 'o/r' },
								comments: { nodes: comments },
							},
						],
					},
				},
				mentions: null,
			} as never,
			{ viewer: 'me' },
		)
	const theirs = { id: 'c1', author: { __typename: 'User', login: 'kim' }, createdAt: '2026-01-01T02:00:00Z' }
	const commentsBefore = mine([theirs], '2026-01-01T02:00:00Z')[0]
	const commentsLater = mine([theirs], '2026-01-05T00:00:00Z')[0]
	assert.equal(commentsLater.activityKey, commentsBefore.activityKey)
	assert.deepEqual(
		mine(
			[theirs, { id: 'c2', author: { __typename: 'User', login: 'me' }, createdAt: '2026-01-01T03:00:00Z' }],
			'2026-01-01T03:00:00Z',
		),
		[],
	)
})

test('third-party text is kept to one line', () => {
	const [observation] = mapGithubSignals(
		{
			prs: null,
			mentions: {
				mentions: {
					nodes: [
						{
							id: 'I_1',
							number: 1,
							title: 'Line one\nline two\u0007',
							url: 'javascript:alert(1)',
							updatedAt: '2026-01-02T00:00:00Z',
							repository: { nameWithOwner: 'o/r' },
						},
					],
				},
			},
		},
		{ viewer: 'me' },
	)
	assert.equal(observation.title, 'Line one line two')
	assert.equal(observation.url, null)
})

// ---------- reader (fake gh) ----------

interface Call {
	file: string
	args: string[]
	env: NodeJS.ProcessEnv
	timeout: number
}

function fakeRunner(answers: ((call: Call) => Promise<{ stdout: string; stderr: string }>)[]): {
	run: SignalCommandRunner
	calls: Call[]
} {
	const calls: Call[] = []
	const run: SignalCommandRunner = async (file, args, options) => {
		const call = { file, args, env: options.env, timeout: options.timeout }
		calls.push(call)
		const answer = answers[calls.length - 1]
		if (!answer) throw new Error('unexpected call')
		return answer(call)
	}
	return { run, calls }
}

const ok = (body: unknown) => async () => ({ stdout: JSON.stringify(body), stderr: '' })
const fail = (fields: Record<string, unknown>) => async () => {
	throw Object.assign(new Error('Command failed'), fields)
}

test('reader runs both read-only graphql queries with prompts disabled', async () => {
	const { run, calls } = fakeRunner([ok(prsResponse), ok(mentionsResponse)])
	const reader = createGithubSignalReader(config, { run, now: () => NOW })
	assert.equal(reader.source, 'github')
	const { result, health } = await reader.read(new AbortController().signal)
	assert.deepEqual(health, { status: 'ok', detail: null })
	assert.ok(result)
	assert.equal(result.complete, true)
	assert.equal(result.source, 'github')
	assert.equal(result.goneReason, 'no longer open or requested')
	assert.equal(result.observations.length, 7)

	assert.equal(calls.length, 2)
	for (const call of calls) {
		assert.equal(call.file, 'gh')
		assert.deepEqual(call.args.slice(0, 2), ['api', 'graphql'])
		assert.equal(call.env.GH_PROMPT_DISABLED, '1')
		assert.equal(call.env.GH_NO_UPDATE_NOTIFIER, '1')
		assert.equal(call.env.NO_COLOR, '1')
		assert.equal(call.timeout, 30_000)
		assert.ok(call.args.includes('n=20') && call.args.includes('c=5'))
		assert.ok(!call.args.some(arg => /token|mutation/i.test(arg)))
		// Nodes carry createdAt: the fixed fallback time for review/ci/mention reasons.
		const query = call.args.find(arg => arg.startsWith('query=')) ?? ''
		assert.match(query, /headRefName createdAt updatedAt/)
	}
	assert.ok(calls[0].args.includes(`reviewQ=${REVIEW_SEARCH}`))
	assert.ok(calls[0].args.includes(`mineQ=${MINE_SEARCH}`))
	assert.ok(
		calls[1].args.includes('mentionQ=mentions:@me is:open archived:false updated:>=2026-01-01 sort:updated-desc'),
	)
})

test('mention window is a UTC date', () => {
	assert.equal(
		mentionSearch(new Date('2026-03-01T00:30:00Z'), 1),
		'mentions:@me is:open archived:false updated:>=2026-02-28 sort:updated-desc',
	)
})

test('a truncated search makes the poll incomplete but healthy', async () => {
	const truncated = structuredClone(prsResponse)
	if (truncated.data.mine) truncated.data.mine.issueCount = 21
	const { run } = fakeRunner([ok(truncated), ok(mentionsResponse)])
	const { result, health } = await createGithubSignalReader(config, { run, now: () => NOW }).read(
		new AbortController().signal,
	)
	assert.equal(result?.complete, false)
	assert.equal(health.status, 'ok')
})

test('graphql errors with partial data keep the data, mark incomplete and report the error', async () => {
	const partial = { data: { ...mentionsResponse.data }, errors: [{ message: 'Something went\nwrong' }] }
	const { run } = fakeRunner([ok(prsResponse), fail({ code: 1, stdout: JSON.stringify(partial), stderr: 'gh: error' })])
	const { result, health } = await createGithubSignalReader(config, { run, now: () => NOW }).read(
		new AbortController().signal,
	)
	assert.equal(result?.complete, false)
	assert.equal(result?.observations.length, 7)
	assert.deepEqual(health, { status: 'error', detail: 'GitHub: Something went wrong' })
})

test('a failed mentions query still upserts the PR threads without closing anything', async () => {
	const { run } = fakeRunner([ok(prsResponse), fail({ code: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway\nmore' })])
	const { result, health } = await createGithubSignalReader(config, { run, now: () => NOW }).read(
		new AbortController().signal,
	)
	assert.equal(result?.complete, false)
	assert.equal(
		result?.observations.some(observation => observation.reasons.includes('mention')),
		false,
	)
	assert.deepEqual(health, { status: 'error', detail: 'gh failed: HTTP 502: Bad Gateway' })
})

test('missing gh and missing login map to health states with no result', async () => {
	const missing = fakeRunner([fail({ code: 'ENOENT' })])
	const notInstalled = await createGithubSignalReader(config, { run: missing.run }).read(new AbortController().signal)
	assert.equal(notInstalled.result, null)
	assert.deepEqual(notInstalled.health, { status: 'unavailable', detail: 'gh is not installed' })
	assert.equal(missing.calls.length, 1)

	const auth = fakeRunner([
		fail({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }),
	])
	const loggedOut = await createGithubSignalReader(config, { run: auth.run }).read(new AbortController().signal)
	assert.equal(loggedOut.result, null)
	assert.deepEqual(loggedOut.health, { status: 'needs_permission', detail: 'Run gh auth login' })
})

test('an aborted poll returns no result and stops calling gh', async () => {
	const controller = new AbortController()
	const { run, calls } = fakeRunner([
		async () => {
			controller.abort()
			throw Object.assign(new Error('aborted'), { name: 'AbortError' })
		},
	])
	const { result } = await createGithubSignalReader(config, { run }).read(controller.signal)
	assert.equal(result, null)
	assert.equal(calls.length, 1)
})
