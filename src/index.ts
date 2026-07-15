import { unknownConfigPaths } from './config-document.js'
import { loadConfig } from './config.js'
import { DB } from './db/client.js'
import { DeployWatcher } from './github/deploy-watcher.js'
import { ItemEnricher } from './items/enricher.js'
import { PlanStatusWatcher } from './plan/status-watcher.js'
import { Poller } from './poller/poller.js'
import { createProvider } from './providers/registry.js'
import { Drainer } from './queue/drainer.js'
import { createApp } from './server/app.js'
import { createSolver } from './solver/registry.js'
import { createSpawner } from './spawner/registry.js'
import { log } from './util/logger.js'

async function main() {
	process.title = 'helm'
	log.info('helm', 'Starting Helm...')

	const { config, configPath, raw } = loadConfig()
	log.info('helm', `Loaded config: ${config.projects.length} project(s), poll every ${config.polling.intervalSeconds}s`)
	for (const path of unknownConfigPaths(raw)) {
		log.warn('helm', `Ignoring unknown config field: ${path} (not in schema — check for typos/removed options)`)
	}

	const db = new DB()
	const provider = createProvider(config.provider)
	log.info('helm', `Provider: ${provider.name}`)

	const solver = await createSolver(config)
	log.info(
		'helm',
		`Solver configured: ${config.solver.type}, agent: ${config.solver.agent}, active: ${solver.constructor.name}`,
	)
	const spawner = await createSpawner(config)
	log.info('helm', `Spawner configured: ${config.spawner.name}, active: ${spawner.constructor.name}`)

	const queue = new Drainer(config, db, provider, solver)

	// The Drainer recovers stale `processing` Items on start(); queued Items are
	// pulled from the DB by the Drainer's lanes.
	const queuedSolveItems = db.items.countQueuedByKind('solve')
	if (queuedSolveItems > 0) {
		log.info('helm', `Found ${queuedSolveItems} queued solve Item(s)`)
	}

	const enricher = new ItemEnricher(config, db.items, provider)
	const poller = new Poller(config, db, provider, enricher)
	const deployWatcher = new DeployWatcher(config, db)
	const planStatusWatcher = new PlanStatusWatcher(config, db)

	// Start API server
	const app = createApp(config, configPath, db, queue, poller, provider, spawner, enricher)
	const { serve } = await import('@hono/node-server')
	serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, () => {
		log.success('helm', `API: http://${config.server.host}:${config.server.port}/api (clients: helm + extension)`)
	})

	// Start polling
	poller.start()

	// One-time backfill of AI enrichment (display name + intent triage) for Items still missing it.
	enricher.backfill()

	// Start processing queue
	queue.start()

	// Start read-only background observation independently of the queue.
	deployWatcher.start()
	planStatusWatcher.start()

	// Graceful shutdown
	const shutdown = () => {
		log.info('helm', 'Shutting down...')
		poller.stop()
		enricher.stop()
		queue.stop()
		deployWatcher.stop()
		planStatusWatcher.stop()
		db.close()
		process.exit(0)
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
}

main().catch(err => {
	log.error('helm', 'Fatal error', err)
	process.exit(1)
})
