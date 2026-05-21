import { loadConfig } from './config.js'
import { DB } from './db/client.js'
import { Poller } from './poller/poller.js'
import { createProvider } from './providers/registry.js'
import { TaskQueue } from './queue/queue.js'
import { createApp } from './server/app.js'
import { createSolver } from './solver/registry.js'
import { startTunnel } from './tunnel.js'
import { log } from './util/logger.js'

async function main() {
	process.title = 'vigil'
	log.info('vigil', 'Starting Vigil...')

	const { config, configPath } = loadConfig()
	log.info(
		'vigil',
		`Loaded config: ${config.projects.length} project(s), poll every ${config.polling.intervalSeconds}s`,
	)

	const db = new DB()
	const provider = createProvider(config.provider)
	log.info('vigil', `Provider: ${provider.name}`)

	// createSolver owns the dynamic-import + silent-fallback invariant (see
	// solver/registry.ts) — the active solver may differ from config.solver.type.
	const solver = await createSolver(config)
	log.info('vigil', `Solver configured: ${config.solver.type}, active: ${solver.constructor.name}`)

	const queue = new TaskQueue(config, db, provider, solver)

	// Recover tasks that were processing when we last shut down
	const stale = db.getProcessingTaskIds()
	for (const id of stale) {
		log.warn('vigil', `Recovering stale processing task: ${id}`)
		db.updateTask(id, { status: 'queued' })
		queue.enqueue(id, true)
	}

	// Re-enqueue any queued tasks from DB
	const queued = db.getQueuedTaskIds()
	for (const id of queued) {
		queue.enqueue(id, true)
	}
	if (queued.length > 0) {
		log.info('vigil', `Re-enqueued ${queued.length} pending task(s) from DB`)
	}

	const poller = new Poller(config, db, provider, id => {
		queue.enqueue(id)
	})

	// Start Cloudflare tunnel if chat.tunnel is enabled
	let stopTunnel: (() => void) | null = null
	if (config.chat?.enabled && config.chat.tunnel) {
		try {
			const tunnel = await startTunnel(config.server.port)
			config.chat.baseUrl = tunnel.url
			stopTunnel = tunnel.stop
			log.success('vigil', `Chat accessible at: ${tunnel.url}/chat/...`)
		} catch (err) {
			log.warn(
				'vigil',
				`Tunnel failed: ${err instanceof Error ? err.message : err} — chat links will use baseUrl from config`,
			)
		}
	}

	// Start API server
	const app = createApp(config, configPath, db, queue, poller, provider, solver)
	const { serve } = await import('@hono/node-server')
	serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, () => {
		log.success('vigil', `Dashboard: http://${config.server.host}:${config.server.port}`)
	})

	// Start polling
	poller.start()

	// Start processing queue
	queue.start()

	// Graceful shutdown
	const shutdown = () => {
		log.info('vigil', 'Shutting down...')
		stopTunnel?.()
		poller.stop()
		queue.stop()
		db.close()
		process.exit(0)
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
}

main().catch(err => {
	log.error('vigil', 'Fatal error', err)
	process.exit(1)
})
