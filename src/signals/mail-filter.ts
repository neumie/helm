// Pure Apple Mail → Signals filtering and threading. Input is the head-only message list the JXA
// read returns (mail-jxa.ts); output is one observation per conversation (or per Sentry issue).
// No IO; sender/subject text is third-party data and stays one bounded line.

import { createHash } from 'node:crypto'
import { oneLine } from '../agent-dock/text.js'
import { SIGNAL_LIMITS, type SignalObservation } from './contract.js'

/** One inbox message as the JXA script reports it (headers never leave the script). */
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
	/** List-Id / List-Unsubscribe / Precedence bulk|list|junk / Auto-Submitted other than no. */
	bulk: boolean
	/** Conversation root Message-ID (first References id, else In-Reply-To, else own id). */
	root: string
}

export interface MailFilterOptions {
	unreadOnly: boolean
	excludeBulk: boolean
	maxAgeDays: number
	/** Sender address globs that are always in (Sentry and friends), read or not, bulk or not. */
	includeSenders: string[]
	/** Sender address globs that are always out (unless also included). */
	excludeSenders: string[]
	/** Jakub's own addresses: his messages are never foreign activity. */
	myAddresses: string[]
}

export const MAIL_GONE_REASON = 'no longer unread in the inbox'

const DAY_MS = 24 * 60 * 60 * 1000

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
		const address = normalizeAddress(message.senderAddress)
		// Sentry is always in, even when the include list was edited without it.
		if (isSentrySender(address) || matchesGlob(address, options.includeSenders)) return true
		if (options.unreadOnly && message.read) return false
		if (options.excludeBulk && message.bulk) return false
		if (matchesGlob(address, options.excludeSenders)) return false
		return !mine.has(address)
	})
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

/** Short reference for a sender: organisation from the domain, or the person for webmail. */
export function mailRef(senderName: string, senderAddress: string): string {
	const address = normalizeAddress(senderAddress)
	const domain = domainOf(address)
	if (domain === '' || GENERIC_PROVIDERS.has(domain)) {
		const name = senderName.trim()
		return name !== '' ? name : address.split('@')[0] || 'Mail'
	}
	const labels = domain.split('.').filter(label => label !== '')
	let label = labels.length >= 2 ? labels[labels.length - 2] : labels[0]
	if (labels.length >= 3 && SUFFIX_LABELS.has(label)) label = labels[labels.length - 3]
	if (!label) return domain
	return label.length <= 3 ? label.toUpperCase() : `${label[0].toUpperCase()}${label.slice(1)}`
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
		if (isSentrySender(message.senderAddress)) {
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
		const subject = line(latest.subject, SIGNAL_LIMITS.title) || '(no subject)'
		const count = group.messages.length
		const head =
			group.kind === 'sentry'
				? line(sentryHead(latest.subject), SIGNAL_LIMITS.head) || subject
				: count > 1
					? `${line(latest.subject, SIGNAL_LIMITS.head - 16) || '(no subject)'} · ${count} messages`
					: line(latest.subject, SIGNAL_LIMITS.head) || '(no subject)'
		observations.push({
			threadKey: group.threadKey,
			source: 'mail',
			kind: group.kind,
			reasons: [group.kind],
			ref: line(group.kind === 'sentry' ? (group.sentryId ?? 'Sentry') : mailRef(name, address), SIGNAL_LIMITS.ref),
			fullRef: line(name ? `${name} <${address}>` : address, SIGNAL_LIMITS.fullRef),
			title: subject,
			head,
			actor: name || address || null,
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
