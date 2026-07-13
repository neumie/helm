import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { ItemEnricher } from '../items/enricher.js'
import type { Poller } from '../poller/poller.js'
import type { TaskProvider } from '../providers/provider.js'
import type { Drainer } from '../queue/drainer.js'
import type { Spawner } from '../spawner/spawner.js'
import { apiRoutes } from './routes/api.js'

export function createApp(
	config: HelmConfig,
	configPath: string,
	db: DB,
	queue: Drainer,
	poller: Poller,
	provider: TaskProvider,
	spawner: Spawner,
	enricher: ItemEnricher,
) {
	const app = new Hono()

	app.use('*', cors())

	app.route('/api', apiRoutes(config, configPath, db, queue, poller, provider, spawner, enricher))

	// Any unmatched /api/* request returns JSON, never HTML — a stale/mismatched
	// client must get a parseable error, not markup.
	app.all('/api/*', c => c.json({ error: 'Not found' }, 404))

	// The daemon is API-only: the browser dashboard (web/) is gone — helm (the
	// native Electron sidebar) and the Chrome extension are the clients, both
	// speaking /api. `/` stays as a tiny liveness/identity probe so a human (or
	// `curl`) hitting the port sees what owns it; everything else is a JSON 404.
	app.get('/', c => c.json({ name: 'helm', api: '/api' }))
	app.all('*', c => c.json({ error: 'Not found' }, 404))

	return app
}
