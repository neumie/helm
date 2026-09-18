import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { createScopedCapability, hashScopedCapability } from '../auth/scoped-capability.js'
import { RemoteHost } from './host.js'

/** Exact static asset allowlist shared by the isolated listener and real-browser proof. */
export function createRemoteAssets(assetsDirectory: string) {
	const assets = new Map([
		['/', { type: 'text/html; charset=utf-8', bytes: readFileSync(join(assetsDirectory, 'index.html')) }],
		['/remote.js', { type: 'text/javascript; charset=utf-8', bytes: readFileSync(join(assetsDirectory, 'remote.js')) }],
		['/remote.css', { type: 'text/css; charset=utf-8', bytes: readFileSync(join(assetsDirectory, 'remote.css')) }],
	])
	// Current HTML opts into one complete PWA asset set. Legacy isolated test shells
	// remain supported, but a partially built installable shell fails startup.
	if (assets.get('/')?.bytes.toString('utf8').includes('/manifest.webmanifest')) {
		for (const [name, type] of [
			['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
			['remote-sw.js', 'text/javascript; charset=utf-8'],
			['icon-180.png', 'image/png'],
			['icon-192.png', 'image/png'],
			['icon-512.png', 'image/png'],
		]) {
			if (name && type) assets.set(`/${name}`, { type, bytes: readFileSync(join(assetsDirectory, name)) })
		}
	}
	return (request: Request): Response | null => {
		let pathname: string
		try {
			pathname = new URL(request.url).pathname
		} catch {
			return new Response(null, { status: 400 })
		}
		const asset = request.method === 'GET' ? assets.get(pathname) : undefined
		if (!asset) return null
		return new Response(asset.bytes, {
			headers: {
				'Content-Type': asset.type,
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy':
					"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
			},
		})
	}
}

/** Explicit development listener only: fresh private state, ephemeral loopback port, no daemon imports. */
export async function startRemoteDevelopment(assetsDirectory: string) {
	const assets = createRemoteAssets(assetsDirectory)
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'hr-')))
	chmodSync(root, 0o700)
	const token = createScopedCapability()
	const localTokens = [createScopedCapability(), createScopedCapability()]
	const enrollments = localTokens.map(capability => ({
		id: randomUUID(),
		capabilityHash: hashScopedCapability(capability),
		scopeId: null,
		generation: 1,
	}))
	let host: RemoteHost | undefined
	const web = createServer(
		{ maxHeaderSize: 8192 },
		getRequestListener((request, env) => {
			return assets(request) ?? (host ? host.browser.fetch(request, env) : new Response(null, { status: 503 }))
		}),
	)
	const local = createServer(
		{ maxHeaderSize: 8192 },
		getRequestListener((request, env) => (host ? host.local.fetch(request, env) : new Response(null, { status: 503 }))),
	)
	for (const server of [web, local]) {
		server.maxConnections = 32
		server.requestTimeout = 6000
		server.headersTimeout = 6000
		server.on('upgrade', (_request, socket) =>
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'),
		)
	}
	async function stop() {
		host?.revoke()
		web.closeAllConnections()
		local.closeAllConnections()
		await Promise.all([web, local].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
		// Retain private scratch for operator inspection; never recursively delete agent-accessible paths.
	}
	try {
		await new Promise<void>((resolve, reject) => {
			web.once('error', reject)
			web.listen(0, '127.0.0.1', resolve)
		})
		const address = web.address()
		if (!address || typeof address === 'string') throw new Error('No loopback address')
		const origin = `http://127.0.0.1:${address.port}`
		host = new RemoteHost({ origin, browserCapabilityHash: hashScopedCapability(token), enrollments })
		const socketPath = join(root, 'host.sock')
		await new Promise<void>((resolve, reject) => {
			local.once('error', reject)
			local.listen(socketPath, resolve)
		})
		chmodSync(socketPath, 0o600)
		writeFileSync(join(root, 'browser-token'), token, { mode: 0o600, flag: 'wx' })
		for (let index = 0; index < enrollments.length; index++) {
			const enrollment = enrollments[index]
			writeFileSync(
				join(root, `enroll-${index + 1}.json`),
				JSON.stringify({
					protocol: 1,
					enrollmentId: enrollment.id,
					capability: localTokens[index],
					scopeId: null,
					generation: 1,
					socketPath,
				}),
				{ mode: 0o600, flag: 'wx' },
			)
		}
		return { origin, root, stop }
	} catch (error) {
		await stop()
		throw error
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const assets = fileURLToPath(new URL('../../app/remote-dist', import.meta.url))
	const running = await startRemoteDevelopment(assets)
	console.log(
		`Helm Remote development preview: ${running.origin}\nPrivate enrollment directory: ${running.root}\nNo agents were launched. No daemon API is exposed.`,
	)
	process.send?.({ type: 'helm-remote-ready' })
	let stopping = false
	const stop = () => {
		if (!stopping) {
			stopping = true
			void running.stop()
		}
	}
	process.once('SIGINT', stop)
	process.once('SIGTERM', stop)
}
