import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import type { ItemEnricher } from '../items/enricher.js'
import type { ItemRecord } from '../items/schema.js'
import type { ProfileRuntime } from '../profiles/store.js'
import type { TaskProvider } from '../providers/provider.js'
import { log } from '../util/logger.js'

export class Poller {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running = false
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
		log.info(
			'poller',
			`Starting poller (interval: ${this.config.polling.intervalSeconds}s, provider: ${this.provider.name})`,
		)
		this.tick()
	}

	stop() {
		this.running = false
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
		log.info('poller', 'Poller stopped')
	}

	/** Wake immediately after active-profile metadata changes. */
	profileChanged(): void {
		if (!this.running) return
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		void this.tick()
	}

	async pollOnce() {
		// Capture the complete tenant scope before provider awaits. A switch while
		// polling can never redirect discovered Items or the watermark.
		const runtime = this.runtimeProvider?.()
		const scopedDb = runtime ? this.db.forProfile(runtime.profile.id) : this.db
		const enabledProjects = runtime ? new Set(runtime.profile.enabledProjects) : this.fixedEnabledProjects
		const commands = new ItemCommands(scopedDb.items, this.config)
		for (const project of this.config.projects) {
			if (enabledProjects && !enabledProjects.has(project.slug)) continue
			try {
				await this.pollProject(project.slug, scopedDb, commands)
			} catch (err) {
				log.error('poller', `Error polling project ${project.slug}`, err)
				if (err instanceof Error && err.stack) console.error(err.stack)
			}
		}
	}

	private async tick() {
		if (!this.running) return
		await this.pollOnce()
		if (this.running) {
			this.timer = setTimeout(() => this.tick(), this.config.polling.intervalSeconds * 1000)
		}
	}

	private async pollProject(projectSlug: string, db: DB, commands: ItemCommands) {
		const state = db.getPollState(projectSlug)
		const since = state?.lastTaskSeen ?? this.config.polling.since ?? new Date().toISOString()

		const tasks = await this.provider.pollNewTasks(projectSlug, since)
		if (tasks.length === 0) return

		let latestCreatedAt = since
		const created: ItemRecord[] = []

		for (const task of tasks) {
			if (db.items.findBySourceExternalId(task.externalId)) continue
			created.push(
				commands.createSolveItem({
					projectSlug,
					title: task.title,
					prompt: task.title,
					source: {
						provider: this.provider.name,
						externalId: task.externalId,
						url: this.config.provider.taskBaseUrl ? `${this.config.provider.taskBaseUrl}${task.externalId}` : undefined,
					},
				}),
			)
			if (task.createdAt > latestCreatedAt) latestCreatedAt = task.createdAt
		}

		db.updatePollState(projectSlug, new Date().toISOString(), latestCreatedAt)
		if (created.length > 0) {
			log.success('poller', `Discovered ${created.length} new source Item(s) in ${projectSlug}`)
			this.enricher?.enqueue(created)
		}
	}
}
