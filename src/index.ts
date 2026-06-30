import { unknownConfigPaths } from './config-document.js'
import { loadConfig } from './config.js'
import { DB } from './db/client.js'
import { DeployWatcher } from './github/deploy-watcher.js'
import { ItemNamer } from './items/namer.js'
import { Poller } from './poller/poller.js'
import { createProvider } from './providers/registry.js'
import { Drainer } from './queue/drainer.js'
import { createApp } from './server/app.js'
import { createSolver } from './solver/registry.js'
import { createSpawner } from './spawner/registry.js'
import { log } from './util/logger.js'

async function main() {
	process.title = 'vigil'
	log.info('vigil', 'Starting Vigil...')

	const { config, configPath, raw } = loadConfig()
	log.info(
		'vigil',
		`Loaded config: ${config.projects.length} project(s), poll every ${config.polling.intervalSeconds}s`,
	)
	for (const path of unknownConfigPaths(raw)) {
		log.warn('vigil', `Ignoring unknown config field: ${path} (not in schema — check for typos/removed options)`)
	}

	const db = new DB()
	const provider = createProvider(config.provider)
	log.info('vigil', `Provider: ${provider.name}`)

	const solver = await createSolver(config)
	log.info(
		'vigil',
		`Solver configured: ${config.solver.type}, agent: ${config.solver.agent}, active: ${solver.constructor.name}`,
	)
	const spawner = await createSpawner(config)
	log.info('vigil', `Spawner configured: ${config.spawner.name}, active: ${spawner.constructor.name}`)

	const queue = new Drainer(config, db, provider, solver)

	// The Drainer recovers stale `processing` Items on start(); queued Items are
	// pulled from the DB by the Drainer's lanes.
	const queuedSolveItems = db.items.countQueuedByKind('solve')
	if (queuedSolveItems > 0) {
		log.info('vigil', `Found ${queuedSolveItems} queued solve Item(s)`)
	}

	const namer = new ItemNamer(config, db.items)
	const poller = new Poller(config, db, provider, namer)
	const deployWatcher = new DeployWatcher(config, db)

	// Start API server
	const app = createApp(config, configPath, db, queue, poller, provider, spawner)
	const { serve } = await import('@hono/node-server')
	serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, () => {
		log.success('vigil', `Dashboard: http://${config.server.host}:${config.server.port}`)
	})

	// Start polling
	poller.start()

	// One-time backfill of short AI display names for Items still missing one.
	namer.backfill()

	// Start processing queue
	queue.start()

	// Start GitHub deploy lifecycle watcher (read-only; independent of the queue)
	deployWatcher.start()

	// Graceful shutdown
	const shutdown = () => {
		log.info('vigil', 'Shutting down...')
		poller.stop()
		namer.stop()
		queue.stop()
		deployWatcher.stop()
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
