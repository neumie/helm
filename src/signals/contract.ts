// Signals wire contract: what the world wants from Jakub (GitHub review requests, comments and
// failed CI on his PRs, mentions; Apple Mail incl. Sentry alerts; asks local agents file with
// `helm signal add`), one row per thread.
//
// Shared by the daemon (store, pollers, routes) and the `helm signal` CLI. The desktop app keeps
// a copied, type-only mirror in app/src/shared-helm.ts (tests/contracts/maintenance.ts checks it).
// Heads only: a thread never carries a PR/mail body, only bounded one-line heads. An agent ask is
// the one exception: its short, bounded body and links are written by a local agent (still shown
// as untrusted text, links as text, opened only on an explicit key press).

import { z } from 'zod'

/** Where a thread comes from. Sentry alerts arrive as mail; `agent` = an ask a local agent filed. */
export const SIGNAL_SOURCES = ['github', 'mail', 'agent'] as const
export type SignalSource = (typeof SIGNAL_SOURCES)[number]

/**
 * Sources a poller reads (and reports health for). Agent asks are pushed through
 * `helm signal add`: never polled, never closed by a poll, no health row.
 */
export const SIGNAL_POLL_SOURCES = ['github', 'mail'] as const
export type SignalPollSource = (typeof SIGNAL_POLL_SOURCES)[number]

