import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { getRequestListener } from '@hono/node-server'
import helmRemoteBridge from '../packages/helm-remote-bridge/index.js'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAccess, type RemoteDeviceGrant } from '../src/remote/access.js'
import {
	HISTORY_HEADER,
	HISTORY_RESULT_BYTES,
	type HistoryDescriptor,
	type HistoryRequest,
	remoteHistoryExchangeSchema,
} from '../src/remote/history-protocol.js'
import { RemoteHistoryReader } from '../src/remote/history-reader.js'
import { RemoteHost } from '../src/remote/host.js'
import type { RemoteSnapshot } from '../src/remote/protocol.js'

async function fixture(t: { after(fn: () => Promise<void>): void }, durable = false, wallClock = false) {
	const root = realpathSync(mkdtempSync('/tmp/hr-history-'))
	chmodSync(root, 0o700)
	const browserToken = createScopedCapability()
	const localToken = createScopedCapability()
	const enrollment = {
		id: randomUUID(),
		capabilityHash: hashScopedCapability(localToken),
		scopeId: null,
		generation: 1,
	}
	let now = wallClock ? Date.now() : 1000
	const access = durable ? new RemoteAccess(join(root, 'devices.json'), () => now) : undefined
	const web = createServer(getRequestListener((request, env) => host.browser.fetch(request, env)))
	const local = createServer(getRequestListener((request, env) => host.local.fetch(request, env)))
	await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve))
	const address = web.address()
	assert.ok(address && typeof address !== 'string')
	const origin = `http://127.0.0.1:${address.port}`
	const host = new RemoteHost({
		origin,
		...(access ? { access } : { browserCapabilityHash: hashScopedCapability(browserToken) }),
		enrollments: [enrollment],
		now: () => now,
	})
	const socketPath = join(root, 'host.sock')
	await new Promise<void>(resolve => local.listen(socketPath, resolve))
	chmodSync(socketPath, 0o600)
	t.after(async () => {
		host.revoke()
		for (const server of [web, local]) server.closeAllConnections()
		await Promise.all([web, local].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
		rmSync(root, { recursive: true, force: true })
	})
	const snapshot: RemoteSnapshot = {
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
		revision: 1,
		label: 'Fixture',
		workspace: 'Fixture',
		model: null,
		activity: 'idle',
		capabilities: { prompt: true, answer: false, interrupt: true },
		question: null,
		messages: [],
		historyTruncated: false,
	}
	const headers = { Authorization: `Bearer ${browserToken}`, Origin: origin, 'Content-Type': 'application/json' }
	function uds(
		path: string,
		body: unknown,
		negotiated = true,
		token = localToken,
		enrollmentId = enrollment.id,
		extraHeaders: Record<string, string> = {},
	): Promise<{ status: number; body: unknown }> {
		return new Promise((resolve, reject) => {
			const request = httpRequest(
				{
					socketPath,
					path,
					agent: false,
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'X-Helm-Enrollment': enrollmentId,
						'Content-Type': 'application/json',
						...(negotiated ? { [HISTORY_HEADER]: '1' } : {}),
						...extraHeaders,
					},
				},
				response => {
					let text = ''
					response.setEncoding('utf8')
					response.on('data', chunk => {
						text += chunk
					})
					response.on('end', () => resolve({ status: required(response.statusCode), body: JSON.parse(text) }))
					response.on('error', reject)
				},
			)
			request.on('error', reject)
			request.setTimeout(2000, () => request.destroy(new Error('test timeout')))
			request.end(JSON.stringify(body))
		})
	}
	const exchange = (negotiated = true) =>
		uds('/exchange', { protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] }, negotiated)
	const readRequest = (): HistoryRequest => ({
		version: 1,
		hostEpoch: host.epoch,
		target: snapshot.target,
		viewId: randomUUID(),
		sequence: 0,
		action: { kind: 'open' },
	})
	const browser = (request: HistoryRequest, signal?: AbortSignal) =>
		fetch(`${origin}/v1/history/read`, { method: 'POST', headers, body: JSON.stringify(request), signal })
	async function delivered(): Promise<HistoryDescriptor> {
		for (let n = 0; n < 100; n++) {
			const response = await exchange()
			const body = remoteHistoryExchangeSchema.parse(response.body)
			if (body.historyRead) return body.historyRead
			await delay(5)
		}
		throw new Error('History descriptor was not delivered')
	}
	return {
		host,
		access,
		root,
		socketPath,
		localToken,
		enrollment,
		snapshot,
		origin,
		headers,
		uds,
		exchange,
		readRequest,
		browser,
		delivered,
		advance: (ms: number) => {
			now += ms
		},
	}
}

