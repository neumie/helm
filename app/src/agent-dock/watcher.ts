// Agent dock watcher (Electron main side, but no Electron import: main.ts
// injects publish/focus so this stays unit-testable under node --test).
//
// Cadence: 1.5 s while some renderer shows the dock AND Helm is focused, 5 s
// while shown but unfocused, and a 5 s background tick while hidden. The
// background tick is deliberate: `helm dock watch` (the dispatcher's event
// stream) must still get events while the dock is collapsed, and one GET
// /v1/state + per-pane detail every 5 s is cheap. Ticks never overlap.
//
// Disk (`<userData>/agent-dock`, 0700; files 0600, atomic replace):
//   state.json     counters (item id, event seq), seen assistant uuids, 24 h resolved ledger (heads only)
//   snapshot.json  spool view for the CLI; rewritten on change or every SNAPSHOT_REFRESH_MS
//   events.ndjson  appended events, ≤300-char lines, monotonic seq, rotated per local day
// Transcript text, dialog `tool_input` and dock answer text never reach disk
// (receipts keep only the action kind and status). Transcript cursors
// are intentionally NOT persisted: the reducer's restart seed needs a fresh
// first page to learn each pane's last assistant message (a restored cursor
// would skip it and lose "turn finished while Helm was closed").

import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
	ITEM_HEAD_MAX,
	SPOOL_EVENTS_FILE,
	SPOOL_SNAPSHOT_FILE,
	SPOOL_STATE_FILE,
	type SpoolItem,
	type SpoolSnapshot,
	appendPrivateText,
	ensurePrivateDir,
	formatEventLine,
	oneLine,
	readSpoolFile,
	rotateSpoolEvents,
	spoolHighWater,
	spoolItemSchema,
	writePrivateFileAtomic,
} from '../../../src/agent-dock/spool'
import { REFUSAL_TEXT } from './act'
import {
	type AgentDockActResult,
	type AgentDockEvent,
	type AgentDockObservation,
	type AgentDockSnapshot,
	type DockActOutcome,
	type DockAction,
	type DockItem,
	type DockRefusalReason,
	type DockSession,
	type DockSourceId,
	agentDockPersistedSchema,
	parseAgentDockActRequest,
} from './model'
import {
	type AgentDockState,
	RESOLVED_RETENTION_MS,
	agentDockPersisted,
	agentDockSnapshot,
	createAgentDockState,
	reduce,
} from './reduce'

export const FOCUSED_INTERVAL_MS = 1_500
export const UNFOCUSED_INTERVAL_MS = 5_000
export const BACKGROUND_INTERVAL_MS = 5_000
export const SNAPSHOT_REFRESH_MS = 10_000
export const LEDGER_MAX = 200

const watcherStateSchema = agentDockPersistedSchema.extend({
	nextSeq: z.number().int().positive().default(1),
	ledger: z.array(spoolItemSchema).default([]),
})
type WatcherPersisted = z.infer<typeof watcherStateSchema>

/** The pane an act or expedite targets; `source` routes it (composite-source.ts). */
export interface AgentDockTarget {
	source: DockSourceId
	profile: string
	terminalId: string
}

export interface AgentDockObservationSource {
	/** One tick: a poll per source (the composite returns one per source). */
	observe(state: AgentDockState, now: number): Promise<AgentDockObservation | AgentDockObservation[]>
	/** Slice 2: CAS read + source write for one dock answer. Absent = the dock cannot answer. */
	act?(target: AgentDockTarget, item: DockItem, action: DockAction): Promise<DockActOutcome>
	/** Read this pane's transcript every tick until `until` (a dock reply waits to be seen). */
	expedite?(target: AgentDockTarget, until: number): void
}

/** How long after a sent dock reply the source keeps reading that pane's transcript. */
export const ACT_EXPEDITE_MS = 20_000

export interface AgentDockWatcherOptions {
	/** `<userData>/agent-dock`. */
	dir: string
	source: AgentDockObservationSource
	/** Push to the renderer (main.ts: webContents send on AGENT_DOCK_IPC.snapshot). */
	publish(snapshot: AgentDockSnapshot): void
	isFocused(): boolean
	now?: () => number
	pid?: number
	log?: (message: string) => void
}

