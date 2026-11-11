// Pure Slack → Signals mapping: Slack conversations/messages/search matches (slack/web-types.ts)
// become one observation per DM / mention / thread where Jakub is the one to move, plus filtered
// observations for the senders the rules keep out (bots, excluded users). No IO; the store bounds
// and sanitizes every field again. Message text is third-party data, rendered to plain one-line
// text with links kept as text — never instructions.

import type { SlackConversation, SlackMessage, SlackSearchMatch } from '../slack/web-types.js'
import { SIGNAL_LIMITS, type SignalFilteredObservation, type SignalKind, type SignalObservation } from './contract.js'

export interface SlackMapContext {
	teamId: string
	domain: string
	/** Jakub's Slack user id. */
	me: string
	now: number
	maxAgeMs: number
	/** Lowercased user ids / handles always counted (overrides bot/exclude). */
	includeUsers: Set<string>
	/** Lowercased user ids / handles never counted. */
	excludeUsers: Set<string>
	/** id → display name (best effort; falls back to the id). */
	resolveUser: (id: string) => string
	/** channel id → name (best effort). */
	resolveChannel: (id: string) => string
}

/** One mapped item: a signal, a filtered entry, or nothing. */
export interface SlackMapResult {
	observation?: SignalObservation
	filtered?: SignalFilteredObservation
}

/** A Slack ts (`"1513718191.000038"`) → ISO time; null when unparseable. */
export function slackTsToIso(ts: string | undefined): string | null {
	if (!ts) return null
	const seconds = Number.parseFloat(ts)
	if (!Number.isFinite(seconds) || seconds <= 0) return null
	return new Date(seconds * 1000).toISOString()
}

/** A message's https permalink. */
export function slackPermalink(domain: string, channel: string, ts: string, threadTs?: string): string {
	const sub = domain || 'app'
	const p = `p${ts.replace('.', '')}`
	const base = `https://${sub}.slack.com/archives/${channel}/${p}`
	return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base
}

export function slackThreadKey(teamId: string, channel: string, threadTs?: string): string {
	return threadTs ? `slack:${teamId}:${channel}:${threadTs}` : `slack:${teamId}:${channel}`
}

/** Render Slack mrkdwn to plain one-line text: mentions, channels, links, entities. */
export function slackMrkdwnToPlain(text: string, ctx: Pick<SlackMapContext, 'resolveUser' | 'resolveChannel'>): string {
	let out = text
	// <@U123> / <@U123|name>
	out = out.replace(/<@([A-Z0-9]+)(\|[^>]+)?>/g, (_m, id: string, label?: string) =>
		label ? `@${label.slice(1)}` : `@${ctx.resolveUser(id)}`,
	)
	// <#C123|name> / <#C123>
	out = out.replace(/<#([A-Z0-9]+)(\|[^>]+)?>/g, (_m, id: string, label?: string) =>
		label ? `#${label.slice(1)}` : `#${ctx.resolveChannel(id)}`,
	)
	// <!here> <!channel> <!subteam^S|@grp>
	out = out.replace(/<!subteam\^[A-Z0-9]+(\|([^>]+))?>/g, (_m, _p, label?: string) => (label ? label : '@group'))
	out = out.replace(/<!([a-z]+)(\|[^>]+)?>/g, (_m, name: string) => `@${name}`)
	// <url|label> and <url>
	out = out.replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_m, _url: string, label: string) => label)
	out = out.replace(/<(https?:[^>]+)>/g, (_m, url: string) => url)
	// mailto
	out = out.replace(/<mailto:([^|>]+)(\|[^>]+)?>/g, (_m, addr: string) => addr)
	// entities
	out = out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
	// collapse whitespace/newlines to one line
	return out.replace(/\s+/g, ' ').trim()
}

/** Whether a message's sender counts as foreign human activity (not me, not a bot/system). */
function isForeign(message: SlackMessage, ctx: SlackMapContext): boolean {
	const user = (message.user ?? '').toLowerCase()
	if (user && ctx.includeUsers.has(user)) return true
	if (message.bot_id || message.subtype === 'bot_message') return false
	if (!message.user || message.user === ctx.me) return false
	if (message.user === 'USLACKBOT') return false
	// join/leave/topic/channel-event subtypes are not someone talking to Jakub.
	if (message.subtype && message.subtype !== 'thread_broadcast' && message.subtype !== 'me_message') return false
	return true
}