/** Why the thread wants Jakub; decides the glyph. A GitHub thread can carry several reasons. */
export const SIGNAL_KINDS = ['review', 'comments', 'ci', 'mention', 'mail', 'sentry', 'ask'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

/** new = unseen foreign activity, seen = looked at, snoozed = until a time, done = handled. */
export const SIGNAL_STATES = ['new', 'seen', 'snoozed', 'done'] as const
export type SignalState = (typeof SIGNAL_STATES)[number]

/** jakub = Needs you; managed = the dispatcher agent (and the agent working on it) handles it. */
export const SIGNAL_OWNERS = ['jakub', 'managed'] as const
export type SignalOwner = (typeof SIGNAL_OWNERS)[number]

/**
 * How a thread was last routed from the Signals column: `sent` to a running agent, `started` a new
 * one, `replied` = Jakub's answer to an agent ask was typed into the asking agent's terminal.
 */
export const SIGNAL_ROUTES = ['sent', 'started', 'replied'] as const
export type SignalRouteHow = (typeof SIGNAL_ROUTES)[number]

/**
 * Who closed a thread by hand: `jakub` = through Helm (the request carried the daemon's local
 * control token, which only Helm's main process holds), `agent` = through `helm signal` (done/set).
 */
export const SIGNAL_CLOSERS = ['jakub', 'agent'] as const
export type SignalCloser = (typeof SIGNAL_CLOSERS)[number]

/** Bounds (UTF-16 code units) applied by the store before anything is persisted or served. */
export const SIGNAL_LIMITS = {
	ref: 80,
	fullRef: 200,
	title: 300,
	head: 300,
	actor: 120,
	url: 2048,
	repo: 200,
	branch: 255,
	note: 300,
	agent: 200,
	detail: 300,
	activityKey: 512,
	threadKey: 512,
	/** Agent asks: one-line title, short body (line breaks kept), links, the caller's key. */
	askTitle: 200,
	askBody: 1000,
	askBodyLines: 12,
	askLinks: 8,
	askKey: 200,
	/** Jakub's answer to an agent ask (line breaks kept). */
	reply: 2000,
	/** A mail sender's address as the sender lists match it (RFC 5321 path limit); never clipped. */
	address: 254,
} as const

/**
 * A mail sender's address as stored for the sender lists: trimmed, lowercase, at most
 * `SIGNAL_LIMITS.address` units, no whitespace, controls or bidi. Anything else is '' (unknown),
 * never clipped: a clipped address would land on the exclude list as a different sender.
 */
export function signalSenderAddress(value: unknown): string {
	if (typeof value !== 'string') return ''
	const address = value.trim().toLowerCase()
	if (address.length > SIGNAL_LIMITS.address) return ''
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting controls is the point
	if (/[\s\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(address)) return ''
	return address
}

/** `--key` of `helm signal add`: the caller's idempotency key (thread key `agent:<key>`). */
export const SIGNAL_ASK_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]{0,199}$/

/** An Okena terminal id (`$OKENA_TERMINAL_ID`), the only delivery target of a reply. */
export const SIGNAL_TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Bidi overrides/isolates and marks: they could reorder text where it is shown. */
const LINK_BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/

/** A link's literal start: the scheme and both slashes, as written (the URL parser would repair `http:x`). */
const LINK_PREFIX = /^https?:\/\//i

/**
 * An agent ask's link as stored and opened: absolute http(s), no credentials, no whitespace,
 * controls, bidi or backslash, at most `SIGNAL_LIMITS.url` units. The text shown must be what
 * opens: it starts with a literal `http://`/`https://` and its authority as written is the host
 * the URL parser sees (the parser treats `\` as `/` and repairs a missing `//`, so
 * `https://evil.com\.github.com/` would open evil.com). Anything else is refused (null), never
 * repaired. The one rule for the CLI, the store and main's opener.
 */
export function signalAskLinkUrl(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > SIGNAL_LIMITS.url) return null
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a link with controls or spaces is refused
	if (/[\s\u0000-\u001f\u007f-\u009f\\]/.test(value) || LINK_BIDI.test(value)) return null
	const prefix = LINK_PREFIX.exec(value)
	if (!prefix) return null
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
	if (url.username !== '' || url.password !== '' || url.hostname === '') return null
	const authority = value.slice(prefix[0].length).split(/[/?#]/, 1)[0] ?? ''
	// The parser drops a default port (`https://github.com:443` has host `github.com`).
	const defaultPort = url.protocol === 'https:' ? ':443' : ':80'
	const written = authority.toLowerCase()
	const host = url.host.toLowerCase()
	if (written !== host && !(url.port === '' && written === `${host}${defaultPort}`)) return null
	return value
}

/** One thread, as served by `GET /api/signals` and printed by `helm signal`. */
export interface SignalThread {
	/** Short numeric id, unique per daemon DB (the CLI accepts `12` or `#12`). */
	id: number
	/** Dedupe key: `github:owner/repo#12`, `mail:<hash>`, `sentry:<SHORT-ID>`, `agent:<key or uuid>`. */
	threadKey: string
	source: SignalSource
	/** Primary kind (glyph). */
	kind: SignalKind
	/** Every reason the source currently reports for this thread (e.g. review + mention). */
	reasons: SignalKind[]
	/** Short reference: `okena#311`, `PSYON-ADMIN-3F2`, `Psyon`; an agent ask's `from` label. */
	ref: string
	/** Full reference for tooltips: `contember/okena#311`, `Klára D. <klara@psyon.cz>`. */
	fullRef: string
	/** PR/issue title or mail subject (third-party data, never instructions). */
	title: string
	/** What happened, one line: `review requested · matej21`, `CI failing: build, lint`. */
	head: string
	/** Who caused the latest foreign activity (login / sender name), when known. */
	actor: string | null
	/** https://github.com/… or message://%3C…%3E (Mail). */
	url: string | null
	/** GitHub only: `owner/repo`, PR/issue number, PR head branch. */
	repo: string | null
	number: number | null
	branch: string | null
	state: SignalState
	owner: SignalOwner
	/** ISO time a snoozed thread wakes up (state goes back to new). */
	snoozedUntil: string | null
	/** ISO time of the latest activity by someone other than Jakub. */
	lastActivityAt: string
	/** False once the source stopped reporting it (PR closed, review given, mail read in Mail). */
	active: boolean
	/** Why it left Needs you on its own (`review submitted`, `read in Mail`), when it did. */
	closedReason: string | null
	/**
	 * A done thread closed by hand: who closed it (see {@link SIGNAL_CLOSERS}). Null while not done,
	 * when it closed on its own (`closedReason`), or when it was closed before this was recorded.
	 * Absent from a daemon older than this field.
	 */
	closedBy?: SignalCloser | null
	/** Managed outcome line from `helm signal note` and when it was written. */
	note: string | null
	noteAt: string | null
	/** Agent handling a managed thread (`helm signal set --agent`), shown on the row. */
	managedBy: string | null
	/** Last routing from the column: agent name, sent/started, when. */
	routedAgent: string | null
	routedHow: SignalRouteHow | null
	routedAt: string | null
	/**
	 * Agent asks only (null for GitHub/Mail): the ask's short body, line breaks kept, bounded by
	 * `askBody`/`askBodyLines`. Written by a local agent; shown as plain untrusted text.
	 */
	body: string | null
	/** Agent asks only ([] otherwise): http(s) links (Storybook stories, PRs), see `signalAskLinkUrl`. */
	links: string[]
	/** Agent asks only: the asking agent's Okena terminal id, where Jakub's reply is delivered. */
	askTerminal: string | null
	/** Agent asks only: Jakub's answer (kept on the thread whether or not it was delivered) and when. */
	reply: string | null
	replyAt: string | null
	createdAt: string
	updatedAt: string
}

/** Health of one poller, shown in the column footer and `helm signal ls`. */
export const SIGNAL_SOURCE_STATUSES = ['ok', 'disabled', 'unavailable', 'needs_permission', 'error'] as const
export type SignalSourceStatus = (typeof SIGNAL_SOURCE_STATUSES)[number]

export interface SignalSourceHealth {
	source: SignalPollSource
	status: SignalSourceStatus
	/** Plain-language reason for anything but ok (`Mail is not running`, `gh: not logged in`). */
	detail: string | null
	lastPollAt: string | null
	lastOkAt: string | null
}

/** `GET /api/signals` response `data`. */
export interface SignalsSnapshot {
	threads: SignalThread[]
	sources: SignalSourceHealth[]
	/** Highest event seq at the time of the read (cursor for `GET /api/signals/events`). */
	seq: number
	generatedAt: string
	/**
	 * Mail kept out of Needs you in the last {@link SIGNAL_FILTERED_RETENTION_DAYS} days (see
	 * `GET /api/signals/filtered`). Absent from a daemon older than the filtered log.
	 */
	filteredCount?: number
}

// ---------- filtered mail (audit log) ----------

/**
 * Why a mail candidate was kept out of Needs you. Bulk reasons come from header-only markers
 * (mail-jxa.ts `bulkReason`): `newsletter` List-Unsubscribe / List-Unsubscribe-Post, `campaign` an
 * X-Campaign / X-CampaignID / X-Campaign-Id header, `junk` Precedence: junk, `auto-reply`
 * Auto-Submitted: auto-replied (vacation and out-of-office replies). `excluded` = the sender is on
 * the exclude list.
 */
export const SIGNAL_FILTER_REASONS = ['newsletter', 'campaign', 'junk', 'auto-reply', 'excluded'] as const
export type SignalFilterReason = (typeof SIGNAL_FILTER_REASONS)[number]

/** How long a filtered candidate stays listed, counted from when it was received. */
export const SIGNAL_FILTERED_RETENTION_DAYS = 7

/** One filtered mail, heads only (never a body), as `GET /api/signals/filtered` serves it. */
export interface SignalFilteredEntry {
	/** Short numeric id (`POST /api/signals/filtered/:id/include`). */
	id: number
	source: 'mail'
	/** Sender display name and address as the From header gave them (third-party data). */
	senderName: string
	senderAddress: string
	/** The address include/exclude globs match: the Hide My Email relay-decoded original when there is one. */
	senderIdentity: string
	subject: string
	reason: SignalFilterReason
	/** Extra mailbox it was read from (`Clientcare`); null for the inbox. */
	mailbox: string | null
	/** message://%3C…%3E (opens it in Mail). */
	url: string | null
	/** ISO time Mail received it. */
	receivedAt: string
	/** ISO time a poll last saw it filtered. */
	lastSeenAt: string
	/**
	 * Present when only an exact exclude entry (a mute) keeps this sender out: `i` then drops that
	 * entry and adds nothing (unmute). Absent for a glob Jakub wrote, where `i` adds the address to
	 * the include list (always show). Older daemons never send it.
	 */
	unmute?: true
}

/** `GET /api/signals/filtered` response `data`: newest received first. */
export interface SignalFilteredPage {
	entries: SignalFilteredEntry[]
	/** Every listed entry in the retention window (entries may be capped). */
	total: number
	retentionDays: number
}

/** `POST /api/signals/filtered/:id/include` response `data`. */
export interface SignalIncludeResult {
	/** The sender shown again (on the include list when `added`; maybe through a glob already). */
	address: string
	/** True when the address went onto the include list. */
	added: boolean
	/**
	 * Present (true) when its exact entry left the exclude list: an `excluded` entry is unmuted, not
	 * added to the include list, unless another exclude glob still matches. Absent from older daemons.
	 */
	unmuted?: boolean
}

/** `POST /api/signals/:id/mute` response `data` (`x` on a mail row, Helm only). */
export interface SignalMuteResult {
	/** The sender now on the exclude list (the relay-decoded original for Hide My Email). */
	address: string
	/** False when an exclude glob already matched it. */
	added: boolean
	/** True when its exact entry left the include list (the two lists never hold the same address). */
	unincluded: boolean
	/** Jakub's open mail threads from it, closed now (they show as filtered `excluded`). */
	threadIds: number[]
}

/** One append-only change, streamed by `GET /api/signals/events` and `helm signal watch`. */
/** `reply` = Jakub answered an agent ask (the detail never carries the answer; read it with `show`). */
export const SIGNAL_EVENT_TYPES = ['created', 'activity', 'state', 'owner', 'note', 'routed', 'gone', 'reply'] as const
export type SignalEventType = (typeof SIGNAL_EVENT_TYPES)[number]

export interface SignalEvent {
	seq: number
	threadId: number
	type: SignalEventType
	/** Small, head-only summary of the change (state/owner/note/agent); never bodies. */
	detail: Record<string, string | number | boolean | null>
	at: string
}

/** `GET /api/signals/events?after=<seq>&wait=<seconds>` response `data`. */
export interface SignalEventsPage {
	events: SignalEvent[]
	/** Cursor to pass as `after` next time: the last event seq, or (empty page) the global latest seq, never below the input. */
	seq: number
}

// ---------- request bodies (strict) ----------

/** `POST /api/signals/:id` — any subset; owner/state transitions are validated by the store. */
export const signalUpdateSchema = z
	.object({
		state: z.enum(SIGNAL_STATES).optional(),
		owner: z.enum(SIGNAL_OWNERS).optional(),
		/** Required with state=snoozed (ISO time in the future); ignored otherwise. */
		snoozedUntil: z.string().datetime({ offset: true }).optional(),
		/** Managed: who handles it. Explicit null clears. */
		managedBy: z.string().trim().min(1).max(SIGNAL_LIMITS.agent).nullable().optional(),
	})
	.strict()
	.refine(body => Object.keys(body).length > 0, 'Nothing to change')
export type SignalUpdate = z.infer<typeof signalUpdateSchema>

/** `POST /api/signals/:id/note` — the outcome line shown on managed rows. */
export const signalNoteSchema = z.object({ note: z.string().trim().min(1).max(SIGNAL_LIMITS.note) }).strict()
export type SignalNote = z.infer<typeof signalNoteSchema>

/** `POST /api/signals/:id/routed` — the column sent the thread to an agent / started one. */
export const signalRoutedSchema = z
	.object({ agent: z.string().trim().min(1).max(SIGNAL_LIMITS.agent), how: z.enum(SIGNAL_ROUTES) })
	.strict()
export type SignalRouted = z.infer<typeof signalRoutedSchema>

// ---------- agent asks ----------

/**
 * `POST /api/signals/asks` (`helm signal add`): create an ask, or with `key` upsert the thread
 * `agent:<key>`. A changed title, body or asking terminal makes it new again (and clears an earlier
 * reply); a change of links or from refreshes it in place; identical input changes nothing.
 */
export const signalAskSchema = z
	.object({
		key: z.string().regex(SIGNAL_ASK_KEY, 'Key: letters, digits and . _ : / # @ + - (at most 200)').optional(),
		title: z
			.string()
			.trim()
			.min(1)
			.max(SIGNAL_LIMITS.askTitle)
			.refine(title => !/[\r\n]/.test(title), 'The title is one line'),
		body: z.string().max(SIGNAL_LIMITS.askBody).optional(),
		links: z
			.array(
				z
					.string()
					.max(SIGNAL_LIMITS.url)
					.refine(link => signalAskLinkUrl(link) !== null, 'Links are absolute http(s) URLs without credentials'),
			)
			.max(SIGNAL_LIMITS.askLinks)
			.optional(),
		/** Who asks, shown as the row's label (default `agent`). */
		from: z.string().trim().min(1).max(SIGNAL_LIMITS.actor).optional(),
		/** The asking agent's `$OKENA_TERMINAL_ID`. */
		terminal: z.string().regex(SIGNAL_TERMINAL_ID).optional(),
	})
	.strict()
export type SignalAsk = z.infer<typeof signalAskSchema>

/** What an upsert did: a new thread, new again (title/body changed), refreshed in place, nothing. */
export const SIGNAL_ASK_OUTCOMES = ['created', 'renewed', 'updated', 'unchanged'] as const
export type SignalAskOutcome = (typeof SIGNAL_ASK_OUTCOMES)[number]

/** `POST /api/signals/asks` response `data`. */
export interface SignalAskResult {
	outcome: SignalAskOutcome
	thread: SignalThread
}

/** `POST /api/signals/:id/done` (`helm signal done ID`): close a thread, optionally with an outcome line. */
export const signalDoneSchema = z.object({ note: z.string().trim().min(1).max(SIGNAL_LIMITS.note).optional() }).strict()
export type SignalDone = z.infer<typeof signalDoneSchema>

/** `POST /api/signals/asks/done` (`helm signal done --key KEY`): the same, by the ask's key. */
export const signalAskDoneSchema = z
	.object({
		key: z.string().regex(SIGNAL_ASK_KEY),
		note: z.string().trim().min(1).max(SIGNAL_LIMITS.note).optional(),
	})
	.strict()
export type SignalAskDone = z.infer<typeof signalAskDoneSchema>

/** `POST /api/signals/:id/reply`: Jakub's answer to an agent ask (agent threads only). */
export const signalReplySchema = z.object({ text: z.string().trim().min(1).max(SIGNAL_LIMITS.reply) }).strict()
export type SignalReply = z.infer<typeof signalReplySchema>

// ---------- source → store observation (daemon internal) ----------

/**
 * One thread as a poller saw it this tick. The store turns a list of these into upserts:
 * a changed `activityKey` with a newer `lastActivityAt` makes the thread `new` again.
 */
export interface SignalObservation {
	threadKey: string
	source: SignalPollSource
	kind: SignalKind
	reasons: SignalKind[]
	ref: string
	fullRef: string
	title: string
	head: string
	actor: string | null
	url: string | null
	repo: string | null
	number: number | null
	branch: string | null
	/** Fingerprint of the latest foreign activity; changes ⇒ candidate for "new again". */
	activityKey: string
	lastActivityAt: string
	/**
	 * Mail only: the latest message's sender as the include/exclude lists match it (lowercase, the
	 * relay-decoded original for Hide My Email). Stored for `x` (mute), never served.
	 */
	sender?: string | null
	/** Mail only: that sender's address as it arrived (the relay address for Hide My Email). Never served. */
	senderAddress?: string | null
}

/**
 * A poll result. `complete` means the source listed everything it would list (no error, no page
 * truncation), so threads of that source missing from `observations` are gone; when false the
 * store only upserts and never closes anything.
 */
export interface SignalPollResult {
	source: SignalPollSource
	observations: SignalObservation[]
	complete: boolean
	/** Why a missing thread left the source, per source (`no longer requested`, `read in Mail`). */
	goneReason: string
	/**
	 * Mail only: candidates this poll kept out of Needs you (logged, heads only) and the message
	 * keys it kept (dropped from the log, e.g. after their sender was included).
	 */
	filtered?: { entries: SignalFilteredObservation[]; keptKeys: string[] }
}

/** One filtered candidate as a poll saw it; the store bounds every field again. */
export interface SignalFilteredObservation {
	/** Normalized Message-ID (lowercase, no angle brackets): the dedupe key across polls. */
	messageKey: string
	senderName: string
	senderAddress: string
	senderIdentity: string
	subject: string
	reason: SignalFilterReason
	mailbox: string | null
	url: string | null
	receivedAt: string
}