// ---------------------------------------------------------------------------
// Pure spool projections (exported for tests)
// ---------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * ≤120-char item label built only from non-agent facts (tool name, counts): this
 * string reaches state.json, snapshot.json and events.ndjson, so it must never
 * carry dialog `tool_input` (question text, permission descriptions) or turn
 * text. Full text stays in memory/IPC; `helm dock show` reads it live.
 */
export function dockItemHead(item: DockItem): string {
	const fact = item.fact
	if (fact.kind === 'turn') {
		const parts = ['Turn ended']
		if (fact.hadBackground) parts.push('background still running')
		return oneLine(parts.join(' · '), ITEM_HEAD_MAX)
	}
	const input = record(fact.input)
	if (fact.tool === 'AskUserQuestion') {
		const questions = Array.isArray(input?.questions) ? input.questions : []
		const first = record(questions[0])
		const parts = ['AskUserQuestion', `${questions.length} question${questions.length === 1 ? '' : 's'}`]
		if (Array.isArray(first?.options)) parts.push(`${first.options.length} opts`)
		return parts.join(' · ')
	}
	if (fact.tool === 'ExitPlanMode') return 'ExitPlanMode: plan ready for review'
	return oneLine(`Permission: ${fact.tool}`, ITEM_HEAD_MAX)
}

export function dockSpoolItem(item: DockItem): SpoolItem {
	const fact = item.fact
	const base: SpoolItem = {
		id: item.id,
		key: item.key,
		kind: item.kind,
		state: item.state,
		session: item.session,
		openedAt: item.openedAt,
		head: dockItemHead(item),
		rev: item.rev,
		...(item.orphanedAt !== undefined ? { orphanedAt: item.orphanedAt } : {}),
		...(item.resolution ? { resolution: { ...item.resolution } } : {}),
		// Kind and status only: never the answer, never Okena's error words (they reach disk).
		...(item.receipt
			? {
					receipt: {
						action: item.receipt.action,
						status: item.receipt.status,
						at: item.receipt.at,
						...(item.receipt.always ? { always: true } : {}),
						...(item.receipt.delivery ? { delivery: item.receipt.delivery } : {}),
						...(item.receipt.reason ? { reason: item.receipt.reason } : {}),
					},
				}
			: {}),
	}
	if (fact.kind === 'ask') return { ...base, tool: fact.tool, dialogId: fact.dialogId, createdAtMs: fact.createdAtMs }
	return {
		...base,
		assistantUuid: fact.assistantUuid,
		endedAt: fact.endedAt,
		hadBackground: fact.hadBackground,
		...(fact.sessionId ? { sessionId: fact.sessionId } : {}),
	}
}

export function dockSpoolSnapshot(
	snapshot: AgentDockSnapshot,
	ledger: readonly SpoolItem[],
	writtenAt: number,
	pid: number,
): SpoolSnapshot {
	const items = snapshot.items.map(dockSpoolItem)
	const live = new Set(items.map(item => item.id))
	const earlier = ledger
		.filter(item => !live.has(item.id))
		.map(item => ({ ...item, fromLedger: true }))
		.sort((a, b) => (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0))
	return {
		version: 1,
		pid,
		writtenAt,
		generatedAt: snapshot.generatedAt,
		source: { ...snapshot.source },
		sources: Object.fromEntries(Object.entries(snapshot.sources).map(([id, health]) => [id, { ...health }])),
		// `source` only for Helm sessions: an Okena-only spool stays byte-identical (absent = okena).
		sessions: snapshot.sessions.map(({ source, ...session }) => ({
			...session,
			...(source === 'okena' ? {} : { source }),
			prLinks: session.prLinks.map(link => ({ ...link })),
		})),
		items: [...items, ...earlier],
	}
}

const where = (session: DockSession | undefined): string | undefined =>
	session ? oneLine(`${session.project}/${session.name}`, 60) : undefined

