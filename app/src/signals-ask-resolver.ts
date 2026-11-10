// Signals asks that follow their Okena terminal (design-system §3.25, AGENTS.md Signals).
//
// An agent ask bound to an Okena terminal (`helm signal add` from that terminal, or
// `--terminal ID`) closes on its own once Jakub sends a prompt into that terminal after the ask was
// filed or renewed: he answered it there. Electron main only: the agent dock's Okena polls bring
// the terminals' transcript pages (`polled`), the dock's prompt sends tell which prompts Helm typed
// itself (`promptSending`), and this asks the daemon to close the ask (`POST /signals/:id/answered`,
// Helm-only, compare-and-set on the ask's `lastActivityAt`).
//
// What counts as Jakub prompting the terminal (`classifyTerminalPrompt`): a user entry Okena reports
// with origin `terminal` (typed or pasted at the keyboard, or by Okena's PTY delivery), with a
// timestamp, written after this resolver started (Helm's record of its own prompts lives in memory),
// that is not a slash command, an interrupt marker or a paste with nothing typed around it, and that
// Helm did not type itself. A prompt Helm typed counts only when it is Jakub's Signals reply to that
// very ask (it starts with the `askReplyMarker`). Known gaps: a short prompt another program typed
// through Okena's prompt API (`okena claude prompt`) looks typed by Jakub (Okena records no
// attribution); a long one is a paste and does not count, nor does Jakub's own paste-only answer.
//
// Memory only: no prompt text or transcript is stored, logged or sent to the daemon (only times).

import { type AgentDockObservation, parseOkenaClaudeTranscriptPage } from './agent-dock/model'
import { replyLanded, replyMatchText } from './agent-dock/reduce'
import type { HelmResult, SignalThread, SignalsSnapshot } from './shared-helm'

/** Open asks are re-read this often (a new ask, a renewal, a close elsewhere). */
export const ASK_REFRESH_MS = 30_000
/** A prompt Helm sent is recognised in a transcript this long (queued until a long turn ends). */
export const SENT_PROMPT_TTL_MS = 6 * 60 * 60 * 1000
const SENT_PER_TERMINAL = 16
const TERMINALS_MAX = 256
const SEEN_UUIDS_MAX = 4096
/** Prompt texts shorter than this match a Helm-sent prompt only when equal (after whitespace folding). */
const SENT_CONTAINS_MIN = 24

/** The first line of `replyPrompt` (renderer/signals/model.ts) for ask `id`. */
export function askReplyMarker(id: number): string {
	return `Jakub answered your Signals ask #${id}.`
}

const MARKER = /^Jakub answered your Signals ask #(\d{1,15})\./

