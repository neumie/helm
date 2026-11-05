// Pure agent-dock reducer: (state, observation, now) → { state, events }.
// No IO, no clocks, no mutation of `prev`. See docs in model.ts and the design
// (§3 lifecycle, §4 freshness/answered-elsewhere/Okena restart).

import { boundText, excerptLine } from '../../../src/agent-dock/text'
import { BACKGROUND_TASKS_MAX, type ObservedBackgroundTasks } from './background-tasks'
import { SLOWEST_INTERVAL_MS } from './cadence'
import { itemWaitingSince } from './item-order'
import {
	ACT_CONFIRM_MS,
	type AgentDockEvent,
	type AgentDockObservation,
	type AgentDockPersisted,
	type AgentDockSnapshot,
	type AgentDockSourceHealth,
	DOCK_EXCERPT_MAX,
	type DockActOutcome,
	type DockActionKind,
	type DockItem,
	type DockRefusalReason,
	type DockResolutionBy,
	type DockSession,
	type DockSessionStatus,
	type DockSourceId,
	type DockTurnFact,
	type OkenaClaudeSession,
	type OkenaClaudeTranscriptPage,
	type OkenaState,
	type SessionKey,
	okenaClaudeCandidates,
	okenaDialogPrefix,
	okenaTerminalProject,
	parseOkenaClaudeSession,
	parseOkenaClaudeTranscriptPage,
	parseOkenaState,
	sessionKey,
} from './model'
import { PERMISSION_SUGGESTIONS_MAX } from './review'

/** A session must stay idle this long before an unchecked turn opens (filters quick resumes). */
export const TURN_IDLE_MS = 8_000
/**
 * A session whose main agent is busy (Okena `busy: true`, working or in its own dialog) this
 * long no longer waits for Jakub: the open turn closes `superseded` even when no reply entry
 * was read. A dialog raised while the main agent is idle (a background subagent) does not count.
 */
export const TURN_RESUMED_MS = 8_000
/**
 * Two observations further apart than this do not make one continuous idle/busy stretch
 * (Helm asleep, Okena down, the pane unlisted or unreadable in between): both restart.
 * Three times the watcher's slowest interval (15 s reconciliation with a healthy push
 * channel → 45 s), so a stretch observed only by reconciliation ticks (each one a little
 * late under load) is never restarted, while a real sleep or outage still is.
 */
export const OBSERVATION_GAP_MS = 3 * SLOWEST_INTERVAL_MS
/** Turn excerpt bound (memory only). */
export const TURN_TEXT_MAX = 2_048
/** Resolved items are kept for dedupe (and a receipt's linger), bounded by age and count. */
export const RESOLVED_RETENTION_MS = 24 * 60 * 60 * 1000
export const RESOLVED_MAX = 50

interface TranscriptTail {
	sessionId?: string
	cursor?: number
	/** `at`: when Helm first read it; `excerpt`: its bounded first line (DockSession.lastMessage). */
	lastAssistant?: { uuid: string; text: string; at: number; excerpt: string }
	/** A user entry was seen after lastAssistant (any origin). */
	userAfterLastAssistant: boolean
}

export interface AgentDockSessionRecord {
	session: DockSession
	/** Its source's epoch this session was last observed in; older = seen before a restart/reconnect. */
	epoch: number
	/** Status from the last successful detail read (the displayed status may be `unreachable`). */
	observedStatus?: DockSessionStatus
	/** First observation of the current idle/background stretch. */
	idleSince?: number
	/** First observation of the current stretch with the main agent busy (Okena `busy: true`). */
	busySince?: number
	/**
	 * The turn closed because the agent went back to work with nothing read after it. If the
	 * pane stops again at that same message, the turn opens again (once per stop) and keeps
	 * its original `endedAt`, so its waiting age is not reset by the round trip.
	 */
	resumedTurn?: { key: string; endedAt: number }
	/**
	 * A turn the idle gate holds back: the pane is idle at an unseen message, but not yet for
	 * TURN_IDLE_MS. Memory only; drives the settle tick (agentDockNextDeadline), the fast
	 * cadence (agentDockActive) and the gate diagnostics (`turn.gated`) when it never opens.
	 */
	gateCandidate?: { uuid: string; idleSince: number; lastIdleAt: number }
	/** Present at the seed tick and its turn not yet evaluated against persisted `seen`. */
	seedPending: boolean
	tail: TranscriptTail
	/** Dialog ids the last successful detail read showed open. */
	dialogIds?: string[]
}

/** Per-source observation state: each source seeds, restarts and goes down on its own. */
export interface SourceObservationState {
	/** False until the source's first successful `/v1/state`; that tick is its seed. */
	seeded: boolean
	/** Bumped on reconnect after down, `state_version` regression, or dialog-prefix change. */
	epoch: number
	stateVersion?: number
	hubPrefix?: string
	health: AgentDockSourceHealth
}

export interface AgentDockState {
	nextItemId: number
	/** Sources observed so far (a source appears with its first poll). */
	sources: Partial<Record<DockSourceId, SourceObservationState>>
	/** All sources together (see AgentDockSnapshot.source); recomputed after every reduction. */
	source: AgentDockSourceHealth
	sessions: Record<SessionKey, AgentDockSessionRecord>
	items: DockItem[]
	/** Last assistant uuid Jakub has seen (acked) per session. Persisted. */
	seen: Record<SessionKey, string>
}

/**
 * A turn the idle gate suppressed: the pane was idle at an unseen message, then resumed
 * (`working`/`waiting`), said something newer (`superseded`) or got a user entry (`replied`)
 * before TURN_IDLE_MS. `idleMs` is the stretch up to the observation that ended it (an upper
 * bound), `seenIdleMs` up to the last idle observation (a lower bound). Diagnostics only:
 * never an item or a dispatcher event (the watcher writes these to their own file).
 */
