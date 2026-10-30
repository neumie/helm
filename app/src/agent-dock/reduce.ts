// Pure agent-dock reducer: (state, observation, now) → { state, events }.
// No IO, no clocks, no mutation of `prev`. See docs in model.ts and the design
// (§3 lifecycle, §4 freshness/answered-elsewhere/Okena restart).

import {
	ACT_CONFIRM_MS,
	type AgentDockEvent,
	type AgentDockObservation,
	type AgentDockPersisted,
	type AgentDockSnapshot,
	type AgentDockSourceHealth,
	type DockActOutcome,
	type DockActionKind,
	type DockItem,
	type DockResolutionBy,
	type DockSession,
	type DockSessionStatus,
	type DockTurnFact,
	type OkenaClaudeSession,
	type OkenaClaudeTranscriptPage,
	type OkenaState,
	PERMISSION_SUGGESTIONS_MAX,
	type SessionKey,
	okenaClaudeCandidates,
	okenaDialogPrefix,
	okenaTerminalProject,
	parseOkenaClaudeSession,
	parseOkenaClaudeTranscriptPage,
	parseOkenaState,
	sessionKey,
} from './model'

/** A session must stay idle this long before an unchecked turn opens (filters quick resumes). */
export const TURN_IDLE_MS = 8_000
/** Turn excerpt bound (memory only). */
export const TURN_TEXT_MAX = 2_048
/** Resolved items are kept for the Recent lane and dedupe, bounded by age and count. */
export const RESOLVED_RETENTION_MS = 24 * 60 * 60 * 1000
export const RESOLVED_MAX = 50

interface TranscriptTail {
	sessionId?: string
	cursor?: number
	lastAssistant?: { uuid: string; text: string }
	/** A user entry was seen after lastAssistant (any origin). */
	userAfterLastAssistant: boolean
}

export interface AgentDockSessionRecord {
	session: DockSession
	/** Okena epoch this session was last observed in; older = seen before an Okena restart/reconnect. */
	epoch: number
	/** Status from the last successful detail read (the displayed status may be `unreachable`). */
	observedStatus?: DockSessionStatus
	/** First observation of the current idle/background stretch. */
	idleSince?: number
	/** Present at the seed tick and its turn not yet evaluated against persisted `seen`. */
	seedPending: boolean
	tail: TranscriptTail
	/** Dialog ids the last successful detail read showed open. */
	dialogIds?: string[]
}

export interface AgentDockState {
	/** False until the first successful `/v1/state`; that tick is the seed. */
	seeded: boolean
	/** Bumped on reconnect after down, `state_version` regression, or dialog-prefix change. */
	epoch: number
	nextItemId: number
	stateVersion?: number
	hubPrefix?: string
	source: AgentDockSourceHealth
	sessions: Record<SessionKey, AgentDockSessionRecord>
	items: DockItem[]
	/** Last assistant uuid Jakub has seen (acked) per session. Persisted. */
	seen: Record<SessionKey, string>
}

export interface AgentDockReduction {
	state: AgentDockState
	events: AgentDockEvent[]
}

export function createAgentDockState(persisted?: AgentDockPersisted | null, now = 0): AgentDockState {
	return {
		seeded: false,
		epoch: 0,
		nextItemId: persisted?.nextItemId ?? 1,
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
 * When the item started owing Jakub (same rule as the renderer's itemWaitingSince,
 * which cannot value-import this module): the dialog's own timestamp, else when the
 * turn ended, else first observed. Live items sort oldest-waiting first on this.
 */
function waitingSince(item: DockItem): number {
	if (item.fact.kind === 'ask' && item.fact.createdAtMs > 0) return Math.min(item.fact.createdAtMs, item.openedAt)
	if (item.fact.kind === 'turn') return item.fact.endedAt
	return item.openedAt
}

/** Sending/unconfirmed items keep their place, so a card never jumps while its answer lands. */
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
		return waitingSince(a) - waitingSince(b) || a.id - b.id
	})
	const sessions = Object.values(state.sessions)
		.map(record => ({ ...record.session, prLinks: [...record.session.prLinks] }))
		.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
	return { generatedAt: now, source: { ...state.source }, sessions, items }
}