test('real HTTP and UDS negotiate history separately, bind results and do not refresh owner freshness', async t => {
	const f = await fixture(t)
	const legacy = await f.exchange(false)
	assert.deepEqual(Object.keys(remoteHistoryExchangeSchema.parse(legacy.body)).sort(), [
		'commands',
		'hostEpoch',
		'protocol',
	])
	assert.equal((await f.browser(f.readRequest())).status, 409)
	await f.exchange()
	const pending = f.browser(f.readRequest())
	const descriptor = await f.delivered()
	const reader = new RemoteHistoryReader(
		f.snapshot.target,
		f.host.epoch,
		() => ({
			getLeafId: () => '00000001',
			getEntry: () => ({
				id: '00000001',
				parentId: null,
				type: 'message',
				message: { role: 'user', content: 'Same text' },
			}),
		}),
		() => 1000,
	)
	const result = reader.execute(descriptor)
	assert.equal((await f.uds('/history-result', result, true, 'invalid')).status, 401)
	assert.equal((await f.uds('/history-result', { ...result, sequence: 3 })).status, 409)
	// A chunked oversized sender may observe the early 413 or EPIPE when the
	// server closes while it is still writing. Neither is a successful result.
	const oversized = await f
		.uds('/history-result', { payload: 'x'.repeat(HISTORY_RESULT_BYTES) })
		.catch((error: NodeJS.ErrnoException) => error)
	if ('status' in oversized) assert.equal(oversized.status, 413)
	else assert.equal(oversized.code, 'EPIPE')
	f.advance(3000)
	assert.equal((await f.uds('/history-result', result)).status, 200)
	const response = await pending
	assert.equal(response.status, 200)
	assert.equal(response.headers.get('cache-control'), 'no-store')
	assert.deepEqual(await response.json(), result)
	assert.equal((await f.uds('/history-result', result)).status, 409)
	f.advance(2500)
	const directory = await fetch(`${f.origin}/v1/sessions`, { headers: f.headers }).then(response => response.json())
	assert.equal(directory.sessions[0].connected, false)
	assert.deepEqual(remoteHistoryExchangeSchema.parse((await f.exchange()).body).commands, [])
	reader.dispose()
})

test('real browser disconnect after POST consumption releases read admission before its deadline', async t => {
	const f = await fixture(t)
	await f.exchange()
	const request = httpRequest(`${f.origin}/v1/history/read`, { method: 'POST', headers: f.headers })
	request.on('error', () => {})
	request.end(JSON.stringify(f.readRequest()))
	const original = await f.delivered() // proves the POST body was consumed and admission completed
	request.destroy()
	let replacement: Response | undefined
	for (let n = 0; n < 50; n++) {
		await delay(5)
		const controller = new AbortController()
		const pending = f.browser(f.readRequest(), controller.signal)
		const outcome = await Promise.race([
			pending.then(response => ({ response })),
			delay(20).then(() => ({ response: undefined })),
		])
		if (!outcome.response) {
			const descriptor = await f.delivered()
			assert.notEqual(descriptor.requestId, original.requestId)
			controller.abort()
			await assert.rejects(pending)
			return
		}
		replacement = outcome.response
		assert.equal(replacement.status, 429)
	}
	assert.fail(`Disconnected read retained admission: ${replacement?.status}`)
})

function required<T>(value: T | null | undefined): T {
	assert.ok(value !== null && value !== undefined, 'Expected fixture value')
	return value
}

const readOnlyGrant: RemoteDeviceGrant = {
	personalCurrentAndFuture: true,
	scopeIds: [],
	operations: { read: true, prompt: false, interrupt: false, answer: false },
}

