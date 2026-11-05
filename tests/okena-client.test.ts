import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OKENA_PID_CHECK_MS, OkenaClient, OkenaConfigCache } from '../src/extensions/okena/client.js'

const TOKEN = 'local-cli-token'

function writeProfile(root: string, remote: Record<string, unknown>): string {
	const baseDir = join(root, 'config')
	const profileDir = join(baseDir, 'profiles', 'default')
	mkdirSync(profileDir, { recursive: true })
	writeFileSync(join(baseDir, 'profiles.json'), JSON.stringify({ last_used: 'default' }))
	writeFileSync(join(profileDir, 'cli.json'), JSON.stringify({ token: TOKEN, token_id: 'token-id' }))
	writeFileSync(join(profileDir, 'remote.json'), JSON.stringify({ pid: process.pid, ...remote }))
	return baseDir
}

function listen(server: Server, target: string | { port: number; host: string }): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		if (typeof target === 'string') server.listen(target, resolve)
		else server.listen(target.port, target.host, resolve)
	})
}

function close(server: Server): Promise<void> {
	return new Promise(resolve => server.close(() => resolve()))
}

test('OkenaClient prefers the advertised local Unix socket over the remote TCP port', async () => {
	const root = mkdtempSync(join(tmpdir(), 'ho-'))
	const socketPath = join(root, 'okena.sock')
	const requests: Array<{ url: string; authorization?: string; contentType?: string; body: string }> = []
	const server = createServer((request, response) => {
		let body = ''
		request.setEncoding('utf8')
		request.on('data', chunk => {
			body += chunk
		})
		request.on('end', () => {
			requests.push({
				url: request.url ?? '',
				authorization: request.headers.authorization,
				contentType: request.headers['content-type'],
				body,
			})
			response.writeHead(200, { 'Content-Type': 'application/json' })
			response.end(request.url === '/v1/state' ? JSON.stringify({ projects: [] }) : JSON.stringify({ ok: true }))
		})
	})
	const baseDir = writeProfile(root, {
		port: 1,
		local_endpoint: { kind: 'unix_socket', path: socketPath },
	})
	await listen(server, socketPath)

	try {
		const client = new OkenaClient(baseDir)
		assert.equal(await client.isAvailable(), true)
		assert.deepEqual(await client.getState(), { projects: [] })
		const action = { action: 'focus_terminal', terminal_id: 'terminal-1' }
		assert.deepEqual(await client.action(action), { ok: true })
		assert.deepEqual(
			requests.map(request => request.url),
			['/health', '/v1/state', '/v1/actions'],
		)
		assert.equal(requests[0]?.authorization, undefined)
		assert.equal(requests[1]?.authorization, `Bearer ${TOKEN}`)
		assert.equal(requests[2]?.authorization, `Bearer ${TOKEN}`)
		assert.equal(requests[2]?.contentType, 'application/json')
		assert.deepEqual(JSON.parse(requests[2]?.body ?? ''), action)
	} finally {
		await close(server)
		rmSync(root, { recursive: true, force: true })
	}
})

test('OkenaClient retains the TCP fallback when local_endpoint is absent', async () => {
	const root = mkdtempSync(join(tmpdir(), 'ho-'))
	const server = createServer((request, response) => {
		assert.equal(request.url, '/v1/state')
		assert.equal(request.headers.authorization, `Bearer ${TOKEN}`)
		response.writeHead(200, { 'Content-Type': 'application/json' })
		response.end(JSON.stringify({ projects: [] }))
	})
	await listen(server, { port: 0, host: '127.0.0.1' })
	const address = server.address()
	assert.ok(address && typeof address !== 'string')
	const baseDir = writeProfile(root, { port: address.port })

	try {
		assert.deepEqual(await new OkenaClient(baseDir).getState(), { projects: [] })
	} finally {
		await close(server)
		rmSync(root, { recursive: true, force: true })
	}
})

test('OkenaClient routes a repository to the profile that owns it instead of stale last_used', async () => {
	const root = mkdtempSync(join(tmpdir(), 'ho-'))
	const baseDir = join(root, 'config')
	const defaultServer = createServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'application/json' })
		response.end(
			JSON.stringify({ projects: [{ id: 'sample-project', name: 'Sample project', path: '/repo/sample-project' }] }),
		)
	})
	const perfServer = createServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'application/json' })
		response.end(JSON.stringify({ projects: [{ id: 'perf', name: 'perf', path: '/tmp/perf' }] }))
	})
	await listen(defaultServer, { port: 0, host: '127.0.0.1' })
	await listen(perfServer, { port: 0, host: '127.0.0.1' })
	const defaultAddress = defaultServer.address()
	const perfAddress = perfServer.address()
	assert.ok(defaultAddress && typeof defaultAddress !== 'string')
	assert.ok(perfAddress && typeof perfAddress !== 'string')
	for (const [id, port, projects] of [
		['default', defaultAddress.port, [{ path: '/repo/sample-project' }]],
		['perf-test', perfAddress.port, [{ path: '/tmp/perf' }]],
	] as const) {
		const profileDir = join(baseDir, 'profiles', id)
		mkdirSync(profileDir, { recursive: true })
		writeFileSync(join(profileDir, 'cli.json'), JSON.stringify({ token: TOKEN, token_id: 'token-id' }))
		writeFileSync(join(profileDir, 'remote.json'), JSON.stringify({ pid: process.pid, port }))
		writeFileSync(join(profileDir, 'workspace.json'), JSON.stringify({ projects }))
	}
	writeFileSync(
		join(baseDir, 'profiles.json'),
		JSON.stringify({
			last_used: 'perf-test',
			default_profile: 'default',
			profiles: [{ id: 'default' }, { id: 'perf-test' }],
		}),
	)

	try {
		const state = await new OkenaClient(baseDir).forProject('/repo/sample-project').getState()
		assert.equal(state.projects[0]?.name, 'Sample project')
	} finally {
		await close(defaultServer)
		await close(perfServer)
		rmSync(root, { recursive: true, force: true })
	}
})

