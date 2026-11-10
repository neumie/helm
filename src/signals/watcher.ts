// Signals poller: one independent loop per source (GitHub, Apple Mail), each single-flight with
// its own timer. Unlike the deploy/plan observers it is NOT gated by the task sidebar watch:
// Signals must keep working with the app closed. Signals are global (one inbox for Jakub across
// every Helm profile), so a profile switch never changes where a poll lands. Agent asks are
// pushed through `helm signal add`, so they have no loop here.

import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { log } from '../util/logger.js'
import {
	SIGNAL_POLL_SOURCES,
	type SignalPollResult,
	type SignalPollSource,
	type SignalSourceHealth,
	type SignalSourceStatus,
} from './contract.js'

/** One source poller. `result` is null when nothing usable was read; `health` is always set. */
export interface SignalReader {
	source: SignalPollSource
	read(signal: AbortSignal): Promise<{
		result: SignalPollResult | null
		health: { status: SignalSourceStatus; detail: string | null }
	}>
}

export interface SignalsWatcherDeps {
	github?: SignalReader
	mail?: SignalReader
	now?: () => Date
}

/** Manual polls of one source run at most this often. */
export const SIGNAL_MANUAL_POLL_GAP_MS = 15_000

interface SourceLoop {
	readonly source: SignalPollSource
	readonly reader: SignalReader | undefined
	readonly intervalMs: number
	timer: ReturnType<typeof setTimeout> | null
	/** When the armed timer fires (ms epoch). */
	timerDue: number
	currentTick: Promise<void> | null
	currentAbort: AbortController | null
	/** Start time of the last tick (ms epoch), for the manual-poll gap. */
	lastStartAt: number
	/** A manual poll arrived while a tick was in flight. */
	manualPending: boolean
}

export class SignalsWatcher {
	private running = false
	/** stop() closes manual and timer admission before it aborts in-flight ticks. */
	private admissionOpen = true
	private stopDrain: Promise<void> | null = null
	private readonly loops: Record<SignalPollSource, SourceLoop>
	private readonly now: () => Date

	constructor(
		private readonly config: HelmConfig,
		private readonly db: DB,
		private readonly deps: SignalsWatcherDeps,
	) {
		this.now = deps.now ?? (() => new Date())
		const loop = (source: SignalPollSource, reader: SignalReader | undefined, seconds: number): SourceLoop => ({
			source,
			reader,
			intervalMs: seconds * 1000,
			timer: null,
			timerDue: 0,
			currentTick: null,
			currentAbort: null,
			lastStartAt: Number.NEGATIVE_INFINITY,
			manualPending: false,
		})
		this.loops = {
			github: loop('github', deps.github, config.signals.github.pollSeconds),
			mail: loop('mail', deps.mail, config.signals.mail.pollSeconds),
		}
	}

	/** Whether a source polls at all (feature on, source on, reader wired). */
	isEnabled(source: SignalPollSource): boolean {
		const signals = this.config.signals
		if (!signals.enabled || this.loops[source].reader === undefined) return false
		return source === 'github' ? signals.github.enabled : signals.mail.enabled
	}

	start(): void {
		if (this.running || this.stopDrain) return
		this.running = true
		this.admissionOpen = true
		for (const source of SIGNAL_POLL_SOURCES) {
			const loop = this.loops[source]
			if (this.isEnabled(source)) {
				this.arm(loop, 0)
				log.info('signals', `${source} signals armed (interval: ${loop.intervalMs / 1000}s)`)
			} else {
				// One write so the column reflects a source turned off in Settings.
				void this.pollOnce(source)
			}
		}
	}

	stop(): Promise<void> {
		if (this.stopDrain) return this.stopDrain
		this.running = false
		this.admissionOpen = false
		const ticks: Promise<void>[] = []
		for (const source of SIGNAL_POLL_SOURCES) {
			const loop = this.loops[source]
			if (loop.timer) clearTimeout(loop.timer)
			loop.timer = null
			loop.manualPending = false
			loop.currentAbort?.abort()
			if (loop.currentTick) ticks.push(loop.currentTick)
		}
		this.stopDrain = Promise.allSettled(ticks).then(() => undefined)
		log.info('signals', 'Signals watcher stopped')
		return this.stopDrain
	}