export interface DockTurnGated {
	t: 'turn.gated'
	at: number
	session: SessionKey
	idleMs: number
	seenIdleMs: number
	by: 'working' | 'waiting' | 'superseded' | 'replied'
}

export interface AgentDockReduction {
	state: AgentDockState
	events: AgentDockEvent[]
	/** Gate diagnostics (see DockTurnGated); empty for most reductions. */
	diagnostics: DockTurnGated[]
}

export function createAgentDockState(persisted?: AgentDockPersisted | null, now = 0): AgentDockState {
	return {
		nextItemId: persisted?.nextItemId ?? 1,
		sources: {},
		source: { state: 'pending', since: now, lastObservedAt: null },
		sessions: {},
		items: [],
		seen: { ...(persisted?.seen ?? {}) },
	}
}

export function agentDockPersisted(state: AgentDockState): AgentDockPersisted {
	return { version: 1, nextItemId: state.nextItemId, seen: { ...state.seen } }
}

/** What the source should send for a terminal's next transcript read (`cursor` + `session_id` query). */
export function agentDockTranscriptRequest(
	state: AgentDockState,
	profile: string,
	terminalId: string,
): { cursor?: number; sessionId?: string } {
	const tail = state.sessions[sessionKey(profile, terminalId)]?.tail
	return tail?.cursor === undefined || !tail.sessionId ? {} : { cursor: tail.cursor, sessionId: tail.sessionId }
}

/**
 * Whether the source should read this pane's transcript while it is busy: a turn item
 * is live, and the user entry that answers it (or the agent's next message) closes it.
 */
export function agentDockAwaitingReply(state: AgentDockState, profile: string, terminalId: string): boolean {
	const key = sessionKey(profile, terminalId)
	return state.items.some(item => item.session === key && item.kind === 'turn' && isLive(item))
}

/** Sending/unconfirmed items keep their place, so an entry never jumps while its answer lands. */
const ITEM_ORDER: Record<string, number> = {
	'open:ask': 0,
	'sending:ask': 0,
	'unconfirmed:ask': 0,
	'orphaned:ask': 1,
	'open:turn': 2,
	'sending:turn': 2,
	'unconfirmed:turn': 2,
	'orphaned:turn': 2,
}

export function agentDockSnapshot(state: AgentDockState, now: number): AgentDockSnapshot {
	const rank = (item: DockItem): number => ITEM_ORDER[`${item.state}:${item.kind}`] ?? 3
	const items = [...state.items].sort((a, b) => {
		const byRank = rank(a) - rank(b)
		if (byRank !== 0) return byRank
		if (a.state === 'resolved') return (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0) || b.id - a.id
		return itemWaitingSince(a) - itemWaitingSince(b) || a.id - b.id
	})
	const sessions = Object.values(state.sessions)
		.map((record): DockSession => {
			const last = record.tail.lastAssistant
			return {
				...record.session,
				prLinks: [...record.session.prLinks],
				...(record.session.reply ? { reply: { ...record.session.reply } } : {}),
				...(last
					? {
							lastMessage: {
								uuid: last.uuid,
								text: last.excerpt,
								at: last.at,
								seen: state.seen[record.session.key] === last.uuid,
							},
						}
					: {}),
			}
		})
		.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
	const sources: AgentDockSnapshot['sources'] = {}
	for (const [id, entry] of Object.entries(state.sources)) if (entry) sources[id as DockSourceId] = { ...entry.health }
	return { generatedAt: now, source: { ...state.source }, sources, sessions, items }
}

/**
 * The dock-wide health of all sources: down when any is down (since the earliest,
 * last data of the down ones), else pending when any is pending, else ok. No
 * source polled yet stays pending from `fallback`.
 */
export function aggregateSourceHealth(
	sources: AgentDockState['sources'],
	fallback: AgentDockSourceHealth,
): AgentDockSourceHealth {
	const all = Object.values(sources).flatMap(entry => (entry ? [entry.health] : []))
	if (all.length === 0) return { ...fallback }
	const down = all.filter(health => health.state === 'down')
	const lastSeen = (list: AgentDockSourceHealth[]): number | null =>
		list.reduce<number | null>(
			(max, health) =>
				health.lastObservedAt === null
					? max
					: max === null
						? health.lastObservedAt
						: Math.max(max, health.lastObservedAt),
			null,
		)
	if (down.length > 0) {
		const detail = down
			.map(health => health.detail)
			.filter(Boolean)
			.join(' · ')
		return {
			state: 'down',
			since: Math.min(...down.map(health => health.since)),
			lastObservedAt: lastSeen(down),
			...(detail ? { detail } : {}),
		}
	}
	const pending = all.filter(health => health.state === 'pending')
	if (pending.length > 0)
		return { state: 'pending', since: Math.min(...pending.map(health => health.since)), lastObservedAt: lastSeen(all) }
	return { state: 'ok', since: Math.max(...all.map(health => health.since)), lastObservedAt: lastSeen(all) }
}

const isLive = (item: DockItem): boolean => item.state !== 'resolved'
/** Okena accepted Jakub's dock answer (sent, maybe unconfirmed): the next observed close is his. */
const isDispatched = (item: DockItem): boolean =>
	(item.state === 'sending' || item.state === 'unconfirmed') &&
	(item.receipt?.status === 'sent' || item.receipt?.status === 'unconfirmed')
/** The act's CAS read/POST is still running: an observed close cannot be attributed yet. */
const isInFlight = (item: DockItem): boolean => item.state === 'sending' && item.receipt?.status === 'sending'

/**
 * A refusal that only said the agent was not free (working, a dialog open, or its state unknown):
 * once the agent is seen idle again it no longer holds, so it is dropped (see observeTerminal).
 */
const refusedNotFree = (receipt: { status: string; reason?: DockRefusalReason } | undefined): boolean =>
	receipt?.status === 'refused' && (receipt.reason === 'busy' || receipt.reason === 'untracked')

