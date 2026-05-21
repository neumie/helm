import { randomUUID } from 'node:crypto'
import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { TaskProvider } from '../providers/provider.js'
import { log } from '../util/logger.js'

export class Poller {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running = false

	constructor(
		private config: VigilConfig,
		private db: DB,
		private provider: TaskProvider,
		private onNewTask: (taskId: string) => void,
	) {}

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

		let newCount = 0
		let latestCreatedAt = since

		for (const task of tasks) {
			if (this.db.taskExistsByClientcareId(task.externalId)) continue

			const id = randomUUID()
			this.db.insertTask({
				id,
				clientcareId: task.externalId,
				projectSlug,
				title: task.title,
			})
			this.db.insertEvent(id, 'task_discovered', {
				externalId: task.externalId,
				title: task.title,
			})
			this.onNewTask(id)
			newCount++

			if (task.createdAt > latestCreatedAt) {
				latestCreatedAt = task.createdAt
			}
		}

		this.db.updatePollState(projectSlug, new Date().toISOString(), latestCreatedAt)

		if (newCount > 0) {
			log.success('poller', `Discovered ${newCount} new task(s) in ${projectSlug}`)
		}
	}
}
