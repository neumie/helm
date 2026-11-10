// Electron main: display-only progress for the send activity line from a bound caller's own provider session file
// (helm open spec D14, S12). Pure parsing is activity.ts; this file owns the reads and the polling.
//
// Reads only, and only for a caller that hinted its provider session at connect (`session-hint`) and only while
// one of its requests is confirmed and pending. Never writes, renames, locks or deletes a provider file; never reads
// provider config, auth or another session; nothing is logged. Claude Code: the transcript
// `<config>/projects/<folder>/<session>.jsonl` (the agent dock's locator). Codex: the plain rollout
// `<CODEX_HOME>/sessions/…/rollout-…-<thread>.jsonl` whose first line is that thread's own `session_meta`.
// Every read goes through the shared strict bounded reader (real path under the provider root, own uid, single
// link, same identity, bounded growth). Anything unexpected falls back to elapsed only for that request.
//
// The one effect beyond display: freshly observed bound activity renews the completion deadline of that exact
// owner and pending request (`ReviewSessions.renew`, capped at delivery + 2 h).

import { realpath } from 'node:fs/promises'
import {
	type JsonlCursor,
	type JsonlRead,
	type JsonlReadOptions,
	readAppendedJsonl,
	readFirstJsonlLine,
} from '../../../src/provider-files/bounded-jsonl'
import { codexSessionsRoot, findCodexRollouts } from '../../../src/provider-files/codex-rollouts'
import { claudeConfigRoots, locateClaudeTranscript } from '../agent-dock/claude-transcript-tail'
import { type ActivityTrack, applyLine, startTrack, trackView } from './activity'
import type { ActivityTarget, ReviewSessions, SessionHint } from './sessions'
import type { ReviewActivity } from './types'

export const ACTIVITY_POLL_MS = 1000
/** A file not found yet is looked up again after this, doubling per miss up to ACTIVITY_LOCATE_RETRY_MAX_MS. */
export const ACTIVITY_LOCATE_RETRY_MS = 5000
/** The agent dock's own lookup interval: an unfound file never costs more than one provider scan a minute. */
export const ACTIVITY_LOCATE_RETRY_MAX_MS = 60_000
export const ACTIVITY_FIRST_READ_BYTES = 2 * 1024 * 1024
export const ACTIVITY_READ_MAX_BYTES = 8 * 1024 * 1024
/** Codex `session_meta` (the first line) carries the base instructions; read at most this much of it. */
export const CODEX_META_BYTES = 512 * 1024
const CODEX_THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Where provider files come from; tests inject temporary roots. */
export interface ActivitySources {
	locate(hint: SessionHint, workspace: string): Promise<{ path: string; root: string } | undefined>
	/** Codex only: the rollout's first line (`session_meta`). */
	firstLine(path: string, root: string): Promise<string | null>
	read(path: string, cursor: JsonlCursor | null, options: JsonlReadOptions): Promise<JsonlRead>
}

export function providerSources(options: { claudeRoots?: string[]; codexRoot?: string } = {}): ActivitySources {
	return {
		locate: async (hint, workspace) => {
			if (hint.provider === 'claude') {
				const found = await locateClaudeTranscript(options.claudeRoots ?? claudeConfigRoots(), hint.session, workspace)
				return found && { path: found.path, root: found.base }
			}
			if (!CODEX_THREAD.test(hint.session)) return undefined
			const root = await realpath(options.codexRoot ?? codexSessionsRoot()).catch(() => null)
			if (!root) return undefined
			const suffix = `-${hint.session.toLowerCase()}.jsonl`
			const found = await findCodexRollouts(root, {
				limit: 1,
				entries: 8192,
				depth: 4,
				match: name => name.startsWith('rollout-') && name.toLowerCase().endsWith(suffix),
			})
			const path = found?.[0]
			return path ? { path, root } : undefined
		},
		firstLine: (path, root) => readFirstJsonlLine(path, CODEX_META_BYTES, root),
		read: readAppendedJsonl,
	}
}

interface Entry {
	profileId: string
	id: string
	owner: string
	requestId: string
	documentId: string
	workspace: string
	hint: SessionHint
	track: ActivityTrack
	file: { path: string; root: string } | null
	cursor: JsonlCursor | null
	missedAt: number | null
	misses: number
	/** Still the caller's pending request; false once it settled (the view is frozen, not working). */
	active: boolean
	view: ReviewActivity | null
}

/** Wait after the n-th miss: 5 s, 10 s, 20 s, 40 s, then a minute. */
export const locateRetryMs = (misses: number): number =>
	Math.min(ACTIVITY_LOCATE_RETRY_MAX_MS, ACTIVITY_LOCATE_RETRY_MS * 2 ** Math.max(0, misses - 1))

export class ReviewActivityWatcher {
	private readonly entries = new Map<string, Entry>()
	private timer: ReturnType<typeof setInterval> | null = null
	private ticking: Promise<void> | null = null
	private stopped = false

	constructor(
		private readonly profiles: () => Iterable<[string, ReviewSessions]>,
		private readonly changed: (profileId: string) => void,
		private readonly sources: ActivitySources = providerSources(),
		private readonly now: () => number = Date.now,
		private readonly intervalMs = ACTIVITY_POLL_MS,
	) {}

	/** The latest view for this caller and document window; null = elapsed only. */
	activity(profileId: string, sessionId: string | null, documentId: string): ReviewActivity | null {
		if (!sessionId) return null
		for (const entry of this.entries.values())
			if (entry.profileId === profileId && entry.id === sessionId && entry.documentId === documentId)
				return entry.view && { ...entry.view }
		return null
	}

