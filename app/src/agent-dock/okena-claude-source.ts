// Agent dock source: one read-only Okena Claude Remote observation per tick,
// through Helm's existing OkenaClient (profile/token/endpoint resolution).
// Structured API only; never screen contents (AGENTS.md). Observation is
// GET-only; the only writes are `act()`, each behind a fresh CAS read:
// dialog decision POST or prompt POST (see act.ts for the exact Okena bodies).
//
// Per tick:
//   1. `GET /v1/state` (fails => whole observation is source-down).
//   2. `GET /v1/claude/terminals/{id}` for every okenaClaudeCandidates() id.
//   3. `GET …/transcript?cursor=&session_id=` only when needed: first read of a
//      pane, a new Claude session, a busy→idle edge, one settle read once the
//      idle stretch reaches TURN_IDLE_MS, a TRANSCRIPT_SWEEP_MS sweep while
//      idle (catches anything written after the edge read), and every
//      REPLY_READ_MS while a busy pane still has a live turn item (Jakub typed
//      the reply in the terminal: its user entry closes the turn).
//   4. Background tasks (Okena only, `background` observer): what the session's own
//      JSONL appended, every tick while the main agent is idle and every
//      BACKGROUND_BUSY_READ_MS while busy (keeps each read small). Okena's transcript
//      page hides the task notifications that end them (claude-transcript-tail.ts).
// Every body is size-bounded by the client; the reducer zod-validates it.

import { DOCK_SOURCE_TEXT } from '../../../src/agent-dock/dock-vocabulary'
import { boundText } from '../../../src/agent-dock/text'
import type { OkenaReadOptions } from '../../../src/extensions/okena/client'
import {
	type DockCheck,
	askStillOpen,
	dockActBody,
	dockPostFailure,
	errorDetail,
	promptText,
	sessionStillIdle,
	turnStillWaiting,
} from './act'
import type { BackgroundTaskObserver } from './claude-transcript-tail'
import type { DockPane, DockSource } from './composite-source'
import {
	type AgentDockMessageResult,
	type AgentDockObservation,
	DOCK_LIVE_MESSAGE_MAX,
	type DockActOutcome,
	type DockAction,
	type DockItem,
	type DockSourceId,
	type ObservedClaudeTerminal,
	type OkenaClaudeSession,
	type OkenaClaudeTranscriptPage,
	type OkenaFetch,
	type OkenaPromptDelivery,
	okenaAgentLifecycle,
	okenaClaudeCandidates,
	okenaTerminalProject,
	parseOkenaClaudeSession,
	parseOkenaClaudeTranscriptPage,
	parseOkenaState,
	sessionKey,
} from './model'
import { type AgentDockState, TURN_IDLE_MS, agentDockAwaitingReply, agentDockTranscriptRequest } from './reduce'

export const OKENA_STATE_MAX_BYTES = 4 * 1024 * 1024
export const OKENA_SESSION_MAX_BYTES = 2 * 1024 * 1024
/** Okena's first page is the last 4 MiB of the JSONL, at most 200 entries. */
export const OKENA_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024
export const OKENA_READ_TIMEOUT_MS = 3_000
export const TRANSCRIPT_SWEEP_MS = 15_000
/** While a busy pane has a live turn item, re-read its transcript this often (continuation pages are small). */
export const REPLY_READ_MS = 2_000
/** While the main agent is busy its background tasks do not change its status: tail its transcript this often. */
export const BACKGROUND_BUSY_READ_MS = 5_000
/** Fan-out bound per tick; more panes than this are left unobserved (status unknown). */
export const MAX_CLAUDE_TERMINALS = 64
const READ_CONCURRENCY = 6
/** The CAS read + POST of one act. Okena types a prompt into the pane before it answers, so give it room. */
export const OKENA_ACT_TIMEOUT_MS = 15_000