const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/g
const INTERRUPTED = /^\[Request interrupted by user/

/** A user entry from an Okena transcript page. */
export interface TerminalPromptEntry {
	uuid: string
	timestamp?: string | null
	text: string
	origin: 'terminal' | 'channel'
}

export interface SentPrompt {
	/** `replyMatchText` of what Helm sent. */
	match: string
	/** When Helm sent it (ms). */
	at: number
	/** The ask it answers, when it is Jakub's Signals reply. */
	askId: number | null
}

export type PromptClass =
	| { kind: 'jakub'; at: number }
	| { kind: 'reply'; at: number; askId: number }
	| {
			kind: 'ignored'
			why: 'channel' | 'no-time' | 'before-start' | 'empty' | 'command' | 'interrupt' | 'paste' | 'helm'
	  }

/** The ask id a Helm reply prompt answers, or null. */
export function askReplyMarkerId(text: string): number | null {
	const found = MARKER.exec(text.replace(PASTED, inner => pastedBody(inner)).trimStart())
	if (!found) return null
	const id = Number(found[1])
	return Number.isSafeInteger(id) && id > 0 ? id : null
}

function pastedBody(block: string): string {
	return block.replace(/^<pasted_content\b[^>]*>/, '').replace(/<\/pasted_content\b[^>]*>$/, '')
}

/** Whether `entry` (already folded with replyMatchText) is the prompt Helm sent as `sent`. */
function isSent(entryText: string, sent: SentPrompt): boolean {
	if (!sent.match) return false
	const folded = replyMatchText(entryText.replace(PASTED, inner => pastedBody(inner)))
	if (folded === sent.match) return true
	return sent.match.length >= SENT_CONTAINS_MIN && replyLanded(folded, sent.match)
}

/**
 * Whether a transcript user entry is Jakub prompting the terminal (see the file comment). `sent`:
 * prompts Helm sent to this terminal; the one that matched is reported through `matched`.
 */
export function classifyTerminalPrompt(
	entry: TerminalPromptEntry,
	sent: readonly SentPrompt[],
	startedAt: number,
	matched?: (prompt: SentPrompt) => void,
): PromptClass {
	if (entry.origin !== 'terminal') return { kind: 'ignored', why: 'channel' }
	const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN
	if (!Number.isFinite(at)) return { kind: 'ignored', why: 'no-time' }
	if (at < startedAt) return { kind: 'ignored', why: 'before-start' }
	const text = entry.text.trim()
	if (text === '') return { kind: 'ignored', why: 'empty' }
	// Helm's own prompts first: Jakub's reply to an ask counts for that ask only.
	for (const prompt of sent) {
		if (prompt.at > at + 5_000 || !isSent(text, prompt)) continue
		matched?.(prompt)
		const markerId = askReplyMarkerId(text)
		if (prompt.askId !== null && markerId === prompt.askId) return { kind: 'reply', at, askId: prompt.askId }
		return { kind: 'ignored', why: 'helm' }
	}
	if (text.startsWith('/')) return { kind: 'ignored', why: 'command' }
	if (INTERRUPTED.test(text)) return { kind: 'ignored', why: 'interrupt' }
	if (text.replace(PASTED, '').trim() === '') return { kind: 'ignored', why: 'paste' }
	return { kind: 'jakub', at }
}

/** An open ask as the resolver needs it. */
export interface OpenAsk {
	id: number
	terminal: string
	activityAt: string
}

/** The open asks bound to a terminal, from a Signals snapshot. */
export function openTerminalAsks(threads: readonly SignalThread[]): OpenAsk[] {
	const asks: OpenAsk[] = []
	for (const thread of threads) {
		if (thread.source !== 'agent' || thread.state === 'done' || !thread.askTerminal) continue
		if (!Number.isFinite(Date.parse(thread.lastActivityAt))) continue
		asks.push({ id: thread.id, terminal: thread.askTerminal.toLowerCase(), activityAt: thread.lastActivityAt })
	}
	return asks
}

export interface ResolverTimers {
	setTimeout(callback: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

export interface SignalsAskResolverOptions {
	/** Daemon `/api` requests (signals-main.ts createSignalsDaemonRequest, with the control token). */
	request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HelmResult<T>>
	/** The dock's Okena source reads these terminals' transcripts while busy too (or `bind` it later). */
	watch?(terminalIds: string[]): void
	now?: () => number
	timers?: ResolverTimers
	log?: (message: string) => void
}

const realTimers: ResolverTimers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Bounded insertion-ordered map: the oldest key goes first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
	map.delete(key)
	map.set(key, value)
	while (map.size > max) {
		const oldest = map.keys().next().value as K
		map.delete(oldest)
	}
}

export class SignalsAskResolver {
	private readonly now: () => number
	private readonly timers: ResolverTimers
	private startedAt = Number.POSITIVE_INFINITY
	private running = false
	private timer: unknown = null
	private refreshing: Promise<void> | null = null
	private asks: OpenAsk[] = []
	/** Prompts Helm sent, per lowercase terminal id. */
	private readonly sent = new Map<string, SentPrompt[]>()
	/** Latest prompt Jakub sent, per lowercase terminal id (ms). */
	private readonly jakubAt = new Map<string, number>()
	/** Latest Signals reply prompt landed, per ask id (ms). */
	private readonly replyAt = new Map<number, number>()
	private readonly seen = new Set<string>()
	/** Asks being closed right now (no second request meanwhile). */
	private readonly closing = new Set<number>()

	private watch: ((terminalIds: string[]) => void) | undefined

	constructor(private readonly options: SignalsAskResolverOptions) {
		this.now = options.now ?? (() => Date.now())
		this.timers = options.timers ?? realTimers
		this.watch = options.watch
	}

	/** The dock's Okena source watch hook (agent-dock-main.ts), told the open asks' terminals. */
	bind(watch: (terminalIds: Iterable<string>) => void): void {
		this.watch = ids => watch(ids)
		watch(this.asks.map(ask => ask.terminal))
	}

	start(): void {
		if (this.running) return
		this.running = true
		this.startedAt = this.now()
		void this.refresh()
	}

	stop(): void {
		this.running = false
		if (this.timer !== null) this.timers.clearTimeout(this.timer)
		this.timer = null
		this.watch?.([])
	}

	/** Helm is about to send `text` as a prompt to Okena terminal `terminalId` (dock reply, Signals). */
	promptSending(target: { source: string; terminalId: string }, text: string): void {
		if (target.source !== 'okena' || typeof text !== 'string') return
		const terminal = target.terminalId.toLowerCase()
		const now = this.now()
		const list = (this.sent.get(terminal) ?? []).filter(prompt => now - prompt.at < SENT_PROMPT_TTL_MS)
		list.push({ match: replyMatchText(text), at: now, askId: askReplyMarkerId(text) })
		remember(this.sent, terminal, list.slice(-SENT_PER_TERMINAL), TERMINALS_MAX)
	}

	/** One dock poll: the user entries of every transcript page it read (Okena only). */
	polled(observation: Extract<AgentDockObservation, { type: 'poll' }>): void {
		if (observation.source !== 'okena') return
		for (const terminal of observation.terminals) {
			if (!terminal.transcript?.ok) continue
			const page = parseOkenaClaudeTranscriptPage(terminal.transcript.body)
			if (!page.ok) continue
			const entries: TerminalPromptEntry[] = []
			for (const entry of page.value.entries) if (entry.kind === 'user') entries.push(entry)
			if (entries.length > 0) this.observePrompts(terminal.terminalId, entries)
		}
	}

	/** User entries seen in `terminalId`'s transcript (duplicates and old entries are ignored). */
	observePrompts(terminalId: string, entries: readonly TerminalPromptEntry[]): void {
		if (!this.running) return
		const terminal = terminalId.toLowerCase()
		const now = this.now()
		const sent = (this.sent.get(terminal) ?? []).filter(prompt => now - prompt.at < SENT_PROMPT_TTL_MS)
		let changed = false
		for (const entry of entries) {
			if (typeof entry.uuid !== 'string' || this.seen.has(entry.uuid)) continue
			this.seen.add(entry.uuid)
			if (this.seen.size > SEEN_UUIDS_MAX) this.seen.delete(this.seen.values().next().value as string)
			const verdict = classifyTerminalPrompt(entry, sent, this.startedAt, prompt => {
				// One landing per send: Jakub's own later "yes" is his again.
				const index = sent.indexOf(prompt)
				if (index >= 0) sent.splice(index, 1)
			})
			if (verdict.kind === 'jakub') {
				if (verdict.at > (this.jakubAt.get(terminal) ?? 0)) remember(this.jakubAt, terminal, verdict.at, TERMINALS_MAX)
				changed = true
			} else if (verdict.kind === 'reply') {
				if (verdict.at > (this.replyAt.get(verdict.askId) ?? 0))
					remember(this.replyAt, verdict.askId, verdict.at, TERMINALS_MAX)
				changed = true
			}
		}
		this.sent.set(terminal, sent)
		if (changed) void this.resolve()
	}

	/** Re-reads the open asks now and closes the answered ones (tests; the loop calls it). */
	refresh(): Promise<void> {
		if (this.refreshing) return this.refreshing
		this.refreshing = this.load().finally(() => {
			this.refreshing = null
			if (!this.running) return
			if (this.timer !== null) this.timers.clearTimeout(this.timer)
			this.timer = this.timers.setTimeout(() => {
				this.timer = null
				void this.refresh()
			}, ASK_REFRESH_MS)
		})
		return this.refreshing
	}

	private async load(): Promise<void> {
		if (!this.running) return
		const result = await this.options.request<SignalsSnapshot>('GET', '/signals?source=agent&state=new,seen,snoozed')
		if (!this.running) return
		if ('error' in result) return
		this.asks = openTerminalAsks(result.data.threads)
		this.watch?.([...new Set(this.asks.map(ask => ask.terminal))])
		await this.resolve()
	}

	/** Closes every open ask a later prompt answered. */
	private async resolve(): Promise<void> {
		for (const ask of [...this.asks]) {
			if (!this.running) return
			if (this.closing.has(ask.id)) continue
			const asked = Date.parse(ask.activityAt)
			const candidates = [this.jakubAt.get(ask.terminal), this.replyAt.get(ask.id)].filter(
				(at): at is number => at !== undefined && at > asked,
			)
			if (candidates.length === 0) continue
			const promptAt = Math.max(...candidates)
			this.closing.add(ask.id)
			try {
				const result = await this.options.request<SignalThread>('POST', `/signals/${ask.id}/answered`, {
					activityAt: ask.activityAt,
					promptAt: new Date(promptAt).toISOString(),
				})
				if ('error' in result) {
					// 409: renewed meanwhile; 404/400: gone or no longer an ask. The next refresh sees it.
					if (result.status !== 409 && result.status !== 404)
						this.options.log?.(`could not close ask #${ask.id}: ${result.error}`)
					if (result.status === 409 || result.status === 404) this.asks = this.asks.filter(open => open !== ask)
					continue
				}
				this.asks = this.asks.filter(open => open !== ask)
				this.options.log?.(`ask #${ask.id} answered in its terminal`)
			} finally {
				this.closing.delete(ask.id)
			}
		}
		this.watch?.([...new Set(this.asks.map(ask => ask.terminal))])
	}
}