/** `background`: main agent idle while its subagents or background tasks (shells, workflows, monitors) still run. */
function deriveStatus(detail: OkenaClaudeSession, backgroundTasks: number): DockSessionStatus {
	if (detail.dialogs.length > 0) return 'waiting'
	if (detail.busy === true) return 'working'
	if (detail.busy === false) return detail.running_subagents.length > 0 || backgroundTasks > 0 ? 'background' : 'idle'
	return 'unknown'
}

/**
 * Background tasks still running for this detail: Helm's hub counts them itself
 * (`background_tasks`), Okena panes carry what their transcript file showed for
 * this very session. Anything else (no read, another session) claims none.
 */
function backgroundOf(
	detail: OkenaClaudeSession,
	observed: ObservedBackgroundTasks | undefined,
): { tasks: number; shells: number } {
	if (detail.background_tasks !== undefined) {
		const tasks = Math.min(detail.background_tasks, BACKGROUND_TASKS_MAX)
		return { tasks, shells: Math.min(detail.background_shells ?? 0, tasks) }
	}
	if (!observed || !detail.session_id || observed.sessionId !== detail.session_id) return { tasks: 0, shells: 0 }
	const tasks = Math.min(observed.tasks, BACKGROUND_TASKS_MAX)
	return { tasks, shells: Math.min(observed.shells, tasks) }
}

/** Observations cross a process boundary in tests and sources: an odd shape claims nothing. */
function validBackground(value: unknown): value is ObservedBackgroundTasks {
	const count = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0
	const v = value as Partial<ObservedBackgroundTasks> | undefined
	return !!v && typeof v === 'object' && typeof v.sessionId === 'string' && count(v.tasks) && count(v.shells)
}

function pruneResolved(items: DockItem[], now: number): DockItem[] {
	const resolved = items
		.filter(item => item.state === 'resolved' && now - (item.resolution?.at ?? now) <= RESOLVED_RETENTION_MS)
		.sort((a, b) => (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0))
		.slice(0, RESOLVED_MAX)
	const keep = new Set(resolved)
	return items.filter(item => isLive(item) || keep.has(item))
}

/** Mutable working copy for one reduction; `prev` is never touched. */
class Draft {
	readonly events: AgentDockEvent[] = []
	readonly diagnostics: DockTurnGated[] = []
	readonly state: AgentDockState

	constructor(
		prev: AgentDockState,
		readonly now: number,
	) {
		this.state = {
			...prev,
			source: { ...prev.source },
			sources: Object.fromEntries(
				Object.entries(prev.sources).map(([id, entry]) => [
					id,
					entry ? { ...entry, health: { ...entry.health } } : entry,
				]),
			),
			sessions: Object.fromEntries(
				Object.entries(prev.sessions).map(([key, record]) => [
					key,
					{ ...record, session: { ...record.session }, tail: { ...record.tail } },
				]),
			),
			items: prev.items.map(item => ({
				...item,
				fact: { ...item.fact },
				...(item.receipt ? { receipt: { ...item.receipt } } : {}),
			})),
			seen: { ...prev.seen },
		}
	}

	resolve(item: DockItem, by: DockResolutionBy): void {
		if (!isLive(item)) return
		item.state = 'resolved'
		item.resolution = { at: this.now, by }
		this.events.push({ t: 'item.resolved', at: this.now, id: item.id, by })
	}

	/** Jakub's dock answer was observed taking effect (dialog closed / user entry after the turn). */
	confirm(item: DockItem): void {
		if (!isLive(item) || !item.receipt) return
		item.receipt = { ...item.receipt, status: 'confirmed', at: this.now }
		this.outcome(item, 'confirmed')
		this.resolve(item, 'dock')
	}

	outcome(item: DockItem, status: 'confirmed' | 'unconfirmed' | 'refused' | 'failed'): void {
		if (!item.receipt) return
		this.events.push({
			t: 'act.outcome',
			at: this.now,
			id: item.id,
			action: item.receipt.action,
			status,
			...(item.receipt.reason ? { reason: item.receipt.reason } : {}),
		})
	}

	/** A live item closed by an observation: Jakub's dock answer if one was sent, else `by`. */
	close(item: DockItem, by: DockResolutionBy): void {
		if (isDispatched(item)) this.confirm(item)
		else this.resolve(item, by)
	}

	orphan(item: DockItem): void {
		if (item.state !== 'open') return
		item.state = 'orphaned'
		item.orphanedAt = this.now
		this.events.push({ t: 'item.orphaned', at: this.now, id: item.id })
	}

	reopen(item: DockItem): void {
		if (item.state !== 'orphaned') return
		item.state = 'open'
		item.orphanedAt = undefined
		this.events.push({ t: 'item.reopened', at: this.now, id: item.id })
	}

	open(item: Omit<DockItem, 'id' | 'openedAt' | 'state'>, silent: boolean): DockItem {
		const opened: DockItem = { ...item, id: this.state.nextItemId++, openedAt: this.now, state: 'open' }
		this.state.items.push(opened)
		if (!silent) {
			this.events.push({
				t: 'item.opened',
				at: this.now,
				id: opened.id,
				kind: opened.kind,
				session: opened.session,
				key: opened.key,
			})
		}
		return opened
	}

	liveItems(key: SessionKey): DockItem[] {
		return this.state.items.filter(item => item.session === key && isLive(item))
	}

	hasKey(key: string): boolean {
		return this.state.items.some(item => item.key === key)
	}

	/** The observation state of `id`, created pending on its first poll. */
	src(id: DockSourceId): SourceObservationState {
		let entry = this.state.sources[id]
		if (!entry) {
			entry = { seeded: false, epoch: 0, health: { state: 'pending', since: this.now, lastObservedAt: null } }
			this.state.sources[id] = entry
		}
		return entry
	}

	health(id: DockSourceId, next: AgentDockSourceHealth, emit: boolean): void {
		const entry = this.src(id)
		const changed = entry.health.state !== next.state
		entry.health = changed ? next : { ...next, since: entry.health.since }
		if (changed && emit && next.state !== 'pending') {
			this.events.push({ t: 'source.health', at: this.now, state: next.state, source: id, detail: next.detail })
		}
	}
}

