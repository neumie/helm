// Global Signals persistence: one row per external thread, an append-only change log
// and per-source poll health. Every value a poller (or an agent filing an ask) hands in is
// untrusted text: it is control/bidi stripped and bounded here, before anything is persisted
// or served.

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { boundText, oneLine } from '../agent-dock/text.js'
import {
	SIGNAL_ASK_KEY,
	SIGNAL_CLOSERS,
	SIGNAL_EVENT_TYPES,
	SIGNAL_FILTERED_RETENTION_DAYS,
	SIGNAL_FILTER_REASONS,
	SIGNAL_KINDS,
	SIGNAL_LIMITS,
	SIGNAL_OWNERS,
	SIGNAL_POLL_SOURCES,
	SIGNAL_ROUTES,
	SIGNAL_SOURCES,
	SIGNAL_SOURCE_STATUSES,
	SIGNAL_STATES,
	SIGNAL_TERMINAL_ID,
	type SignalAsk,
	type SignalAskOutcome,
	type SignalAskResult,
	type SignalCloser,
	type SignalEvent,
	type SignalEventType,
	type SignalFilteredEntry,
	type SignalFilteredObservation,
	type SignalFilteredPage,
	type SignalKind,
	type SignalObservation,
	type SignalOwner,
	type SignalPollResult,
	type SignalPollSource,
	type SignalRouteHow,
	type SignalSource,
	type SignalSourceHealth,
	type SignalSourceStatus,
	type SignalState,
	type SignalThread,
	type SignalUpdate,
	signalAskLinkUrl,
	signalSenderAddress,
} from './contract.js'

/** Newest events kept; older ones are pruned after each write. */
export const SIGNAL_EVENT_RETENTION = 5000
/** Upper bound of one `list` read. */
export const SIGNAL_LIST_CAP = 300
/** Done threads older than this leave the default list. */
export const SIGNAL_DONE_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000
/** Filtered candidates stay listed this long after they were received. */
export const SIGNAL_FILTERED_RETENTION_MS = SIGNAL_FILTERED_RETENTION_DAYS * 24 * 60 * 60 * 1000
/** Upper bound of filtered rows kept (newest received first). */
export const SIGNAL_FILTERED_CAP = 1000
/** Upper bound of one filtered `list` read. */
export const SIGNAL_FILTERED_LIST_CAP = 300

/** Consecutive complete polls a thread may be missing from before it counts as gone. */
export const SIGNAL_GONE_AFTER_MISSES = 2
/** Lines kept of Jakub's reply to an ask (the unit bound is `SIGNAL_LIMITS.reply`). */
export const SIGNAL_REPLY_LINES = 40
/** `closed_reason` of an ask the agent closed with `helm signal done`. */
export const SIGNAL_ASK_CLOSED_REASON = 'closed by the agent'
/**
 * `closed_reason` of an ask bound to an Okena terminal that closed because Jakub sent a prompt into
 * that terminal after it was asked (`answered`, Helm's ask resolver).
 */
export const SIGNAL_ASK_ANSWERED_REASON = 'answered in the terminal'
/** How far in the future a terminal prompt's time may be (clock skew) before `answered` refuses it. */
export const SIGNAL_ANSWERED_SKEW_MS = 60_000
/**
 * `closed_reason` of a mail thread closed because Jakub muted its sender (`x`). Its mail is listed
 * as filtered (`excluded`) instead; showing the sender again reopens it on the next poll.
 */
export const SIGNAL_MUTED_REASON = 'sender muted'
/**
 * Open (not done) agent asks at most. A new one beyond this is refused so asks can never push
 * GitHub and Mail threads out of the `SIGNAL_LIST_CAP` snapshot. Renewing or refreshing an open
 * ask always works; reopening a done one takes a slot like a new ask.
 */
export const SIGNAL_OPEN_ASKS_MAX = 50

export class SignalNotFoundError extends Error {
	constructor(id: number) {
		super(`Signal not found: ${id}`)
		this.name = 'SignalNotFoundError'
	}
}

export class SignalInvalidError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SignalInvalidError'
	}
}

/** A write refused because a bound is full (the route answers 429). */
export class SignalLimitError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SignalLimitError'
	}
}

/** A write refused because the thread changed since the caller read it (the route answers 409). */
export class SignalConflictError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SignalConflictError'
	}
}

export interface SignalListFilter {
	owner?: SignalOwner
	states?: SignalState[]
	source?: SignalSource
	/** Include done threads older than seven days. */
	includeAllDone?: boolean
}

export interface SignalApplyResult {
	created: number
	renewed: number
	gone: number
}

interface ThreadRow {
	id: number
	thread_key: string
	source: string
	kind: string
	reasons: string
	ref: string
	full_ref: string
	title: string
	head: string
	actor: string | null
	url: string | null
	repo: string | null
	number: number | null
	branch: string | null
	state: string
	owner: string
	snoozed_until: string | null
	activity_key: string
	last_activity_at: string
	active: number
	missed_polls: number
	closed_reason: string | null
	closed_by: string | null
	note: string | null
	note_at: string | null
	managed_by: string | null
	routed_agent: string | null
	routed_how: string | null
	routed_at: string | null
	body: string | null
	links: string
	ask_terminal: string | null
	reply: string | null
	reply_at: string | null
	sender: string | null
	sender_address: string | null
	created_at: string
	updated_at: string
}

interface EventRow {
	seq: number
	thread_id: number
	type: string
	detail: string
	at: string
}

interface SourceRow {
	source: string
	status: string
	detail: string | null
	last_poll_at: string | null
	last_ok_at: string | null
}

interface FilteredRow {
	id: number
	message_key: string
	source: string
	sender_name: string
	sender_address: string
	sender_identity: string
	subject: string
	reason: string
	mailbox: string | null
	url: string | null
	received_at: string
	first_seen_at: string
	last_seen_at: string
}

type EventDetail = Record<string, string | number | boolean | null>

/** Bidi overrides/isolates and marks: they could reorder text where it is shown. */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const HAS_BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/

/** One line of untrusted text: controls and bidi stripped, whitespace collapsed, bounded. */
function clean(value: string, max: number): string {
	return oneLine(value.replace(BIDI, ''), max)
}

function cleanOptional(value: string | null | undefined, max: number): string | null {
	if (typeof value !== 'string') return null
	const text = clean(value, max)
	return text === '' ? null : text
}

/** Only https: (GitHub) and message: (Mail) links survive; anything else is dropped, not clipped. */
function cleanUrl(value: string | null | undefined): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > SIGNAL_LIMITS.url) return null
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a link with controls or spaces is refused
	if (/[\s\u0000-\u001f\u007f-\u009f]/.test(value) || HAS_BIDI.test(value)) return null
	try {
		const protocol = new URL(value).protocol
		return protocol === 'https:' || protocol === 'message:' ? value : null
	} catch {
		return null
	}
}

