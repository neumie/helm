import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { ItemEnricher } from '../items/enricher.js'
import type { Poller } from '../poller/poller.js'
import type { TaskProvider } from '../providers/provider.js'
import type { Drainer } from '../queue/drainer.js'
import type { Spawner } from '../spawner/spawner.js'
import { apiRoutes } from './routes/api.js'
import type { ProfileContext } from './routes/api.js'

const CLIENTCARE_EXTENSION_PAGE_ORIGIN = 'https://clientcare.eu.contember.cloud'

export function daemonCorsOrigin(origin: string): string {
	if (!origin) return ''
	try {
		const url = new URL(origin)
		if (url.origin === CLIENTCARE_EXTENSION_PAGE_ORIGIN) return origin
		if (url.protocol === 'chrome-extension:' && url.hostname) return origin
		if (
			(url.protocol === 'http:' || url.protocol === 'https:') &&
			['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
		) {
			return origin
		}
	} catch {
		// Invalid origins are denied below.
	}
	return ''
}

export async function daemonCorsMiddleware(c: Context, next: Next): Promise<Response | undefined> {
	const requestOrigin = c.req.header('Origin') ?? ''
	const allowedOrigin = daemonCorsOrigin(requestOrigin)
	// Omitting response headers does not prevent simple cross-origin POSTs;
	// reject an explicit untrusted Origin before a route can mutate state.
	if (requestOrigin && !allowedOrigin) return c.json({ error: 'Origin is not allowed' }, 403)
	if (allowedOrigin) {
		c.header('Access-Control-Allow-Origin', allowedOrigin)
		c.header('Vary', 'Origin')
		c.header('Access-Control-Allow-Headers', 'Content-Type')
		c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS')
	}
	if (c.req.method === 'OPTIONS') return c.body(null, allowedOrigin ? 204 : 403)
	await next()
}

export function createApp(
	config: HelmConfig,
	configPath: string,
	db: DB,
	queue: Drainer,
	poller: Poller,
	provider: TaskProvider,
	spawner: Spawner,
	enricher: ItemEnricher,
	profileContext?: ProfileContext,
) {
	const app = new Hono()

	app.use('/api/*', daemonCorsMiddleware)

	app.route(
		'/api',
		apiRoutes(
			config,
			configPath,
			db,
			queue,
			poller,
			provider,
			spawner,
			enricher,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			profileContext,
		),
	)

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