/** The OkenaClient surface the source uses (structural, so tests inject a double). */
export interface OkenaClaudeClient {
	activeProfileId(): string | null
	forProfile(profileId: string): OkenaClaudeClient
	getStateJson(opts?: OkenaReadOptions): Promise<unknown>
	getClaudeSession(terminalId: string, opts?: OkenaReadOptions): Promise<unknown>
	getClaudeTranscript(
		terminalId: string,
		query?: { cursor?: number; sessionId?: string },
		opts?: OkenaReadOptions,
	): Promise<unknown>
	/** Act routes; a read-only double may omit them and the dock then cannot answer. */
	postClaudeDialogDecision?(
		terminalId: string,
		dialogId: string,
		decision: unknown,
		opts?: OkenaReadOptions,
	): Promise<void>
	postClaudePrompt?(terminalId: string, text: string, opts?: OkenaReadOptions): Promise<unknown>
}

export interface TerminalReadState {
	/** Last parsed detail facts, for edge detection. */
	busy?: boolean
	dialogs: number
	sessionId?: string
	/** Last transcript request (success or failure). */
	readAt?: number
	/** busy→idle edge time awaiting its settle read. */
	edgeAt?: number
	/** Read the transcript every tick until then (a dock reply is waiting to be seen). */
	expediteUntil?: number
	/** Last background-task read of the session's transcript file. */
	backgroundAt?: number
}