/**
 * Multi-line untrusted text (an ask's body, Jakub's reply): line breaks kept, every other control
 * and bidi stripped, trailing spaces and runs of blank lines dropped, at most `maxLines` lines and
 * `max` units (clipped with an ellipsis). Null when nothing is left.
 */
function cleanMultiline(value: unknown, max: number, maxLines: number): string | null {
	if (typeof value !== 'string') return null
	const lines = value
		.replace(BIDI, '')
		.replace(/\r\n|[\r\u2028\u2029]/g, '\n')
		.replace(/\t/g, ' ')
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
		.split('\n')
		.map(line => line.trimEnd())
	const kept: string[] = []
	for (const line of lines) {
		if (line === '' && (kept.length === 0 || kept.at(-1) === '')) continue
		kept.push(line)
	}
	while (kept.at(-1) === '') kept.pop()
	if (kept.length > maxLines) {
		kept.length = maxLines
		kept[maxLines - 1] = `${kept[maxLines - 1]}…`
	}
	const text = boundText(kept.join('\n'), max).trim()
	return text === '' ? null : text
}

/** Stored links JSON → the links that still pass the one link rule; bad JSON reads as none. */
function parseLinks(raw: string | null): string[] {
	if (raw === null) return []
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed.flatMap(link => {
			const url = signalAskLinkUrl(link)
			return url === null ? [] : [url]
		})
	} catch {
		return []
	}
}

/** An ask as it would be stored, every field cleaned; title is never empty. */
interface CleanAsk {
	threadKey: string
	title: string
	body: string | null
	links: string[]
	from: string
	terminal: string | null
}

function cleanAsk(input: SignalAsk): CleanAsk {
	if (input.key !== undefined && (typeof input.key !== 'string' || !SIGNAL_ASK_KEY.test(input.key))) {
		throw new SignalInvalidError('Invalid ask key')
	}
	const title = clean(String(input.title ?? ''), SIGNAL_LIMITS.askTitle)
	if (title === '') throw new SignalInvalidError('An ask needs a title')
	const links: string[] = []
	for (const raw of Array.isArray(input.links) ? input.links : []) {
		const url = signalAskLinkUrl(raw)
		if (url !== null && !links.includes(url)) links.push(url)
		if (links.length === SIGNAL_LIMITS.askLinks) break
	}
	const terminal =
		typeof input.terminal === 'string' && SIGNAL_TERMINAL_ID.test(input.terminal) ? input.terminal.toLowerCase() : null
	return {
		threadKey: `agent:${input.key ?? randomUUID()}`,
		title,
		body: cleanMultiline(input.body, SIGNAL_LIMITS.askBody, SIGNAL_LIMITS.askBodyLines),
		links,
		from: cleanOptional(input.from, SIGNAL_LIMITS.actor) ?? 'agent',
		terminal,
	}
}

/** The row's label columns for an ask: ref/actor = who asks, full ref says where a reply goes. */
function askLabels(ask: CleanAsk): { ref: string; full_ref: string; actor: string } {
	return {
		ref: clean(ask.from, SIGNAL_LIMITS.ref),
		full_ref: clean(ask.terminal ? `${ask.from} · Okena terminal` : ask.from, SIGNAL_LIMITS.fullRef),
		actor: ask.from,
	}
}

function isoTime(value: string): string | null {
	const ms = Date.parse(value)
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function parseReasons(raw: string, kind: SignalKind): SignalKind[] {
	try {
		const parsed: unknown = JSON.parse(raw)
		if (Array.isArray(parsed)) {
			const reasons = parsed.filter((value): value is SignalKind => oneOf(SIGNAL_KINDS, value))
			if (reasons.length > 0) return [...new Set(reasons)]
		}
	} catch {
		// fall through to the primary kind
	}
	return [kind]
}

function parseDetail(raw: string): EventDetail {
	try {
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
		const detail: EventDetail = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				detail[key] = value
			}
		}
		return detail
	} catch {
		return {}
	}
}

/** Sanitized observation, or null when it cannot be stored (wrong source, bad kind/time/key). */
function sanitizeObservation(observation: SignalObservation, source: SignalPollSource): SignalObservation | null {
	if (observation.source !== source || !oneOf(SIGNAL_KINDS, observation.kind)) return null
	const threadKey = clean(String(observation.threadKey ?? ''), SIGNAL_LIMITS.threadKey)
	const lastActivityAt = isoTime(String(observation.lastActivityAt ?? ''))
	if (threadKey === '' || lastActivityAt === null) return null
	const reasons = Array.isArray(observation.reasons)
		? [...new Set(observation.reasons.filter(reason => oneOf(SIGNAL_KINDS, reason)))]
		: []
	if (!reasons.includes(observation.kind)) reasons.unshift(observation.kind)
	const number =
		typeof observation.number === 'number' && Number.isSafeInteger(observation.number) && observation.number > 0
			? observation.number
			: null
	return {
		threadKey,
		source,
		kind: observation.kind,
		reasons,
		ref: clean(String(observation.ref ?? ''), SIGNAL_LIMITS.ref),
		fullRef: clean(String(observation.fullRef ?? ''), SIGNAL_LIMITS.fullRef),
		title: clean(String(observation.title ?? ''), SIGNAL_LIMITS.title),
		head: clean(String(observation.head ?? ''), SIGNAL_LIMITS.head),
		actor: cleanOptional(observation.actor, SIGNAL_LIMITS.actor),
		url: cleanUrl(observation.url),
		repo: cleanOptional(observation.repo, SIGNAL_LIMITS.repo),
		number,
		branch: cleanOptional(observation.branch, SIGNAL_LIMITS.branch),
		activityKey: clean(String(observation.activityKey ?? ''), SIGNAL_LIMITS.activityKey),
		lastActivityAt,
		sender: source === 'mail' ? signalSenderAddress(observation.sender) || null : null,
		senderAddress: source === 'mail' ? signalSenderAddress(observation.senderAddress) || null : null,
	}
}

