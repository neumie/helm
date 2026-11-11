// Slack Signals reader: polls the connected workspaces' web-client session (helm slack connect) for
// DMs, @mentions and followed threads that need Jakub, maps them (slack-map.ts), and reports health.
// Read-mostly: the only writes are Jakub's own `r` replies (the route, not here). Bounded per poll
// to stay well inside Slack's rate limits; honours the client's per-method backoff. No secret is
// ever logged: errors carry only Slack's machine codes.

import type { HelmConfig } from '../config.js'
import { type SlackSession, SlackSessionStore } from '../slack/session.js'
import { SlackApiError, SlackClient, SlackRateLimitError, SlackTransportError } from '../slack/web-api.js'
import type {
	SlackAuthTest,
	SlackConversation,
	SlackConversationInfo,
	SlackConversationsList,
	SlackRepliesResponse,
	SlackSearchMatch,
	SlackSearchResponse,
	SlackUserInfo,
} from '../slack/web-types.js'
import type { SignalObservation, SignalSourceStatus } from './contract.js'
import {
	type SlackMapContext,
	type SlackMapResult,
	mapDm,
	mapMention,
	mapThread,
	mergeSlackObservations,
} from './slack-map.js'
import type { SignalReader } from './watcher.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** Caps per poll, well under Slack's Tier 3 (~50/min) budgets. */
const MAX_DM_INFO = 30
const MAX_THREADS = 15
const MAX_SEARCH = 50
const MAX_NAME_LOOKUPS = 30
const MAX_CONV_PAGES = 10

export interface SlackReaderDeps {
	store?: SlackSessionStore
	/** Create a client for a session (injected in tests). */
	clientFor?: (session: SlackSession) => SlackClient
	now?: () => Date
}

type Health = { status: SignalSourceStatus; detail: string | null }

const STATUS_RANK: Record<SignalSourceStatus, number> = {
	needs_permission: 4,
	unavailable: 3,
	error: 2,
	ok: 1,
	disabled: 0,
}
const worse = (a: Health, b: Health): Health => (STATUS_RANK[b.status] > STATUS_RANK[a.status] ? b : a)

/** Map a Slack API error to source health. */
function classify(error: unknown): Health {
	if (error instanceof SlackRateLimitError) return { status: 'error', detail: 'Slack rate limited; will retry' }
	if (error instanceof SlackApiError) {
		if (['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'].includes(error.code)) {
			return { status: 'needs_permission', detail: 'Slack session expired — run helm slack connect' }
		}
		if (error.code === 'missing_scope') return { status: 'error', detail: 'Slack session is missing a scope' }
		return { status: 'error', detail: `Slack error: ${error.code}` }
	}
	if (error instanceof SlackTransportError) return { status: 'unavailable', detail: 'Could not reach Slack' }
	return { status: 'error', detail: 'Slack read failed' }
}

function parseTeamFilter(raw: string): Set<string> {
	return new Set(
		raw
			.split('\n')
			.map(line => line.trim().toLowerCase())
			.filter(line => line !== ''),
	)
}

function parseUserList(raw: string): Set<string> {
	return new Set(
		raw
			.split('\n')
			.map(line => line.trim().toLowerCase().replace(/^@/, ''))
			.filter(line => line !== ''),
	)
}

export function createSlackSignalReader(config: HelmConfig, deps: SlackReaderDeps = {}): SignalReader {
	const store = deps.store ?? new SlackSessionStore()
	const now = deps.now ?? (() => new Date())
	const clientFor =
		deps.clientFor ?? ((session: SlackSession) => new SlackClient({ token: session.token, cookie: session.cookie }))

	return {
		source: 'slack',
		async read(signal) {
			const cancelled = { result: null, health: { status: 'error' as const, detail: 'Poll was cancelled' } }
			if (signal.aborted) return cancelled
			const settings = config.signals.slack
			const teamIds = await store.list()
			if (teamIds.length === 0) {
				return { result: null, health: { status: 'disabled', detail: 'Not connected (helm slack connect)' } }
			}
			const wanted = parseTeamFilter(settings.teams)
			const sessions: SlackSession[] = []
			for (const id of teamIds) {
				const session = await store.get(id)
				if (!session) continue
				if (wanted.size > 0 && !wanted.has(session.teamId.toLowerCase()) && !wanted.has(session.domain.toLowerCase())) {
					continue
				}
				sessions.push(session)
			}
			if (sessions.length === 0) {
				return { result: null, health: { status: 'disabled', detail: 'No matching connected workspace' } }
			}

			const observations: SignalObservation[] = []
			const filtered: SlackMapResult['filtered'][] = []
			let complete = true
			let health: Health = { status: 'ok', detail: null }
			const includeUsers = parseUserList(settings.includeUsers)
			const excludeUsers = parseUserList(settings.excludeUsers)

			for (const session of sessions) {
				if (signal.aborted) return cancelled
				try {
					const one = await pollWorkspace(clientFor(session), session, {
						settings,
						now: now().getTime(),
						includeUsers,
						excludeUsers,
						signal,
					})
					observations.push(...one.observations)
					filtered.push(...one.filtered)
					if (!one.complete) complete = false
				} catch (error) {
					if (signal.aborted) return cancelled
					complete = false
					health = worse(health, classify(error))
				}
			}

			return {
				result: {
					source: 'slack',
					observations,
					filtered: { entries: filtered.filter((f): f is NonNullable<typeof f> => f != null), keptKeys: [] },
					complete,
					goneReason: 'read or answered in Slack',
				},
				health,
			}
		},
	}
}

interface WorkspaceOptions {
	settings: HelmConfig['signals']['slack']
	now: number
	includeUsers: Set<string>
	excludeUsers: Set<string>
	signal: AbortSignal
}

