import { createHash, randomUUID } from 'node:crypto'
import type { DB } from '../db/client.js'
import { log } from '../util/logger.js'
import type { KnowledgeIntegration } from './integration.js'
import { KnowledgeProviderError } from './provider.js'
import type { KnowledgeCandidateOutboxEntry, KnowledgeDeliveryReceipt } from './schema.js'

const DEFAULT_SWEEP_INTERVAL_MS = 30_000
const DELIVERY_LEASE_MS = 180_000
const MAX_PER_SWEEP = 20
const CONCURRENCY = 2
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const

export interface KnowledgeDeliverySweepResult {
	claimed: number
	delivered: number
	retried: number
	blocked: number
}

interface KnowledgeOutboxDrainerOptions {
	sweepIntervalMs?: number
	now?: () => Date
	setInterval?: typeof globalThis.setInterval
	clearInterval?: typeof globalThis.clearInterval
}

/** Durable all-profile candidate delivery; independent from Item execution truth. */
export class KnowledgeOutboxDrainer {
	private readonly owner = `knowledge-delivery-${process.pid}-${randomUUID()}`
	private readonly now: () => Date
	private readonly sweepIntervalMs: number
	private readonly setIntervalFn: typeof globalThis.setInterval
	private readonly clearIntervalFn: typeof globalThis.clearInterval
	private timer: ReturnType<typeof setInterval> | null = null
	private running: Promise<KnowledgeDeliverySweepResult> | null = null
	private controller: AbortController | null = null
	private stopped = true

	constructor(
		private readonly db: DB,
		private readonly integration: KnowledgeIntegration,
		private readonly profileIds: () => string[],
		options: KnowledgeOutboxDrainerOptions = {},
	) {
		this.now = options.now ?? (() => new Date())
		this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
		this.setIntervalFn = options.setInterval ?? globalThis.setInterval
		this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval
	}

	start(): void {
		if (!this.stopped) return
		this.stopped = false
		this.recoverExpiredLeases()
		this.timer = this.setIntervalFn(() => this.wake(), this.sweepIntervalMs)
		this.timer.unref?.()
		this.wake()
	}

	wake(): void {
		if (this.stopped || this.running) return
		queueMicrotask(() => {
			if (!this.stopped && !this.running) void this.runSweep().catch(() => undefined)
		})
	}

	runSweep(): Promise<KnowledgeDeliverySweepResult> {
		if (this.running) return this.running
		if (this.stopped) return Promise.resolve({ claimed: 0, delivered: 0, retried: 0, blocked: 0 })
		this.controller = new AbortController()
		const running = this.runSweepInternal(this.controller.signal).finally(() => {
			if (this.running === running) this.running = null
			this.controller = null
		})
		this.running = running
		return running
	}

	async stop(): Promise<void> {
		if (this.stopped) return
		this.stopped = true
		if (this.timer) this.clearIntervalFn(this.timer)
		this.timer = null
		this.controller?.abort()
		await this.running?.catch(() => undefined)
		const now = this.now().toISOString()
		for (const profileId of this.profileIds()) {
			this.db.forProfile(profileId).knowledge.releaseDeliveryLeases(this.owner, now)
		}
	}

	private recoverExpiredLeases(): void {
		const now = this.now().toISOString()
		for (const profileId of this.profileIds()) {
			this.db.forProfile(profileId).knowledge.recoverExpiredDeliveryLeases(now)
		}
	}