/** Strip C0/C1 controls except tab/newline, then bound by UTF-16 length without splitting a surrogate pair. */
export function boundAgentText(text: string, max = TURN_TEXT_MAX): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
	const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
	if (clean.length <= max) return clean
	let end = max - 1
	const code = clean.charCodeAt(end - 1)
	if (code >= 0xd800 && code <= 0xdbff) end -= 1
	return `${clean.slice(0, end)}…`
}

const isLive = (item: DockItem): boolean => item.state !== 'resolved'
/** Okena accepted Jakub's dock answer (sent, maybe unconfirmed): the next observed close is his. */
const isDispatched = (item: DockItem): boolean =>
	(item.state === 'sending' || item.state === 'unconfirmed') &&
	(item.receipt?.status === 'sent' || item.receipt?.status === 'unconfirmed')
/** The act's CAS read/POST is still running: an observed close cannot be attributed yet. */
const isInFlight = (item: DockItem): boolean => item.state === 'sending' && item.receipt?.status === 'sending'

function deriveStatus(detail: OkenaClaudeSession): DockSessionStatus {
	if (detail.dialogs.length > 0) return 'waiting'
	if (detail.busy === true) return 'working'
	if (detail.busy === false) return detail.running_subagents.length > 0 ? 'background' : 'idle'
	return 'unknown'
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
	readonly state: AgentDockState

	constructor(
		prev: AgentDockState,
		readonly now: number,
	) {
		this.state = {
			...prev,
			source: { ...prev.source },
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

	open(item: Omit<DockItem, 'id' | 'openedAt' | 'state' | 'rev'>, silent: boolean): DockItem {
		const opened: DockItem = { ...item, id: this.state.nextItemId++, rev: 1, openedAt: this.now, state: 'open' }
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

	health(next: AgentDockSourceHealth, emit: boolean): void {
		const changed = this.state.source.state !== next.state
		this.state.source = changed ? next : { ...next, since: this.state.source.since }
		if (changed && emit && next.state !== 'pending') {
			this.events.push({ t: 'source.health', at: this.now, state: next.state, detail: next.detail })
		}
	}
}

function setStatus(record: AgentDockSessionRecord, status: DockSessionStatus, now: number): void {
	if (record.observedStatus !== status) record.session.since = now
	record.observedStatus = status
	record.session.status = status
}

function sourceDown(draft: Draft, detail: string): void {
	draft.health(
		{ state: 'down', since: draft.now, lastObservedAt: draft.state.source.lastObservedAt, detail },
		draft.state.source.state !== 'down',
	)
	// Freeze: rows go grey with their age; no item opens, orphans or resolves from missing data.
	for (const record of Object.values(draft.state.sessions)) record.session.status = 'unreachable'
}

/** Applies one transcript page; returns whether a user entry followed each live turn's assistant uuid. */
function applyTranscript(
	record: AgentDockSessionRecord,
	page: OkenaClaudeTranscriptPage,
	liveTurnUuids: Set<string>,
): { repliedTurns: Set<string>; activity: boolean } {
	const tail: TranscriptTail = page.reset ? { userAfterLastAssistant: false } : { ...record.tail }
	// On a continuation every live turn's uuid is already behind the cursor.
	const passed = new Set(page.reset ? [] : liveTurnUuids)
	const repliedTurns = new Set<string>()
	let activity = false
	for (const entry of page.entries) {
		if (entry.kind === 'assistant') {
			tail.lastAssistant = { uuid: entry.uuid, text: entry.text }
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
	profile: string
	state: OkenaState
	seedTick: boolean
}

function observeTerminal(
	draft: Draft,
	ctx: TickContext,
	terminalId: string,
	observed: { detail: OkenaClaudeSession | null; transcript: OkenaClaudeTranscriptPage | null },
): void {
	const { now } = draft
	const key = sessionKey(ctx.profile, terminalId)
	const project = okenaTerminalProject(ctx.state, terminalId)
	const existing = draft.state.sessions[key]
	const record: AgentDockSessionRecord = existing ?? {
		epoch: draft.state.epoch,
		seedPending: ctx.seedTick,
		tail: { userAfterLastAssistant: false },
		session: {
			key,
			profile: ctx.profile,
			terminalId,
			project: '',
			name: '',
			status: 'unknown',
			since: now,
			observedAt: now,
			subagents: 0,
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
	record.session.name =
		project?.terminal_names?.[terminalId] ?? project?.git_status?.branch ?? `terminal ${terminalId.slice(0, 8)}`

	const detail = observed.detail
	if (!detail || detail.terminal_id !== terminalId) {
		// Fail closed: no fact, so nothing opens or closes for this session.
		setStatus(record, 'unknown', now)
		return
	}
	// Last observed before an Okena restart/reconnect (epoch already bumped for this tick).
	const restarted = existing !== undefined && existing.epoch !== draft.state.epoch
	const live = () => draft.liveItems(key)

	// A new Claude conversation in the same pane ends everything the old one owed.
	if (record.session.sessionId && detail.session_id && record.session.sessionId !== detail.session_id) {
		for (const item of live()) draft.resolve(item, 'session_ended')
		record.tail = { userAfterLastAssistant: false }
		record.idleSince = undefined
	}
	record.session.sessionId = detail.session_id
	record.session.subagents = detail.running_subagents.length
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
	record.epoch = draft.state.epoch

	// Transcript: replies, orphan recovery.
	const page = observed.transcript
	if (page && page.session_id === detail.session_id) {
		const liveTurns = live().filter(item => item.fact.kind === 'turn')
		const orphanAnchor = record.tail.lastAssistant?.uuid
		const { repliedTurns, activity } = applyTranscript(
			record,
			page,
			new Set(liveTurns.map(item => (item.fact as DockTurnFact).assistantUuid)),
		)
		for (const item of liveTurns) {
			// An act still in flight cannot be attributed yet; the settle check below picks it up.
			if (repliedTurns.has((item.fact as DockTurnFact).assistantUuid) && !isInFlight(item)) draft.close(item, 'replied')
		}
		// Unknown anchor (tail never read) proves nothing; a reset page alone is not new activity.
		const progressed = activity || (orphanAnchor !== undefined && record.tail.lastAssistant?.uuid !== orphanAnchor)
		if (progressed) {
			for (const item of live()) if (item.state === 'orphaned') draft.resolve(item, 'outside')
		}
	}

	const status = deriveStatus(detail)
	setStatus(record, status, now)
	if (status === 'idle' || status === 'background') record.idleSince ??= now
	else if (status === 'working' || status === 'waiting') record.idleSince = undefined
	// A dock reply already sent is waiting to show up as a user entry; seeing it closes the turn.
	for (const item of live()) {
		if (item.fact.kind !== 'turn' || !isDispatched(item)) continue
		if (record.tail.lastAssistant?.uuid === item.fact.assistantUuid && record.tail.userAfterLastAssistant)
			draft.confirm(item)
	}
	if (status === 'working') {
		for (const item of live()) {
			if (item.fact.kind !== 'turn' || record.tail.userAfterLastAssistant || isDispatched(item) || isInFlight(item))
				continue
			if (item.fact.continuedAt === undefined) {
				item.fact.continuedAt = now
				item.rev += 1
			}
		}
	}

	// Asks: one item per Okena dialog; vanished → answered elsewhere, or orphaned across a restart.
	record.dialogIds = detail.dialogs.map(dialog => dialog.id)
	const present = new Set<string>()
	for (const dialog of detail.dialogs) {
		const itemKey = `ask:${key}:${dialog.id}`
		present.add(itemKey)
		if (draft.hasKey(itemKey)) {
			// Okena removes the dialog before acting on a decision, so an unconfirmed
			// answer whose dialog is still open well after it was sent never landed:
			// the agent still waits, so the item owes Jakub again.
			const item = draft.state.items.find(candidate => candidate.key === itemKey)
			if (
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
			ctx.seedTick,
		)
	}
	for (const item of live()) {
		if (item.fact.kind !== 'ask' || present.has(item.key) || isInFlight(item)) continue
		// Okena took Jakub's decision (decide() removes the dialog first): its close is his answer.
		if (isDispatched(item)) {
			draft.confirm(item)
			continue
		}
		if (item.state !== 'open') continue
		const hub = draft.state.hubPrefix
		if (restarted || (hub !== undefined && okenaDialogPrefix(item.fact.dialogId) !== hub)) draft.orphan(item)
		else draft.resolve(item, 'outside')
	}

	// Turns: the transcript's last assistant message, after a stable idle stretch.
	const last = record.tail.lastAssistant
	const tailKnown = detail.has_transcript && record.tail.cursor !== undefined
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
		return
	}
	if (last.uuid === seen) return
	const itemKey = `turn:${detail.session_id ?? key}:${last.uuid}`
	if (draft.hasKey(itemKey)) return
	for (const item of live()) if (item.fact.kind === 'turn' && !isInFlight(item)) draft.close(item, 'superseded')
	draft.open(
		{
			key: itemKey,
			kind: 'turn',
			session: key,
			fact: {
				kind: 'turn',
				sessionId: detail.session_id,
				assistantUuid: last.uuid,
				text: boundAgentText(last.text),
				endedAt: record.idleSince ?? now,
				hadBackground: status === 'background',
			},
		},
		false,
	)
}

function reducePoll(draft: Draft, observation: Extract<AgentDockObservation, { type: 'poll' }>): void {
	const { now } = draft
	if (!observation.state.ok) {
		sourceDown(draft, observation.state.error)
		return
	}
	const parsedState = parseOkenaState(observation.state.body)
	if (!parsedState.ok) {
		sourceDown(draft, parsedState.error)
		return
	}
	const okenaState = parsedState.value

	const seedTick = !draft.state.seeded
	const reconnected = draft.state.source.state === 'down' && draft.state.source.lastObservedAt !== null
	const regressed = draft.state.stateVersion !== undefined && okenaState.state_version < draft.state.stateVersion

	const details = new Map<string, { detail: OkenaClaudeSession | null; transcript: OkenaClaudeTranscriptPage | null }>()
	for (const terminal of observation.terminals) {
		const detail = terminal.detail.ok ? parseOkenaClaudeSession(terminal.detail.body) : null
		const transcript = terminal.transcript?.ok ? parseOkenaClaudeTranscriptPage(terminal.transcript.body) : null
		details.set(terminal.terminalId, {
			detail: detail?.ok ? detail.value : null,
			transcript: transcript?.ok ? transcript.value : null,
		})
	}

	// Okena hub restart: dialog ids carry a per-hub-start prefix.
	const newest = [...details.values()]
		.flatMap(entry => entry.detail?.dialogs ?? [])
		.sort((a, b) => b.created_at_ms - a.created_at_ms)[0]
	const prefix = newest ? okenaDialogPrefix(newest.id) : undefined
	const prefixChanged = prefix !== undefined && draft.state.hubPrefix !== undefined && prefix !== draft.state.hubPrefix
	if (prefix !== undefined) draft.state.hubPrefix = prefix
	if (reconnected || regressed || prefixChanged) draft.state.epoch += 1

	draft.health({ state: 'ok', since: now, lastObservedAt: now }, !seedTick)
	draft.state.stateVersion = okenaState.state_version
	draft.state.seeded = true

	const ctx: TickContext = { profile: observation.profile, state: okenaState, seedTick }
	const candidates = okenaClaudeCandidates(okenaState)
	for (const terminalId of candidates) {
		observeTerminal(draft, ctx, terminalId, details.get(terminalId) ?? { detail: null, transcript: null })
	}

	const listed = new Set(candidates.map(terminalId => sessionKey(observation.profile, terminalId)))
	for (const [key, record] of Object.entries(draft.state.sessions)) {
		if (record.session.profile !== observation.profile || listed.has(key)) continue
		const live = draft.liveItems(key)
		if (record.epoch === draft.state.epoch) {
			// Gone within one Okena epoch: SessionEnd or pane closed.
			for (const item of live) draft.resolve(item, 'session_ended')
			delete draft.state.sessions[key]
			continue
		}
		// Last seen before a restart/reconnect: may not be relisted until its next step. Never resolve from absence.
		// Its dialog ids died with the old hub.
		record.dialogIds = undefined
		for (const item of live) if (item.fact.kind === 'ask') draft.orphan(item)
		if (live.length === 0) delete draft.state.sessions[key]
		else setStatus(record, 'unknown', now)
	}
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

/** Sent but not observed for ACT_CONFIRM_MS: amber "sent, unconfirmed" until observed or acked. */
function expireUnconfirmed(draft: Draft): void {
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
	else {
		reducePoll(draft, observation)
		expireUnconfirmed(draft)
	}
	draft.state.items = pruneResolved(draft.state.items, now)
	return { state: draft.state, events: draft.events }
}