function setStatus(record: AgentDockSessionRecord, status: DockSessionStatus, now: number): void {
	if (record.observedStatus !== status) record.session.since = now
	record.observedStatus = status
	record.session.status = status
}

function sourceDown(draft: Draft, id: DockSourceId, detail: string): void {
	const entry = draft.src(id)
	draft.health(
		id,
		{ state: 'down', since: draft.now, lastObservedAt: entry.health.lastObservedAt, detail },
		entry.health.state !== 'down',
	)
	// Freeze this source's rows: grey with their age; no item opens, orphans or resolves from missing data.
	for (const record of Object.values(draft.state.sessions))
		if (record.session.source === id) record.session.status = 'unreachable'
}

/** Applies one transcript page; returns whether a user entry followed each live turn's assistant uuid. */
function applyTranscript(
	record: AgentDockSessionRecord,
	page: OkenaClaudeTranscriptPage,
	liveTurnUuids: Set<string>,
	now: number,
): { repliedTurns: Set<string>; activity: boolean } {
	const before = record.tail.lastAssistant
	const tail: TranscriptTail = page.reset ? { userAfterLastAssistant: false } : { ...record.tail }
	// On a continuation every live turn's uuid is already behind the cursor.
	const passed = new Set(page.reset ? [] : liveTurnUuids)
	const repliedTurns = new Set<string>()
	let activity = false
	for (const entry of page.entries) {
		if (entry.kind === 'assistant') {
			// A reset page re-reads messages Helm already knows: they keep when it first read them.
			const known =
				before?.uuid === entry.uuid ? before : tail.lastAssistant?.uuid === entry.uuid ? tail.lastAssistant : null
			tail.lastAssistant = {
				uuid: entry.uuid,
				text: entry.text,
				at: known?.at ?? now,
				excerpt: excerptLine(entry.text, DOCK_EXCERPT_MAX),
			}
			tail.userAfterLastAssistant = false
			if (liveTurnUuids.has(entry.uuid)) passed.add(entry.uuid)
			if (!page.reset) activity = true
		} else if (entry.kind === 'user') {
			tail.userAfterLastAssistant = true
			for (const uuid of passed) repliedTurns.add(uuid)
			if (!page.reset) activity = true
		}
	}
	tail.cursor = page.cursor
	tail.sessionId = page.session_id
	record.tail = tail
	return { repliedTurns, activity }
}

interface TickContext {
	source: DockSourceId
	profile: string
	state: OkenaState
	seedTick: boolean
}

