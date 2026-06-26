import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { Poller } from '../poller/poller.js'
import type { TaskProvider } from '../providers/provider.js'
import type { Drainer } from '../queue/drainer.js'
import type { Spawner } from '../spawner/spawner.js'
import { apiRoutes } from './routes/api.js'

const MIME: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
}

export function createApp(
	config: VigilConfig,
	configPath: string,
	db: DB,
	queue: Drainer,
	poller: Poller,
	provider: TaskProvider,
	spawner: Spawner,
) {
	const app = new Hono()
	const webDir = resolve(import.meta.dirname, '../web')

	app.use('*', cors())

	app.route('/api', apiRoutes(config, configPath, db, queue, poller, provider, spawner))

	// Any unmatched /api/* request returns JSON, never the SPA HTML below —
	// otherwise a stale/mismatched client gets `index.html` and dies with
	// "Unexpected token '<'" trying to parse it as JSON.
	app.all('/api/*', c => c.json({ error: 'Not found' }, 404))

	// Serve static frontend assets
	app.get('*', c => {
		const urlPath = c.req.path === '/' ? '/index.html' : c.req.path
		const ext = urlPath.substring(urlPath.lastIndexOf('.'))
		try {
			const content = readFileSync(join(webDir, urlPath))
			return c.body(content, 200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
		} catch {
			// SPA fallback — serve index.html for client-side routing
			const html = readFileSync(join(webDir, 'index.html'))
			return c.body(html, 200, { 'Content-Type': 'text/html' })
		}
	})

	return app
}
