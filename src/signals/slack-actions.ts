// Slack write actions the Signals routes and the CLI share: post a reply (chat.postMessage) to a
// thread's DM or thread, and resolve a send target. The session comes from Helm's Keychain; the
// token/cookie never leave this layer. Reply text is escaped for Slack and bounded.

import { type SlackSession, SlackSessionStore } from '../slack/session.js'
import { SlackApiError, SlackClient } from '../slack/web-api.js'
import type { SlackChatPostMessage, SlackConversationOpen, SlackUser } from '../slack/web-types.js'
import { SIGNAL_LIMITS, type SignalThread } from './contract.js'

export interface SlackActionsDeps {
	store?: SlackSessionStore
	clientFor?: (session: SlackSession) => SlackClient
}

export interface SlackReplyResult {
	ok: boolean
	/** Machine code when it failed (never a secret). */
	error?: string
}

/** The channel and optional thread ts a Slack thread row points at. */
export function parseSlackThreadTarget(thread: Pick<SignalThread, 'threadKey'>): {
	teamId: string
	channel: string
	threadTs?: string
} | null {
	const parts = thread.threadKey.split(':')
	if (parts[0] !== 'slack' || !parts[1] || !parts[2]) return null
	return { teamId: parts[1], channel: parts[2], threadTs: parts[3] }
}

/** Escape user text for Slack mrkdwn (only &, <, > per Slack's rules). */
export function escapeSlackText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export class SlackActions {
	private readonly store: SlackSessionStore
	private readonly clientFor: (session: SlackSession) => SlackClient

	constructor(deps: SlackActionsDeps = {}) {
		this.store = deps.store ?? new SlackSessionStore()
		this.clientFor = deps.clientFor ?? (session => new SlackClient({ token: session.token, cookie: session.cookie }))
	}

	private async sessionFor(teamId: string): Promise<SlackSession | null> {
		const direct = await this.store.get(teamId)
		if (direct) return direct
		// Fall back to a domain match (CLI --team may pass a domain).
		for (const id of await this.store.list()) {
			const session = await this.store.get(id)
			if (session && (session.teamId === teamId || session.domain === teamId)) return session
		}
		return null
	}

	/** Post Jakub's reply to the thread's DM/thread. */
	async reply(thread: Pick<SignalThread, 'threadKey'>, text: string): Promise<SlackReplyResult> {
		const target = parseSlackThreadTarget(thread)
		if (!target) return { ok: false, error: 'not_a_slack_thread' }
		const trimmed = text.trim()
		if (!trimmed) return { ok: false, error: 'empty_text' }
		const session = await this.sessionFor(target.teamId)
		if (!session) return { ok: false, error: 'not_connected' }
		try {
			await this.clientFor(session).call<SlackChatPostMessage>('chat.postMessage', {
				channel: target.channel,
				text: escapeSlackText(trimmed).slice(0, SIGNAL_LIMITS.slackReply),
				...(target.threadTs ? { thread_ts: target.threadTs } : {}),
			})
			return { ok: true }
		} catch (error) {
			return { ok: false, error: error instanceof SlackApiError ? error.code : 'post_failed' }
		}
	}

	/** Post a message to an explicit target (CLI send): a channel/DM id, or open a DM with a user. */
	async send(
		teamId: string | undefined,
		target: { channel?: string; user?: string },
		text: string,
		threadTs?: string,
	): Promise<{ ok: boolean; channel?: string; error?: string }> {
		const session = teamId ? await this.sessionFor(teamId) : await this.onlySession()
		if (!session) return { ok: false, error: 'not_connected' }
		const client = this.clientFor(session)
		let channel = target.channel
		if (!channel && target.user) {
			try {
				const open = await client.call<SlackConversationOpen>('conversations.open', { users: target.user })
				channel = open.channel?.id
			} catch (error) {
				return { ok: false, error: error instanceof SlackApiError ? error.code : 'open_failed' }
			}
		}
		if (!channel) return { ok: false, error: 'no_target' }
		try {
			const res = await client.call<SlackChatPostMessage>('chat.postMessage', {
				channel,
				text: escapeSlackText(text).slice(0, SIGNAL_LIMITS.slackReply),
				...(threadTs ? { thread_ts: threadTs } : {}),
			})
			return { ok: true, channel: res.channel ?? channel }
		} catch (error) {
			return { ok: false, error: error instanceof SlackApiError ? error.code : 'post_failed' }
		}
	}

	/** Resolve a user handle/id/email to a Slack user (for the CLI). */
	async resolveUser(teamId: string | undefined, query: string): Promise<SlackUser | null> {
		const session = teamId ? await this.sessionFor(teamId) : await this.onlySession()
		if (!session) return null
		const client = this.clientFor(session)
		const q = query.trim()
		if (/^U[A-Z0-9]+$/i.test(q)) {
			const info = await client.call<{ user?: SlackUser }>('users.info', { user: q })
			return info.user ?? null
		}
		if (q.includes('@') && q.includes('.')) {
			const info = await client.call<{ user?: SlackUser }>('users.lookupByEmail', { email: q })
			return info.user ?? null
		}
		return null
	}

	private async onlySession(): Promise<SlackSession | null> {
		const ids = await this.store.list()
		if (ids.length !== 1) return null
		return this.store.get(ids[0])
	}
}