/** The single row → wire mapping. */
export function toSignalThread(row: ThreadRow): SignalThread {
	const kind: SignalKind = oneOf(SIGNAL_KINDS, row.kind) ? row.kind : 'mail'
	return {
		id: row.id,
		threadKey: row.thread_key,
		source: oneOf(SIGNAL_SOURCES, row.source) ? row.source : 'github',
		kind,
		reasons: parseReasons(row.reasons, kind),
		ref: row.ref,
		fullRef: row.full_ref,
		title: row.title,
		head: row.head,
		actor: row.actor,
		url: row.url,
		repo: row.repo,
		number: row.number,
		branch: row.branch,
		state: oneOf(SIGNAL_STATES, row.state) ? row.state : 'new',
		owner: oneOf(SIGNAL_OWNERS, row.owner) ? row.owner : 'jakub',
		snoozedUntil: row.snoozed_until,
		lastActivityAt: row.last_activity_at,
		active: row.active === 1,
		closedReason: row.closed_reason,
		closedBy: oneOf(SIGNAL_CLOSERS, row.closed_by) ? row.closed_by : null,
		note: row.note,
		noteAt: row.note_at,
		managedBy: row.managed_by,
		routedAgent: row.routed_agent,
		routedHow: oneOf(SIGNAL_ROUTES, row.routed_how) ? row.routed_how : null,
		routedAt: row.routed_at,
		body: row.body ?? null,
		links: parseLinks(row.links ?? null),
		askTerminal: row.ask_terminal ?? null,
		reply: row.reply ?? null,
		replyAt: row.reply_at ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

/** The single filtered row → wire mapping. */
export function toSignalFilteredEntry(row: FilteredRow): SignalFilteredEntry {
	return {
		id: row.id,
		source: 'mail',
		senderName: row.sender_name,
		senderAddress: row.sender_address,
		senderIdentity: row.sender_identity,
		subject: row.subject,
		reason: oneOf(SIGNAL_FILTER_REASONS, row.reason) ? row.reason : 'excluded',
		mailbox: row.mailbox,
		url: row.url,
		receivedAt: row.received_at,
		lastSeenAt: row.last_seen_at,
	}
}

/** Sanitized filtered observation, or null when it cannot be stored. */
function sanitizeFiltered(observation: SignalFilteredObservation): SignalFilteredObservation | null {
	if (!oneOf(SIGNAL_FILTER_REASONS, observation.reason)) return null
	const messageKey = clean(String(observation.messageKey ?? ''), SIGNAL_LIMITS.activityKey).toLowerCase()
	const receivedAt = isoTime(String(observation.receivedAt ?? ''))
	if (messageKey === '' || receivedAt === null) return null
	// Addresses are never clipped: `i` puts them on the sender lists as they are.
	const senderAddress = signalSenderAddress(observation.senderAddress)
	return {
		messageKey,
		senderName: clean(String(observation.senderName ?? ''), SIGNAL_LIMITS.actor),
		senderAddress,
		senderIdentity: signalSenderAddress(observation.senderIdentity) || senderAddress,
		subject: clean(String(observation.subject ?? ''), SIGNAL_LIMITS.title),
		reason: observation.reason,
		mailbox: cleanOptional(observation.mailbox, SIGNAL_LIMITS.ref),
		// Only Mail links: a filtered entry is always mail.
		url: (() => {
			const url = cleanUrl(observation.url)
			return url?.startsWith('message:') ? url : null
		})(),
		receivedAt,
	}
}

/** Columns a poll refresh may write that people never see change (no `updated_at` bump). */
const BOOKKEEPING_COLUMNS = new Set(['missed_polls', 'activity_key', 'sender', 'sender_address'])

const HEAD_COLUMNS = [
	['kind', 'kind'],
	['reasons', 'reasons'],
	['ref', 'ref'],
	['full_ref', 'fullRef'],
	['title', 'title'],
	['head', 'head'],
	['actor', 'actor'],
	['url', 'url'],
	['repo', 'repo'],
	['number', 'number'],
	['branch', 'branch'],
] as const

function headValues(observation: SignalObservation): Record<(typeof HEAD_COLUMNS)[number][0], string | number | null> {
	return {
		kind: observation.kind,
		reasons: JSON.stringify(observation.reasons),
		ref: observation.ref,
		full_ref: observation.fullRef,
		title: observation.title,
		head: observation.head,
		actor: observation.actor,
		url: observation.url,
		repo: observation.repo,
		number: observation.number,
		branch: observation.branch,
	}
}

export class SignalStore {
	/** Signals are global: one inbox for Jakub across every Helm profile (never tenant scoped). */
	constructor(private readonly db: Database.Database) {}

	transaction<T>(fn: () => T): T {
		return this.db.transaction(fn)()
	}

	/** Upsert one poll's observations, renew threads with newer foreign activity, close gone ones. */
	applyPoll(result: SignalPollResult, now: Date): SignalApplyResult {
		// Agent asks are pushed, never polled: a poll must never upsert or close one.
		if (!oneOf(SIGNAL_POLL_SOURCES, result.source)) throw new SignalInvalidError('Unknown signal source')
		const source = result.source
		const at = now.toISOString()
		const goneReason = clean(String(result.goneReason ?? ''), SIGNAL_LIMITS.detail) || 'no longer reported'
		const observations = new Map<string, SignalObservation>()
		for (const raw of result.observations) {
			const observation = sanitizeObservation(raw, source)
			if (!observation) continue
			const previous = observations.get(observation.threadKey)
			if (!previous || Date.parse(observation.lastActivityAt) > Date.parse(previous.lastActivityAt)) {
				observations.set(observation.threadKey, observation)
			}
		}
		return this.transaction(() => {
			const counts: SignalApplyResult = { created: 0, renewed: 0, gone: 0 }
			const existing = new Map(
				(this.db.prepare('SELECT * FROM signal_threads WHERE source = ?').all(source) as ThreadRow[]).map(row => [
					row.thread_key,
					row,
				]),
			)
			for (const observation of observations.values()) {
				const row = existing.get(observation.threadKey)
				if (!row) {
					this.insertThread(observation, at)
					counts.created += 1
				} else if (this.refreshThread(row, observation, at)) {
					counts.renewed += 1
				}
			}
			if (result.complete === true) {
				for (const row of existing.values()) {
					if (observations.has(row.thread_key)) continue
					if (row.active === 1) {
						if (this.missThread(row, goneReason, at)) counts.gone += 1
					} else if (this.closeReturnedGone(row, goneReason, at)) {
						counts.gone += 1
					}
				}
			}
			if (source === 'mail' && result.filtered) this.applyFiltered(result.filtered, now)
			this.wakeSnoozedAt(at)
			this.pruneEvents()
			return counts
		})
	}

	/** Filtered candidates still in the retention window. */
	filteredCount(now: Date): number {
		const row = this.db
			.prepare('SELECT COUNT(*) AS count FROM signal_filtered WHERE received_at >= ?')
			.get(this.filteredCutoff(now)) as { count: number } | undefined
		return row?.count ?? 0
	}

	/** Filtered candidates in the retention window, newest received first. */
	listFiltered(now: Date, limit = SIGNAL_FILTERED_LIST_CAP): SignalFilteredPage {
		const bounded = Math.max(1, Math.min(Math.trunc(limit) || 1, SIGNAL_FILTERED_LIST_CAP))
		const rows = this.db
			.prepare('SELECT * FROM signal_filtered WHERE received_at >= ? ORDER BY received_at DESC, id DESC LIMIT ?')
			.all(this.filteredCutoff(now), bounded) as FilteredRow[]
		return {
			entries: rows.map(toSignalFilteredEntry),
			total: this.filteredCount(now),
			retentionDays: SIGNAL_FILTERED_RETENTION_DAYS,
		}
	}

	getFiltered(id: number, now: Date): SignalFilteredEntry | null {
		if (!Number.isSafeInteger(id) || id <= 0) return null
		const row = this.db
			.prepare('SELECT * FROM signal_filtered WHERE id = ? AND received_at >= ?')
			.get(id, this.filteredCutoff(now)) as FilteredRow | undefined
		return row ? toSignalFilteredEntry(row) : null
	}

	/** Drops every filtered row of a sender (its mail shows from the next poll on); returns how many. */
	forgetFilteredSender(identity: string): number {
		const address = identity.trim().toLowerCase()
		if (address === '') return 0
		return this.db
			.prepare('DELETE FROM signal_filtered WHERE sender_identity = ? OR sender_address = ?')
			.run(address, address).changes
	}

	/**
	 * A mail thread's latest sender as the sender lists match it (`identity`, relay-decoded) and as
	 * it arrived (`raw`, the relay address; equal to `identity` for ordinary mail), plus who owns the
	 * thread. Null when it is not mail or no Mail poll recorded the sender yet.
	 */
	threadSender(id: number): { identity: string; raw: string; owner: SignalOwner } | null {
		const row = this.row(id)
		if (row?.source !== 'mail' || !row.sender) return null
		return { identity: row.sender, raw: row.sender_address || row.sender, owner: row.owner as SignalOwner }
	}

	/**
	 * Jakub muted `identity` (`x`): his open mail threads whose latest message is from it close at
	 * once (done, `sender muted`, gone from the poll's view so showing the sender again reopens them)
	 * and their latest message is listed as filtered (`excluded`) until the next poll lists the
	 * thread's messages itself. Managed threads stay with their agent. `raw` is the address the mail
	 * arrived from (the relay address for Hide My Email), listed as the filtered entry's address.
	 * Returns the closed ids.
	 */
	muteSender(identity: string, now: Date, raw?: string): number[] {
		const sender = signalSenderAddress(identity)
		if (sender === '') return []
		const address = signalSenderAddress(raw) || sender
		const at = now.toISOString()
		const cutoff = this.filteredCutoff(now)
		return this.transaction(() => {
			const rows = this.db
				.prepare(
					`SELECT * FROM signal_threads
					 WHERE source = 'mail' AND kind = 'mail' AND sender = ? AND owner = 'jakub' AND state <> 'done'`,
				)
				.all(sender) as ThreadRow[]
			const close = this.db.prepare(
				`UPDATE signal_threads SET state = 'done', snoozed_until = NULL, closed_reason = ?, closed_by = 'jakub',
				   active = 0, missed_polls = 0, updated_at = ?
				 WHERE id = ?`,
			)
			const listed = this.db.prepare(
				`INSERT INTO signal_filtered (
				   message_key, source, sender_name, sender_address, sender_identity, subject, reason, mailbox, url,
				   received_at, first_seen_at, last_seen_at
				 ) VALUES (?, 'mail', ?, ?, ?, ?, 'excluded', NULL, ?, ?, ?, ?)
				 ON CONFLICT (message_key) DO UPDATE SET reason = 'excluded', last_seen_at = excluded.last_seen_at`,
			)
			for (const row of rows) {
				close.run(SIGNAL_MUTED_REASON, at, row.id)
				this.insertEvent(
					row.id,
					'state',
					{ owner: row.owner, from: row.state, to: 'done', reason: SIGNAL_MUTED_REASON },
					at,
				)
				const messageKey = row.activity_key.trim().replace(/^<|>$/g, '').toLowerCase()
				if (messageKey === '' || row.last_activity_at < cutoff) continue
				listed.run(
					messageKey,
					row.actor ?? '',
					row.sender_address || address,
					sender,
					row.title,
					row.url?.startsWith('message:') ? row.url : null,
					row.last_activity_at,
					at,
					at,
				)
			}
			if (rows.length > 0) this.pruneEvents()
			return rows.map(row => row.id)
		})
	}

	/** Snoozed threads whose time has come are new again. */
	wakeSnoozed(now: Date): number {
		return this.transaction(() => {
			const woken = this.wakeSnoozedAt(now.toISOString())
			if (woken > 0) this.pruneEvents()
			return woken
		})
	}

	list(filter: SignalListFilter, now: Date): SignalThread[] {
		const where: string[] = []
		const params: Array<string | number> = []
		if (filter.owner) {
			where.push('owner = ?')
			params.push(filter.owner)
		}
		if (filter.source) {
			where.push('source = ?')
			params.push(filter.source)
		}
		const states = filter.states?.filter(state => oneOf(SIGNAL_STATES, state)) ?? []
		if (states.length > 0) {
			where.push(`state IN (${states.map(() => '?').join(', ')})`)
			params.push(...states)
		}
		if (!filter.includeAllDone && !states.includes('done')) {
			where.push("(state <> 'done' OR updated_at >= ?)")
			params.push(new Date(now.getTime() - SIGNAL_DONE_VISIBLE_MS).toISOString())
		}
		params.push(SIGNAL_LIST_CAP)
		const rows = this.db
			.prepare(
				`SELECT * FROM signal_threads ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_activity_at DESC, id DESC LIMIT ?`,
			)
			.all(...params) as ThreadRow[]
		return rows.map(toSignalThread)
	}

	get(id: number): SignalThread | null {
		const row = this.row(id)
		return row ? toSignalThread(row) : null
	}

	getByThreadKey(threadKey: string): SignalThread | null {
		const row = this.db.prepare('SELECT * FROM signal_threads WHERE thread_key = ?').get(threadKey) as
			| ThreadRow
			| undefined
		return row ? toSignalThread(row) : null
	}

	/**
	 * Change state/owner/agent. `by` is who asks (the route knows: Helm or `helm signal`); a thread
	 * it moves to done remembers it as `closed_by`.
	 */
	update(id: number, patch: SignalUpdate, now: Date, by: SignalCloser = 'agent'): SignalThread {
		const at = now.toISOString()
		return this.transaction(() => {
			const row = this.requireRow(id)
			const next = {
				state: row.state,
				owner: row.owner,
				snoozed_until: row.snoozed_until,
				closed_reason: row.closed_reason,
				closed_by: row.closed_by,
				managed_by: row.managed_by,
			}
			if (patch.state !== undefined) {
				if (!oneOf(SIGNAL_STATES, patch.state)) throw new SignalInvalidError('Unknown state')
				if (patch.state === 'snoozed') {
					const until = patch.snoozedUntil === undefined ? null : isoTime(patch.snoozedUntil)
					if (until === null || Date.parse(until) <= now.getTime()) {
						throw new SignalInvalidError('Snoozing needs a time in the future')
					}
					next.snoozed_until = until
				} else {
					next.snoozed_until = null
				}
				next.state = patch.state
				next.closed_reason = null
				// Already done stays as it was closed; closing records who; leaving done forgets it.
				if (patch.state !== row.state) next.closed_by = patch.state === 'done' ? by : null
			}
			// Jakub putting a gone thread back into new/seen himself wins over the auto-close of a
			// complete poll: clear its miss count so `closeReturnedGone` leaves it alone.
			const reopenedByHand =
				patch.state !== undefined && row.active !== 1 && (next.state === 'new' || next.state === 'seen')
			if (patch.owner !== undefined) {
				if (!oneOf(SIGNAL_OWNERS, patch.owner)) throw new SignalInvalidError('Unknown owner')
				next.owner = patch.owner
			}
			if (patch.managedBy !== undefined) {
				next.managed_by = patch.managedBy === null ? null : cleanOptional(patch.managedBy, SIGNAL_LIMITS.agent)
				if (patch.managedBy !== null && next.managed_by === null) throw new SignalInvalidError('Agent name is empty')
			}
			const changed =
				next.state !== row.state ||
				next.owner !== row.owner ||
				next.snoozed_until !== row.snoozed_until ||
				next.closed_reason !== row.closed_reason ||
				next.closed_by !== row.closed_by ||
				next.managed_by !== row.managed_by
			if (!changed) return toSignalThread(row)
			this.db
				.prepare(
					`UPDATE signal_threads SET state = ?, owner = ?, snoozed_until = ?, closed_reason = ?, closed_by = ?,
					   managed_by = ?, missed_polls = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(
					next.state,
					next.owner,
					next.snoozed_until,
					next.closed_reason,
					next.closed_by,
					next.managed_by,
					reopenedByHand ? 0 : row.missed_polls,
					at,
					id,
				)
			if (next.owner !== row.owner) {
				this.insertEvent(id, 'owner', { owner: next.owner, from: row.owner, to: next.owner }, at)
			}
			if (next.state !== row.state) {
				this.insertEvent(id, 'state', { owner: next.owner, from: row.state, to: next.state }, at)
			}
			this.pruneEvents()
			return toSignalThread(this.requireRow(id))
		})
	}

	setNote(id: number, note: string, now: Date): SignalThread {
		const at = now.toISOString()
		const text = clean(String(note ?? ''), SIGNAL_LIMITS.note)
		if (text === '') throw new SignalInvalidError('Note is empty')
		return this.transaction(() => {
			const row = this.requireRow(id)
			this.db
				.prepare('UPDATE signal_threads SET note = ?, note_at = ?, updated_at = ? WHERE id = ?')
				.run(text, at, at, id)
			this.insertEvent(id, 'note', { owner: row.owner, note: text }, at)
			this.pruneEvents()
			return toSignalThread(this.requireRow(id))
		})
	}

	setRouted(id: number, routed: { agent: string; how: SignalRouteHow }, now: Date): SignalThread {
		const at = now.toISOString()
		const agent = clean(String(routed.agent ?? ''), SIGNAL_LIMITS.agent)
		if (agent === '') throw new SignalInvalidError('Agent name is empty')
		if (!oneOf(SIGNAL_ROUTES, routed.how)) throw new SignalInvalidError('Unknown route')
		return this.transaction(() => {
			const row = this.requireRow(id)
			const state = row.state === 'new' ? 'seen' : row.state
			this.db
				.prepare(
					`UPDATE signal_threads SET routed_agent = ?, routed_how = ?, routed_at = ?, state = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(agent, routed.how, at, state, at, id)
			this.insertEvent(id, 'routed', { owner: row.owner, agent, how: routed.how, state }, at)
			this.pruneEvents()
			return toSignalThread(this.requireRow(id))
		})
	}

	/** Jakub opened the source: new → seen, anything else unchanged. */
	markSeen(id: number, now: Date): SignalThread {
		const at = now.toISOString()
		return this.transaction(() => {
			const row = this.requireRow(id)
			if (row.state !== 'new') return toSignalThread(row)
			this.db.prepare("UPDATE signal_threads SET state = 'seen', updated_at = ? WHERE id = ?").run(at, id)
			this.insertEvent(id, 'state', { owner: row.owner, from: 'new', to: 'seen' }, at)
			this.pruneEvents()
			return toSignalThread(this.requireRow(id))
		})
	}

	events(afterSeq: number, limit = 200): SignalEvent[] {
		const after = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0
		const bounded = Math.max(1, Math.min(Math.trunc(limit) || 1, 1000))
		const rows = this.db
			.prepare('SELECT seq, thread_id, type, detail, at FROM signal_events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
			.all(after, bounded) as EventRow[]
		return rows.flatMap(row =>
			oneOf(SIGNAL_EVENT_TYPES, row.type)
				? [{ seq: row.seq, threadId: row.thread_id, type: row.type, detail: parseDetail(row.detail), at: row.at }]
				: [],
		)
	}

	/** Newest event seq (the cursor for `events`). */
	latestSeq(): number {
		const row = this.db.prepare('SELECT MAX(seq) AS seq FROM signal_events').get() as { seq: number | null } | undefined
		return row?.seq ?? 0
	}

	setSourceHealth(
		source: SignalPollSource,
		status: SignalSourceStatus,
		detail: string | null,
		now: Date,
		ok: boolean,
	): void {
		// Only pollers report health; agent asks have no health row.
		if (!oneOf(SIGNAL_POLL_SOURCES, source)) throw new SignalInvalidError('Unknown signal source')
		if (!oneOf(SIGNAL_SOURCE_STATUSES, status)) throw new SignalInvalidError('Unknown source status')
		const at = now.toISOString()
		const text = cleanOptional(detail, SIGNAL_LIMITS.detail)
		// A disabled source is not a poll: keep the last poll/ok times for context.
		const polled = status === 'disabled' ? null : at
		this.db
			.prepare(
				`INSERT INTO signal_sources (source, status, detail, last_poll_at, last_ok_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT (source) DO UPDATE SET
				   status = excluded.status,
				   detail = excluded.detail,
				   last_poll_at = COALESCE(excluded.last_poll_at, signal_sources.last_poll_at),
				   last_ok_at = COALESCE(excluded.last_ok_at, signal_sources.last_ok_at)`,
			)
			.run(source, status, text, polled, ok ? at : null)
	}

	/** Health of every polled source; a source that never reported is disabled. */
	sources(): SignalSourceHealth[] {
		const rows = new Map(
			(
				this.db
					.prepare('SELECT source, status, detail, last_poll_at, last_ok_at FROM signal_sources')
					.all() as SourceRow[]
			).map(row => [row.source, row]),
		)
		return SIGNAL_POLL_SOURCES.map(source => {
			const row = rows.get(source)
			return {
				source,
				status: row && oneOf(SIGNAL_SOURCE_STATUSES, row.status) ? row.status : 'disabled',
				detail: row?.detail ?? null,
				lastPollAt: row?.last_poll_at ?? null,
				lastOkAt: row?.last_ok_at ?? null,
			}
		})
	}

	// ---------- agent asks ----------

	/**
	 * File an ask (`helm signal add`). With a key it upserts `agent:<key>`: a changed title or
	 * body or of the asking terminal makes it new again (an earlier reply no longer answers it), a change of links or label
	 * refreshes it in place, identical input writes nothing. Without a key it always creates.
	 */
	upsertAsk(input: SignalAsk, now: Date): SignalAskResult {
		const at = now.toISOString()
		const ask = cleanAsk(input)
		const labels = askLabels(ask)
		const links = JSON.stringify(ask.links)
		return this.transaction(() => {
			const row = this.db.prepare('SELECT * FROM signal_threads WHERE thread_key = ?').get(ask.threadKey) as
				| ThreadRow
				| undefined
			let outcome: SignalAskOutcome
			let id: number
			// A new delivery target is a new ask too: Jakub's answer must never move to another agent unseen.
			const renews =
				row !== undefined &&
				(row.title !== ask.title || (row.body ?? null) !== ask.body || (row.ask_terminal ?? null) !== ask.terminal)
			// A new ask, or a done one opened again, takes a slot; renewing an open ask does not.
			if (!row || (renews && row.state === 'done')) {
				const open = this.db
					.prepare("SELECT COUNT(*) AS n FROM signal_threads WHERE source = 'agent' AND state <> 'done'")
					.get() as { n: number }
				if (open.n >= SIGNAL_OPEN_ASKS_MAX)
					throw new SignalLimitError(
						`Too many open agent asks (${SIGNAL_OPEN_ASKS_MAX}). Close some with helm signal done.`,
					)
			}
			if (!row) {
				const info = this.db
					.prepare(
						`INSERT INTO signal_threads (
						   thread_key, source, kind, reasons, ref, full_ref, title, head, actor, url, repo, number, branch,
						   state, owner, activity_key, last_activity_at, active, missed_polls,
						   body, links, ask_terminal, created_at, updated_at
						 ) VALUES (?, 'agent', 'ask', '["ask"]', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
						   'new', 'jakub', ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
					)
					.run(
						ask.threadKey,
						labels.ref,
						labels.full_ref,
						ask.title,
						ask.title,
						labels.actor,
						`ask:${at}`,
						at,
						ask.body,
						links,
						ask.terminal,
						at,
						at,
					)
				id = Number(info.lastInsertRowid)
				this.insertEvent(id, 'created', { owner: 'jakub', kind: 'ask', head: ask.title }, at)
				outcome = 'created'
			} else if (renews) {
				id = row.id
				this.db
					.prepare(
						`UPDATE signal_threads SET title = ?, head = ?, body = ?, links = ?, ref = ?, full_ref = ?, actor = ?,
						   ask_terminal = ?, activity_key = ?, last_activity_at = ?, state = 'new', snoozed_until = NULL,
						   closed_reason = NULL, closed_by = NULL, reply = NULL, reply_at = NULL, updated_at = ?
						 WHERE id = ?`,
					)
					.run(
						ask.title,
						ask.title,
						ask.body,
						links,
						labels.ref,
						labels.full_ref,
						labels.actor,
						ask.terminal,
						`ask:${at}`,
						at,
						at,
						id,
					)
				this.insertEvent(id, 'activity', { owner: row.owner, kind: 'ask', head: ask.title, state: 'new' }, at)
				outcome = 'renewed'
			} else if (
				row.links !== links ||
				row.ref !== labels.ref ||
				row.full_ref !== labels.full_ref ||
				row.actor !== labels.actor
			) {
				id = row.id
				// No state change and no event; like a poll refresh, a done ask keeps its done time.
				this.db
					.prepare(
						`UPDATE signal_threads SET links = ?, ref = ?, full_ref = ?, actor = ?, updated_at = ?
						 WHERE id = ?`,
					)
					.run(links, labels.ref, labels.full_ref, labels.actor, row.state === 'done' ? row.updated_at : at, id)
				outcome = 'updated'
			} else {
				return { outcome: 'unchanged', thread: toSignalThread(row) }
			}
			this.pruneEvents()
			return { outcome, thread: toSignalThread(this.requireRow(id)) }
		})
	}

	/** The ask filed with `--key`, or null. */
	getAskByKey(key: string): SignalThread | null {
		if (typeof key !== 'string' || !SIGNAL_ASK_KEY.test(key)) return null
		return this.getByThreadKey(`agent:${key}`)
	}

	/**
	 * Close a thread (`helm signal done`), optionally with an outcome line. An ask the agent closes
	 * says so in its closed reason. `by` is who asks (`closed_by`). Already done without a note
	 * changes nothing.
	 */
	done(id: number, note: string | undefined, now: Date, by: SignalCloser = 'agent'): SignalThread {
		const at = now.toISOString()
		const text = note === undefined ? null : clean(String(note), SIGNAL_LIMITS.note)
		if (text === '') throw new SignalInvalidError('Note is empty')
		return this.transaction(() => {
			const row = this.requireRow(id)
			const closing = row.state !== 'done'
			if (!closing && text === null) return toSignalThread(row)
			if (closing) {
				this.db
					.prepare(
						`UPDATE signal_threads SET state = 'done', snoozed_until = NULL, closed_reason = ?, closed_by = ?,
						   updated_at = ?
						 WHERE id = ?`,
					)
					.run(row.source === 'agent' && by === 'agent' ? SIGNAL_ASK_CLOSED_REASON : null, by, at, id)
				this.insertEvent(id, 'state', { owner: row.owner, from: row.state, to: 'done' }, at)
			}
			if (text !== null) {
				this.db
					.prepare('UPDATE signal_threads SET note = ?, note_at = ?, updated_at = ? WHERE id = ?')
					.run(text, at, at, id)
				this.insertEvent(id, 'note', { owner: row.owner, note: text }, at)
			}
			this.pruneEvents()
			return toSignalThread(this.requireRow(id))
		})
	}

	/**
	 * Jakub's answer to an ask, kept on the thread whether or not it reaches the agent. new → seen.
	 * The event says that he answered, never what (`helm signal show` reads the text).
	 */
	reply(id: number, text: string, now: Date): SignalThread {
		const at = now.toISOString()
		const answer = cleanMultiline(text, SIGNAL_LIMITS.reply, SIGNAL_REPLY_LINES)
		return this.transaction(() => {
			const row = this.requireRow(id)
			if (row.source !== 'agent') throw new SignalInvalidError('Only agent asks take a reply')
			if (answer === null) throw new SignalInvalidError('The reply is empty')
			const state = row.state === 'new' ? 'seen' : row.state
			this.db
				.prepare('UPDATE signal_threads SET reply = ?, reply_at = ?, state = ?, updated_at = ? WHERE id = ?')
				.run(answer, at, state, at, id)
			this.insertEvent(id, 'reply', { owner: row.owner, state }, at)
			this.pruneEvents()
			return toSignalThread(this.requireRow(id))
		})
	}

	/**
	 * Jakub sent a prompt into the ask's Okena terminal after it was asked: the ask closes as answered
	 * there (`SIGNAL_ASK_ANSWERED_REASON`, closed by Jakub). Only for an open ask bound to a terminal.
	 * `activityAt` must still be the ask's `lastActivityAt` (else it was renewed meanwhile: conflict)
	 * and `promptAt` later than it and not in the future. An ask already done changes nothing.
	 */
	answered(id: number, input: { activityAt: string; promptAt: string }, now: Date): SignalThread {
		const at = now.toISOString()
		const activity = Date.parse(input.activityAt)
		const prompt = Date.parse(input.promptAt)
		if (!Number.isFinite(activity) || !Number.isFinite(prompt)) throw new SignalInvalidError('Invalid time')
		return this.transaction(() => {
			const row = this.requireRow(id)
			if (row.source !== 'agent' || row.ask_terminal === null)
				throw new SignalInvalidError('Only an ask bound to a terminal closes from that terminal')
			if (row.state === 'done') return toSignalThread(row)
			if (Date.parse(row.last_activity_at) !== activity)
				throw new SignalConflictError('The ask changed since that prompt was matched')
			if (prompt <= activity) throw new SignalInvalidError('The prompt is older than the ask')
			if (prompt > now.getTime() + SIGNAL_ANSWERED_SKEW_MS) throw new SignalInvalidError('The prompt is in the future')
			this.db
				.prepare(
					`UPDATE signal_threads SET state = 'done', snoozed_until = NULL, closed_reason = ?, closed_by = 'jakub',
					   updated_at = ?
					 WHERE id = ?`,
				)
				.run(SIGNAL_ASK_ANSWERED_REASON, at, id)
			this.insertEvent(
				id,
				'state',
				{ owner: row.owner, from: row.state, to: 'done', reason: SIGNAL_ASK_ANSWERED_REASON },
				at,
			)
			this.pruneEvents()
			return toSignalThread(this.requireRow(id))
		})
	}

	// ---------- internals (callers hold a transaction) ----------

	private filteredCutoff(now: Date): string {
		return new Date(now.getTime() - SIGNAL_FILTERED_RETENTION_MS).toISOString()
	}

	/** Log this poll's filtered candidates; forget the ones it kept; prune by age and count. */
	private applyFiltered(filtered: NonNullable<SignalPollResult['filtered']>, now: Date): void {
		const at = now.toISOString()
		const cutoff = this.filteredCutoff(now)
		const forget = this.db.prepare('DELETE FROM signal_filtered WHERE message_key = ?')
		for (const key of Array.isArray(filtered.keptKeys) ? filtered.keptKeys : []) {
			if (typeof key === 'string' && key !== '') forget.run(clean(key, SIGNAL_LIMITS.activityKey).toLowerCase())
		}
		const upsert = this.db.prepare(
			`INSERT INTO signal_filtered (
			   message_key, source, sender_name, sender_address, sender_identity, subject, reason, mailbox, url,
			   received_at, first_seen_at, last_seen_at
			 ) VALUES (?, 'mail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (message_key) DO UPDATE SET
			   sender_name = excluded.sender_name,
			   sender_address = excluded.sender_address,
			   sender_identity = excluded.sender_identity,
			   subject = excluded.subject,
			   reason = excluded.reason,
			   mailbox = excluded.mailbox,
			   url = excluded.url,
			   received_at = excluded.received_at,
			   last_seen_at = excluded.last_seen_at`,
		)
		for (const raw of Array.isArray(filtered.entries) ? filtered.entries : []) {
			const entry = sanitizeFiltered(raw)
			if (!entry || entry.receivedAt < cutoff) continue
			upsert.run(
				entry.messageKey,
				entry.senderName,
				entry.senderAddress,
				entry.senderIdentity,
				entry.subject,
				entry.reason,
				entry.mailbox,
				entry.url,
				entry.receivedAt,
				at,
				at,
			)
		}
		this.db.prepare('DELETE FROM signal_filtered WHERE received_at < ?').run(cutoff)
		this.db
			.prepare(
				`DELETE FROM signal_filtered WHERE id NOT IN (
				   SELECT id FROM signal_filtered ORDER BY received_at DESC, id DESC LIMIT ?
				 )`,
			)
			.run(SIGNAL_FILTERED_CAP)
	}

	private row(id: number): ThreadRow | null {
		if (!Number.isSafeInteger(id) || id <= 0) return null
		const row = this.db.prepare('SELECT * FROM signal_threads WHERE id = ?').get(id) as ThreadRow | undefined
		return row ?? null
	}

	private requireRow(id: number): ThreadRow {
		const row = this.row(id)
		if (!row) throw new SignalNotFoundError(id)
		return row
	}

	private insertThread(observation: SignalObservation, at: string): void {
		const heads = headValues(observation)
		const info = this.db
			.prepare(
				`INSERT INTO signal_threads (
				   thread_key, source, kind, reasons, ref, full_ref, title, head, actor, url, repo, number, branch,
				   state, owner, activity_key, last_activity_at, active, missed_polls, sender, sender_address,
				   created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'jakub', ?, ?, 1, 0, ?, ?, ?, ?)`,
			)
			.run(
				observation.threadKey,
				observation.source,
				heads.kind,
				heads.reasons,
				heads.ref,
				heads.full_ref,
				heads.title,
				heads.head,
				heads.actor,
				heads.url,
				heads.repo,
				heads.number,
				heads.branch,
				observation.activityKey,
				observation.lastActivityAt,
				observation.sender ?? null,
				observation.senderAddress ?? null,
				at,
				at,
			)
		this.insertEvent(
			Number(info.lastInsertRowid),
			'created',
			{ owner: 'jakub', kind: observation.kind, head: observation.head },
			at,
		)
	}

	/** Refresh heads of a reported thread; true when it carries newer foreign activity. */
	private refreshThread(row: ThreadRow, observation: SignalObservation, at: string): boolean {
		const heads = headValues(observation)
		const update: Record<string, string | number | null> = {}
		for (const [column] of HEAD_COLUMNS) {
			if (row[column] !== heads[column]) update[column] = heads[column]
		}
		if (row.active !== 1) update.active = 1
		if (row.missed_polls !== 0) update.missed_polls = 0
		const sender = observation.sender ?? null
		if ((row.sender ?? null) !== sender) update.sender = sender
		const senderAddress = observation.senderAddress ?? null
		if ((row.sender_address ?? null) !== senderAddress) update.sender_address = senderAddress
		let state = row.state
		const newer =
			observation.activityKey !== row.activity_key &&
			Date.parse(observation.lastActivityAt) > Date.parse(row.last_activity_at)
		if (newer) {
			update.activity_key = observation.activityKey
			update.last_activity_at = observation.lastActivityAt
			if (row.state === 'seen' || row.state === 'snoozed' || row.state === 'done') {
				state = 'new'
				update.state = 'new'
				update.snoozed_until = null
				update.closed_reason = null
				if (row.closed_by !== null) update.closed_by = null
			}
		} else {
			if (observation.activityKey !== row.activity_key) update.activity_key = observation.activityKey
			// Back after the store closed it as gone, with nothing new: reopen as already seen.
			if (row.active !== 1 && row.state === 'done' && row.closed_reason !== null) {
				state = 'seen'
				update.state = 'seen'
				update.closed_reason = null
				if (row.closed_by !== null) update.closed_by = null
			}
		}
		const columns = Object.keys(update)
		if (columns.length === 0) return false
		// Bookkeeping alone (missed_polls, the key, the sender) does not count as a change people see.
		// A done thread keeps its done time (`updated_at`) through head refreshes; only a state change moves it.
		const visible =
			state !== row.state || (row.state !== 'done' && columns.some(column => !BOOKKEEPING_COLUMNS.has(column)))
		if (visible) update.updated_at = at
		const assignments = Object.keys(update).map(column => `${column} = ?`)
		this.db
			.prepare(`UPDATE signal_threads SET ${assignments.join(', ')} WHERE id = ?`)
			.run(...Object.values(update), row.id)
		if (newer) {
			const detail = { owner: row.owner, kind: observation.kind, head: observation.head, state }
			this.insertEvent(row.id, 'activity', detail, at)
		} else if (state !== row.state) {
			this.insertEvent(row.id, 'state', { owner: row.owner, from: row.state, to: state, reason: 'reported again' }, at)
		}
		return newer
	}

	/** One complete poll without the thread; true when it is now gone. */
	private missThread(row: ThreadRow, goneReason: string, at: string): boolean {
		const missed = row.missed_polls + 1
		if (missed < SIGNAL_GONE_AFTER_MISSES) {
			this.db.prepare('UPDATE signal_threads SET missed_polls = ? WHERE id = ?').run(missed, row.id)
			return false
		}
		// Managed threads stay with their agent; only Jakub's open threads close themselves.
		const close = row.owner === 'jakub' && (row.state === 'new' || row.state === 'seen')
		// Going inactive alone is bookkeeping: `updated_at` (a done thread's done time) moves only on close.
		this.db
			.prepare(
				`UPDATE signal_threads SET missed_polls = ?, active = 0, state = ?, closed_reason = ?, closed_by = ?,
				   updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				missed,
				close ? 'done' : row.state,
				close ? goneReason : row.closed_reason,
				close ? null : row.closed_by,
				close ? at : row.updated_at,
				row.id,
			)
		this.insertEvent(row.id, 'gone', { owner: row.owner, reason: goneReason, state: close ? 'done' : row.state }, at)
		return true
	}

	/**
	 * A gone thread (active = 0) that came back to Jakub as new/seen — taken back from an agent — is
	 * closed by the next complete poll that still lacks it. Not when Jakub reopened it by hand
	 * (`update` then resets `missed_polls`).
	 */
	private closeReturnedGone(row: ThreadRow, goneReason: string, at: string): boolean {
		if (row.owner !== 'jakub' || (row.state !== 'new' && row.state !== 'seen')) return false
		if (row.missed_polls < SIGNAL_GONE_AFTER_MISSES) return false
		this.closeGone(row, goneReason, at)
		return true
	}

	private closeGone(row: { id: number; owner: string; state: string }, goneReason: string, at: string): void {
		this.db
			.prepare(
				`UPDATE signal_threads SET state = 'done', snoozed_until = NULL, closed_reason = ?, closed_by = NULL,
				   updated_at = ?
				 WHERE id = ?`,
			)
			.run(goneReason, at, row.id)
		this.insertEvent(row.id, 'gone', { owner: row.owner, reason: goneReason, state: 'done', from: row.state }, at)
	}

	/** The reason of the thread's latest `gone` event, while the event log still holds it. */
	private lastGoneReason(threadId: number): string {
		const row = this.db
			.prepare("SELECT detail FROM signal_events WHERE thread_id = ? AND type = 'gone' ORDER BY seq DESC LIMIT 1")
			.get(threadId) as { detail: string } | undefined
		const reason = row ? parseDetail(row.detail).reason : null
		return typeof reason === 'string' && reason !== '' ? reason : 'no longer reported'
	}

	private wakeSnoozedAt(at: string): number {
		const rows = this.db
			.prepare(
				"SELECT id, owner, active FROM signal_threads WHERE state = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?",
			)
			.all(at) as Array<{ id: number; owner: string; active: number }>
		for (const row of rows) {
			// Gone while snoozed: Jakub's thread closes instead of waking into Needs you, since no
			// later poll would ever close it (missThread only touches active threads).
			if (row.active !== 1 && row.owner === 'jakub') {
				this.closeGone({ ...row, state: 'snoozed' }, this.lastGoneReason(row.id), at)
				continue
			}
			this.db
				.prepare("UPDATE signal_threads SET state = 'new', snoozed_until = NULL, updated_at = ? WHERE id = ?")
				.run(at, row.id)
			this.insertEvent(row.id, 'state', { owner: row.owner, from: 'snoozed', to: 'new' }, at)
		}
		return rows.length
	}

	private insertEvent(threadId: number, type: SignalEventType, detail: EventDetail, at: string): void {
		const bounded: EventDetail = {}
		for (const [key, value] of Object.entries(detail)) {
			bounded[key] = typeof value === 'string' ? clean(value, SIGNAL_LIMITS.detail) : value
		}
		this.db
			.prepare('INSERT INTO signal_events (thread_id, type, detail, at) VALUES (?, ?, ?, ?)')
			.run(threadId, type, JSON.stringify(bounded), at)
	}

	private pruneEvents(): void {
		const floor = this.db
			.prepare('SELECT seq FROM signal_events ORDER BY seq DESC LIMIT 1 OFFSET ?')
			.get(SIGNAL_EVENT_RETENTION) as { seq: number } | undefined
		if (!floor) return
		this.db.prepare('DELETE FROM signal_events WHERE seq <= ?').run(floor.seq)
	}
}
