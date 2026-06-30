import type { VigilConfig } from '../config.js'
import type { TaskContext, TaskProvider } from '../providers/provider.js'
import { log } from '../util/logger.js'
import { ensureItemAssessment } from './assess.js'
import { ItemCommands } from './commands.js'
import { ensureItemDisplayName } from './naming.js'
import type { ItemRecord } from './schema.js'
import type { ItemStore } from './store.js'

/**
 * Background per-item AI enricher. For each source Item it runs the best-effort
 * enrichments that are enabled and still missing — a short display name (from the
 * title) and a pre-solve intent assessment (from the live task context) — off the
 * poll hot path, with a small concurrency cap so a batch poll can't fan out dozens
 * of model calls at once. Wired in `index.ts`; the poller enqueues newly-discovered
 * Items, and startup runs a one-time backfill over Items still missing enrichment.
 */
export class ItemEnricher {
	private readonly commands: ItemCommands
	private readonly queue: string[] = []
	private readonly pending = new Set<string>()
	private active = 0
	private stopped = false

	constructor(
		private readonly config: VigilConfig,
		private readonly store: ItemStore,
		private readonly provider: TaskProvider,
		private readonly concurrency = 3,
	) {
		this.commands = new ItemCommands(store, config)
	}

	private get enabled(): boolean {
		return this.config.solver.nameModel.displayNames || this.config.solver.triage.enabled
	}

	/** One-time startup sweep over source Items still missing any enrichment. */
	backfill() {
		if (!this.enabled) return
		const pending = this.store.listSourceItemsNeedingEnrichment()
		if (pending.length > 0) log.info('enrich', `Backfilling enrichment for ${pending.length} Item(s)`)
		this.enqueue(pending)
	}

	enqueue(items: ItemRecord[]) {
		if (this.stopped || !this.enabled) return
		for (const item of items) {
			if (!item.source) continue
			if (item.displayName && item.assessment) continue
			if (this.pending.has(item.id)) continue
			this.pending.add(item.id)
			this.queue.push(item.id)
		}
		this.pump()
	}

	stop() {
		this.stopped = true
		this.queue.length = 0
		this.pending.clear()
	}

	private pump() {
		while (!this.stopped && this.active < this.concurrency && this.queue.length > 0) {
			const id = this.queue.shift()
			if (!id) break
			this.active++
			void this.enrichOne(id).finally(() => {
				this.active--
				this.pending.delete(id)
				if (!this.stopped) this.pump()
			})
		}
	}

	private async enrichOne(id: string) {
		let item = this.store.get(id)
		if (!item) return
		// Display name first (title-only); it returns the updated row so the
		// assessment step sees the freshest Item without a reload.
		item = await ensureItemDisplayName({ commands: this.commands, item, config: this.config }).catch(err => {
			log.warn('enrich', `Display naming error for Item ${id}: ${err instanceof Error ? err.message : err}`)
			return item as ItemRecord
		})

		if (this.config.solver.triage.enabled && !item.assessment) {
			const taskContext = await this.fetchContext(item)
			await ensureItemAssessment({ commands: this.commands, item, taskContext, config: this.config }).catch(err => {
				log.warn('enrich', `Assessment error for Item ${id}: ${err instanceof Error ? err.message : err}`)
			})
		}
	}

	/** Live task context for assessment; degrades to a title-only context on any provider failure. */
	private async fetchContext(item: ItemRecord): Promise<TaskContext> {
		const fallback: TaskContext = { title: item.displayName ?? item.title }
		if (!item.source) return fallback
		try {
			const ctx = await this.provider.getTaskContext(item.source.externalId)
			return ctx ?? fallback
		} catch (err) {
			log.warn('enrich', `getTaskContext failed for Item ${item.id}: ${err instanceof Error ? err.message : err}`)
			return fallback
		}
	}
}