	/** Poll one source (or both) now; single-flight per source, resolves when done. */
	async pollOnce(source?: SignalPollSource): Promise<void> {
		if (source === undefined) {
			await Promise.all(SIGNAL_POLL_SOURCES.map(each => this.pollOnce(each)))
			return
		}
		const loop = this.loops[source]
		if (!this.admissionOpen) return
		if (loop.currentTick) return loop.currentTick
		const controller = new AbortController()
		loop.currentAbort = controller
		loop.lastStartAt = Date.now()
		loop.currentTick = this.runPoll(loop, controller.signal).finally(() => {
			loop.currentAbort = null
			loop.currentTick = null
		})
		return loop.currentTick
	}

	/**
	 * Manual trigger (`POST /api/signals/poll`): coalesced, and at most one manual poll per
	 * source every 15s. A tick in flight is followed by one more once the gap has passed.
	 */
	requestPoll(): void {
		if (!this.running) return
		for (const source of SIGNAL_POLL_SOURCES) {
			if (!this.isEnabled(source)) continue
			const loop = this.loops[source]
			if (loop.currentTick) {
				loop.manualPending = true
				continue
			}
			this.arm(loop, this.manualDelay(loop))
		}
	}

	/**
	 * A source's settings changed under a read in flight (`x` muted a sender, `i` showed one
	 * again): that read began with the old lists, so it is aborted (an aborted read is never
	 * persisted; it would reopen the threads just muted) and a fresh poll follows.
	 */
	restartPoll(source: SignalPollSource): void {
		if (!this.running) return
		this.loops[source].currentAbort?.abort()
		this.requestPoll()
	}

	private manualDelay(loop: SourceLoop): number {
		return Math.max(0, loop.lastStartAt + SIGNAL_MANUAL_POLL_GAP_MS - Date.now())
	}

	/** Arm the source timer to fire in `delayMs`, unless it already fires sooner. */
	private arm(loop: SourceLoop, delayMs: number): void {
		if (!this.running) return
		const due = Date.now() + delayMs
		if (loop.timer) {
			if (loop.timerDue <= due) return
			clearTimeout(loop.timer)
		}
		loop.timerDue = due
		loop.timer = setTimeout(() => {
			loop.timer = null
			void this.tick(loop)
		}, delayMs)
		loop.timer.unref?.()
	}

	private async tick(loop: SourceLoop): Promise<void> {
		if (!this.running) return
		try {
			await this.pollOnce(loop.source)
		} catch (err) {
			log.error('signals', `${loop.source} signals poll failed`, err)
		}
		if (!this.running) return
		if (loop.manualPending) {
			loop.manualPending = false
			this.arm(loop, this.manualDelay(loop))
		}
		this.arm(loop, loop.intervalMs)
	}

	private async runPoll(loop: SourceLoop, signal: AbortSignal): Promise<void> {
		const store = this.db.signals
		const reader = loop.reader
		if (!this.isEnabled(loop.source) || reader === undefined) {
			store.setSourceHealth(loop.source, 'disabled', null, this.now(), false)
			return
		}
		let read: Awaited<ReturnType<SignalReader['read']>>
		try {
			read = await reader.read(signal)
		} catch (err) {
			if (signal.aborted) return
			log.warn('signals', `${loop.source} signals read failed`, err)
			store.setSourceHealth(loop.source, 'error', 'Reading failed; see the daemon log', this.now(), false)
			return
		}
		// Never persist a partial read of an aborted tick.
		if (signal.aborted) return
		const now = this.now()
		if (read.result && read.result.source === loop.source) {
			const counts = store.applyPoll(read.result, now)
			if (counts.created + counts.renewed + counts.gone > 0) {
				log.info('signals', `${loop.source}: ${counts.created} new, ${counts.renewed} renewed, ${counts.gone} gone`)
			}
		}
		const { status, detail } = read.health
		store.setSourceHealth(loop.source, status, detail, now, status === 'ok')
	}

	/** Store health with sources that do not poll forced to disabled (rows may be stale). */
	health(stored: SignalSourceHealth[]): SignalSourceHealth[] {
		return stored.map(entry =>
			this.isEnabled(entry.source) ? entry : { ...entry, status: 'disabled' as const, detail: null },
		)
	}
}
