// Agent dock source: one read-only Okena Claude Remote observation per tick,
// through Helm's existing OkenaClient (profile/token/endpoint resolution).
// Structured API only; never screen contents (AGENTS.md). Observation is
// GET-only; the only writes are `act()` (slice 2), each behind a fresh CAS read:
// dialog decision POST or prompt POST (see act.ts for the exact Okena bodies).
//
// Per tick:
//   1. `GET /v1/state` (fails => whole observation is source-down).
//   2. `GET /v1/claude/terminals/{id}` for every okenaClaudeCandidates() id.
//   3. `GET …/transcript?cursor=&session_id=` only when needed: first read of a
//      pane, a new Claude session, a busy→idle edge, one settle read once the
//      idle stretch reaches TURN_IDLE_MS, and a TRANSCRIPT_SWEEP_MS sweep while
//      idle (catches anything written after the edge read).
// Every body is size-bounded by the client; the reducer zod-validates it.

import type { OkenaReadOptions } from '../../../src/extensions/okena/client'
import { askStillOpen, dockActBody, dockPostFailure, errorDetail, turnStillWaiting } from './act'
import {
	type AgentDockObservation,
	type DockActOutcome,
	type DockAction,
	type DockItem,
	type ObservedClaudeTerminal,
	type OkenaClaudeSession,
	type OkenaFetch,
	type OkenaPromptDelivery,
	okenaClaudeCandidates,
	parseOkenaClaudeSession,
	parseOkenaClaudeTranscriptPage,
	parseOkenaState,
	sessionKey,
} from './model'
import { type AgentDockState, TURN_IDLE_MS, agentDockTranscriptRequest } from './reduce'

export const OKENA_STATE_MAX_BYTES = 4 * 1024 * 1024
export const OKENA_SESSION_MAX_BYTES = 2 * 1024 * 1024
/** Okena's first page is the last 4 MiB of the JSONL, at most 200 entries. */
export const OKENA_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024
export const OKENA_READ_TIMEOUT_MS = 3_000
export const TRANSCRIPT_SWEEP_MS = 15_000
/** Fan-out bound per tick; more panes than this are left unobserved (status unknown). */
export const MAX_CLAUDE_TERMINALS = 64
const READ_CONCURRENCY = 6
/** The CAS read + POST of one act. Okena types a prompt into the pane before it answers, so give it room. */
export const OKENA_ACT_TIMEOUT_MS = 15_000
/** After a dock reply, read the transcript every tick (even while busy) this long, to see the user entry land. */
export const EXPEDITE_MS = 20_000

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
	/** Act routes (slice 2); a read-only double may omit them and the dock then cannot answer. */
	postClaudeDialogDecision?(
		terminalId: string,
		dialogId: string,
		decision: unknown,
		opts?: OkenaReadOptions,
	): Promise<void>
	postClaudePrompt?(terminalId: string, text: string, opts?: OkenaReadOptions): Promise<unknown>
}

/** The pane an act targets. */
export interface DockActTarget {
	profile: string
	terminalId: string
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
}

const errorText = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300)