/** Why a sender is kept out, or null when it is not. */
function excludedReason(message: SlackMessage, ctx: SlackMapContext): 'excluded' | 'bot' | null {
	const user = (message.user ?? '').toLowerCase()
	if (user && ctx.includeUsers.has(user)) return null
	if (user && ctx.excludeUsers.has(user)) return 'excluded'
	if (message.bot_id || message.subtype === 'bot_message') return 'bot'
	return null
}

function senderName(message: SlackMessage, ctx: SlackMapContext): string {
	return message.user ? ctx.resolveUser(message.user) : 'someone'
}

function filteredOf(
	channel: string,
	message: SlackMessage,
	reason: 'excluded' | 'bot',
	ctx: SlackMapContext,
): SignalFilteredObservation | undefined {
	const iso = slackTsToIso(message.ts)
	if (!iso || !message.ts) return undefined
	const user = (message.user ?? '').toLowerCase()
	return {
		messageKey: `slack:${channel}:${message.ts}`,
		senderName: senderName(message, ctx),
		senderAddress: user,
		senderIdentity: user,
		subject: slackMrkdwnToPlain(message.text ?? '', ctx).slice(0, SIGNAL_LIMITS.title),
		reason,
		mailbox: channel,
		url: slackPermalink(ctx.domain, channel, message.ts, message.thread_ts),
		receivedAt: iso,
	}
}

/** Map one DM/mpim: its latest message decides whether it needs Jakub. */
export function mapDm(conv: SlackConversation, ctx: SlackMapContext): SlackMapResult {
	const channel = conv.id ?? ''
	const latest = conv.latest
	if (!channel || !latest || !latest.ts) return {}
	const iso = slackTsToIso(latest.ts)
	if (!iso) return {}
	// Within the age window.
	if (ctx.now - Date.parse(iso) > ctx.maxAgeMs) return {}
	// Jakub already read up to here (last_read advances past the latest ts when read in Slack).
	if (conv.last_read && Number.parseFloat(conv.last_read) >= Number.parseFloat(latest.ts)) return {}

	const reason = excludedReason(latest, ctx)
	if (reason) return { filtered: filteredOf(channel, latest, reason, ctx) }
	if (!isForeign(latest, ctx)) return {}

	const group = conv.is_mpim === true
	const otherName = conv.is_im ? ctx.resolveUser(latest.user ?? conv.user ?? '') : ctx.resolveChannel(channel)
	const ref = group ? ctx.resolveChannel(channel) || 'group DM' : otherName || 'DM'
	const text = slackMrkdwnToPlain(latest.text ?? '', ctx)
	return {
		observation: {
			threadKey: slackThreadKey(ctx.teamId, channel),
			source: 'slack',
			kind: 'dm',
			reasons: ['dm'],
			ref,
			fullRef: group ? `group DM · ${ref}` : `DM · ${ref}`,
			title: text || '(no text)',
			head: `${senderName(latest, ctx)}: ${text}`.slice(0, SIGNAL_LIMITS.head),
			actor: senderName(latest, ctx),
			url: slackPermalink(ctx.domain, channel, latest.ts, latest.thread_ts),
			repo: null,
			number: null,
			branch: null,
			activityKey: latest.ts,
			lastActivityAt: iso,
			sender: (latest.user ?? '').toLowerCase() || null,
			senderAddress: (latest.user ?? '').toLowerCase() || null,
		},
	}
}

