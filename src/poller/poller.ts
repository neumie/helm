import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import type { ItemNamer } from '../items/namer.js'
import type { ItemRecord } from '../items/schema.js'
import type { TaskProvider } from '../providers/provider.js'
import { log } from '../util/logger.js'

export class Poller {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running = false
	private readonly itemCommands: ItemCommands

	constructor(
		private config: VigilConfig,
		private db: DB,
		private provider: TaskProvider,
		private namer?: ItemNamer,
	) {
		this.itemCommands = new ItemCommands(db.items, config)
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

	async pollOnce() {
		for (const project of this.config.projects) {
			try {
				await this.pollProject(project.slug)
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

	private async pollProject(projectSlug: string) {
		const state = this.db.getPollState(projectSlug)
		const since = state?.lastTaskSeen ?? this.config.polling.since ?? new Date().toISOString()

		const tasks = await this.provider.pollNewTasks(projectSlug, since)
		if (tasks.length === 0) return

		let latestCreatedAt = since
		const created: ItemRecord[] = []

		for (const task of tasks) {
			if (this.db.items.findBySourceExternalId(task.externalId)) continue

			created.push(
				this.itemCommands.createSolveItem({
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

			if (task.createdAt > latestCreatedAt) {
				latestCreatedAt = task.createdAt
			}
		}

		this.db.updatePollState(projectSlug, new Date().toISOString(), latestCreatedAt)

		if (created.length > 0) {
			log.success('poller', `Discovered ${created.length} new source Item(s) in ${projectSlug}`)
			// Off the hot path: kick off short AI display names for the new Items.
			this.namer?.enqueue(created)
		}
	}
}