	/** Something changed in a mailbox: start polling when a hinted request is pending. */
	kick(): void {
		if (this.stopped || this.timer) return
		if (!this.targets().length) {
			for (const profileId of this.reconcile([])) this.changed(profileId)
			return
		}
		this.timer = setInterval(() => void this.tick(), this.intervalMs)
		this.timer.unref()
		void this.tick()
	}

	/** One poll (tests call it directly). */
	tick(): Promise<void> {
		if (this.ticking) return this.ticking
		this.ticking = this.poll().finally(() => {
			this.ticking = null
		})
		return this.ticking
	}

	stop(): void {
		this.stopped = true
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		this.entries.clear()
	}

	private targets(): Array<ActivityTarget & { profileId: string; sessions: ReviewSessions }> {
		const all: Array<ActivityTarget & { profileId: string; sessions: ReviewSessions }> = []
		for (const [profileId, sessions] of this.profiles())
			for (const target of sessions.activityTargets()) all.push({ ...target, profileId, sessions })
		return all
	}

	private async poll(): Promise<void> {
		if (this.stopped) return
		const targets = this.targets()
		const touched = this.reconcile(targets)
		for (const target of targets) {
			if (this.stopped) return
			const key = `${target.profileId}\0${target.id}\0${target.owner}`
			const entry = this.entries.get(key)
			if (!entry?.active) continue
			const before = entry.track.serial
			await this.read(entry)
			// The request may have settled while reading: only a still pending, same request counts.
			if (this.entries.get(key) !== entry || !entry.active) continue
			if (entry.track.serial > before) target.sessions.renew(target.id, target.owner, target.requestId, this.now())
			if (this.refresh(entry)) touched.add(entry.profileId)
		}
		for (const profileId of touched) this.changed(profileId)
		if (!targets.length && this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Start entries for new requests, freeze settled ones, drop retired owners. Returns profiles whose view changed. */
	private reconcile(targets: Array<ActivityTarget & { profileId: string; sessions: ReviewSessions }>): Set<string> {
		const touched = new Set<string>()
		const current = new Set<string>()
		for (const target of targets) {
			const key = `${target.profileId}\0${target.id}\0${target.owner}`
			current.add(key)
			const existing = this.entries.get(key)
			if (existing?.requestId === target.requestId && existing.active) continue
			if (existing?.view) touched.add(target.profileId)
			this.entries.set(key, {
				profileId: target.profileId,
				id: target.id,
				owner: target.owner,
				requestId: target.requestId,
				documentId: target.documentId,
				workspace: target.workspace,
				hint: target.hint,
				track: startTrack(target.hint.provider, target.hint.session, target.requestId, target.confirmedAt),
				file: null,
				cursor: null,
				missedAt: null,
				misses: 0,
				active: true,
				view: null,
			})
		}
		const live = new Map<string, ReviewSessions>([...this.profiles()])
		for (const [key, entry] of this.entries) {
			if (current.has(key)) continue
			if (!live.get(entry.profileId)?.live(entry.id, entry.owner)) {
				this.entries.delete(key)
				if (entry.view) touched.add(entry.profileId)
				continue
			}
			if (!entry.active) continue
			// Settled (reply, unknown or acknowledgement): keep tokens for "Worked for", never "working".
			entry.active = false
			entry.file = null
			entry.cursor = null
			if (entry.view?.working) {
				entry.view = { ...entry.view, working: false, verb: null }
				touched.add(entry.profileId)
			}
		}
		return touched
	}

	private async read(entry: Entry): Promise<void> {
		if (entry.track.failed) return
		const now = this.now()
		try {
			if (!entry.file) {
				if (entry.missedAt !== null && now - entry.missedAt < locateRetryMs(entry.misses)) return
				const found = await this.sources.locate(entry.hint, entry.workspace)
				if (!found) {
					entry.missedAt = now
					entry.misses += 1
					return
				}
				if (entry.hint.provider === 'codex') {
					// The file's own UUID and its first record must both be this thread (not a subagent sharing it).
					const first = await this.sources.firstLine(found.path, found.root)
					entry.track = first === null ? { ...entry.track, failed: 'not this thread' } : applyLine(entry.track, first)
					if (entry.track.failed || entry.track.version === null) {
						entry.track = { ...entry.track, failed: entry.track.failed ?? 'not this thread' }
						return
					}
				}
				entry.file = found
			}
			const read = await this.sources.read(entry.file.path, entry.cursor, {
				firstReadBytes: ACTIVITY_FIRST_READ_BYTES,
				maxReadBytes: ACTIVITY_READ_MAX_BYTES,
				strict: { root: entry.file.root },
			})
			entry.cursor = read.cursor
			let track = entry.track
			for (const line of read.lines) {
				track = applyLine(track, line)
				if (track.failed) break
			}
			entry.track = track
		} catch {
			// Lost, replaced, linked, grown past the bound or otherwise unreadable: elapsed only, for good.
			entry.track = { ...entry.track, failed: 'file unavailable', working: false }
		}
	}

	private refresh(entry: Entry): boolean {
		const view = trackView(entry.track, this.now())
		const next: ReviewActivity | null = view && { sessionId: entry.id, requestId: entry.requestId, ...view }
		const same =
			next === entry.view ||
			(next !== null &&
				entry.view !== null &&
				next.working === entry.view.working &&
				next.verb === entry.view.verb &&
				next.outputTokens === entry.view.outputTokens)
		entry.view = next
		return !same
	}
}
