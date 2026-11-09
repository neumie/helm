// Pure Apple Mail → Signals filtering and threading. Input is the head-only message list the JXA
// read returns (mail-jxa.ts); output is one observation per conversation (or per Sentry issue).
// No IO; sender/subject text is third-party data and stays one bounded line.

import { createHash } from 'node:crypto'
import { oneLine } from '../agent-dock/text.js'
import { SIGNAL_LIMITS, type SignalObservation } from './contract.js'

/** One message as the JXA script reports it (headers never leave the script). */
export interface MailMessageHead {
	/** Message-ID without angle brackets. */
	messageId: string
	subject: string
	senderName: string
	senderAddress: string
	/** ISO time. */
	dateReceived: string
	read: boolean
	flagged: boolean
	/**
	 * Bulk header present (mail-jxa.ts `isBulk`): List-Id / List-Unsubscribe / List-Unsubscribe-Post,
	 * an X-Campaign* header, Precedence bulk|list|junk, Auto-Submitted other than no.
	 */
	bulk: boolean
	/** Conversation root Message-ID (first References id, else In-Reply-To, else own id). */
	root: string
	/**
	 * Name of the configured extra mailbox it was read from (`Clientcare`); null or absent for the
	 * inbox. Shown in front of the row's head so Jakub sees where it came from.
	 */
	mailbox?: string | null
}

export interface MailFilterOptions {
	unreadOnly: boolean
	excludeBulk: boolean
	maxAgeDays: number
	/**
	 * Sender address globs that are always in (Sentry and friends), read or not, bulk or not. Matched
	 * against the relay-decoded address as well as the raw one ({@link relayedSenderAddress}).
	 */
	includeSenders: string[]
	/** Sender address globs that are always out (unless also included); raw or relay-decoded. */
	excludeSenders: string[]
	/** Jakub's own addresses: his messages are never foreign activity. */
	myAddresses: string[]
}

export const MAIL_GONE_REASON = 'no longer unread in the inbox'

/** Why a mail thread left on its own, naming the extra mailboxes it may have come from. */
export function mailGoneReason(mailboxes: string[]): string {
	if (mailboxes.length === 0) return MAIL_GONE_REASON
	if (mailboxes.length > 1) return `${MAIL_GONE_REASON} or the listed mailboxes`
	return `${MAIL_GONE_REASON} or ${oneLine(mailboxes[0], 60)}`
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Bound for the mailbox label in front of a row's head. */
const MAILBOX_LABEL_MAX = 40

/** One glob per line; blank lines and surrounding whitespace ignored. */
export function parseGlobList(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line !== '')
}

/** Anchored, case-insensitive regex source for a `*` glob (every other character literal). */
export function globToRegExpSource(glob: string): string {
	return `^${glob
		.split('*')
		.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*')}$`
}

/** Configured extra mailboxes: one per line, trimmed, blank lines and case-insensitive repeats dropped. */
export function parseMailboxList(text: string): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const entry of parseGlobList(text)) {
		const key = entry.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(entry)
	}
	return out
}

/** A Mail account as the mailbox matcher sees it; null for local (On My Mac) mailboxes. */
export interface MailAccountIdentity {
	name: string
	addresses: string[]
}

/**
 * Whether a configured entry names this mailbox: the mailbox name (`Clientcare`, in any account),
 * or `<account name or address>/<mailbox name>` (`neumann@contember.com/Clientcare`). Compared
 * case-insensitively on the mailbox's own name, not its path (`[Gmail]/All Mail` is `All Mail`).
 * Mirrored by `mailboxMatches` in mail-jxa.ts.
 */
export function mailboxEntryMatches(entry: string, account: MailAccountIdentity | null, mailbox: string): boolean {
	const wanted = entry.trim().toLowerCase()
	const name = mailbox.trim().toLowerCase()
	if (wanted === '' || name === '') return false
	if (wanted === name) return true
	if (account === null) return false
	const slash = wanted.indexOf('/')
	if (slash <= 0 || wanted.slice(slash + 1).trim() !== name) return false
	const qualifier = wanted.slice(0, slash).trim()
	return (
		qualifier === account.name.trim().toLowerCase() ||
		account.addresses.some(address => qualifier === address.trim().toLowerCase())
	)
}

function messageIdKey(messageId: string): string {
	return messageId.trim().replace(/^<|>$/g, '').toLowerCase()
}

/**
 * One message per Message-ID: the same mail filed in several mailboxes (an inbox copy and a Gmail
 * label) is one message. The inbox copy wins, else the first one listed.
 */
export function dedupeMailMessages(messages: MailMessageHead[]): MailMessageHead[] {
	const kept = new Map<string, number>()
	const out: MailMessageHead[] = []
	for (const message of messages) {
		const key = messageIdKey(message.messageId)
		const at = kept.get(key)
		if (at === undefined) {
			kept.set(key, out.length)
			out.push(message)
		} else if (out[at].mailbox && !message.mailbox) {
			out[at] = message
		}
	}
	return out
}

