import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import type { ItemRecord } from '../items/schema.js'
import type { TaskProvider } from '../providers/provider.js'
import type { Solver } from '../solver/solver.js'
import type { QueueStatus } from '../types.js'
import { log } from '../util/logger.js'
import { AlmanacLoopRunner } from './loop-runner.js'
import type { LoopRunner } from './loop-runner.js'
import { processLoopItem, processSolveItem } from './worker.js'

type ActiveRun = { title: string; startedAt: string; controller: AbortController }

const PAUSED_STATE_KEY = 'drainer_paused'
/** Max total starts before an auto-retried Item gives up (1 initial + 2 retries). */
const MAX_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 30_000

function isStartableItem(item: ItemRecord): boolean {
	return item.status === 'ready' || item.status === 'inbox'
}

/** Transient failures worth auto-retrying (network/okena/worktree), vs real solve bugs. */
function isTransientFailure(item: ItemRecord): boolean {
	if (item.errorPhase === 'poll' || item.errorPhase === 'worktree') return true
	const msg = (item.errorMessage ?? '').toLowerCase()
	return /okena|not reachable|econnrefused|etimedout|fetch failed|terminal|network|socket hang/.test(msg)
}

export class Drainer {
	private activeSolveItems = new Map<string, ActiveRun>()
	private activeLoopItems = new Map<string, ActiveRun>()
	private retryTimers = new Set<ReturnType<typeof setTimeout>>()
	private running = false
	private paused: boolean
	private recoveredStaleItems = false
	private readonly itemCommands: ItemCommands

	constructor(
		private config: HelmConfig,
		private db: DB,
		private provider: TaskProvider,
		private solver: Solver,
		private loopRunner: LoopRunner = new AlmanacLoopRunner(),
	) {
		this.itemCommands = new ItemCommands(db.items, config)
		// Default running; a deliberate pause is persisted and survives restarts.
		this.paused = db.getAppState(PAUSED_STATE_KEY) === 'true'
	}

	start() {
		const recovered = this.recoverStaleProcessingItemsOnce()
		this.running = true
		log.info(
			'drainer',
			`Drainer started (solve lane: ${this.solveCapacity()}, loop lane: ${this.loopCapacity()}, paused: ${this.paused})`,
		)
		if (recovered > 0) log.warn('drainer', `Recovered ${recovered} stale processing Item(s)`)
		if (!this.paused) this.processNext()
	}

	stop() {
		this.running = false
		for (const timer of this.retryTimers) clearTimeout(timer)
		this.retryTimers.clear()
		log.info('drainer', 'Drainer stopped')
	}

	pause() {
		this.paused = true
		this.db.setAppState(PAUSED_STATE_KEY, 'true')
		log.info('drainer', 'Drainer paused - queued work will not start')
	}

	resume() {
		this.paused = false
		this.db.setAppState(PAUSED_STATE_KEY, 'false')
		log.info('drainer', 'Drainer resumed')
		this.processNext()
	}

	wake() {
		if (this.running && !this.paused) this.processNext()
	}

	isPaused(): boolean {
		return this.paused
	}

	/** Process a single Item immediately, bypassing pause state. */
	processOneItem(itemId: string): boolean {
		const item = this.db.items.get(itemId)
		if (!item) return false
		if (item.kind === 'solve') return this.startSolveItem(itemId)
		if (item.kind === 'loop') return this.startLoopItem(itemId)
		return false
	}

	retryItem(itemId: string): ItemRecord {
		const item = this.itemCommands.retryItem(itemId)
		this.wake()
		return item
	}

	cancelItem(itemId: string): boolean {
		const active = this.activeSolveItems.get(itemId)
		if (active) {
			active.controller.abort()
			return true
		}
		const activeLoop = this.activeLoopItems.get(itemId)
		if (activeLoop) {
			activeLoop.controller.abort()
			return true
		}
		this.itemCommands.cancelQueuedItem(itemId)
		return true
	}

	getStatus(): QueueStatus {
		const solvePending = this.itemCommands.countQueuedItems('solve')
		const loopPending = this.itemCommands.countQueuedItems('loop')
		const activeSolve = this.activeSolveCount()
		const activeLoop = this.activeLoopCount()
		return {
			paused: this.paused,
			pending: solvePending + loopPending,
			active: activeSolve + activeLoop,
			maxConcurrency: this.solveCapacity() + this.loopCapacity(),
			activeTasks: [
				...Array.from(this.activeSolveItems.entries()).map(([taskId, info]) => ({
					taskId,
					title: info.title,
					startedAt: info.startedAt,
				})),
				...Array.from(this.activeLoopItems.entries()).map(([taskId, info]) => ({
					taskId,
					title: info.title,
					startedAt: info.startedAt,
				})),
			],
			lanes: {
				solve: {
					pending: solvePending,
					active: activeSolve,
					maxConcurrency: this.solveCapacity(),
				},
				loop: {
					pending: loopPending,
					active: activeLoop,
					maxConcurrency: this.loopCapacity(),
				},
			},
		}
	}