function observeTerminal(
	draft: Draft,
	ctx: TickContext,
	terminalId: string,
	observed: {
		detail: OkenaClaudeSession | null
		transcript: OkenaClaudeTranscriptPage | null
		background?: ObservedBackgroundTasks
	},
): void {
	const { now } = draft
	const key = sessionKey(ctx.profile, terminalId)
	const project = okenaTerminalProject(ctx.state, terminalId)
	const existing = draft.state.sessions[key]
	const src = draft.src(ctx.source)
	const record: AgentDockSessionRecord = existing ?? {
		epoch: src.epoch,
		seedPending: ctx.seedTick,
		tail: { userAfterLastAssistant: false },
		session: {
			key,
			source: ctx.source,
			profile: ctx.profile,
			terminalId,
			project: '',
			name: '',
			status: 'unknown',
			since: now,
			observedAt: now,
			subagents: 0,
			backgroundTasks: 0,
			backgroundShells: 0,
			queuedPrompts: 0,
			prLinks: [],
			hasTranscript: false,
			hooksAttached: false,
			channelAttached: false,
		},
	}
	draft.state.sessions[key] = record
	record.session.projectId = project?.id
	record.session.project = project?.name ?? 'unknown project'
	const parentId = project?.worktree_info?.parent_project_id
	record.session.repo = (parentId && ctx.state.projects.find(p => p.id === parentId)?.name) || undefined
	record.session.name =
		project?.terminal_names?.[terminalId] ?? project?.git_status?.branch ?? `terminal ${terminalId.slice(0, 8)}`
	record.session.branch = project?.git_status?.branch || undefined

	const detail = observed.detail
	if (!detail || detail.terminal_id !== terminalId) {
		// Fail closed: no fact, so nothing opens or closes for this session, and the
		// idle/busy stretch is broken (it may have changed unseen in between).
		setStatus(record, 'unknown', now)
		record.idleSince = undefined
		record.busySince = undefined
		record.gateCandidate = undefined
		return
	}
	if (existing !== undefined && now - existing.session.observedAt > OBSERVATION_GAP_MS) {
		record.idleSince = undefined
		record.busySince = undefined
		record.gateCandidate = undefined
	}
	// Last observed before a source restart/reconnect (epoch already bumped for this tick).
	const restarted = existing !== undefined && existing.epoch !== src.epoch
	const live = () => draft.liveItems(key)

	// A new Claude conversation in the same pane ends everything the old one owed.
	if (record.session.sessionId && detail.session_id && record.session.sessionId !== detail.session_id) {
		for (const item of live()) draft.resolve(item, 'session_ended')
		record.tail = { userAfterLastAssistant: false }
		record.idleSince = undefined
		record.busySince = undefined
		record.resumedTurn = undefined
		record.gateCandidate = undefined
		record.session.reply = undefined
	}
	record.session.sessionId = detail.session_id
	record.session.subagents = detail.running_subagents.length
	const background = backgroundOf(detail, observed.background)
	record.session.backgroundTasks = background.tasks
	record.session.backgroundShells = background.shells
	record.session.queuedPrompts = detail.queued_prompts
	record.session.prLinks = detail.pr_links.map(link => ({
		number: link.number,
		url: link.url,
		repository: link.repository,
	}))
	record.session.hasTranscript = detail.has_transcript
	record.session.hooksAttached = detail.hooks_attached
	record.session.channelAttached = detail.channel_attached
	record.session.observedAt = now
	record.epoch = src.epoch

	// Transcript: replies, orphan recovery.
	const page = observed.transcript
	if (page && page.session_id === detail.session_id) {
		const liveTurns = live().filter(item => item.fact.kind === 'turn')
		const orphanAnchor = record.tail.lastAssistant?.uuid
		const { repliedTurns, activity } = applyTranscript(
			record,
			page,
			new Set(liveTurns.map(item => (item.fact as DockTurnFact).assistantUuid)),
			now,
		)
		const newest = record.tail.lastAssistant?.uuid
		// A settled agent-detail reply (landed, refused, failed) says nothing about a newer message.
		const settled = record.session.reply
		if (
			settled &&
			newest !== orphanAnchor &&
			(settled.status === 'confirmed' || settled.status === 'refused' || settled.status === 'failed')
		)
			record.session.reply = undefined
		for (const item of liveTurns) {
			// An act still in flight cannot be attributed yet; the settle check below picks it up.
			if (isInFlight(item)) continue
			const fact = item.fact as DockTurnFact
			if (repliedTurns.has(fact.assistantUuid)) draft.close(item, 'replied')
			// The agent said something after the turn (a background wake, or a reset page whose
			// window no longer reaches the turn): it is not waiting on that message any more.
			// A dock reply already sent waits for its own user entry (or the ack) instead.
			else if (newest !== undefined && newest !== fact.assistantUuid && !isDispatched(item))
				draft.resolve(item, 'superseded')
		}
		// Unknown anchor (tail never read) proves nothing; a reset page alone is not new activity.
		const progressed = activity || (orphanAnchor !== undefined && record.tail.lastAssistant?.uuid !== orphanAnchor)
		if (progressed) {
			// An orphaned ask whose dialog is listed right now is still waiting (it reopens below).
			const open = new Set(detail.dialogs.map(dialog => dialog.id))
			for (const item of live()) {
				if (item.state !== 'orphaned' || (item.fact.kind === 'ask' && open.has(item.fact.dialogId))) continue
				draft.resolve(item, 'outside')
			}
		}
	}

	const status = deriveStatus(detail, background.tasks)
	setStatus(record, status, now)
	if (status === 'idle' || status === 'background') record.idleSince ??= now
	else if (status === 'working' || status === 'waiting') record.idleSince = undefined
	if (detail.busy === true) record.busySince ??= now
	else record.busySince = undefined
	// "Check it again": seen idle now, a reply refused as busy/untracked can simply be sent again,
	// so the pane and its strip entry stop reading as refused (the refusal stays while it holds).
	if (status === 'idle' || status === 'background') {
		for (const item of live()) if (item.state === 'open' && refusedNotFree(item.receipt)) item.receipt = undefined
		if (refusedNotFree(record.session.reply)) record.session.reply = undefined
	}
	// A dock reply already sent is waiting to show up as a user entry; seeing it closes the turn.
	for (const item of live()) {
		if (item.fact.kind !== 'turn' || !isDispatched(item)) continue
		if (record.tail.lastAssistant?.uuid === item.fact.assistantUuid && record.tail.userAfterLastAssistant)
			draft.confirm(item)
	}
	confirmSessionReply(record, now)
	// A turn means "the agent waits for you". Main agent busy past a short debounce, it plainly
	// does not (Jakub typed in the terminal and the entry was not read yet, or a background task
	// woke it): close it. A dock reply being sent or confirmed keeps its item until its own entry
	// is seen. A dialog with the main agent idle (background subagent) leaves the turn open.
	if (record.busySince !== undefined && now - record.busySince >= TURN_RESUMED_MS) {
		for (const item of live()) {
			if (item.fact.kind !== 'turn' || isDispatched(item) || isInFlight(item)) continue
			record.resumedTurn = { key: item.key, endedAt: item.fact.endedAt }
			draft.resolve(item, 'superseded')
		}
	}

	reconcileAsks(draft, record, key, detail, restarted, ctx.seedTick)
	settleGateCandidate(draft, record, key, status)
	maybeOpenTurn(draft, record, key, detail, status)
}

/**
 * The gate's held-back turn after this observation: still held (same idle stretch, same
 * message, no user entry) it stays; otherwise it ended without opening, and a resume, a newer
 * message or a reply logs `turn.gated` (a broken stretch was already dropped silently).
 */
function settleGateCandidate(
	draft: Draft,
	record: AgentDockSessionRecord,
	key: SessionKey,
	status: DockSessionStatus,
): void {
	const candidate = record.gateCandidate
	if (!candidate) return
	let by: DockTurnGated['by'] | undefined
	if (record.idleSince === undefined) by = status === 'waiting' ? 'waiting' : 'working'
	else if (record.idleSince !== candidate.idleSince) by = undefined
	else if (record.tail.lastAssistant?.uuid !== candidate.uuid) by = 'superseded'
	else if (record.tail.userAfterLastAssistant) by = 'replied'
	else return
	record.gateCandidate = undefined
	if (!by) return
	draft.diagnostics.push({
		t: 'turn.gated',
		at: draft.now,
		session: key,
		idleMs: draft.now - candidate.idleSince,
		seenIdleMs: candidate.lastIdleAt - candidate.idleSince,
		by,
	})
}

/**
 * A reply sent from the agent detail (no item) lands once the transcript shows a user entry
 * after the message Jakub replied to, or the agent already said something after it.
 */
function confirmSessionReply(record: AgentDockSessionRecord, now: number): void {
	const reply = record.session.reply
	if (!reply || (reply.status !== 'sent' && reply.status !== 'unconfirmed')) return
	const last = record.tail.lastAssistant?.uuid
	const landed =
		reply.assistantUuid === undefined
			? record.tail.userAfterLastAssistant
			: last !== undefined && (last !== reply.assistantUuid || record.tail.userAfterLastAssistant)
	if (landed) record.session.reply = { ...reply, status: 'confirmed', at: now }
}