async function capture(read: () => Promise<unknown>): Promise<OkenaFetch> {
	try {
		return { ok: true, body: await read() }
	} catch (error) {
		return { ok: false, error: errorText(error) }
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

export class OkenaClaudeSource {
	private readonly reads = new Map<string, TerminalReadState>()
	private lastProfile: string | null = null

	constructor(private readonly client: OkenaClaudeClient) {}

	/** After a dock reply: read this pane's transcript on every tick until `until`, busy or not. */
	expedite(target: DockActTarget, until: number): void {
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
	async act(target: DockActTarget, item: DockItem, action: DockAction): Promise<DockActOutcome> {
		const built = dockActBody(item, action)
		if (!built.ok) return { status: 'refused', reason: built.reason, detail: built.detail }
		const client = this.client.forProfile(target.profile)
		const opts = { maxBytes: OKENA_SESSION_MAX_BYTES, timeoutMs: OKENA_READ_TIMEOUT_MS }
		let fresh: OkenaClaudeSession
		try {
			const parsed = parseOkenaClaudeSession(await client.getClaudeSession(target.terminalId, opts))
			if (!parsed.ok) return { status: 'failed', detail: parsed.error }
			fresh = parsed.value
		} catch (error) {
			if ((error as { status?: unknown }).status === 404)
				return { status: 'refused', reason: 'gone', detail: 'The pane is no longer in Okena.' }
			return { status: 'failed', detail: errorDetail(error) }
		}
		if (fresh.terminal_id !== target.terminalId) return { status: 'failed', detail: 'Okena answered for another pane.' }

		const request = built.body
		if (request.kind === 'decision') {
			const check = askStillOpen(item, fresh)
			if (!check.ok) return { status: 'refused', reason: check.reason, detail: check.detail }
			if (!client.postClaudeDialogDecision)
				return { status: 'failed', detail: 'This Okena client cannot answer dialogs.' }
			try {
				await client.postClaudeDialogDecision(target.terminalId, request.dialogId, request.body, {
					timeoutMs: OKENA_ACT_TIMEOUT_MS,
				})
				return { status: 'sent' }
			} catch (error) {
				return dockPostFailure(error, true)
			}
		}

		let page = null
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
			page = parsed.ok ? parsed.value : null
		} catch {
			page = null
		}
		const check = turnStillWaiting(item, fresh, page)
		if (!check.ok) return { status: 'refused', reason: check.reason, detail: check.detail }
		if (!client.postClaudePrompt) return { status: 'failed', detail: 'This Okena client cannot send prompts.' }
		try {
			const response = await client.postClaudePrompt(target.terminalId, request.body.text, {
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
			return dockPostFailure(error, false)
		}
	}

	/** One poll observation. Never throws: transport failures become `OkenaFetch` errors. */
	async observe(state: AgentDockState, now: number): Promise<AgentDockObservation> {
		const profile = this.client.activeProfileId()
		if (!profile) {
			return {
				type: 'poll',
				profile: this.lastProfile ?? 'unknown',
				state: { ok: false, error: 'Okena not configured or not running' },
				terminals: [],
			}
		}
		if (profile !== this.lastProfile) this.reads.clear()
		this.lastProfile = profile
		const client = this.client.forProfile(profile)

		const stateFetch = await capture(() =>
			client.getStateJson({ maxBytes: OKENA_STATE_MAX_BYTES, timeoutMs: OKENA_READ_TIMEOUT_MS }),
		)
		if (!stateFetch.ok) return { type: 'poll', profile, state: stateFetch, terminals: [] }
		const parsedState = parseOkenaState(stateFetch.body)
		if (!parsedState.ok) return { type: 'poll', profile, state: { ok: false, error: parsedState.error }, terminals: [] }

		const candidates = okenaClaudeCandidates(parsedState.value).slice(0, MAX_CLAUDE_TERMINALS)
		const terminals = await mapLimited(candidates, READ_CONCURRENCY, terminalId =>
			this.observeTerminal(client, state, profile, terminalId, now),
		)
		const listed = new Set(candidates.map(terminalId => sessionKey(profile, terminalId)))
		for (const key of this.reads.keys()) if (!listed.has(key)) this.reads.delete(key)
		return { type: 'poll', profile, state: stateFetch, terminals }
	}

	private async observeTerminal(
		client: OkenaClaudeClient,
		state: AgentDockState,
		profile: string,
		terminalId: string,
		now: number,
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
		const want = transcriptWanted(read, parsed.value, request, now)
		const expedited = read?.expediteUntil !== undefined && now < read.expediteUntil && parsed.value.has_transcript
		const doRead = want.read || expedited
		this.reads.set(key, {
			busy: parsed.value.busy,
			dialogs: parsed.value.dialogs.length,
			sessionId: parsed.value.session_id,
			readAt: doRead ? now : read?.readAt,
			edgeAt: want.edgeAt,
			...(expedited ? { expediteUntil: read?.expediteUntil } : {}),
		})
		if (!doRead) return { terminalId, detail }
		// A cursor is only honoured with the session it came from; a new session starts with a reset page.
		const query = request.sessionId === parsed.value.session_id ? request : {}
		const transcript = await capture(() =>
			client.getClaudeTranscript(terminalId, query, {
				maxBytes: OKENA_TRANSCRIPT_MAX_BYTES,
				timeoutMs: OKENA_READ_TIMEOUT_MS,
			}),
		)
		return { terminalId, detail, transcript }
	}
}

/**
 * Transcript read policy (pure, exported for tests). Reads only while the pane
 * is idle or for its first/new-session read; never while it is working.
 */
export function transcriptWanted(
	prev: TerminalReadState | undefined,
	detail: OkenaClaudeSession,
	request: { cursor?: number; sessionId?: string },
	now: number,
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
	if (!idle) return { read: false }
	if (edge) return { read: true, edgeAt }
	if (edgeAt !== undefined && now - edgeAt >= TURN_IDLE_MS) {
		// Settle read: the turn rule fires on this tick with fresh data.
		edgeAt = undefined
		return { read: true, edgeAt }
	}
	if (sinceRead >= TRANSCRIPT_SWEEP_MS) return { read: true, edgeAt }
	return { read: false, edgeAt }
}