async function pair(f: Awaited<ReturnType<typeof fixture>>, grant = readOnlyGrant) {
	const challenge = required(f.access).createPairing('Wire fixture', grant)
	const response = await fetch(`${f.origin}/v1/pair`, {
		method: 'POST',
		headers: { Origin: f.origin, 'Content-Type': 'application/json', 'X-Helm-Remote': '1' },
		body: JSON.stringify({ qrCapability: challenge.qrCapability }),
	})
	assert.equal(response.status, 201)
	const cookie = required(response.headers.get('set-cookie')).split(';')[0]
	const headers = { Cookie: cookie, Origin: f.origin, 'Content-Type': 'application/json', 'X-Helm-Remote': '1' }
	const body = await response.json()
	assert.equal(typeof body.device.id, 'string')
	return { headers, deviceId: body.device.id as string }
}

function readResult(f: Awaited<ReturnType<typeof fixture>>, descriptor: HistoryDescriptor) {
	const reader = new RemoteHistoryReader(
		f.snapshot.target,
		f.host.epoch,
		() => ({
			getLeafId: () => '00000001',
			getEntry: () => ({
				id: '00000001',
				parentId: null,
				type: 'message',
				message: { role: 'user', content: 'Private fixture' },
			}),
		}),
		() => 1000,
	)
	const result = reader.execute(descriptor)
	reader.dispose()
	return result
}

function withHeaders(
	f: Awaited<ReturnType<typeof fixture>>,
	headers: Record<string, string>,
	request = f.readRequest(),
) {
	return fetch(`${f.origin}/v1/history/read`, { method: 'POST', headers, body: JSON.stringify(request) })
}

test('durable read-only grants allow history but not effects; Origin, CSRF, scope and revocation fence disclosure', async t => {
	const f = await fixture(t, true)
	const owner = await pair(f)
	const denied = await pair(f, { ...readOnlyGrant, personalCurrentAndFuture: false, scopeIds: [randomUUID()] })
	await f.exchange()
	// Reload the actual durable ledger, not a synthetic principal.
	assert.ok(new RemoteAccess(join(f.root, 'devices.json'), () => 1000).principal(owner.deviceId))
	for (const headers of [
		{ ...owner.headers, Origin: 'https://foreign.invalid' },
		{ ...owner.headers, Origin: '' },
		{ ...owner.headers, 'X-Helm-Remote': '' },
		{ ...owner.headers, 'Sec-Fetch-Site': 'cross-site' },
	])
		assert.equal((await withHeaders(f, headers)).status, 403)
	assert.equal((await withHeaders(f, denied.headers)).status, 401)
	const command = {
		protocol: 1,
		hostEpoch: f.host.epoch,
		commandId: randomUUID(),
		target: f.snapshot.target,
		operation: { kind: 'prompt', text: 'Must not send', delivery: 'steer' },
	}
	assert.equal(
		(await fetch(`${f.origin}/v1/commands`, { method: 'POST', headers: owner.headers, body: JSON.stringify(command) }))
			.status,
		403,
	)
	const pending = withHeaders(f, owner.headers)
	const descriptor = await f.delivered()
	assert.equal((await withHeaders(f, owner.headers)).status, 429)
	const result = readResult(f, descriptor)
	assert.equal((await f.uds('/history-result', result)).status, 200)
	assert.deepEqual(await (await pending).json(), result)
	const revoked = withHeaders(f, owner.headers)
	const late = readResult(f, await f.delivered())
	assert.equal(required(f.access).revoke(owner.deviceId), true)
	assert.equal((await revoked).status, 401)
	assert.equal((await f.uds('/history-result', late)).status, 409)
	assert.equal((await withHeaders(f, owner.headers)).status, 401)
	assert.deepEqual(remoteHistoryExchangeSchema.parse((await f.exchange()).body).commands, [])
})

test('device expiry, stale owner, changed epoch and lost negotiation reject reads and late results', async t => {
	for (const cause of ['expiry', 'freshness', 'negotiation'] as const)
		await t.test(cause, async sub => {
			const f = await fixture(sub, true)
			const owner = await pair(f)
			await f.exchange()
			assert.equal((await withHeaders(f, owner.headers, { ...f.readRequest(), hostEpoch: randomUUID() })).status, 409)
			const pending = withHeaders(f, owner.headers)
			const result = readResult(f, await f.delivered())
			if (cause === 'expiry') f.advance(90 * 24 * 60 * 60 * 1000)
			else if (cause === 'freshness') f.advance(5000)
			else await f.exchange(false)
			await f.uds('/history-result', result)
			const response = await pending
			assert.equal(response.status, cause === 'expiry' ? 401 : 409)
			assert.equal((await f.uds('/history-result', result)).status, 409)
		})
})