/**
 * Asks: one item per dialog; vanished → answered elsewhere (or Jakub's dock answer
 * landing), or orphaned across a source restart.
 */
function reconcileAsks(
	draft: Draft,
	record: AgentDockSessionRecord,
	key: SessionKey,
	detail: OkenaClaudeSession,
	restarted: boolean,
	seedTick: boolean,
): void {
	const { now } = draft
	const src = draft.src(record.session.source)
	record.dialogIds = detail.dialogs.map(dialog => dialog.id)
	const present = new Set<string>()
	for (const dialog of detail.dialogs) {
		const itemKey = `ask:${key}:${dialog.id}`
		present.add(itemKey)
		if (draft.hasKey(itemKey)) {
			const item = draft.state.items.find(candidate => candidate.key === itemKey)
			// Orphaned while its profile was not polled (or across a reconnect), and the source
			// lists the same dialog again: the agent still waits, so it owes Jakub again.
			if (item?.state === 'orphaned') draft.reopen(item)
			// Okena removes the dialog before acting on a decision, so an unconfirmed
			// answer whose dialog is still open well after it was sent never landed:
			// the agent still waits, so the item owes Jakub again.
			else if (
				item?.state === 'unconfirmed' &&
				item.receipt?.status === 'unconfirmed' &&
				now - item.receipt.at >= ACT_CONFIRM_MS
			) {
				item.state = 'open'
				item.receipt = {
					...item.receipt,
					status: 'failed',
					at: now,
					detail: 'Not delivered: the dialog is still open. Answer again.',
				}
				draft.outcome(item, 'failed')
			}
			continue
		}
		draft.open(
			{
				key: itemKey,
				kind: 'ask',
				session: key,
				fact: {
					kind: 'ask',
					dialogId: dialog.id,
					tool: dialog.tool_name,
					input: dialog.tool_input,
					...(dialog.permission_suggestions.length > 0
						? { suggestions: dialog.permission_suggestions.slice(0, PERMISSION_SUGGESTIONS_MAX) }
						: {}),
					...(dialog.permission_suggestions.length > PERMISSION_SUGGESTIONS_MAX
						? { suggestionsTruncated: true as const }
						: {}),
					createdAtMs: dialog.created_at_ms,
				},
			},
			seedTick,
		)
	}
	for (const item of draft.liveItems(key)) {
		if (item.fact.kind !== 'ask' || present.has(item.key) || isInFlight(item)) continue
		// Okena took Jakub's decision (decide() removes the dialog first): its close is his answer.
		if (isDispatched(item)) {
			draft.confirm(item)
			continue
		}
		if (item.state !== 'open') continue
		const hub = src.hubPrefix
		if (restarted || (hub !== undefined && okenaDialogPrefix(item.fact.dialogId) !== hub)) draft.orphan(item)
		else draft.resolve(item, 'outside')
	}
}

/** Turns: the transcript's last assistant message opens one, after a stable idle stretch. */
function maybeOpenTurn(
	draft: Draft,
	record: AgentDockSessionRecord,
	key: SessionKey,
	detail: OkenaClaudeSession,
	status: DockSessionStatus,
): void {
	const { now } = draft
	const last = record.tail.lastAssistant
	const tailKnown = detail.has_transcript && record.tail.cursor !== undefined
	// Re-derived on every observation: only the gate branch below holds a turn back.
	record.gateCandidate = undefined
	// Silent seed adoption covers only what already existed when Helm first saw the pane
	// AND only while the pane has stayed idle since. Nothing to adopt (no transcript at the
	// seed tick) or any busy/dialog observation in between means a later turn is new.
	if (record.seedPending && (!detail.has_transcript || status === 'working' || status === 'waiting')) {
		record.seedPending = false
	}
	if (!last || !tailKnown || record.tail.userAfterLastAssistant || (status !== 'idle' && status !== 'background')) {
		if (tailKnown) record.seedPending = false
		return
	}
	const seen = draft.state.seen[key]
	if (record.seedPending) {
		record.seedPending = false
		// First-ever observation of this pane: adopt silently, like a tab that was never seen running.
		if (seen === undefined) {
			draft.state.seen[key] = last.uuid
			return
		}
	} else if (record.idleSince === undefined || now - record.idleSince < TURN_IDLE_MS) {
		// Held back by the gate: remember it, so the watcher ticks again right when it can open.
		const itemKey = `turn:${detail.session_id ?? key}:${last.uuid}`
		const opens = last.uuid !== seen && (!draft.hasKey(itemKey) || record.resumedTurn?.key === itemKey)
		if (opens && record.idleSince !== undefined)
			record.gateCandidate = { uuid: last.uuid, idleSince: record.idleSince, lastIdleAt: now }
		return
	}
	if (last.uuid === seen) return
	const itemKey = `turn:${detail.session_id ?? key}:${last.uuid}`
	// Closed only because the agent went back to work, and it stopped at that same message
	// again with no reply in between: it waits for Jakub again, as a new item.
	const resumed = record.resumedTurn?.key === itemKey ? record.resumedTurn : undefined
	if (draft.hasKey(itemKey) && resumed === undefined) return
	record.resumedTurn = undefined
	for (const item of draft.liveItems(key))
		if (item.fact.kind === 'turn' && !isInFlight(item)) draft.close(item, 'superseded')
	draft.open(
		{
			key: itemKey,
			kind: 'turn',
			session: key,
			fact: {
				kind: 'turn',
				sessionId: detail.session_id,
				assistantUuid: last.uuid,
				text: boundText(last.text, TURN_TEXT_MAX),
				endedAt: resumed?.endedAt ?? record.idleSince ?? now,
				hadBackground: status === 'background',
			},
		},
		false,
	)
}