async function pollWorkspace(
	client: SlackClient,
	session: SlackSession,
	options: WorkspaceOptions,
): Promise<{
	observations: SignalObservation[]
	filtered: NonNullable<SlackMapResult['filtered']>[]
	complete: boolean
}> {
	const { settings } = options
	const maxAgeMs = settings.maxAgeDays * DAY_MS
	const sinceIso = new Date(options.now - maxAgeMs).toISOString().slice(0, 10)

	const auth = await client.call<SlackAuthTest>('auth.test')
	const me = auth.user_id ?? session.userId
	if (!me) throw new SlackApiError('not_authed', 'auth.test')

	const names = new Map<string, string>()
	const channels = new Map<string, string>()
	const ctx: SlackMapContext = {
		teamId: session.teamId,
		domain: session.domain || auth.url?.replace(/^https?:\/\/([^.]+).*$/, '$1') || '',
		me,
		now: options.now,
		maxAgeMs,
		includeUsers: options.includeUsers,
		excludeUsers: options.excludeUsers,
		resolveUser: id => names.get(id) ?? id,
		resolveChannel: id => channels.get(id) ?? id,
	}

	let complete = true
	const needName = new Set<string>()
	const dmConvs: SlackConversation[] = []
	const mentionMatches: SlackSearchMatch[] = []
	const threadReplies: { channel: string; replies: SlackRepliesResponse['messages'] }[] = []

	// 1) DMs and group DMs — fetch raw, collect the names we will need.
	const dms = await listConversations(client, 'im,mpim')
	complete = complete && dms.complete
	for (const conv of dms.channels.slice(0, MAX_DM_INFO)) {
		if (options.signal.aborted) break
		const info = await client.call<SlackConversationInfo>('conversations.info', { channel: conv.id ?? '' })
		const merged: SlackConversation = { ...conv, ...info.channel }
		if (merged.name) channels.set(merged.id ?? '', merged.name)
		const latestUser = merged.latest?.user ?? merged.user
		if (latestUser) needName.add(latestUser)
		dmConvs.push(merged)
	}
	if (dms.channels.length > MAX_DM_INFO) complete = false

	// 2) Mentions.
	if (settings.mentions) {
		const search = await client.call<SlackSearchResponse>('search.messages', {
			query: `<@${me}> after:${sinceIso}`,
			count: MAX_SEARCH,
			sort: 'timestamp',
		})
		if ((search.messages?.paging?.pages ?? 1) > 1) complete = false
		for (const match of search.messages?.matches ?? []) {
			if (match.channel?.id) channels.set(match.channel.id, match.channel.name ?? match.channel.id)
			if (match.user) needName.add(match.user)
			mentionMatches.push(match)
		}
	}

	// 3) Threads Jakub wrote in.
	if (settings.threads) {
		const search = await client.call<SlackSearchResponse>('search.messages', {
			query: `from:<@${me}> is:thread after:${sinceIso}`,
			count: MAX_SEARCH,
			sort: 'timestamp',
		})
		const threads = dedupeThreads(search.messages?.matches ?? []).slice(0, MAX_THREADS)
		if ((search.messages?.matches?.length ?? 0) > MAX_THREADS) complete = false
		for (const { channel, ts } of threads) {
			if (options.signal.aborted) break
			const replies = await client.call<SlackRepliesResponse>('conversations.replies', { channel, ts, limit: 200 })
			for (const m of replies.messages ?? []) if (m.user) needName.add(m.user)
			if (replies.has_more) complete = false
			threadReplies.push({ channel, replies: replies.messages })
		}
	}

	// Resolve display names (bounded) before mapping, so refs/heads show names, not ids.
	let looked = 0
	for (const id of needName) {
		if (looked >= MAX_NAME_LOOKUPS || options.signal.aborted) break
		if (names.has(id)) continue
		looked++
		try {
			const info = await client.call<SlackUserInfo>('users.info', { user: id })
			const u = info.user
			names.set(id, u?.profile?.display_name || u?.real_name || u?.name || id)
		} catch {
			names.set(id, id)
		}
	}

	const results: SlackMapResult[] = []
	for (const conv of dmConvs) results.push(mapDm(conv, ctx))
	for (const match of mentionMatches) results.push(mapMention(match, ctx))
	for (const { channel, replies } of threadReplies) results.push(mapThread(channel, replies ?? [], ctx))
	const merged = mergeSlackObservations(results)
	return { observations: merged.observations, filtered: merged.filtered, complete }
}

async function listConversations(
	client: SlackClient,
	types: string,
): Promise<{ channels: SlackConversation[]; complete: boolean }> {
	const channels: SlackConversation[] = []
	let cursor: string | undefined
	let pages = 0
	let complete = true
	do {
		const page = await client.call<SlackConversationsList>('users.conversations', {
			types,
			exclude_archived: true,
			limit: 200,
			cursor,
		})
		for (const c of page.channels ?? []) if (!c.is_archived && !c.is_user_deleted) channels.push(c)
		cursor = page.response_metadata?.next_cursor || undefined
		pages++
		if (pages >= MAX_CONV_PAGES && cursor) {
			complete = false
			break
		}
	} while (cursor)
	return { channels, complete }
}

/** One (channel, thread_ts) per thread Jakub posted in, newest first. */
function dedupeThreads(matches: { channel?: { id?: string }; ts?: string; thread_ts?: string }[]): {
	channel: string
	ts: string
}[] {
	const seen = new Map<string, { channel: string; ts: string }>()
	for (const m of matches) {
		const channel = m.channel?.id
		const ts = m.thread_ts ?? m.ts
		if (!channel || !ts) continue
		const key = `${channel}:${ts}`
		if (!seen.has(key)) seen.set(key, { channel, ts })
	}
	return [...seen.values()]
}