	private processNext() {
		if (!this.running || this.paused) return

		while (this.activeSolveCount() < this.solveCapacity()) {
			const item = this.nextQueuedSolveItem()
			if (!item) break
			if (!this.startSolveItem(item.id)) break
		}

		while (this.activeLoopCount() < this.loopCapacity()) {
			const item = this.nextQueuedLoopItem()
			if (!item) break
			if (!this.startLoopItem(item.id)) break
		}
	}

	private recoverStaleProcessingItemsOnce(): number {
		if (this.recoveredStaleItems) return 0
		this.recoveredStaleItems = true
		return this.itemCommands.recoverStaleProcessingItems().length
	}

	private startSolveItem(itemId: string): boolean {
		if (this.activeSolveItems.has(itemId)) return false
		const item = this.db.items.get(itemId)
		if (!item || item.kind !== 'solve') return false
		if (!isStartableItem(item)) return false

		const controller = new AbortController()
		this.activeSolveItems.set(itemId, { title: item.title, startedAt: new Date().toISOString(), controller })

		processSolveItem(itemId, this.config, this.db, this.provider, this.solver, controller.signal).finally(() => {
			this.activeSolveItems.delete(itemId)
			this.maybeScheduleRetry(itemId)
			this.wake()
		})

		return true
	}

	/**
	 * After a run finishes, auto-requeue an Item that failed transiently
	 * (network/okena/worktree) with a backoff, up to {@link MAX_ATTEMPTS} total
	 * starts. Real solve failures and cancellations are left alone.
	 */
	private maybeScheduleRetry(itemId: string): void {
		if (!this.running) return
		const item = this.db.items.get(itemId)
		if (!item || item.status !== 'failed' || !isTransientFailure(item)) return

		const attempts = this.db.items.countEvents(itemId, 'item_started')
		if (attempts >= MAX_ATTEMPTS) {
			log.warn('drainer', `Item ${itemId} failed transiently but hit ${MAX_ATTEMPTS} attempts — not retrying`)
			return
		}

		const backoff = RETRY_BACKOFF_MS * attempts
		log.warn(
			'drainer',
			`Item ${itemId} failed transiently (${item.errorPhase}); auto-retry ${attempts + 1}/${MAX_ATTEMPTS} in ${Math.round(backoff / 1000)}s`,
		)
		const timer = setTimeout(() => {
			this.retryTimers.delete(timer)
			try {
				this.itemCommands.retryItem(itemId)
				this.wake()
			} catch (err) {
				log.warn('drainer', `Auto-retry of ${itemId} failed: ${err instanceof Error ? err.message : err}`)
			}
		}, backoff)
		this.retryTimers.add(timer)
	}

	private startLoopItem(itemId: string): boolean {
		if (this.activeLoopItems.has(itemId)) return false
		const item = this.db.items.get(itemId)
		if (!item || item.kind !== 'loop') return false
		if (!isStartableItem(item)) return false

		const controller = new AbortController()
		this.activeLoopItems.set(itemId, { title: item.title, startedAt: new Date().toISOString(), controller })

		processLoopItem(itemId, this.config, this.db, this.loopRunner, controller.signal).finally(() => {
			this.activeLoopItems.delete(itemId)
			this.maybeScheduleRetry(itemId)
			this.wake()
		})

		return true
	}

	private nextQueuedSolveItem(): ItemRecord | null {
		const activeIds = new Set(this.activeSolveItems.keys())
		return (
			this.itemCommands.nextQueuedItems('solve', this.solveCapacity() + activeIds.size + 5).find(item => {
				return !activeIds.has(item.id)
			}) ?? null
		)
	}

	private nextQueuedLoopItem(): ItemRecord | null {
		const activeIds = new Set(this.activeLoopItems.keys())
		const limit = this.loopCapacity() + activeIds.size + 5
		const candidates = this.itemCommands.nextQueuedItems('loop', limit).filter(item => !activeIds.has(item.id))
		candidates.sort((a, b) => {
			const queued = (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt)
			if (queued !== 0) return queued
			return a.createdAt.localeCompare(b.createdAt)
		})
		return candidates[0] ?? null
	}

	private activeSolveCount(): number {
		return this.activeSolveItems.size
	}

	private activeLoopCount(): number {
		return this.activeLoopItems.size
	}

	private solveCapacity(): number {
		return this.config.solver.concurrency
	}

	private loopCapacity(): number {
		return 1
	}
}
