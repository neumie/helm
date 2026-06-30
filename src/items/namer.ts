import type { VigilConfig } from '../config.js'
import { log } from '../util/logger.js'
import { ItemCommands } from './commands.js'
import { ensureItemDisplayName } from './naming.js'
import type { ItemRecord } from './schema.js'
import type { ItemStore } from './store.js'

/**
 * Background AI display-namer. Compresses each source Item's raw provider title
 * into a short dashboard label via a cheap one-shot model call — off the poll
 * hot path, with a small concurrency cap so a batch poll can't fan out dozens of
 * model calls at once. Best-effort: any failure leaves the raw title. Wired in
 * `index.ts`; the poller enqueues newly-discovered Items, and startup runs a
 * one-time backfill over Items that still lack a name.
 */
export class ItemNamer {
	private readonly commands: ItemCommands
	private readonly queue: string[] = []
	private readonly pending = new Set<string>()
	private active = 0
	private stopped = false

	constructor(
		private readonly config: VigilConfig,
		private readonly store: ItemStore,
		private readonly concurrency = 3,
	) {
		this.commands = new ItemCommands(store, config)
	}

	/** One-time startup sweep: name every source Item that still lacks a display name. */
	backfill() {
		if (!this.config.solver.nameModel.displayNames) return
		const pending = this.store.listSourceItemsMissingDisplayName()
		if (pending.length > 0) log.info('naming', `Backfilling display names for ${pending.length} Item(s)`)
		this.enqueue(pending)
	}

	enqueue(items: ItemRecord[]) {
		if (this.stopped || !this.config.solver.nameModel.displayNames) return
		for (const item of items) {
			if (item.displayName || !item.source) continue
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
			void this.nameOne(id).finally(() => {
				this.active--
				this.pending.delete(id)
				if (!this.stopped) this.pump()
			})
		}
	}

	private async nameOne(id: string) {
		const item = this.store.get(id)
		if (!item) return
		try {
			await ensureItemDisplayName({ commands: this.commands, item, config: this.config })
		} catch (err) {
			// ensureItemDisplayName only re-throws cancellation, and we pass no signal,
			// so nothing should land here — swallow defensively to keep the pump alive.
			log.warn('naming', `Display naming pump error for Item ${id}: ${err instanceof Error ? err.message : err}`)
		}
	}
}