test('stale owner replacement burns old enrollment and never routes its read to the replacement', async t => {
	const f = await fixture(t)
	await f.exchange()
	const pending = f.browser(f.readRequest())
	const result = readResult(f, await f.delivered())
	const token = createScopedCapability()
	const enrollment = { id: randomUUID(), capabilityHash: hashScopedCapability(token), scopeId: null, generation: 1 }
	f.host.issueEnrollment(enrollment)
	const snapshot = { ...f.snapshot, target: { ...f.snapshot.target, incarnation: randomUUID() } }
	const exchange = () =>
		f.uds('/exchange', { protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] }, true, token, enrollment.id)
	assert.equal((await exchange()).status, 409)
	f.advance(5000)
	assert.equal((await exchange()).status, 200)
	assert.equal((await pending).status, 409)
	assert.equal((await f.uds('/history-result', result)).status, 401)
	assert.equal(remoteHistoryExchangeSchema.parse((await exchange()).body).historyRead, undefined)
	assert.equal((await f.browser(f.readRequest())).status, 409)
})

test('wall-clock deadline releases admission and rejects out-of-order, duplicate and retried old deliveries', async t => {
	const f = await fixture(t)
	await f.exchange()
	const start = Date.now()
	const pending = f.browser(f.readRequest())
	const descriptor = await f.delivered()
	const late = readResult(f, descriptor)
	assert.equal((await pending).status, 503)
	assert.ok(Date.now() - start >= 3900)
	const retry = f.browser(descriptor.request)
	const next = await f.delivered()
	assert.notEqual(next.requestId, descriptor.requestId)
	assert.equal((await f.uds('/history-result', late)).status, 409)
	const result = readResult(f, next)
	assert.equal((await f.uds('/history-result', result)).status, 200)
	assert.equal((await retry).status, 200)
	assert.equal((await f.uds('/history-result', result)).status, 409)
})

test('reachable escaped command pressure plus history stays below exchange cap; reads create no receipt', async t => {
	const f = await fixture(t)
	await f.exchange()
	const ids: string[] = []
	for (let n = 0; n < 8; n++) {
		const commandId = randomUUID()
		ids.push(commandId)
		const command = {
			protocol: 1,
			hostEpoch: f.host.epoch,
			commandId,
			target: f.snapshot.target,
			operation: { kind: 'prompt', text: `x${'\0'.repeat(3900)}`, delivery: 'followUp' },
		}
		assert.ok(Buffer.byteLength(JSON.stringify(command)) < 24 * 1024)
		assert.equal(
			(await fetch(`${f.origin}/v1/commands`, { method: 'POST', headers: f.headers, body: JSON.stringify(command) }))
				.status,
			202,
		)
	}
	const pending = f.browser(f.readRequest())
	const descriptor = await f.delivered()
	const response = remoteHistoryExchangeSchema.parse((await f.exchange()).body)
	assert.equal(response.commands.length, 8)
	assert.deepEqual(
		response.commands.map(value => value.command.commandId),
		ids,
	)
	const bytes = Buffer.byteLength(JSON.stringify(response))
	assert.ok(bytes > 180 * 1024 && bytes < 256 * 1024, `${bytes} serialized bytes`)
	assert.ok(response.historyRead)
	assert.equal((await f.uds('/history-result', readResult(f, descriptor))).status, 200)
	assert.equal((await pending).status, 200)
	const query = new URLSearchParams({
		hostEpoch: f.host.epoch,
		sessionId: f.snapshot.target.sessionId,
		incarnation: f.snapshot.target.incarnation,
	})
	assert.equal(
		(await fetch(`${f.origin}/v1/commands/${descriptor.requestId}?${query}`, { headers: f.headers })).status,
		404,
	)
	// Reachable maximum: eight <=24KiB admitted command bodies, wrappers and a <=4KiB descriptor.
	// No legitimate browser request can reach the defensive 256KiB deferral branch.
	assert.ok(8 * (24 * 1024 + 64) + 4096 + 128 < 256 * 1024)
})

