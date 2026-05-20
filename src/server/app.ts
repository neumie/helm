import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { chatRoutes } from '../chat/routes.js'
import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { createMcpServer, handleMcpRequest } from '../mcp/server.js'
import type { Poller } from '../poller/poller.js'
import type { TaskProvider } from '../providers/provider.js'
import type { TaskQueue } from '../queue/queue.js'
import type { Solver } from '../solver/solver.js'
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

export function createApp(config: VigilConfig, configPath: string, db: DB, queue: TaskQueue, poller: Poller, provider: TaskProvider, solver: Solver) {
	const app = new Hono()
	const webDir = resolve(import.meta.dirname, '../web')

	app.use('*', cors())

	app.route('/api', apiRoutes(config, configPath, db, queue, poller, provider, solver))
	app.route('/api/chat', chatRoutes(config, db))

	// MCP endpoint for Claude CLI chat tools
	if (config.chat?.enabled) {
		const mcpServer = createMcpServer(config, db, provider)

		app.all('/mcp', async c => {
			const response = await handleMcpRequest(mcpServer, c.req.raw)
			return response
		})
		app.all('/mcp/*', async c => {
			const response = await handleMcpRequest(mcpServer, c.req.raw)
			return response
		})
	}

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