/** Map a search mention match (channel message mentioning Jakub). */
export function mapMention(match: SlackSearchMatch, ctx: SlackMapContext): SlackMapResult {
	const channel = match.channel?.id ?? ''
	if (!channel || !match.ts) return {}
	const iso = slackTsToIso(match.ts)
	if (!iso) return {}
	if (ctx.now - Date.parse(iso) > ctx.maxAgeMs) return {}
	const message: SlackMessage = { user: match.user, text: match.text, ts: match.ts }
	const reason = excludedReason(message, ctx)
	if (reason) return { filtered: filteredOf(channel, message, reason, ctx) }
	if (!isForeign(message, ctx)) return {}
	const chan = ctx.resolveChannel(channel) || match.channel?.name || channel
	const text = slackMrkdwnToPlain(match.text ?? '', ctx)
	return {
		observation: {
			threadKey: slackThreadKey(ctx.teamId, channel, match.ts),
			source: 'slack',
			kind: 'mention',
			reasons: ['mention'],
			ref: `#${chan}`,
			fullRef: `mention · #${chan}`,
			title: text || '(no text)',
			head: `${senderName(message, ctx)}: ${text}`.slice(0, SIGNAL_LIMITS.head),
			actor: senderName(message, ctx),
			url: match.permalink ?? slackPermalink(ctx.domain, channel, match.ts),
			repo: null,
			number: null,
			branch: null,
			activityKey: match.ts,
			lastActivityAt: iso,
			sender: (match.user ?? '').toLowerCase() || null,
			senderAddress: (match.user ?? '').toLowerCase() || null,
		},
	}
}

/**
 * Map a thread Jakub is in: `replies` is conversations.replies (parent first). Needs Jakub when the
 * latest message is foreign, newer than his last message in the thread and newer than last_read.
 */
export function mapThread(channel: string, replies: SlackMessage[], ctx: SlackMapContext): SlackMapResult {
	if (!channel || replies.length === 0) return {}
	const parent = replies[0]
	const threadTs = parent?.thread_ts ?? parent?.ts
	if (!threadTs) return {}
	const latest = replies[replies.length - 1]
	if (!latest?.ts) return {}
	const iso = slackTsToIso(latest.ts)
	if (!iso) return {}
	if (ctx.now - Date.parse(iso) > ctx.maxAgeMs) return {}
	// Jakub's own last message in the thread.
	const myLast = [...replies].reverse().find(m => m.user === ctx.me)?.ts
	if (myLast && Number.parseFloat(myLast) >= Number.parseFloat(latest.ts)) return {}
	// Read marker on the parent.
	if (parent.last_read && Number.parseFloat(parent.last_read) >= Number.parseFloat(latest.ts)) return {}

	const reason = excludedReason(latest, ctx)
	if (reason) return { filtered: filteredOf(channel, latest, reason, ctx) }
	if (!isForeign(latest, ctx)) return {}

	const chan = ctx.resolveChannel(channel) || channel
	const text = slackMrkdwnToPlain(latest.text ?? '', ctx)
	const reasons: SignalKind[] = ['thread']
	return {
		observation: {
			threadKey: slackThreadKey(ctx.teamId, channel, threadTs),
			source: 'slack',
			kind: 'thread',
			reasons,
			ref: `#${chan}`,
			fullRef: `thread · #${chan}`,
			title: text || '(no text)',
			head: `${senderName(latest, ctx)}: ${text}`.slice(0, SIGNAL_LIMITS.head),
			actor: senderName(latest, ctx),
			url: slackPermalink(ctx.domain, channel, latest.ts, threadTs),
			repo: null,
			number: null,
			branch: null,
			activityKey: latest.ts,
			lastActivityAt: iso,
			sender: (latest.user ?? '').toLowerCase() || null,
			senderAddress: (latest.user ?? '').toLowerCase() || null,
		},
	}
}

/** Merge observations that share a thread key (mention + thread on the same thread), newest wins. */
export function mergeSlackObservations(results: SlackMapResult[]): {
	observations: SignalObservation[]
	filtered: SignalFilteredObservation[]
} {
	const byKey = new Map<string, SignalObservation>()
	const filtered: SignalFilteredObservation[] = []
	for (const result of results) {
		if (result.filtered) filtered.push(result.filtered)
		const obs = result.observation
		if (!obs) continue
		const existing = byKey.get(obs.threadKey)
		if (!existing) {
			byKey.set(obs.threadKey, obs)
			continue
		}
		// Merge reasons; keep the newer activity's heads.
		const reasons = [...new Set([...existing.reasons, ...obs.reasons])]
		const newer = Date.parse(obs.lastActivityAt) > Date.parse(existing.lastActivityAt) ? obs : existing
		byKey.set(obs.threadKey, { ...newer, reasons, kind: newer.kind })
	}
	return { observations: [...byKey.values()], filtered }
}
