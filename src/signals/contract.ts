// Signals wire contract: what the world wants from Jakub (GitHub review requests, comments and
// failed CI on his PRs, mentions; Apple Mail incl. Sentry alerts), one row per thread.
//
// Shared by the daemon (store, pollers, routes) and the `helm signal` CLI. The desktop app keeps
// a copied, type-only mirror in app/src/shared-helm.ts (tests/contracts/maintenance.ts checks it).
// Heads only: a thread never carries a PR/mail body, only bounded one-line heads.

import { z } from 'zod'

/** Where a thread comes from. Sentry alerts arrive as mail. */
export const SIGNAL_SOURCES = ['github', 'mail'] as const
export type SignalSource = (typeof SIGNAL_SOURCES)[number]

/** Why the thread wants Jakub; decides the glyph. A GitHub thread can carry several reasons. */
export const SIGNAL_KINDS = ['review', 'comments', 'ci', 'mention', 'mail', 'sentry'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

/** new = unseen foreign activity, seen = looked at, snoozed = until a time, done = handled. */
export const SIGNAL_STATES = ['new', 'seen', 'snoozed', 'done'] as const
export type SignalState = (typeof SIGNAL_STATES)[number]

/** jakub = Needs you; managed = the dispatcher agent (and the agent working on it) handles it. */
export const SIGNAL_OWNERS = ['jakub', 'managed'] as const
export type SignalOwner = (typeof SIGNAL_OWNERS)[number]

/** How a thread was last routed from the Signals column. */
export const SIGNAL_ROUTES = ['sent', 'started'] as const
export type SignalRouteHow = (typeof SIGNAL_ROUTES)[number]

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
} as const

/** One thread, as served by `GET /api/signals` and printed by `helm signal`. */
export interface SignalThread {
	/** Short numeric id, unique per daemon DB (the CLI accepts `12` or `#12`). */
	id: number
	/** Dedupe key: `github:owner/repo#12`, `mail:<hash>`, `sentry:<SHORT-ID>`. */
	threadKey: string
	source: SignalSource
	/** Primary kind (glyph). */
	kind: SignalKind
	/** Every reason the source currently reports for this thread (e.g. review + mention). */
	reasons: SignalKind[]
	/** Short reference: `okena#311`, `PSYON-ADMIN-3F2`, `Psyon`. */
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
	/** Managed outcome line from `helm signal note` and when it was written. */
	note: string | null
	noteAt: string | null
	/** Agent handling a managed thread (`helm signal set --agent`), shown on the row. */
	managedBy: string | null
	/** Last routing from the column: agent name, sent/started, when. */
	routedAgent: string | null
	routedHow: SignalRouteHow | null
	routedAt: string | null
	createdAt: string
	updatedAt: string
}

/** Health of one poller, shown in the column footer and `helm signal ls`. */
export const SIGNAL_SOURCE_STATUSES = ['ok', 'disabled', 'unavailable', 'needs_permission', 'error'] as const
export type SignalSourceStatus = (typeof SIGNAL_SOURCE_STATUSES)[number]

export interface SignalSourceHealth {
	source: SignalSource
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
}

/** One append-only change, streamed by `GET /api/signals/events` and `helm signal watch`. */
export const SIGNAL_EVENT_TYPES = ['created', 'activity', 'state', 'owner', 'note', 'routed', 'gone'] as const
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
	/** Cursor to pass as `after` next time (== last event seq, or the input when empty). */
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

// ---------- source → store observation (daemon internal) ----------

/**
 * One thread as a poller saw it this tick. The store turns a list of these into upserts:
 * a changed `activityKey` with a newer `lastActivityAt` makes the thread `new` again.
 */
export interface SignalObservation {
	threadKey: string
	source: SignalSource
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
}

/**
 * A poll result. `complete` means the source listed everything it would list (no error, no page
 * truncation), so threads of that source missing from `observations` are gone; when false the
 * store only upserts and never closes anything.
 */
export interface SignalPollResult {
	source: SignalSource
	observations: SignalObservation[]
	complete: boolean
	/** Why a missing thread left the source, per source (`no longer requested`, `read in Mail`). */
	goneReason: string
}