test('complete descriptor including server identity must fit 4KiB before admission', async t => {
	const f = await fixture(t)
	await f.exchange()
	const request = { ...f.readRequest(), action: { kind: 'page', cursor: '\0'.repeat(615) } }
	assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 4096)
	const pending = fetch(`${f.origin}/v1/history/read`, {
		method: 'POST',
		headers: f.headers,
		body: JSON.stringify(request),
	})
	const response = await pending
	assert.equal(response.status, 400)
	assert.equal(remoteHistoryExchangeSchema.parse((await f.exchange()).body).historyRead, undefined)
})

test('real durable devices share eight global slots with no backlog and one slot per target/device', async t => {
	const f = await fixture(t, true)
	const owners = []
	for (let n = 0; n < 9; n++) {
		const device = await pair(f)
		const token = createScopedCapability()
		const enrollment = { id: randomUUID(), capabilityHash: hashScopedCapability(token), scopeId: null, generation: 1 }
		f.host.issueEnrollment(enrollment)
		const snapshot = {
			...f.snapshot,
			target: { ...f.snapshot.target, sessionId: randomUUID(), incarnation: randomUUID() },
		}
		const exchange = () =>
			f.uds(
				'/exchange',
				{ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] },
				true,
				token,
				enrollment.id,
			)
		assert.equal((await exchange()).status, 200)
		owners.push({ device, token, enrollment, snapshot, exchange })
	}
	const pending: Promise<Response>[] = []
	const descriptors: HistoryDescriptor[] = []
	for (const owner of owners.slice(0, 8)) {
		pending.push(withHeaders(f, owner.device.headers, { ...f.readRequest(), target: owner.snapshot.target }))
		let descriptor: HistoryDescriptor | undefined
		for (let n = 0; n < 100 && !descriptor; n++) {
			descriptor = remoteHistoryExchangeSchema.parse((await owner.exchange()).body).historyRead
			if (!descriptor) await delay(5)
		}
		descriptors.push(required(descriptor))
	}
	assert.equal(
		(await withHeaders(f, owners[8].device.headers, { ...f.readRequest(), target: owners[8].snapshot.target })).status,
		429,
	)
	// Free one slot. Neither a second device targeting an occupied owner nor an
	// occupied device targeting the free owner can bypass the independent ceilings.
	assert.equal(required(f.access).revoke(owners[0].device.deviceId), true)
	assert.equal((await pending[0]).status, 401)
	assert.equal(
		(await withHeaders(f, owners[8].device.headers, { ...f.readRequest(), target: owners[1].snapshot.target })).status,
		429,
	)
	assert.equal(
		(await withHeaders(f, owners[1].device.headers, { ...f.readRequest(), target: owners[8].snapshot.target })).status,
		429,
	)
	// Complete in reverse order, not queue/admission order.
	for (let n = 7; n >= 1; n--) {
		const owner = owners[n]
		const d = descriptors[n]
		const reader = new RemoteHistoryReader(
			owner.snapshot.target,
			f.host.epoch,
			() => ({ getLeafId: () => null, getEntry: () => undefined }),
			() => 1000,
		)
		const result = reader.execute(d)
		reader.dispose()
		assert.equal((await f.uds('/history-result', result, true, owner.token, owner.enrollment.id)).status, 200)
		assert.deepEqual(await (await pending[n]).json(), result)
		assert.deepEqual(remoteHistoryExchangeSchema.parse((await owner.exchange()).body).commands, [])
	}
	assert.equal(remoteHistoryExchangeSchema.parse((await owners[8].exchange()).body).historyRead, undefined)
})

