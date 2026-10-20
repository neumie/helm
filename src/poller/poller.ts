import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import type { ItemEnricher } from '../items/enricher.js'
import type { ItemRecord } from '../items/schema.js'
import type { ProfileRuntime } from '../profiles/store.js'
import type { DiscoveredTask, TaskProvider } from '../providers/provider.js'
import { log } from '../util/logger.js'

export class Poller {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running = false
	private stopped = false
	private watching = false
	private pendingWake = false
	private flight: Promise<void> | null = null
	private controller: AbortController | null = null
	private readonly runtimeProvider?: () => ProfileRuntime
	private readonly fixedEnabledProjects?: ReadonlySet<string>

	constructor(
		private config: HelmConfig,
		private db: DB,
		private provider: TaskProvider,
		private enricher?: ItemEnricher,
		profileScope?: ReadonlySet<string> | (() => ProfileRuntime),
	) {
		if (typeof profileScope === 'function') this.runtimeProvider = profileScope
		else this.fixedEnabledProjects = profileScope
	}

	start() {
		if (this.running) return
		this.running = true
		this.stopped = false
		log.info(
			'poller',
			`Poller armed (interval: ${this.config.polling.intervalSeconds}s, provider: ${this.provider.name}); waiting until the task sidebar is visible`,
		)
	}

	/** Desktop task sidebar is the only automatic watcher. Hidden or absent means no provider poll. */
	setWatching(watching: boolean): void {
		this.watching = watching
		if (!this.running || this.stopped) return
		if (!watching) {
			this.clearTimer()
			return
		}
		if (this.flight) {
			this.pendingWake = true
			return
		}
		this.pendingWake = false
		this.clearTimer()
		void this.pollOnce()
	}

	stop(): Promise<void> {
		this.running = false
		this.stopped = true
		this.watching = false
		this.pendingWake = false
		this.clearTimer()
		this.controller?.abort()
		log.info('poller', 'Poller stopped')
		return this.flight ?? Promise.resolve()
	}

	/** Coalesce changes into one latest-scope wake, never a second polling chain. */
	profileChanged(): void {
		if (!this.running) return
		if (!this.watching) {
			this.pendingWake = true
			return
		}
		this.clearTimer()
		if (this.flight) this.pendingWake = true
		else void this.pollOnce()
	}

	pollOnce(): Promise<void> {
		if (this.stopped) return Promise.resolve()
		if (this.flight) return this.flight
		this.clearTimer()
		// Capture the complete tenant scope at admission, before provider awaits.
		const runtime = this.runtimeProvider?.()
		const scopedDb = this.db.forProfile(runtime?.profile.id ?? this.db.currentProfileId())
		const enabledProjects = runtime ? new Set(runtime.profile.enabledProjects) : this.fixedEnabledProjects
		const controller = new AbortController()
		this.controller = controller
		// Publish admission before invoking any provider or enrichment callbacks.
		const flight = Promise.resolve()
			.then(() => this.pollScope(scopedDb, enabledProjects, controller.signal))
			.finally(() => {
				this.flight = null
				this.controller = null
				if (!this.running) return
				if (this.pendingWake && this.watching) {
					this.pendingWake = false
					void this.pollOnce()
				} else if (this.watching) {
					this.timer = setTimeout(() => {
						this.timer = null
						void this.pollOnce()
					}, this.config.polling.intervalSeconds * 1000)
				}
			})
		this.flight = flight
		return flight
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}

	private async pollScope(db: DB, enabledProjects: ReadonlySet<string> | undefined, signal: AbortSignal) {
		const commands = new ItemCommands(db.items, this.config)
		for (const project of this.config.projects) {
			if (signal.aborted) return
			if (enabledProjects && !enabledProjects.has(project.slug)) continue
			try {
				await this.pollProject(project.slug, db, commands, signal)
			} catch (err) {
				if (signal.aborted) return
				log.error('poller', `Error polling project ${project.slug}`, err)
				if (err instanceof Error && err.stack) console.error(err.stack)
			}
		}
	}

	private async *taskPages(projectSlug: string, since: string, signal: AbortSignal): AsyncIterable<DiscoveredTask[]> {
		if (this.provider.pollNewTaskPages) {
			yield* this.provider.pollNewTaskPages(projectSlug, since, signal)
		} else {
			yield await this.provider.pollNewTasks(projectSlug, since)
		}
	}

	private async pollProject(projectSlug: string, db: DB, commands: ItemCommands, signal: AbortSignal) {
		const state = db.getPollState(projectSlug)
		const since = state?.lastTaskSeen ?? this.config.polling.since ?? new Date().toISOString()
		for await (const tasks of this.taskPages(projectSlug, since, signal)) {
			if (signal.aborted) return
			let latestCreatedAt = db.getPollState(projectSlug)?.lastTaskSeen ?? since
			const created: ItemRecord[] = []
			try {
				for (const task of tasks) {
					if (!db.items.findBySourceExternalId(task.externalId)) {
						created.push(
							commands.createSolveItem({
								projectSlug,
								title: task.title,
								prompt: task.title,
								source: {
									provider: this.provider.name,
									externalId: task.externalId,
									url: this.config.provider.taskBaseUrl
										? `${this.config.provider.taskBaseUrl}${task.externalId}`
										: undefined,
								},
							}),
						)
					}
					if (task.createdAt > latestCreatedAt) latestCreatedAt = task.createdAt
				}
				// Observation advances even for duplicate-only pages, but never past a failed page.
				db.updatePollState(projectSlug, new Date().toISOString(), latestCreatedAt)
			} finally {
				// A later row failure must not strand the Items already admitted in this page.
				if (created.length > 0) {
					log.success('poller', `Discovered ${created.length} new source Item(s) in ${projectSlug}`)
					this.enricher?.enqueue(created)
				}
			}
		}
	}
}