	private async runSweepInternal(signal: AbortSignal): Promise<KnowledgeDeliverySweepResult> {
		this.recoverExpiredLeases()
		const result: KnowledgeDeliverySweepResult = { claimed: 0, delivered: 0, retried: 0, blocked: 0 }
		const profiles = [...new Set(this.profileIds())]
		let processed = 0
		let profileCursor = 0
		while (!signal.aborted && processed < MAX_PER_SWEEP) {
			const wave: Array<{ profileId: string; entry: KnowledgeCandidateOutboxEntry }> = []
			for (let offset = 0; offset < profiles.length; offset += 1) {
				if (wave.length >= CONCURRENCY || processed + wave.length >= MAX_PER_SWEEP) break
				const profileId = profiles[(profileCursor + offset) % profiles.length]
				if (!profileId) continue
				const now = this.now()
				const [entry] = this.db
					.forProfile(profileId)
					.knowledge.claimCandidateBatches(
						1,
						now.toISOString(),
						this.owner,
						new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString(),
					)
				if (entry) wave.push({ profileId, entry })
			}
			if (wave.length === 0) break
			profileCursor = profiles.length === 0 ? 0 : (profileCursor + wave.length) % profiles.length
			result.claimed += wave.length
			processed += wave.length
			const outcomes = await Promise.all(wave.map(work => this.deliver(work.profileId, work.entry, signal)))
			for (const outcome of outcomes) result[outcome] += 1
		}
		return result
	}

	private async deliver(
		profileId: string,
		entry: KnowledgeCandidateOutboxEntry,
		signal: AbortSignal,
	): Promise<'delivered' | 'retried' | 'blocked'> {
		const store = this.db.forProfile(profileId).knowledge
		if (!entry.providerId || !entry.providerProjectId || !entry.bindingId) {
			store.markCandidateBatchBlocked(
				entry.id,
				this.owner,
				'configuration',
				'Knowledge candidate destination is not configured',
			)
			return 'blocked'
		}
		let receipt: KnowledgeDeliveryReceipt
		try {
			receipt = await this.integration.provider(entry.providerId).submitCandidates({
				providerProjectId: entry.providerProjectId,
				idempotencyKey: entry.idempotencyKey,
				attemptRef: `helm-outbox:${entry.id}`,
				sourceRefs: [entry.itemId, ...(entry.snapshotId ? [entry.snapshotId] : [])],
				candidates: entry.candidates,
				signal,
			})
		} catch (error) {
			const failure =
				error instanceof KnowledgeProviderError
					? error
					: new KnowledgeProviderError('invalid-response', 'Knowledge candidate delivery failed safely', false)
			if (failure.retryable || failure.outcomeUnknown || failure.code === 'cancelled') {
				const nextAttemptAt = new Date(this.now().getTime() + retryDelay(entry)).toISOString()
				store.recordCandidateDeliveryFailure(entry.id, this.owner, failure.code, failure.message, nextAttemptAt)
				log.warn('knowledge', `Candidate delivery deferred (${failure.code}) for ${entry.id}`)
				return 'retried'
			}
			store.markCandidateBatchBlocked(entry.id, this.owner, failure.code, failure.message)
			log.warn('knowledge', `Candidate delivery blocked (${failure.code}) for ${entry.id}`)
			return 'blocked'
		}
		try {
			store.markCandidateBatchDelivered(entry.id, this.owner, receipt)
			return 'delivered'
		} catch {
			// The provider may have committed. Keep the row replayable with the same
			// key rather than converting an ambiguous local persistence failure into
			// a permanent block.
			try {
				store.recordCandidateDeliveryFailure(
					entry.id,
					this.owner,
					'local-storage',
					'Knowledge delivery receipt could not be persisted',
					new Date(this.now().getTime() + retryDelay(entry)).toISOString(),
				)
			} catch {
				// Leave the durable lease to expire if SQLite itself is unavailable.
			}
			log.warn('knowledge', `Candidate delivery receipt deferred for ${entry.id}`)
			return 'retried'
		}
	}
}

function retryDelay(entry: KnowledgeCandidateOutboxEntry): number {
	const base = RETRY_DELAYS_MS[Math.min(entry.attemptCount, RETRY_DELAYS_MS.length - 1)] ?? 15 * 60_000
	const byte = createHash('sha256').update(entry.id).digest()[0] ?? 128
	return Math.round(base * (0.75 + (byte / 255) * 0.5))
}