async function capture(read: () => Promise<unknown>): Promise<OkenaFetch> {
	try {
		return { ok: true, body: await read() }
	} catch (error) {
		return { ok: false, error: errorDetail(error) }
	}
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0
	const worker = async () => {
		while (next < items.length) {
			const index = next++
			results[index] = await run(items[index] as T)
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
	return results
}

/** Okena's busy lifecycles (claude_remote hub.rs `lifecycle_is_busy`). */
const OKENA_BUSY_LIFECYCLES = new Set(['working', 'blocked'])

export class OkenaClaudeSource implements DockSource {
	private readonly reads = new Map<string, TerminalReadState>()
	private lastProfile: string | null = null
	/** The last observation listed every Claude pane with a resting lifecycle (pushCovered). */
	private covered = false

	/** How this source names itself in act failures and poll errors (DOCK_SOURCE_TEXT). */
	private readonly text: (typeof DOCK_SOURCE_TEXT)[DockSourceId]

	/**
	 * `id`: which dock source this client is (Okena, or Helm's own hub, which reuses this class).
	 * `background`: reads background tasks from transcript files (Okena; the hub counts its own).
	 */
	constructor(
		private readonly client: OkenaClaudeClient,
		readonly id: DockSourceId = 'okena',
		private readonly background?: BackgroundTaskObserver,
	) {
		this.text = DOCK_SOURCE_TEXT[id]
	}

	/** After a dock reply: read this pane's transcript on every tick until `until`, busy or not. */
	expedite(target: DockPane, until: number): void {
		const key = sessionKey(target.profile, target.terminalId)
		const read = this.reads.get(key)
		if (read) read.expediteUntil = until
		else this.reads.set(key, { dialogs: 0, expediteUntil: until })
	}

	/**
	 * One dock act: validate, re-read the pane (CAS), then POST. Never throws.
	 * The fresh read must match what Jakub saw (dialog id + verbatim input, or the
	 * idle turn's last assistant uuid); otherwise nothing is sent.
	 */
	async act(target: DockPane, item: DockItem, action: DockAction): Promise<DockActOutcome> {
		const built = dockActBody(item, action, this.id)
		if (!built.ok) return { status: 'refused', reason: built.reason, detail: built.detail }
		const client = this.client.forProfile(target.profile)
		const fresh = await this.freshSession(client, target)
		if (!fresh.ok) return fresh.outcome

		const request = built.body
		if (request.kind === 'decision') {
			const check = askStillOpen(item, fresh.session)
			if (!check.ok) return { status: 'refused', reason: check.reason, detail: check.detail }
			if (!client.postClaudeDialogDecision)
				return { status: 'failed', detail: `This ${this.text.label} client cannot answer dialogs.` }
			try {
				await client.postClaudeDialogDecision(target.terminalId, request.dialogId, request.body, {
					timeoutMs: OKENA_ACT_TIMEOUT_MS,
				})
				return { status: 'sent' }
			} catch (error) {
				return dockPostFailure(error, true, this.text.label)
			}
		}
		const page = await this.freshTail(client, target)
		return this.sendPrompt(client, target, turnStillWaiting(item, fresh.session, page), request.body.text)
	}

	/**
	 * A reply from the agent detail (the agent owes Jakub nothing): the same CAS as a turn reply,
	 * against the message Jakub read (`expect`), then the same prompt POST. Never throws.
	 */
	async prompt(
		target: DockPane,
		expect: { sessionId?: string; assistantUuid?: string },
		text: string,
	): Promise<DockActOutcome> {
		const body = promptText(text)
		if (body === null) return { status: 'refused', reason: 'invalid', detail: 'The reply is empty.' }
		const client = this.client.forProfile(target.profile)
		const fresh = await this.freshSession(client, target)
		if (!fresh.ok) return fresh.outcome
		const page = await this.freshTail(client, target)
		return this.sendPrompt(client, target, sessionStillIdle(expect, fresh.session, page), body)
	}

	/** The pane's last assistant message, read live (the agent detail; `helm dock show` reads turns the same way). */
	async readMessage(target: DockPane): Promise<AgentDockMessageResult> {
		const client = this.client.forProfile(target.profile)
		let page: OkenaClaudeTranscriptPage
		try {
			const parsed = parseOkenaClaudeTranscriptPage(
				await client.getClaudeTranscript(
					target.terminalId,
					{},
					{ maxBytes: OKENA_TRANSCRIPT_MAX_BYTES, timeoutMs: OKENA_READ_TIMEOUT_MS },
				),
			)
			if (!parsed.ok) return { ok: false, detail: parsed.error }
			page = parsed.value
		} catch (error) {
			return { ok: false, detail: errorDetail(error) }
		}
		let last: { uuid: string; text: string } | undefined
		for (const entry of page.entries) if (entry.kind === 'assistant') last = entry
		return {
			ok: true,
			...(page.session_id ? { sessionId: page.session_id } : {}),
			...(last ? { message: { uuid: last.uuid, text: boundText(last.text, DOCK_LIVE_MESSAGE_MAX) } } : {}),
		}
	}

	/** The CAS read every act starts with: the pane as the source shows it right now. */
	private async freshSession(
		client: OkenaClaudeClient,
		target: DockPane,
	): Promise<{ ok: true; session: OkenaClaudeSession } | { ok: false; outcome: DockActOutcome }> {
		const opts = { maxBytes: OKENA_SESSION_MAX_BYTES, timeoutMs: OKENA_READ_TIMEOUT_MS }
		try {
			const parsed = parseOkenaClaudeSession(await client.getClaudeSession(target.terminalId, opts))
			if (!parsed.ok) return { ok: false, outcome: { status: 'failed', detail: parsed.error } }
			if (parsed.value.terminal_id !== target.terminalId)
				return { ok: false, outcome: { status: 'failed', detail: `${this.text.label} answered for another pane.` } }
			return { ok: true, session: parsed.value }
		} catch (error) {
			if ((error as { status?: unknown }).status === 404)
				return {
					ok: false,
					outcome: { status: 'refused', reason: 'gone', detail: `The pane is no longer in ${this.text.label}.` },
				}
			return { ok: false, outcome: { status: 'failed', detail: errorDetail(error) } }
		}
	}

	/** A fresh first (reset) transcript page: the tail a reply's CAS checks; null when unreadable. */
	private async freshTail(client: OkenaClaudeClient, target: DockPane): Promise<OkenaClaudeTranscriptPage | null> {
		try {
			const parsed = parseOkenaClaudeTranscriptPage(
				await client.getClaudeTranscript(
					target.terminalId,
					{},
					{
						maxBytes: OKENA_TRANSCRIPT_MAX_BYTES,
						timeoutMs: OKENA_READ_TIMEOUT_MS,
					},
				),
			)
			return parsed.ok ? parsed.value : null
		} catch {
			return null
		}
	}

	/** The prompt POST once its CAS passed. */
	private async sendPrompt(
		client: OkenaClaudeClient,
		target: DockPane,
		check: DockCheck,
		text: string,
	): Promise<DockActOutcome> {
		if (!check.ok) return { status: 'refused', reason: check.reason, detail: check.detail }
		if (!client.postClaudePrompt)
			return { status: 'failed', detail: `This ${this.text.label} client cannot send prompts.` }
		try {
			const response = await client.postClaudePrompt(target.terminalId, text, {
				timeoutMs: OKENA_ACT_TIMEOUT_MS,
			})
			const delivery = (response as { delivery?: unknown } | null)?.delivery
			return {
				status: 'sent',
				...(delivery === 'channel' || delivery === 'pty' || delivery === 'queued'
					? { delivery: delivery as OkenaPromptDelivery }
					: {}),
			}
		} catch (error) {
			return dockPostFailure(error, false, this.text.label)
		}
	}

	/**
	 * Whether Okena's /v1/stream would carry every change the last observation could see:
	 * the state read succeeded and every listed Claude pane reports an agent lifecycle
	 * (`terminal_agent_status`, the OSC from the okena-lifecycle hooks, which bumps
	 * state_version on working/idle/done). A pane without one flips busy unseen by the
	 * stream (Okena's own busy hook does not bump it), so the dock keeps polling.
	 * A pane whose lifecycle says `working`/`blocked` is not covered either: a busy pane
	 * already ticks at the active rate, so this only matters when the lifecycle OSC
	 * landed but Okena's busy hook has not yet (a separate hook process, late under
	 * load): the busy flip that follows bumps nothing, and a turn whose busy stretch the
	 * dock never saw would skip the idle gate. Polling sees it within one interval.
	 */
	pushCovered(): boolean {
		return this.covered
	}

	/** One poll observation. Never throws: transport failures become `OkenaFetch` errors. */
	async observe(state: AgentDockState, now: number): Promise<AgentDockObservation> {
		this.covered = false
		const source = this.id
		const profile = this.client.activeProfileId()
		if (!profile) {
			return {
				type: 'poll',
				source,
				profile: this.lastProfile ?? 'unknown',
				state: { ok: false, error: this.text.notRunning },
				terminals: [],
			}
		}
		if (profile !== this.lastProfile) this.reads.clear()
		this.lastProfile = profile
		const client = this.client.forProfile(profile)

		const stateFetch = await capture(() =>
			client.getStateJson({ maxBytes: OKENA_STATE_MAX_BYTES, timeoutMs: OKENA_READ_TIMEOUT_MS }),
		)
		if (!stateFetch.ok) return { type: 'poll', source, profile, state: stateFetch, terminals: [] }
		const parsedState = parseOkenaState(stateFetch.body)
		if (!parsedState.ok)
			return { type: 'poll', source, profile, state: { ok: false, error: parsedState.error }, terminals: [] }

		const all = okenaClaudeCandidates(parsedState.value)
		const candidates = all.slice(0, MAX_CLAUDE_TERMINALS)
		const terminals = await mapLimited(candidates, READ_CONCURRENCY, terminalId =>
			this.observeTerminal(
				client,
				state,
				profile,
				terminalId,
				now,
				okenaTerminalProject(parsedState.value, terminalId)?.path,
			),
		)
		const listed = new Set(candidates.map(terminalId => sessionKey(profile, terminalId)))
		for (const key of this.reads.keys()) if (!listed.has(key)) this.reads.delete(key)
		this.covered =
			all.length === candidates.length &&
			candidates.every(terminalId => {
				const lifecycle = okenaAgentLifecycle(parsedState.value, terminalId)
				return lifecycle !== undefined && !OKENA_BUSY_LIFECYCLES.has(lifecycle)
			})
		return { type: 'poll', source, profile, state: stateFetch, terminals }
	}

	private async observeTerminal(
		client: OkenaClaudeClient,
		state: AgentDockState,
		profile: string,
		terminalId: string,
		now: number,
		cwd?: string,
	): Promise<ObservedClaudeTerminal> {
		const detail = await capture(() =>
			client.getClaudeSession(terminalId, { maxBytes: OKENA_SESSION_MAX_BYTES, timeoutMs: OKENA_READ_TIMEOUT_MS }),
		)
		if (!detail.ok) return { terminalId, detail }
		const parsed = parseOkenaClaudeSession(detail.body)
		// Invalid detail: the reducer marks the session unknown; no transcript read.
		if (!parsed.ok) return { terminalId, detail }

		const key = sessionKey(profile, terminalId)
		const read = this.reads.get(key)
		const request = agentDockTranscriptRequest(state, profile, terminalId)
		const want = transcriptWanted(read, parsed.value, request, now, agentDockAwaitingReply(state, profile, terminalId))
		const expedited = read?.expediteUntil !== undefined && now < read.expediteUntil && parsed.value.has_transcript
		const doRead = want.read || expedited
		const sessionId = parsed.value.session_id
		const backgroundDue =
			this.background !== undefined &&
			sessionId !== undefined &&
			(parsed.value.busy !== true ||
				read?.backgroundAt === undefined ||
				read.sessionId !== sessionId ||
				now - read.backgroundAt >= BACKGROUND_BUSY_READ_MS)
		this.reads.set(key, {
			busy: parsed.value.busy,
			dialogs: parsed.value.dialogs.length,
			sessionId,
			readAt: doRead ? now : read?.readAt,
			edgeAt: want.edgeAt,
			...(expedited ? { expediteUntil: read?.expediteUntil } : {}),
			...(backgroundDue
				? { backgroundAt: now }
				: read?.backgroundAt !== undefined
					? { backgroundAt: read.backgroundAt }
					: {}),
		})
		const background = await this.observeBackground(sessionId, cwd, backgroundDue, now)
		const withBackground = background ? { background } : {}
		if (!doRead) return { terminalId, detail, ...withBackground }
		// A cursor is only honoured with the session it came from; a new session starts with a reset page.
		const query = request.sessionId === parsed.value.session_id ? request : {}
		const transcript = await capture(() =>
			client.getClaudeTranscript(terminalId, query, {
				maxBytes: OKENA_TRANSCRIPT_MAX_BYTES,
				timeoutMs: OKENA_READ_TIMEOUT_MS,
			}),
		)
		return { terminalId, detail, transcript, ...withBackground }
	}

	/** The session's background tasks; never throws (unreadable = no claim). */
	private async observeBackground(
		sessionId: string | undefined,
		cwd: string | undefined,
		refresh: boolean,
		now: number,
	): Promise<ObservedClaudeTerminal['background']> {
		if (!this.background || sessionId === undefined) return undefined
		try {
			return await this.background.observe(sessionId, { cwd, refresh, now })
		} catch {
			return undefined
		}
	}
}

/**
 * Transcript read policy (pure, exported for tests). Reads while the pane is
 * idle, for its first/new-session read, and while it is busy only when a turn
 * item for it is still live (`awaitingReply`): the reply typed in the terminal
 * is what makes the pane busy, and only the transcript shows it.
 */
export function transcriptWanted(
	prev: TerminalReadState | undefined,
	detail: OkenaClaudeSession,
	request: { cursor?: number; sessionId?: string },
	now: number,
	awaitingReply = false,
): { read: boolean; edgeAt?: number } {
	if (!detail.has_transcript) return { read: false }
	const idle = detail.busy === false && detail.dialogs.length === 0
	const wasActive = prev !== undefined && (prev.busy !== false || prev.dialogs > 0)
	const edge = idle && wasActive
	let edgeAt = edge ? now : idle ? prev?.edgeAt : undefined
	const sinceRead = prev?.readAt === undefined ? Number.POSITIVE_INFINITY : now - prev.readAt

	// First read of this pane (or the reducer lost its cursor): throttled so a 404ing transcript is not hammered.
	if (request.cursor === undefined && sinceRead >= TRANSCRIPT_SWEEP_MS) return { read: true, edgeAt }
	if (prev !== undefined && prev.sessionId !== detail.session_id) return { read: true, edgeAt }
	if (!idle) {
		// Awaiting a reply: read on the idle→busy edge (a reply typed in the terminal is what
		// makes the pane busy), then every REPLY_READ_MS until the reducer closes the turn.
		const resumed = prev !== undefined && prev.busy === false && prev.dialogs === 0
		return { read: awaitingReply && request.cursor !== undefined && (resumed || sinceRead >= REPLY_READ_MS) }
	}
	if (edge) return { read: true, edgeAt }
	if (edgeAt !== undefined && now - edgeAt >= TURN_IDLE_MS) {
		// Settle read: the turn rule fires on this tick with fresh data.
		edgeAt = undefined
		return { read: true, edgeAt }
	}
	if (sinceRead >= TRANSCRIPT_SWEEP_MS) return { read: true, edgeAt }
	return { read: false, edgeAt }
}