test('request/result preparse bounds and malformed/truncated socket bodies leave pending identity intact', async t => {
	const f = await fixture(t)
	await f.exchange()
	assert.equal(
		(await fetch(`${f.origin}/v1/history/read`, { method: 'POST', headers: f.headers, body: '{' })).status,
		400,
	)
	assert.equal(
		(
			await fetch(`${f.origin}/v1/history/read`, {
				method: 'POST',
				headers: f.headers,
				body: JSON.stringify({ padding: 'x'.repeat(4096) }),
			})
		).status,
		413,
	)
	const pending = f.browser(f.readRequest())
	const descriptor = await f.delivered()
	const result = readResult(f, descriptor)
	assert.equal(
		(await f.uds('/history-result', result, true, f.localToken, f.enrollment.id, { Origin: f.origin })).status,
		403,
	)
	// Announced oversize is refused before waiting for the rest of the body.
	assert.equal(
		(
			await f.uds('/history-result', {}, true, f.localToken, f.enrollment.id, {
				'Content-Length': String(HISTORY_RESULT_BYTES + 1),
			})
		).status,
		413,
	)
	for (const endpoint of ['browser', 'result']) {
		const url = new URL(f.origin)
		const request = httpRequest({
			...(endpoint === 'browser'
				? { hostname: url.hostname, port: url.port, path: '/v1/history/read' }
				: { socketPath: f.socketPath, path: '/history-result' }),
			method: 'POST',
			agent: false,
			headers:
				endpoint === 'browser'
					? { ...f.headers, 'Content-Length': '500' }
					: {
							Authorization: `Bearer ${f.localToken}`,
							'X-Helm-Enrollment': f.enrollment.id,
							'Content-Type': 'application/json',
							'Content-Length': '500',
						},
		})
		request.on('error', () => {})
		request.write('{"version":1')
		await delay(20)
		request.destroy() // actual underlength socket close, not a complete malformed JSON body
	}
	await delay(20)
	assert.equal(
		remoteHistoryExchangeSchema.parse((await f.exchange()).body).historyRead?.requestId,
		descriptor.requestId,
	)
	assert.equal((await f.uds('/history-result', result)).status, 200)
	assert.equal((await pending).status, 200)
})

test('real authenticated host and production bridge compose read-only history over the private UDS', async t => {
	const f = await fixture(t, true, true)
	const device = await pair(f)
	const keys = [
		'PI_SUBAGENT_CHILD',
		'HELM_REMOTE_DISABLE_AUTO',
		'OKENA_TERMINAL_ID',
		'HELM_REMOTE_TERMINAL_ID',
		'HELM_REMOTE_TERMINAL_REGISTRY',
	]
	const prior = keys.map(key => [key, process.env[key]] as const)
	const policy = Symbol.for('helm.remote.manual-only.v1')
	const oldPolicy = Object.getOwnPropertyDescriptor(process, policy)
	for (const key of keys) Reflect.deleteProperty(process.env, key)
	process.env.HELM_REMOTE_DISABLE_AUTO = '1'
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>()
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
	const bus = new EventEmitter()
	let effects = 0
	let reads = 0
	const context = {
		mode: 'tui',
		cwd: f.root,
		model: undefined,
		isIdle: () => true,
		ui: { notify() {} },
		abort() {
			effects++
		},
		get sessionManager() {
			reads++
			return {
				getSessionId: () => f.snapshot.target.sessionId,
				getLeafId: () => '00000065',
				getEntry(id: string) {
					const n = Number.parseInt(id, 16)
					if (n < 1 || n > 101) return undefined
					return {
						id,
						parentId: n === 1 ? null : (n - 1).toString(16).padStart(8, '0'),
						type: 'message',
						message: { role: 'user', content: 'Same text' },
					}
				},
			}
		},
	}
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(event, handler)
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, command.handler)
		},
		getSessionName: () => 'Fixture bridge',
		sendUserMessage() {
			effects++
		},
		events: {
			on(name: string, handler: (value: unknown) => void) {
				bus.on(name, handler)
				return () => bus.off(name, handler)
			},
			emit(name: string, value: unknown) {
				bus.emit(name, value)
			},
		},
	}
	t.after(() => {
		handlers.get('session_shutdown')?.({}, context)
		for (const [key, value] of prior) {
			if (value === undefined) Reflect.deleteProperty(process.env, key)
			else process.env[key] = value
		}
		if (oldPolicy) Object.defineProperty(process, policy, oldPolicy)
		else Reflect.deleteProperty(process, policy)
	})
	const path = join(f.root, 'enrollment.json')
	writeFileSync(
		path,
		JSON.stringify({
			protocol: 1,
			enrollmentId: f.enrollment.id,
			capability: f.localToken,
			socketPath: f.socketPath,
			scopeId: null,
			generation: 1,
		}),
		{ mode: 0o600 },
	)
	helmRemoteBridge(pi as never) // public Pi API double; all wire/reader code is production
	assert.equal(reads, 0)
	required(handlers.get('session_start'))({}, context)
	await required(commands.get('helm-remote-connect'))(path, context)
	let target: RemoteSnapshot['target'] | undefined
	for (let n = 0; n < 100 && !target; n++) {
		const directory = await fetch(`${f.origin}/v1/sessions`, { headers: device.headers }).then(response =>
			response.json(),
		)
		target = directory.sessions[0]?.target
		if (!target) await delay(10)
	}
	f.snapshot.target = required(target)
	const request = f.readRequest()
	const first = await withHeaders(f, device.headers, request)
	assert.equal(first.status, 200)
	const result = await first.json()
	assert.equal(result.page.records.length, 40)
	assert.equal(result.page.records[0].message.id, '0000003e')
	assert.equal(result.page.records[39].message.id, '00000065')
	assert.equal(new Set(result.page.records.map((r: { message: { id: string } }) => r.message.id)).size, 40)
	const retry = await (await withHeaders(f, device.headers, request)).json()
	assert.notEqual(retry.requestId, result.requestId)
	assert.deepEqual(retry.page, result.page)
	const older = await (
		await withHeaders(f, device.headers, {
			...request,
			sequence: 1,
			action: { kind: 'page', cursor: result.page.older },
		})
	).json()
	assert.equal(older.page.records[39].message.id, '0000003d')
	assert.equal(effects, 0)
	assert.ok(reads > 1)
	assert.equal(required(f.access).revoke(device.deviceId), true)
	assert.equal((await withHeaders(f, device.headers, request)).status, 401)
	required(handlers.get('session_shutdown'))({}, context)
})