export function matchesGlob(address: string, globs: string[]): boolean {
	return globs.some(glob => new RegExp(globToRegExpSource(glob), 'i').test(address))
}

function normalizeAddress(address: string): string {
	return address.trim().toLowerCase()
}

/** Messages that want Jakub, per the configured rules. */
export function filterMail(messages: MailMessageHead[], options: MailFilterOptions, now: Date): MailMessageHead[] {
	const mine = new Set(options.myAddresses.map(normalizeAddress))
	const oldest = now.getTime() - options.maxAgeDays * DAY_MS
	return messages.filter(message => {
		const received = Date.parse(message.dateReceived)
		if (!Number.isFinite(received) || received < oldest) return false
		const raw = normalizeAddress(message.senderAddress)
		const address = senderIdentity(raw)
		const matches = (globs: string[]) => matchesGlob(address, globs) || (address !== raw && matchesGlob(raw, globs))
		// Sentry is always in, even when the include list was edited without it.
		if (isSentrySender(address) || matches(options.includeSenders)) return true
		if (options.unreadOnly && message.read) return false
		if (options.excludeBulk && message.bulk) return false
		if (matches(options.excludeSenders)) return false
		return !mine.has(raw) && !mine.has(address)
	})
}

/**
 * Apple Hide My Email (Sign in with Apple and iCloud+) rewrites every relayed sender to an address
 * at one of these domains. Ordinary iCloud users also live on `icloud.com`, so there only the full
 * relay grammar decodes and an undecodable address stays a person.
 */
const APPLE_RELAY_ONLY_DOMAINS = new Set(['privaterelay.appleid.com', 'private.icloud.com'])
const APPLE_RELAY_DOMAINS = new Set([...APPLE_RELAY_ONLY_DOMAINS, 'icloud.com'])

/**
 * Relay local part: `<user>_at_<domain with dots as underscores>_<token>_<hex>`, e.g.
 * `jobot_at_startupjobs_cz_pp77sqsgqd_3e707591`. The token is per relay alias (shared by senders of
 * one domain), the hex per sender. The first `_at_` splits user from domain, so a `.at` domain
 * stays decodable.
 */
const RELAY_LOCAL = /^(.+?)_at_([a-z0-9-]+(?:_[a-z0-9-]+)+)_[a-z0-9]{6,16}_[0-9a-f]{6,16}$/
const RELAY_LOCAL_MAX = 400
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const TOP_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/

/**
 * The original sender behind an Apple Hide My Email relay address (`jobot@startupjobs.cz` for
 * `jobot_at_startupjobs_cz_pp77sqsgqd_3e707591@privaterelay.appleid.com`), else null: not a relay
 * address, or one this decoder does not understand. Mirrored by `relayDecode` in mail-jxa.ts.
 * The From header is the sender's word either way: a decoded address earns no more trust than the
 * same address in a plain From would.
 */
export function relayedSenderAddress(address: string): string | null {
	const normalized = normalizeAddress(address)
	const at = normalized.lastIndexOf('@')
	if (at <= 0 || !APPLE_RELAY_DOMAINS.has(normalized.slice(at + 1))) return null
	const local = normalized.slice(0, at)
	if (local.length > RELAY_LOCAL_MAX) return null
	const match = local.match(RELAY_LOCAL)
	if (!match) return null
	const labels = match[2].split('_')
	if (!labels.every(label => HOST_LABEL.test(label)) || !TOP_LABEL.test(labels[labels.length - 1])) return null
	return `${match[1]}@${labels.join('.')}`
}

/** A relay-only address (never a person's own mailbox) that did not decode. */
function isAppleRelay(address: string): boolean {
	return APPLE_RELAY_ONLY_DOMAINS.has(domainOf(address))
}

/** The address that identifies a sender: the relay-decoded original when there is one. */
export function senderIdentity(address: string): string {
	const normalized = normalizeAddress(address)
	return relayedSenderAddress(normalized) ?? normalized
}

function domainOf(address: string): string {
	const at = address.lastIndexOf('@')
	return at === -1 ? '' : address.slice(at + 1).toLowerCase()
}

export function isSentrySender(address: string): boolean {
	const domain = domainOf(address)
	return (
		domain === 'sentry.io' ||
		domain.endsWith('.sentry.io') ||
		domain === 'getsentry.com' ||
		// Sentry's hosted alerts come from `noreply@md.getsentry.com`.
		domain.endsWith('.getsentry.com')
	)
}

const SENTRY_SHORT_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/

export function sentryShortId(subject: string): string | null {
	return subject.match(SENTRY_SHORT_ID)?.[0] ?? null
}

/** Subject without leading `[Sentry]` / `Sentry:` decorations. */
export function sentryHead(subject: string): string {
	let head = subject.trim()
	for (;;) {
		const next = head.replace(/^(?:\[Sentry\]|Sentry:)\s*/i, '')
		if (next === head) return head
		head = next
	}
}

const GENERIC_PROVIDERS = new Set([
	'gmail.com',
	'googlemail.com',
	'icloud.com',
	'me.com',
	'outlook.com',
	'hotmail.com',
	'live.com',
	'yahoo.com',
	'seznam.cz',
	'email.cz',
	'centrum.cz',
	'post.cz',
	'proton.me',
	'protonmail.com',
])