function reducePoll(draft: Draft, observation: Extract<AgentDockObservation, { type: 'poll' }>): void {
	const { now } = draft
	const id = observation.source
	if (!observation.state.ok) {
		sourceDown(draft, id, observation.state.error)
		return
	}
	const parsedState = parseOkenaState(observation.state.body)
	if (!parsedState.ok) {
		sourceDown(draft, id, parsedState.error)
		return
	}
	const okenaState = parsedState.value
	const src = draft.src(id)

	const seedTick = !src.seeded
	const reconnected = src.health.state === 'down' && src.health.lastObservedAt !== null
	const regressed = src.stateVersion !== undefined && okenaState.state_version < src.stateVersion

	const details = new Map<
		string,
		{
			detail: OkenaClaudeSession | null
			transcript: OkenaClaudeTranscriptPage | null
			background?: ObservedBackgroundTasks
		}
	>()
	for (const terminal of observation.terminals) {
		const detail = terminal.detail.ok ? parseOkenaClaudeSession(terminal.detail.body) : null
		const transcript = terminal.transcript?.ok ? parseOkenaClaudeTranscriptPage(terminal.transcript.body) : null
		details.set(terminal.terminalId, {
			detail: detail?.ok ? detail.value : null,
			transcript: transcript?.ok ? transcript.value : null,
			...(validBackground(terminal.background) ? { background: terminal.background } : {}),
		})
	}

	// Okena hub restart: dialog ids carry a per-hub-start prefix.
	const newest = [...details.values()]
		.flatMap(entry => entry.detail?.dialogs ?? [])
		.sort((a, b) => b.created_at_ms - a.created_at_ms)[0]
	const prefix = newest ? okenaDialogPrefix(newest.id) : undefined
	const prefixChanged = prefix !== undefined && src.hubPrefix !== undefined && prefix !== src.hubPrefix
	if (prefix !== undefined) src.hubPrefix = prefix
	if (reconnected || regressed || prefixChanged) src.epoch += 1

	draft.health(id, { state: 'ok', since: now, lastObservedAt: now }, !seedTick)
	src.stateVersion = okenaState.state_version
	src.seeded = true

	const ctx: TickContext = { source: id, profile: observation.profile, state: okenaState, seedTick }
	const candidates = okenaClaudeCandidates(okenaState)
	for (const terminalId of candidates) {
		observeTerminal(draft, ctx, terminalId, details.get(terminalId) ?? { detail: null, transcript: null })
	}

	const listed = new Set(candidates.map(terminalId => sessionKey(observation.profile, terminalId)))
	for (const [key, record] of Object.entries(draft.state.sessions)) {
		if (record.session.source !== id) continue
		// Another profile is polled now (Okena `last_used` changed, Helm switched its session
		// profile): its agent may still run there, it is just not observed.
		if (record.session.profile !== observation.profile) {
			unobserved(draft, key, record)
			continue
		}
		if (listed.has(key)) continue
		if (record.epoch === src.epoch) {
			// Gone within one source epoch: SessionEnd or pane closed.
			for (const item of draft.liveItems(key)) draft.resolve(item, 'session_ended')
			delete draft.state.sessions[key]
			continue
		}
		// Last seen before a restart/reconnect: may not be relisted until its next step.
		// Its dialog ids died with the old hub.
		unobserved(draft, key, record)
	}
}

/**
 * A session the source no longer shows (another profile is polled, or it was last seen
 * before a restart/reconnect). Never resolve from absence: open asks orphan (ackable, and
 * they reopen if the same dialog is listed again), turns stay, and the row reads unknown
 * until it is seen again (or goes once nothing is live).
 */
function unobserved(draft: Draft, key: SessionKey, record: AgentDockSessionRecord): void {
	record.dialogIds = undefined
	record.gateCandidate = undefined
	const live = draft.liveItems(key)
	for (const item of live) if (item.fact.kind === 'ask') draft.orphan(item)
	if (live.length === 0) delete draft.state.sessions[key]
	else setStatus(record, 'unknown', draft.now)
}

function reduceAck(draft: Draft, itemId: number): void {
	const item = draft.state.items.find(candidate => candidate.id === itemId)
	// An open ask closes only when Okena shows its dialog gone; acking it would hide a waiting agent.
	// An answer being sent is not ackable either; once unconfirmed, Jakub may check the terminal and ack
	// (an unconfirmed ask only once Okena no longer shows its dialog: see below).
	if (!item || item.state === 'resolved' || item.state === 'sending') return
	if (item.fact.kind === 'ask' && item.state === 'open') return
	// An unconfirmed answer whose dialog Okena still shows may never have landed: acking it would hide a blocked agent.
	if (
		item.fact.kind === 'ask' &&
		item.state === 'unconfirmed' &&
		draft.state.sessions[item.session]?.dialogIds?.includes(item.fact.dialogId)
	)
		return
	if (item.fact.kind === 'turn') draft.state.seen[item.session] = item.fact.assistantUuid
	draft.resolve(item, 'acked')
}

function reduceActSending(draft: Draft, itemId: number, action: DockActionKind, always: boolean | undefined): void {
	const item = draft.state.items.find(candidate => candidate.id === itemId)
	if (!item || item.state !== 'open') return
	item.state = 'sending'
	item.receipt = { action, ...(always ? { always: true } : {}), status: 'sending', at: draft.now }
}

function reduceActResult(draft: Draft, itemId: number, outcome: DockActOutcome): void {
	const item = draft.state.items.find(candidate => candidate.id === itemId)
	if (!item?.receipt || item.receipt.status !== 'sending') return
	const receipt = item.receipt
	const live = isLive(item)
	if (outcome.status === 'sent') {
		item.receipt = {
			...receipt,
			status: 'sent',
			at: draft.now,
			sentAt: draft.now,
			...(outcome.delivery ? { delivery: outcome.delivery } : {}),
		}
		return
	}
	if (outcome.status === 'unconfirmed') {
		item.receipt = { ...receipt, status: 'unconfirmed', at: draft.now, sentAt: draft.now, detail: outcome.detail }
		if (live) item.state = 'unconfirmed'
		draft.outcome(item, 'unconfirmed')
		return
	}
	item.receipt = {
		...receipt,
		status: outcome.status,
		at: draft.now,
		detail: outcome.detail,
		...(outcome.status === 'refused' ? { reason: outcome.reason } : {}),
	}
	// Nothing reached the agent: the item owes Jakub again (the next poll resolves it if it closed elsewhere).
	if (live) item.state = 'open'
	draft.outcome(item, outcome.status)
}