/** One events.ndjson line (≤300 chars) for a reducer event. */
export function dockEventLine(
	event: AgentDockEvent,
	seq: number,
	items: readonly DockItem[],
	sessions: readonly DockSession[],
): string {
	if (event.t === 'item.opened') {
		const item = items.find(candidate => candidate.id === event.id)
		return formatEventLine({
			seq,
			t: event.t,
			at: event.at,
			id: event.id,
			kind: event.kind,
			where: where(sessions.find(session => session.key === event.session)),
			head: item ? dockItemHead(item) : undefined,
			session: event.session,
		})
	}
	if (event.t === 'source.health') {
		return formatEventLine({
			seq,
			t: event.t,
			at: event.at,
			state: event.state,
			...(event.source && event.source !== 'okena' ? { source: event.source } : {}),
			...(event.detail ? { detail: oneLine(event.detail, 160) } : {}),
		})
	}
	return formatEventLine({ seq, ...event })
}

function pruneLedger(ledger: SpoolItem[], now: number): SpoolItem[] {
	return ledger
		.filter(item => item.resolution && now - item.resolution.at <= RESOLVED_RETENTION_MS)
		.sort((a, b) => (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0))
		.slice(0, LEDGER_MAX)
}

/** Digest of what the CLI/renderer care about, ignoring per-tick freshness stamps. */
function contentDigest(snapshot: AgentDockSnapshot): string {
	return JSON.stringify({
		source: { state: snapshot.source.state, detail: snapshot.source.detail },
		sources: Object.entries(snapshot.sources).map(([id, health]) => [id, health?.state, health?.detail]),
		sessions: snapshot.sessions.map(session => ({ ...session, observedAt: 0 })),
		items: snapshot.items.map(item => [
			item.id,
			item.rev,
			item.state,
			item.resolution?.by,
			item.fact.kind,
			item.receipt?.status,
			item.receipt?.reason,
			item.receipt?.detail,
			item.receipt?.delivery,
		]),
	})
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export class AgentDockWatcher {
	private state: AgentDockState
	private ledger: SpoolItem[] = []
	private nextSeq = 1
	private visible = false
	private started = false
	private loaded = false
	private stopped = false
	private inFlight = false
	/** A dock act is running: ticks wait so no observation lands between its CAS read and its POST result. */
	private acting = false
	private timer: ReturnType<typeof setTimeout> | null = null
	private io: Promise<void> = Promise.resolve()
	private pendingLines: string[] = []
	private lastPersisted = ''
	private lastSnapshotDigest = ''
	private lastSnapshotWriteAt = 0
	private lastPublishedDigest = ''
	private lastPublishAt = 0
	private lastLog = ''
	private readonly now: () => number
	private readonly pid: number

	constructor(private readonly options: AgentDockWatcherOptions) {
		this.now = options.now ?? Date.now
		this.pid = options.pid ?? process.pid
		this.state = createAgentDockState(null, this.now())
	}

	/** Loads persisted counters and schedules the first tick. Never throws; never waits on Okena. */
	async start(): Promise<void> {
		if (this.started) return
		this.started = true
		await this.load()
		if (!this.stopped) this.schedule(0)
	}

	/** Loads state.json and the event seq high-water mark (start() does this; tests call it directly). */
	async load(): Promise<void> {
		if (this.loaded) return
		this.loaded = true
		try {
			await ensurePrivateDir(this.options.dir)
			const persisted = await this.loadPersisted()
			this.state = createAgentDockState(persisted, this.now())
			this.ledger = pruneLedger(persisted?.ledger ?? [], this.now())
			this.nextSeq = persisted?.nextSeq ?? 1
		} catch (error) {
			this.warn(`state unavailable, starting fresh: ${errorMessage(error)}`)
		}
		try {
			// seq and item ids stay monotonic for `helm dock watch` cursors and the
			// dispatcher's `#id` references even if state.json was lost or invalid.
			const high = await spoolHighWater(this.options.dir)
			this.nextSeq = Math.max(this.nextSeq, high.seq + 1)
			this.state = { ...this.state, nextItemId: Math.max(this.state.nextItemId, high.itemId + 1) }
		} catch (error) {
			this.warn(`event spool unreadable: ${errorMessage(error)}`)
		}
	}

	stop(): void {
		this.stopped = true
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}

	/** Some renderer shows (true) or hid (false) the dock. Showing pushes the current snapshot right away. */
	setVisible(visible: boolean): void {
		const wasVisible = this.visible
		this.visible = visible
		if (visible) {
			this.publish(true)
			if (!wasVisible) this.poke()
		}
	}

	/** Re-evaluate cadence now (window focus changed, dock shown). */
	poke(): void {
		if (this.started && !this.stopped && !this.inFlight) this.schedule(0)
	}

	/** Jakub acked an item. Resolves true when it was resolved (turns and orphaned asks only). */
	async ack(itemId: number): Promise<boolean> {
		if (!Number.isSafeInteger(itemId) || itemId <= 0) return false
		const events = this.apply({ type: 'ack', itemId })
		const acked = events.some(event => event.t === 'item.resolved' && event.id === itemId)
		this.publish(true)
		await this.flush()
		return acked
	}

	/**
	 * One dock answer (renderer IPC input, validated here). Order: preconditions
	 * on the live item → `sending` (published) → source CAS read + Okena POST →
	 * receipt. Ticks pause meanwhile. Resolves; never throws.
	 */
	async act(request: unknown): Promise<AgentDockActResult> {
		const refused = (reason: DockRefusalReason, detail = REFUSAL_TEXT[reason]): AgentDockActResult => ({
			ok: false,
			outcome: { status: 'refused', reason, detail },
		})
		const parsed = parseAgentDockActRequest(request)
		if (!parsed.ok) return refused('invalid', parsed.error)
		const { itemId, rev, action } = parsed.value
		if (this.stopped) return { ok: false, outcome: { status: 'failed', detail: 'The agent dock stopped.' } }
		if (this.acting) return refused('in_flight')
		const item = this.state.items.find(candidate => candidate.id === itemId)
		if (!item) return refused('unknown_item')
		if (item.state !== 'open') return refused(item.state === 'resolved' ? 'gone' : 'not_open')
		if (rev !== undefined && rev !== item.rev) return refused('changed')
		const session = this.state.sessions[item.session]?.session
		// Okena wording unchanged; Helm terminals name their own source.
		if (!session)
			return refused(
				'gone',
				item.session.startsWith('helm:')
					? 'The agent is no longer listed in Helm terminals.'
					: 'The agent is no longer listed by Okena.',
			)
		if (this.state.sources[session.source]?.health.state !== 'ok')
			return refused(
				'source_down',
				session.source === 'okena' ? undefined : 'Helm terminals are unreachable; answer in the terminal',
			)
		const source = this.options.source
		if (!source.act) return { ok: false, outcome: { status: 'failed', detail: 'This Helm build cannot answer.' } }
		const target: AgentDockTarget = { source: session.source, profile: session.profile, terminalId: session.terminalId }

		this.acting = true
		let outcome: DockActOutcome
		try {
			this.apply({
				type: 'act.sending',
				itemId,
				action: action.type,
				...(action.type === 'allow' && action.always ? { always: true } : {}),
			})
			this.publish(true)
			try {
				outcome = await source.act(target, item, action)
			} catch (error) {
				outcome = { status: 'failed', detail: errorMessage(error) }
			}
			this.apply({ type: 'act.result', itemId, outcome })
			if (outcome.status === 'sent' && action.type === 'prompt') source.expedite?.(target, this.now() + ACT_EXPEDITE_MS)
			this.publish(true)
			await this.flush()
		} finally {
			this.acting = false
		}
		// See it land as soon as possible.
		this.poke()
		return { ok: outcome.status === 'sent', outcome }
	}

	snapshot(): AgentDockSnapshot {
		return agentDockSnapshot(this.state, this.now())
	}

	/** Current tick interval (exported behavior for tests). */
	interval(): number {
		if (!this.visible) return BACKGROUND_INTERVAL_MS
		return this.options.isFocused() ? FOCUSED_INTERVAL_MS : UNFOCUSED_INTERVAL_MS
	}

	/** One poll + spool write. Public for tests; the scheduler calls it. */
	async tick(): Promise<void> {
		if (this.inFlight || this.stopped || this.acting) return
		this.inFlight = true
		try {
			const observed = await this.options.source.observe(this.state, this.now())
			if (this.stopped) return
			for (const observation of Array.isArray(observed) ? observed : [observed]) this.apply(observation)
			// Only while shown: on content change, plus a slow freshness refresh for "stale Ns" meta.
			if (this.visible) this.publish(this.now() - this.lastPublishAt >= SNAPSHOT_REFRESH_MS)
			await this.flush()
		} catch (error) {
			this.warn(`tick failed: ${errorMessage(error)}`)
		} finally {
			this.inFlight = false
		}
	}

	/** Waits for queued disk writes (tests, shutdown). */
	drain(): Promise<void> {
		return this.io
	}

	private schedule(delay: number): void {
		if (this.stopped) return
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			this.timer = null
			void this.tick().finally(() => {
				if (!this.timer) this.schedule(this.interval())
			})
		}, delay)
		this.timer.unref?.()
	}

	private apply(observation: AgentDockObservation): AgentDockEvent[] {
		const now = this.now()
		const { state, events } = reduce(this.state, observation, now)
		this.state = state
		if (events.length > 0) {
			const sessions = Object.values(state.sessions).map(entry => entry.session)
			for (const event of events) this.pendingLines.push(dockEventLine(event, this.nextSeq++, state.items, sessions))
			const resolved = state.items.filter(item => item.state === 'resolved').map(dockSpoolItem)
			const byId = new Map(this.ledger.map(item => [item.id, item]))
			for (const item of resolved) byId.set(item.id, item)
			this.ledger = pruneLedger([...byId.values()], now)
		}
		return events
	}

	private publish(force: boolean): void {
		const snapshot = this.snapshot()
		const digest = contentDigest(snapshot)
		if (!force && digest === this.lastPublishedDigest) return
		this.lastPublishedDigest = digest
		this.lastPublishAt = this.now()
		try {
			this.options.publish(snapshot)
		} catch (error) {
			this.warn(`publish failed: ${errorMessage(error)}`)
		}
	}

	private flush(): Promise<void> {
		this.io = this.io.then(
			() => this.writeSpool(),
			() => this.writeSpool(),
		)
		this.io = this.io.catch(error => this.warn(`spool write failed: ${errorMessage(error)}`))
		return this.io
	}

	private async writeSpool(): Promise<void> {
		const { dir } = this.options
		const now = this.now()
		await ensurePrivateDir(dir)
		if (this.pendingLines.length > 0) {
			const lines = this.pendingLines.splice(0)
			await rotateSpoolEvents(dir, now)
			await appendPrivateText(join(dir, SPOOL_EVENTS_FILE), `${lines.join('\n')}\n`)
		}
		const persisted: WatcherPersisted = {
			...agentDockPersisted(this.state),
			nextSeq: this.nextSeq,
			ledger: pruneLedger(this.ledger, now),
		}
		const persistedText = JSON.stringify(persisted)
		if (persistedText !== this.lastPersisted) {
			await writePrivateFileAtomic(join(dir, SPOOL_STATE_FILE), persistedText)
			this.lastPersisted = persistedText
		}
		const snapshot = this.snapshot()
		const digest = contentDigest(snapshot)
		if (digest !== this.lastSnapshotDigest || now - this.lastSnapshotWriteAt >= SNAPSHOT_REFRESH_MS) {
			const spool = dockSpoolSnapshot(snapshot, this.ledger, now, this.pid)
			await writePrivateFileAtomic(join(dir, SPOOL_SNAPSHOT_FILE), JSON.stringify(spool))
			this.lastSnapshotDigest = digest
			this.lastSnapshotWriteAt = now
		}
	}

	private async loadPersisted(): Promise<WatcherPersisted | null> {
		const text = await readSpoolFile(join(this.options.dir, SPOOL_STATE_FILE), 4 * 1024 * 1024)
		if (text === null) return null
		let body: unknown
		try {
			body = JSON.parse(text)
		} catch {
			body = undefined
		}
		const parsed = watcherStateSchema.safeParse(body)
		if (parsed.success) return parsed.data
		// Keep the bad file for inspection instead of silently overwriting it on the next flush.
		const path = join(this.options.dir, SPOOL_STATE_FILE)
		await rename(path, `${path}.corrupt-${this.now()}`).catch(() => {})
		throw new Error(`state.json invalid: ${parsed.error.issues[0]?.message ?? 'parse failed'}`)
	}

	private warn(message: string): void {
		if (message === this.lastLog) return
		this.lastLog = message
		;(this.options.log ?? (text => console.warn(`[helm] agent dock: ${text}`)))(message)
	}
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300)