/** Second-level labels that are really part of a public suffix (`acme.co.uk`). */
const SUFFIX_LABELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'])

/**
 * Short reference for a sender: organisation from the domain, or the person for webmail. A Hide My
 * Email relay sender is named by its decoded original domain, else by its display name: never by
 * the relay's own domain.
 */
export function mailRef(senderName: string, senderAddress: string): string {
	const name = senderName.trim()
	const address = senderIdentity(senderAddress)
	if (isAppleRelay(address)) return name !== '' ? name : 'Mail'
	const domain = domainOf(address)
	if (domain === '' || GENERIC_PROVIDERS.has(domain)) {
		return name !== '' ? name : address.split('@')[0] || 'Mail'
	}
	const labels = domain.split('.').filter(label => label !== '')
	let label = labels.length >= 2 ? labels[labels.length - 2] : labels[0]
	if (labels.length >= 3 && SUFFIX_LABELS.has(label)) label = labels[labels.length - 3]
	if (!label) return domain
	return label.length <= 3 ? label.toUpperCase() : `${label[0].toUpperCase()}${label.slice(1)}`
}

/** `Name <address>` for the row tooltip; a decoded relay sender says it came through the relay. */
export function mailFullRef(senderName: string, senderAddress: string): string {
	const raw = normalizeAddress(senderAddress)
	const decoded = relayedSenderAddress(raw)
	const address = decoded ?? raw
	const name = senderName.trim()
	const base = name ? `${name} <${address}>` : address
	return decoded ? `${base} via Hide My Email` : base
}

/** `message://%3Cid%3E` for the given Message-ID (with or without angle brackets). */
export function messageUrl(messageId: string): string {
	const bare = messageId.trim().replace(/^<|>$/g, '')
	return `message://${encodeURIComponent(`<${bare}>`)}`
}

function hash16(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function line(text: string, max: number): string {
	return oneLine(text, max)
}

interface MailGroup {
	threadKey: string
	kind: 'mail' | 'sentry'
	sentryId: string | null
	messages: MailMessageHead[]
}

/** One observation per conversation (mail) or Sentry issue, from already filtered messages. */
export function mapMailThreads(messages: MailMessageHead[]): SignalObservation[] {
	const groups = new Map<string, MailGroup>()
	for (const message of messages) {
		const root = (message.root || message.messageId).trim().replace(/^<|>$/g, '').toLowerCase()
		let group: Omit<MailGroup, 'messages'>
		if (isSentrySender(senderIdentity(message.senderAddress))) {
			const shortId = sentryShortId(message.subject)
			group = shortId
				? { threadKey: `sentry:${shortId}`, kind: 'sentry', sentryId: shortId }
				: { threadKey: `sentry:${hash16(root)}`, kind: 'sentry', sentryId: null }
		} else {
			group = { threadKey: `mail:${hash16(root)}`, kind: 'mail', sentryId: null }
		}
		const existing = groups.get(group.threadKey)
		if (existing) existing.messages.push(message)
		else groups.set(group.threadKey, { ...group, messages: [message] })
	}

	const observations: SignalObservation[] = []
	for (const group of groups.values()) {
		const latest = group.messages.reduce((best, message) =>
			Date.parse(message.dateReceived) > Date.parse(best.dateReceived) ? message : best,
		)
		const address = normalizeAddress(latest.senderAddress)
		const name = line(latest.senderName, SIGNAL_LIMITS.actor)
		const identity = senderIdentity(address)
		const subject = line(latest.subject, SIGNAL_LIMITS.title) || '(no subject)'
		const count = group.messages.length
		// Mail from an extra mailbox says which one (`Clientcare · [Psyon] New task: …`).
		const label = latest.mailbox ? line(latest.mailbox, MAILBOX_LABEL_MAX) : ''
		const room = SIGNAL_LIMITS.head - (label ? label.length + 3 : 0)
		const what =
			group.kind === 'sentry'
				? line(sentryHead(latest.subject), room) || line(subject, room)
				: count > 1
					? `${line(latest.subject, room - 16) || '(no subject)'} · ${count} messages`
					: line(latest.subject, room) || '(no subject)'
		const head = label ? `${label} · ${what}` : what
		observations.push({
			threadKey: group.threadKey,
			source: 'mail',
			kind: group.kind,
			reasons: [group.kind],
			ref: line(group.kind === 'sentry' ? (group.sentryId ?? 'Sentry') : mailRef(name, address), SIGNAL_LIMITS.ref),
			fullRef: line(mailFullRef(name, address), SIGNAL_LIMITS.fullRef),
			title: subject,
			head,
			actor: name || identity || null,
			url: messageUrl(latest.messageId),
			repo: null,
			number: null,
			branch: null,
			activityKey: latest.messageId,
			lastActivityAt: new Date(Date.parse(latest.dateReceived)).toISOString(),
		})
	}
	return observations
}