/** Jakub replied from the agent detail: the reply is on its way (the message he read counts as seen). */
function reducePromptSending(draft: Draft, key: SessionKey, assistantUuid: string | undefined): void {
	const record = draft.state.sessions[key]
	if (!record) return
	record.session.reply = {
		action: 'prompt',
		status: 'sending',
		at: draft.now,
		...(assistantUuid ? { assistantUuid } : {}),
	}
	// Only the message the reducer holds as the last one: an older uuid (a stale live read) never
	// moves `seen` back, which would reopen a turn Jakub already acked.
	if (assistantUuid && record.tail.lastAssistant?.uuid === assistantUuid) draft.state.seen[key] = assistantUuid
}

function reducePromptResult(draft: Draft, key: SessionKey, outcome: DockActOutcome): void {
	const record = draft.state.sessions[key]
	const reply = record?.session.reply
	if (!record || reply?.status !== 'sending') return
	const { now } = draft
	if (outcome.status === 'sent')
		record.session.reply = {
			...reply,
			status: 'sent',
			at: now,
			sentAt: now,
			...(outcome.delivery ? { delivery: outcome.delivery } : {}),
		}
	else if (outcome.status === 'unconfirmed')
		record.session.reply = { ...reply, status: 'unconfirmed', at: now, sentAt: now, detail: outcome.detail }
	else
		record.session.reply = {
			...reply,
			status: outcome.status,
			at: now,
			detail: outcome.detail,
			...(outcome.status === 'refused' ? { reason: outcome.reason } : {}),
		}
}

/** Sent but not observed for ACT_CONFIRM_MS: amber "sent, unconfirmed" until observed or acked. */
function expireUnconfirmed(draft: Draft): void {
	for (const record of Object.values(draft.state.sessions)) {
		const reply = record.session.reply
		if (reply?.status !== 'sent' || reply.sentAt === undefined || draft.now - reply.sentAt < ACT_CONFIRM_MS) continue
		record.session.reply = { ...reply, status: 'unconfirmed', at: draft.now }
	}
	for (const item of draft.state.items) {
		const receipt = item.receipt
		if (item.state !== 'sending' || receipt?.status !== 'sent' || receipt.sentAt === undefined) continue
		if (draft.now - receipt.sentAt < ACT_CONFIRM_MS) continue
		item.state = 'unconfirmed'
		item.receipt = { ...receipt, status: 'unconfirmed', at: draft.now }
		draft.outcome(item, 'unconfirmed')
	}
}

export function reduce(prev: AgentDockState, observation: AgentDockObservation, now: number): AgentDockReduction {
	const draft = new Draft(prev, now)
	if (observation.type === 'ack') reduceAck(draft, observation.itemId)
	else if (observation.type === 'act.sending')
		reduceActSending(draft, observation.itemId, observation.action, observation.always)
	else if (observation.type === 'act.result') reduceActResult(draft, observation.itemId, observation.outcome)
	else if (observation.type === 'prompt.sending')
		reducePromptSending(draft, observation.session, observation.assistantUuid)
	else if (observation.type === 'prompt.result') reducePromptResult(draft, observation.session, observation.outcome)
	else {
		reducePoll(draft, observation)
		expireUnconfirmed(draft)
	}
	draft.state.source = aggregateSourceHealth(draft.state.sources, draft.state.source)
	draft.state.items = pruneResolved(draft.state.items, now)
	return { state: draft.state, events: draft.events, diagnostics: draft.diagnostics }
}

/** Sessions of a source that answered its last poll (down/pending sources freeze their rows). */
function observedRecords(state: AgentDockState): AgentDockSessionRecord[] {
	return Object.values(state.sessions).filter(record => state.sources[record.session.source]?.health.state === 'ok')
}

/**
 * Whether some agent is doing something the dock should see within a second (watcher cadence):
 * main agent busy or working, a dialog open, a turn held by the idle gate, or a dock answer
 * or agent-detail reply sent and waiting to be observed.
 */
export function agentDockActive(state: AgentDockState): boolean {
	for (const record of observedRecords(state)) {
		const status = record.session.status
		if (status === 'working' || status === 'waiting') return true
		if (record.busySince !== undefined || (record.dialogIds?.length ?? 0) > 0) return true
		if (record.gateCandidate && (status === 'idle' || status === 'background')) return true
		if (record.session.reply?.status === 'sent') return true
	}
	return state.items.some(item => isLive(item) && item.receipt?.status === 'sent')
}

/**
 * The earliest time after `now` at which a poll decides a turn without new source data: a
 * held turn passing TURN_IDLE_MS, or a live turn's busy stretch passing TURN_RESUMED_MS. The
 * watcher ticks right then (settle timer) instead of on its next cadence tick.
 */
export function agentDockNextDeadline(state: AgentDockState, now: number): number | undefined {
	let next: number | undefined
	const consider = (at: number) => {
		if (at > now && (next === undefined || at < next)) next = at
	}
	for (const record of observedRecords(state)) {
		if (record.gateCandidate && record.idleSince === record.gateCandidate.idleSince)
			consider(record.gateCandidate.idleSince + TURN_IDLE_MS)
		if (
			record.busySince !== undefined &&
			state.items.some(
				item =>
					item.session === record.session.key &&
					item.fact.kind === 'turn' &&
					isLive(item) &&
					!isDispatched(item) &&
					!isInFlight(item),
			)
		)
			consider(record.busySince + TURN_RESUMED_MS)
	}
	return next
}