test('explicit scoped read grant cannot read personal or other scoped owners, and unused expiry cannot enroll via results', async t => {
	const f = await fixture(t, true)
	const scope = randomUUID()
	const device = await pair(f, { ...readOnlyGrant, personalCurrentAndFuture: false, scopeIds: [scope] })
	await f.exchange()
	assert.equal((await withHeaders(f, device.headers)).status, 401)
	for (const allowed of [true, false]) {
		const token = createScopedCapability()
		const enrollment = {
			id: randomUUID(),
			capabilityHash: hashScopedCapability(token),
			scopeId: allowed ? scope : randomUUID(),
			generation: 2,
		}
		f.host.issueEnrollment(enrollment)
		const snapshot = {
			...f.snapshot,
			target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: enrollment.scopeId, generation: 2 },
		}
		const exchange = () =>
			f.uds(
				'/exchange',
				{ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] },
				true,
				token,
				enrollment.id,
			)
		assert.equal((await exchange()).status, 200)
		const pending = withHeaders(f, device.headers, { ...f.readRequest(), target: snapshot.target })
		if (!allowed) {
			assert.equal((await pending).status, 401)
			continue
		}
		let descriptor: HistoryDescriptor | undefined
		for (let n = 0; n < 100 && !descriptor; n++) {
			descriptor = remoteHistoryExchangeSchema.parse((await exchange()).body).historyRead
			if (!descriptor) await delay(5)
		}
		const reader = new RemoteHistoryReader(
			snapshot.target,
			f.host.epoch,
			() => ({ getLeafId: () => null, getEntry: () => undefined }),
			() => 1000,
		)
		const result = reader.execute(required(descriptor))
		reader.dispose()
		assert.equal((await f.uds('/history-result', result)).status, 409) // valid but different enrollment
		assert.equal((await f.uds('/history-result', result, true, token, enrollment.id)).status, 200)
		assert.equal((await pending).status, 200)
	}
	const token = createScopedCapability()
	const expired = {
		id: randomUUID(),
		capabilityHash: hashScopedCapability(token),
		scopeId: null,
		generation: 1,
		expiresAt: 1001,
	}
	f.host.issueEnrollment(expired)
	f.advance(2)
	assert.equal(
		(
			await f.uds(
				'/exchange',
				{
					protocol: 1,
					enrollmentId: expired.id,
					snapshot: { ...f.snapshot, target: { ...f.snapshot.target, sessionId: randomUUID() } },
					receipts: [],
				},
				true,
				token,
				expired.id,
			)
		).status,
		403,
	)
	assert.equal((await f.uds('/history-result', {}, true, token, expired.id)).status, 401)
})
