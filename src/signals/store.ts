// Profile-bound Signals persistence: one row per external thread, an append-only change log
// and per-source poll health. Every value a poller hands in is untrusted third-party text:
// it is control/bidi stripped and bounded here, before anything is persisted or served.

import type Database from 'better-sqlite3'
import { oneLine } from '../agent-dock/text.js'
import {
	SIGNAL_EVENT_TYPES,
	SIGNAL_KINDS,
	SIGNAL_LIMITS,
	SIGNAL_OWNERS,
	SIGNAL_ROUTES,
	SIGNAL_SOURCES,
	SIGNAL_SOURCE_STATUSES,
	SIGNAL_STATES,
	type SignalEvent,
	type SignalEventType,
	type SignalKind,
	type SignalObservation,
	type SignalOwner,
	type SignalPollResult,
	type SignalRouteHow,
	type SignalSource,
	type SignalSourceHealth,
	type SignalSourceStatus,
	type SignalState,
	type SignalThread,
	type SignalUpdate,
} from './contract.js'

/** Newest events kept per profile; older ones are pruned after each write. */
export const SIGNAL_EVENT_RETENTION = 5000
/** Upper bound of one `list` read. */
export const SIGNAL_LIST_CAP = 300
/** Done threads older than this leave the default list. */
export const SIGNAL_DONE_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000
/** Consecutive complete polls a thread may be missing from before it counts as gone. */
export const SIGNAL_GONE_AFTER_MISSES = 2

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
	profile_id: string
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
	note: string | null
	note_at: string | null
	managed_by: string | null
	routed_agent: string | null
	routed_how: string | null
	routed_at: string | null
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
function sanitizeObservation(observation: SignalObservation, source: SignalSource): SignalObservation | null {
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
		note: row.note,
		noteAt: row.note_at,
		managedBy: row.managed_by,
		routedAgent: row.routed_agent,
		routedHow: oneOf(SIGNAL_ROUTES, row.routed_how) ? row.routed_how : null,
		routedAt: row.routed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

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
	constructor(
		private readonly db: Database.Database,
		private readonly profile: string | (() => string) = 'work',
	) {}

	private get profileId(): string {
		return typeof this.profile === 'function' ? this.profile() : this.profile
	}

	transaction<T>(fn: () => T): T {
		return this.db.transaction(fn)()
	}

	/** Upsert one poll's observations, renew threads with newer foreign activity, close gone ones. */
	applyPoll(result: SignalPollResult, now: Date): SignalApplyResult {
		if (!oneOf(SIGNAL_SOURCES, result.source)) throw new SignalInvalidError('Unknown signal source')
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
				(
					this.db
						.prepare('SELECT * FROM signal_threads WHERE profile_id = ? AND source = ?')
						.all(this.profileId, source) as ThreadRow[]
				).map(row => [row.thread_key, row]),
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
					if (row.active !== 1 || observations.has(row.thread_key)) continue
					if (this.missThread(row, goneReason, at)) counts.gone += 1
				}
			}
			this.wakeSnoozedAt(at)
			this.pruneEvents()
			return counts
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
		const where = ['profile_id = ?']
		const params: Array<string | number> = [this.profileId]
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
				`SELECT * FROM signal_threads WHERE ${where.join(' AND ')} ORDER BY last_activity_at DESC, id DESC LIMIT ?`,
			)
			.all(...params) as ThreadRow[]
		return rows.map(toSignalThread)
	}

	get(id: number): SignalThread | null {
		const row = this.row(id)
		return row ? toSignalThread(row) : null
	}

	getByThreadKey(threadKey: string): SignalThread | null {
		const row = this.db
			.prepare('SELECT * FROM signal_threads WHERE profile_id = ? AND thread_key = ?')
			.get(this.profileId, threadKey) as ThreadRow | undefined
		return row ? toSignalThread(row) : null
	}

	update(id: number, patch: SignalUpdate, now: Date): SignalThread {
		const at = now.toISOString()
		return this.transaction(() => {
			const row = this.requireRow(id)
			const next = {
				state: row.state,
				owner: row.owner,
				snoozed_until: row.snoozed_until,
				closed_reason: row.closed_reason,
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
			}
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
				next.managed_by !== row.managed_by
			if (!changed) return toSignalThread(row)
			this.db
				.prepare(
					`UPDATE signal_threads SET state = ?, owner = ?, snoozed_until = ?, closed_reason = ?, managed_by = ?, updated_at = ?
					 WHERE profile_id = ? AND id = ?`,
				)
				.run(next.state, next.owner, next.snoozed_until, next.closed_reason, next.managed_by, at, this.profileId, id)
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
				.prepare('UPDATE signal_threads SET note = ?, note_at = ?, updated_at = ? WHERE profile_id = ? AND id = ?')
				.run(text, at, at, this.profileId, id)
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
					 WHERE profile_id = ? AND id = ?`,
				)
				.run(agent, routed.how, at, state, at, this.profileId, id)
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
			this.db
				.prepare("UPDATE signal_threads SET state = 'seen', updated_at = ? WHERE profile_id = ? AND id = ?")
				.run(at, this.profileId, id)
			this.insertEvent(id, 'state', { owner: row.owner, from: 'new', to: 'seen' }, at)
			this.pruneEvents()
			return toSignalThread(this.requireRow(id))
		})
	}

	events(afterSeq: number, limit = 200): SignalEvent[] {
		const after = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0
		const bounded = Math.max(1, Math.min(Math.trunc(limit) || 1, 1000))
		const rows = this.db
			.prepare(
				'SELECT seq, thread_id, type, detail, at FROM signal_events WHERE profile_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
			)
			.all(this.profileId, after, bounded) as EventRow[]
		return rows.flatMap(row =>
			oneOf(SIGNAL_EVENT_TYPES, row.type)
				? [{ seq: row.seq, threadId: row.thread_id, type: row.type, detail: parseDetail(row.detail), at: row.at }]
				: [],
		)
	}

	latestSeq(): number {
		const row = this.db.prepare('SELECT MAX(seq) AS seq FROM signal_events WHERE profile_id = ?').get(this.profileId) as
			| { seq: number | null }
			| undefined
		return row?.seq ?? 0
	}

	setSourceHealth(
		source: SignalSource,
		status: SignalSourceStatus,
		detail: string | null,
		now: Date,
		ok: boolean,
	): void {
		if (!oneOf(SIGNAL_SOURCES, source)) throw new SignalInvalidError('Unknown signal source')
		if (!oneOf(SIGNAL_SOURCE_STATUSES, status)) throw new SignalInvalidError('Unknown source status')
		const at = now.toISOString()
		const text = cleanOptional(detail, SIGNAL_LIMITS.detail)
		// A disabled source is not a poll: keep the last poll/ok times for context.
		const polled = status === 'disabled' ? null : at
		this.db
			.prepare(
				`INSERT INTO signal_sources (profile_id, source, status, detail, last_poll_at, last_ok_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (profile_id, source) DO UPDATE SET
				   status = excluded.status,
				   detail = excluded.detail,
				   last_poll_at = COALESCE(excluded.last_poll_at, signal_sources.last_poll_at),
				   last_ok_at = COALESCE(excluded.last_ok_at, signal_sources.last_ok_at)`,
			)
			.run(this.profileId, source, status, text, polled, ok ? at : null)
	}

	/** Health of every source; a source that never reported is disabled. */
	sources(): SignalSourceHealth[] {
		const rows = new Map(
			(
				this.db
					.prepare('SELECT source, status, detail, last_poll_at, last_ok_at FROM signal_sources WHERE profile_id = ?')
					.all(this.profileId) as SourceRow[]
			).map(row => [row.source, row]),
		)
		return SIGNAL_SOURCES.map(source => {
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

	// ---------- internals (callers hold a transaction) ----------

	private row(id: number): ThreadRow | null {
		if (!Number.isSafeInteger(id) || id <= 0) return null
		const row = this.db
			.prepare('SELECT * FROM signal_threads WHERE profile_id = ? AND id = ?')
			.get(this.profileId, id) as ThreadRow | undefined
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
				   profile_id, thread_key, source, kind, reasons, ref, full_ref, title, head, actor, url, repo, number, branch,
				   state, owner, activity_key, last_activity_at, active, missed_polls, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'jakub', ?, ?, 1, 0, ?, ?)`,
			)
			.run(
				this.profileId,
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
			}
		} else {
			if (observation.activityKey !== row.activity_key) update.activity_key = observation.activityKey
			// Back after the store closed it as gone, with nothing new: reopen as already seen.
			if (row.active !== 1 && row.state === 'done' && row.closed_reason !== null) {
				state = 'seen'
				update.state = 'seen'
				update.closed_reason = null
			}
		}
		const columns = Object.keys(update)
		if (columns.length === 0) return false
		// Bookkeeping alone (missed_polls, the key) does not count as a change people see.
		const visible = columns.some(column => column !== 'missed_polls' && column !== 'activity_key')
		if (visible) update.updated_at = at
		const assignments = Object.keys(update).map(column => `${column} = ?`)
		this.db
			.prepare(`UPDATE signal_threads SET ${assignments.join(', ')} WHERE profile_id = ? AND id = ?`)
			.run(...Object.values(update), this.profileId, row.id)
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
			this.db
				.prepare('UPDATE signal_threads SET missed_polls = ? WHERE profile_id = ? AND id = ?')
				.run(missed, this.profileId, row.id)
			return false
		}
		// Managed threads stay with their agent; only Jakub's open threads close themselves.
		const close = row.owner === 'jakub' && (row.state === 'new' || row.state === 'seen')
		this.db
			.prepare(
				`UPDATE signal_threads SET missed_polls = ?, active = 0, state = ?, closed_reason = ?, updated_at = ?
				 WHERE profile_id = ? AND id = ?`,
			)
			.run(missed, close ? 'done' : row.state, close ? goneReason : row.closed_reason, at, this.profileId, row.id)
		this.insertEvent(row.id, 'gone', { owner: row.owner, reason: goneReason, state: close ? 'done' : row.state }, at)
		return true
	}

	private wakeSnoozedAt(at: string): number {
		const rows = this.db
			.prepare(
				"SELECT id, owner FROM signal_threads WHERE profile_id = ? AND state = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?",
			)
			.all(this.profileId, at) as Array<{ id: number; owner: string }>
		for (const row of rows) {
			this.db
				.prepare(
					"UPDATE signal_threads SET state = 'new', snoozed_until = NULL, updated_at = ? WHERE profile_id = ? AND id = ?",
				)
				.run(at, this.profileId, row.id)
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
			.prepare('INSERT INTO signal_events (profile_id, thread_id, type, detail, at) VALUES (?, ?, ?, ?, ?)')
			.run(this.profileId, threadId, type, JSON.stringify(bounded), at)
	}

	private pruneEvents(): void {
		const floor = this.db
			.prepare('SELECT seq FROM signal_events WHERE profile_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?')
			.get(this.profileId, SIGNAL_EVENT_RETENTION) as { seq: number } | undefined
		if (!floor) return
		this.db.prepare('DELETE FROM signal_events WHERE profile_id = ? AND seq <= ?').run(this.profileId, floor.seq)
	}
}
