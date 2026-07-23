import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import { itemExecutionMode } from '../items/execution.js'
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
	return (
		item.status === 'ready' ||
		item.status === 'inbox' ||
		(item.status === 'active' && item.workMode === 'manual' && item.plannedAt != null)
	)
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
	private quiescing = false
	private paused: boolean
	private readonly recoveredProfiles = new Set<string>()
	private readonly itemCommands: ItemCommands

	constructor(
		private config: HelmConfig,
		private db: DB,
		private provider: TaskProvider,
		private solver: Solver,
		private loopRunner: LoopRunner = new AlmanacLoopRunner(),
		private readonly profileIds?: () => string[],
		private readonly activeProfileId?: () => string,
	) {
		this.itemCommands = new ItemCommands(db.items, config)
		// Default running; a deliberate pause is persisted and survives restarts.
		this.paused = db.getAppState(PAUSED_STATE_KEY) === 'true'
	}

	start() {
		const recovered = this.recoverStaleProcessingItemsOnce()
		this.quiescing = false
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
		this.clearRetryTimers()
		log.info('drainer', 'Drainer stopped')
	}

	/**
	 * Atomically stop new starts before a process restart. Existing runs make
	 * quiescing fail; callers must not schedule exit in that case. Unlike pause,
	 * this is process-local and never persists into the next profile/runtime.
	 */
	quiesce(): boolean {
		// A second caller must not inherit ownership and later unquiesce the
		// first caller's pending restart guard.
		if (this.quiescing || this.activeSolveCount() > 0 || this.activeLoopCount() > 0) return false
		this.quiescing = true
		this.running = false
		this.clearRetryTimers()
		return true
	}

	unquiesce(): void {
		if (!this.quiescing) return
		this.quiescing = false
		this.running = true
		if (!this.paused) this.processNext()
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
		if (this.running && !this.quiescing && !this.paused) this.processNext()
	}

	/** Active profile changed; existing runs continue and only new admission follows the new tenant. */
	profileChanged(): void {
		this.recoverStaleProcessingItemsOnce()
		this.wake()
	}

	isPaused(): boolean {
		return this.paused
	}

	isQuiescing(): boolean {
		return this.quiescing
	}

	/** Process a single Item immediately, bypassing pause state. */
	processOneItem(itemId: string): boolean {
		if (this.quiescing) return false
		const item = this.db.items.get(itemId)
		if (!item) return false
		return itemExecutionMode(item) === 'loop'
			? this.startLoopItem(itemId, item.profileId)
			: this.startSolveItem(itemId, item.profileId)
	}

	retryItem(itemId: string): ItemRecord {
		if (this.quiescing) throw new Error('Daemon is restarting — new runs are temporarily unavailable')
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
		const queued = this.admissionCommands().nextQueuedAgentItems(10_000)
		const solvePending = queued.filter(item => itemExecutionMode(item) === 'solve').length
		const loopPending = queued.filter(item => itemExecutionMode(item) === 'loop').length
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
		if (!this.running || this.quiescing || this.paused) return

		while (this.activeSolveCount() < this.solveCapacity()) {
			const item = this.nextQueuedSolveItem()
			if (!item) break
			if (!this.startSolveItem(item.id, item.profileId)) break
		}

		while (this.activeLoopCount() < this.loopCapacity()) {
			const item = this.nextQueuedLoopItem()
			if (!item) break
			if (!this.startLoopItem(item.id, item.profileId)) break
		}
	}

	private recoverStaleProcessingItemsOnce(): number {
		const profileIds = this.profileIds?.() ?? []
		if (profileIds.length === 0) {
			// Fixed/dynamic test DBs without a registry retain the original behavior.
			if (this.recoveredProfiles.has('current')) return 0
			this.recoveredProfiles.add('current')
			return this.itemCommands.recoverStaleProcessingItems().length
		}
		let recovered = 0
		for (const profileId of profileIds) {
			if (this.recoveredProfiles.has(profileId)) continue
			this.recoveredProfiles.add(profileId)
			const commands = new ItemCommands(this.db.forProfile(profileId).items, this.config)
			recovered += commands.recoverStaleProcessingItems().length
		}
		return recovered
	}

	private startSolveItem(itemId: string, profileId?: string): boolean {
		if (this.quiescing || this.activeSolveItems.has(itemId)) return false
		const item = (profileId ? this.db.forProfile(profileId) : this.admissionDb()).items.get(itemId)
		if (!item || itemExecutionMode(item) !== 'solve') return false
		if (!isStartableItem(item)) return false

		const controller = new AbortController()
		const runDb = this.db.forProfile(item.profileId)
		this.activeSolveItems.set(itemId, { title: item.title, startedAt: new Date().toISOString(), controller })

		processSolveItem(itemId, this.config, runDb, this.provider, this.solver, controller.signal).finally(() => {
			this.activeSolveItems.delete(itemId)
			this.maybeScheduleRetry(itemId, runDb)
			this.wake()
		})

		return true
	}

	/**
	 * After a run finishes, auto-requeue an Item that failed transiently
	 * (network/okena/worktree) with a backoff, up to {@link MAX_ATTEMPTS} total
	 * starts. Real solve failures and cancellations are left alone.
	 */
	private maybeScheduleRetry(itemId: string, itemDb: DB): void {
		if (!this.running) return
		const item = itemDb.items.get(itemId)
		if (!item || item.status !== 'failed' || !isTransientFailure(item)) return

		const attempts = itemDb.items.countEvents(itemId, 'item_started')
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
				new ItemCommands(itemDb.items, this.config).retryItem(itemId)
				this.wake()
			} catch (err) {
				log.warn('drainer', `Auto-retry of ${itemId} failed: ${err instanceof Error ? err.message : err}`)
			}
		}, backoff)
		this.retryTimers.add(timer)
	}

	private startLoopItem(itemId: string, profileId?: string): boolean {
		if (this.quiescing || this.activeLoopItems.has(itemId)) return false
		const item = (profileId ? this.db.forProfile(profileId) : this.admissionDb()).items.get(itemId)
		if (!item || itemExecutionMode(item) !== 'loop') return false
		if (!isStartableItem(item)) return false

		const controller = new AbortController()
		const runDb = this.db.forProfile(item.profileId)
		this.activeLoopItems.set(itemId, { title: item.title, startedAt: new Date().toISOString(), controller })

		processLoopItem(itemId, this.config, runDb, this.loopRunner, controller.signal).finally(() => {
			this.activeLoopItems.delete(itemId)
			this.maybeScheduleRetry(itemId, runDb)
			this.wake()
		})

		return true
	}

	private nextQueuedSolveItem(): ItemRecord | null {
		const activeIds = new Set(this.activeSolveItems.keys())
		return (
			this.admissionCommands()
				.nextQueuedAgentItems()
				.find(item => itemExecutionMode(item) === 'solve' && !activeIds.has(item.id)) ?? null
		)
	}

	private nextQueuedLoopItem(): ItemRecord | null {
		const activeIds = new Set(this.activeLoopItems.keys())
		return (
			this.admissionCommands()
				.nextQueuedAgentItems()
				.find(item => itemExecutionMode(item) === 'loop' && !activeIds.has(item.id)) ?? null
		)
	}

	private admissionDb(): DB {
		return this.activeProfileId ? this.db.forProfile(this.activeProfileId()) : this.db
	}

	private admissionCommands(): ItemCommands {
		return new ItemCommands(this.admissionDb().items, this.config)
	}

	private clearRetryTimers(): void {
		for (const timer of this.retryTimers) clearTimeout(timer)
		this.retryTimers.clear()
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