test('OkenaClient rejects a truncated Unix-socket response instead of hanging', { timeout: 1000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), 'ho-'))
	const socketPath = join(root, 'okena.sock')
	const server = createServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'application/json' })
		response.write('{"projects":')
		setImmediate(() => response.socket?.destroy())
	})
	const baseDir = writeProfile(root, {
		port: 1,
		local_endpoint: { kind: 'unix_socket', path: socketPath },
	})
	await listen(server, socketPath)

	try {
		await assert.rejects(new OkenaClient(baseDir).getState(), /response aborted|socket hang up|ECONNRESET/)
	} finally {
		await close(server)
		rmSync(root, { recursive: true, force: true })
	}
})

test('OkenaConfigCache re-reads a config file only when its mtime/size/inode moves', () => {
	const root = mkdtempSync(join(tmpdir(), 'hoc-'))
	try {
		const path = join(root, 'cli.json')
		writeFileSync(path, JSON.stringify({ token: 'one', token_id: 'a' }))
		const cache = new OkenaConfigCache()
		const first = cache.readJson<{ token: string }>(path)
		assert.equal(first.token, 'one')
		assert.equal(cache.readJson(path), first, 'unchanged file: the parsed value is reused')

		// Same size, same content length, new mtime: re-read.
		writeFileSync(path, JSON.stringify({ token: 'two', token_id: 'a' }))
		utimesSync(path, new Date(), new Date(Date.now() + 5_000))
		assert.equal(cache.readJson<{ token: string }>(path).token, 'two')

		// Invalid JSON throws (like JSON.parse) and keeps throwing until the file changes.
		writeFileSync(path, '{"token":')
		utimesSync(path, new Date(), new Date(Date.now() + 10_000))
		assert.throws(() => cache.readJson(path), SyntaxError)
		assert.throws(() => cache.readJson(path), SyntaxError)
		writeFileSync(path, JSON.stringify({ token: 'three', token_id: 'a' }))
		utimesSync(path, new Date(), new Date(Date.now() + 15_000))
		assert.equal(cache.readJson<{ token: string }>(path).token, 'three')

		rmSync(path)
		assert.throws(() => cache.readJson(path), /ENOENT/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('OkenaConfigCache checks remote.json pid liveness at most every OKENA_PID_CHECK_MS', () => {
	const clock = { now: 1_000 }
	const checks: number[] = []
	let alive = true
	const cache = new OkenaConfigCache(
		() => clock.now,
		pid => {
			checks.push(pid)
			return alive
		},
	)
	assert.equal(cache.isProcessAlive(42), true)
	alive = false
	clock.now += OKENA_PID_CHECK_MS - 1
	assert.equal(cache.isProcessAlive(42), true, 'cached')
	assert.deepEqual(checks, [42])
	clock.now += 1
	assert.equal(cache.isProcessAlive(42), false)
	assert.equal(cache.isProcessAlive(43), false)
	assert.deepEqual(checks, [42, 42, 43])
})

test('OkenaClient picks up a rotated token through its config cache', async () => {
	const root = mkdtempSync(join(tmpdir(), 'hor-'))
	const socketPath = join(root, 'okena.sock')
	const seen: Array<string | undefined> = []
	const server = createServer((request, response) => {
		seen.push(request.headers.authorization)
		response.writeHead(200, { 'Content-Type': 'application/json' })
		response.end(JSON.stringify({ state_version: 1 }))
	})
	const baseDir = writeProfile(root, { port: 1, local_endpoint: { kind: 'unix_socket', path: socketPath } })
	await listen(server, socketPath)
	try {
		const client = new OkenaClient(baseDir, undefined, new OkenaConfigCache())
		await client.getStateJson()
		await client.forProfile('default').getStateJson()
		const cliPath = join(baseDir, 'profiles', 'default', 'cli.json')
		writeFileSync(cliPath, JSON.stringify({ token: 'rotated-token', token_id: 'token-id' }))
		utimesSync(cliPath, new Date(), new Date(Date.now() + 5_000))
		await client.getStateJson()
		assert.deepEqual(seen, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, 'Bearer rotated-token'])
	} finally {
		await close(server)
		rmSync(root, { recursive: true, force: true })
	}
})
