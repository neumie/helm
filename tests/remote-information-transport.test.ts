import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { getRequestListener } from '@hono/node-server'
import browserTransport from '../app/src/renderer/remote/transport.js'
import helmRemoteBridge from '../packages/helm-remote-bridge/index.js'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAccess } from '../src/remote/access.js'
import { RemoteHost } from '../src/remote/host.js'
import {
	FOOTER_INFORMATION_READY,
	FOOTER_INFORMATION_REQUEST,
	SIDEBAR_INFORMATION_READY,
	SIDEBAR_INFORMATION_REQUEST,
} from '../src/remote/information-client.js'
import { projectFooterSource, projectSidebarSource } from '../src/remote/information-projection.js'
import {
	INFORMATION_HEADER,
	INFORMATION_PUBLISH_BYTES,
	INFORMATION_RESPONSE_BYTES,
	informationResponseSchema,
} from '../src/remote/information-protocol.js'
import { RemoteInformationPublisher, postInformation } from '../src/remote/information-transport.js'
import type { RemoteSnapshot } from '../src/remote/protocol.js'

async function fixture(t: { after(fn: () => void | Promise<void>): void }, durable = false) {
	const root = realpathSync(mkdtempSync('/tmp/hr-info-'))
	chmodSync(root, 0o700)
	const capability = createScopedCapability()
	const browserCapability = createScopedCapability()
	const enrollment = {
		id: randomUUID(),
		capabilityHash: hashScopedCapability(capability),
		scopeId: null,
		generation: 1,
	}
	let now = 1000
	const access = durable ? new RemoteAccess(join(root, 'devices.json'), () => now) : undefined
	const web = createServer(getRequestListener((r, e) => host.browser.fetch(r, e)))
	let hideSupport = false
	let informationPosts = 0
	const local = createServer(
		getRequestListener(async (r, e) => {
			if (new URL(r.url).pathname === '/extension-information') informationPosts++
			const response = await host.local.fetch(r, e)
			if (hideSupport) response.headers.delete(INFORMATION_HEADER)
			return response
		}),
	)
	await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve))
	const address = web.address()
	assert.ok(address && typeof address !== 'string')
	const origin = `http://127.0.0.1:${address.port}`
	const host: RemoteHost = new RemoteHost({
		origin,
		enrollments: [enrollment],
		now: () => now,
		...(access ? { access } : { browserCapabilityHash: hashScopedCapability(browserCapability) }),
	})
	const socketPath = join(root, 'host.sock')
	await new Promise<void>(resolve => local.listen(socketPath, resolve))
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
		capabilities: { prompt: true, interrupt: true, answer: false },
		question: null,
		messages: [],
		historyTruncated: false,
	}
	const headers = { Authorization: `Bearer ${browserCapability}`, [INFORMATION_HEADER]: '1' }
	const localHeaders = {
		Authorization: `Bearer ${capability}`,
		'X-Helm-Enrollment': enrollment.id,
		'Content-Type': 'application/json',
		[INFORMATION_HEADER]: '1',
	}
	function uds(path: string, value: unknown, extra: Record<string, string> = {}) {
		return new Promise<{ status: number; body: unknown; support: string | string[] | undefined }>((resolve, reject) => {
			const req = request(
				{ socketPath, path, method: 'POST', agent: false, headers: { ...localHeaders, ...extra } },
				res => {
					let text = ''
					res.on('data', chunk => {
						text += chunk
					})
					res.on('error', reject)
					res.on('end', () =>
						resolve({
							status: res.statusCode ?? 0,
							body: JSON.parse(text),
							support: res.headers[INFORMATION_HEADER.toLowerCase()],
						}),
					)
				},
			)
			req.on('error', reject)
			req.end(JSON.stringify(value))
		})
	}
	const exchangeBody = () => ({ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] })
	const exchange = (support = true) => uds('/exchange', exchangeBody(), { [INFORMATION_HEADER]: support ? '1' : '' })
	const envelope = (sequence = 1) => ({
		version: 1,
		hostEpoch: host.epoch,
		target: snapshot.target,
		sequence,
		footer: { availability: 'unsupported', fields: null },
		sidebar: {
			availability: 'available',
			sections: [
				{
					title: 'Jobs',
					scope: 'session',
					availability: 'available',
					coverage: 'limited',
					rows: [{ label: 'Running', value: 0 }],
					omitted: 0,
				},
			],
			omittedProviders: 0,
		},
	})
	const url = () =>
		`${origin}/v1/sessions/${snapshot.target.sessionId}/information?${new URLSearchParams({ hostEpoch: host.epoch, incarnation: snapshot.target.incarnation, scopeId: '', generation: '1' })}`
	const read = (h: Record<string, string> = headers) => fetch(url(), { headers: h })
	const file = {
		protocol: 1 as const,
		enrollmentId: enrollment.id,
		capability,
		socketPath,
		scopeId: null,
		generation: 1,
	}
	return {
		root,
		host,
		access,
		snapshot,
		exchange,
		exchangeBody,
		envelope,
		uds,
		read,
		url,
		headers,
		localHeaders,
		origin,
		file,
		hideSupport: (value: boolean) => {
			hideSupport = value
		},
		informationPosts: () => informationPosts,
		advance: (ms: number) => {
			now += ms
		},
	}
}

test('actual HTTP/UDS negotiation, independent receipt expiry and strict legacy exchange', async t => {
	const f = await fixture(t)
	assert.equal((await f.uds('/extension-information', f.envelope())).status, 409)
	const legacy = await f.exchange(false)
	assert.equal(legacy.support, undefined)
	assert.deepEqual(Object.keys(legacy.body as object).sort(), ['commands', 'hostEpoch', 'protocol'])
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).status, 'unsupported')
	assert.equal((await f.exchange()).support, '1')
	assert.equal((await f.uds('/extension-information', f.envelope())).status, 200)
	const first = await f.read()
	assert.equal(first.headers.get('cache-control'), 'no-store')
	const bytes = await first.text()
	assert.ok(Buffer.byteLength(bytes) <= INFORMATION_RESPONSE_BYTES)
	assert.equal(informationResponseSchema.parse(JSON.parse(bytes)).freshForMs, 5000)
	f.advance(4000)
	await f.exchange() // Liveness is not an information receipt.
	assert.equal((await f.uds('/extension-information', f.envelope())).status, 409)
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).freshForMs, 1000)
	f.advance(1000)
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).status, 'unavailable')
	assert.equal((await f.uds('/extension-information', f.envelope())).status, 409)
	assert.equal((await f.uds('/extension-information', f.envelope(2))).status, 200)
	await f.exchange(false)
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).status, 'unsupported')
	await f.exchange()
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).status, 'unavailable')
	assert.equal((await f.uds('/extension-information', f.envelope(2))).status, 409)
	assert.equal((await f.uds('/extension-information', f.envelope(Number.MAX_SAFE_INTEGER))).status, 200)
	assert.equal((await f.uds('/extension-information', f.envelope(Number.MAX_SAFE_INTEGER + 1))).status, 400)
	assert.equal((await f.uds('/extension-information', f.envelope(0))).status, 409)
})

test('exact target, epoch, authentication and origin remain errors, not unsupported', async t => {
	const f = await fixture(t)
	assert.equal((await f.read()).status, 404)
	await f.exchange(false)
	assert.equal((await f.read({})).status, 401)
	assert.equal((await f.read({ ...f.headers, Origin: 'https://foreign.invalid' })).status, 403)
	for (const key of ['hostEpoch', 'incarnation', 'scopeId', 'generation']) {
		const url = new URL(f.url())
		url.searchParams.set(key, 'wrong')
		assert.equal(url.origin, f.origin) // Only this fixture's ephemeral loopback listener.
		assert.equal(
			(
				await fetch(`${f.origin}/v1/sessions/${f.snapshot.target.sessionId}/information?${url.searchParams}`, {
					headers: f.headers,
				})
			).status,
			409,
		)
	}
	await f.exchange()
	assert.equal((await f.uds('/extension-information', { ...f.envelope(), hostEpoch: randomUUID() })).status, 409)
	assert.equal((await f.uds('/extension-information', f.envelope(), { Authorization: 'Bearer invalid' })).status, 401)
	assert.equal((await f.uds('/extension-information', f.envelope(), { [INFORMATION_HEADER]: '' })).status, 409)
	const before = await fetch(`${f.origin}/v1/sessions`, { headers: f.headers }).then(r => r.json())
	await f.uds('/extension-information', f.envelope())
	assert.deepEqual(await fetch(`${f.origin}/v1/sessions`, { headers: f.headers }).then(r => r.json()), before)
})

for (const race of ['support', 'revocation', 'replacement'] as const)
	test(`body-await ${race} cannot commit a captured frame`, async t => {
		const f = await fixture(t)
		await f.exchange()
		let release: (() => void) | undefined
		let started: (() => void) | undefined
		const admitted = new Promise<void>(resolve => {
			started = resolve
		})
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{'))
				release = () => {
					controller.enqueue(new TextEncoder().encode(JSON.stringify(f.envelope()).slice(1)))
					controller.close()
				}
			},
			pull() {
				started?.()
			},
		})
		const pending = f.host.local.fetch(
			new Request('http://localhost/extension-information', {
				method: 'POST',
				headers: f.localHeaders,
				body,
				duplex: 'half',
			} as RequestInit),
		)
		await admitted
		await delay(5)
		if (race === 'support') {
			await f.exchange(false)
			await f.exchange()
		}
		if (race === 'revocation') f.host.revoke()
		if (race === 'replacement') {
			f.advance(6000)
			f.host.issueEnrollment({
				id: randomUUID(),
				capabilityHash: hashScopedCapability(createScopedCapability()),
				scopeId: null,
				generation: 1,
			})
		}
		release?.()
		assert.equal((await pending).status, 409)
	})

test('actual byte bound rejects lying lengths, encoded pressure, truncation and aborted streams without disclosure', async t => {
	const f = await fixture(t)
	await f.exchange()
	assert.equal(
		(
			await f.uds(
				'/extension-information',
				{ junk: 'x'.repeat(INFORMATION_PUBLISH_BYTES) },
				{ 'Transfer-Encoding': 'chunked' },
			)
		).status,
		413,
	)
	// A declared oversized upload is refused from headers, before sending bytes.
	// Sending a large pending client write after that early413 legitimately races EPIPE.
	const declaredStatus = await new Promise<number>((resolve, reject) => {
		const req = request(
			{
				socketPath: f.file.socketPath,
				path: '/extension-information',
				method: 'POST',
				agent: false,
				headers: { ...f.localHeaders, 'Content-Length': String(INFORMATION_PUBLISH_BYTES + 1) },
			},
			res => {
				res.resume()
				res.on('end', () => resolve(res.statusCode ?? 0))
				res.on('error', reject)
			},
		)
		req.on('error', reject)
		req.flushHeaders()
	})
	assert.equal(declaredStatus, 413)
	for (const [body, length, status] of [
		['x'.repeat(INFORMATION_PUBLISH_BYTES + 1), '1', 413],
		['{}', '3', 400],
		['{', '1', 400],
	] as const) {
		const response = await f.host.local.fetch(
			new Request('http://localhost/extension-information', {
				method: 'POST',
				headers: { ...f.localHeaders, 'Content-Length': length },
				body,
			}),
		)
		assert.equal(response.status, status)
		assert.ok((await response.text()).length < 100)
	}
	const controller = new AbortController()
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(new TextEncoder().encode('{'))
		},
	})
	const pending = f.host.local.fetch(
		new Request('http://localhost/extension-information', {
			method: 'POST',
			headers: f.localHeaders,
			body,
			signal: controller.signal,
			duplex: 'half',
		} as RequestInit),
	)
	controller.abort()
	assert.ok([400, 409].includes((await pending).status))
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).status, 'unavailable')
	const envelope = f.envelope()
	envelope.sidebar.sections = Array.from({ length: 4 }, (_, n) => ({
		title: '名'.repeat(80),
		scope: 'session',
		availability: 'available',
		coverage: 'limited',
		rows: Array.from({ length: n === 3 ? 11 : 24 }, () => ({ label: '名'.repeat(20), value: 0 })),
		omitted: 10000,
	}))
	await postInformation(f.file, JSON.stringify(envelope), new AbortController().signal)
	const text = await (await f.read()).text()
	assert.ok(Buffer.byteLength(text) <= INFORMATION_RESPONSE_BYTES)
	assert.equal(informationResponseSchema.parse(JSON.parse(text)).information?.sidebar.sections.length, 4)
})

test('durable read-only and scoped devices, revoked credentials, and queued GET revocation', async t => {
	const f = await fixture(t, true)
	assert.ok(f.access)
	const issue = (scoped = false) => {
		const challenge = f.access?.createPairing('Fixture', {
			personalCurrentAndFuture: !scoped,
			scopeIds: scoped ? [randomUUID()] : [],
			operations: { read: true, prompt: false, interrupt: false, answer: false },
		})
		assert.ok(challenge)
		const result = f.access?.redeem({ qrCapability: challenge.qrCapability })
		assert.ok(result)
		return { ...result, headers: { [INFORMATION_HEADER]: '1', Cookie: `__Host-helm-remote=${result.credential}` } }
	}
	const device = issue()
	const other = issue(true)
	await f.exchange()
	await f.uds('/extension-information', f.envelope())
	assert.equal((await f.read(device.headers)).status, 200)
	assert.equal((await f.read(other.headers)).status, 404)
	const pending = f.read(device.headers)
	f.access.revoke(device.principal.deviceId)
	assert.equal((await pending).status, 401)
	assert.equal((await f.read(device.headers)).status, 401)
})

test('production bridge owns one source client across manual reconnect and fences navigation immediately', async t => {
	const f = await fixture(t)
	const keys = [
		'HELM_REMOTE_DISABLE_AUTO',
		'PI_SUBAGENT_CHILD',
		'OKENA_TERMINAL_ID',
		'HELM_REMOTE_TERMINAL_ID',
		'HELM_REMOTE_TERMINAL_REGISTRY',
	]
	const prior = keys.map(key => [key, process.env[key]] as const)
	for (const key of keys) Reflect.deleteProperty(process.env, key)
	process.env.HELM_REMOTE_DISABLE_AUTO = '1'
	const policy = Symbol.for('helm.remote.manual-only.v1')
	const oldPolicy = Object.getOwnPropertyDescriptor(process, policy)
	const bus = new EventEmitter()
	const handlers = new Map<string, (e: unknown, ctx: unknown) => void>()
	const commands = new Map<string, (s: string, ctx: unknown) => Promise<void>>()
	let requests = 0
	let reads = 0
	let sequence = 1
	let footerFails = false
	const context = {
		mode: 'tui',
		cwd: f.root,
		isIdle: () => true,
		ui: { notify() {} },
		sessionManager: {
			getSessionId: () => f.snapshot.target.sessionId,
			getLeafId: () => null,
			getEntry: () => undefined,
		},
	}
	const getter = () => {
		reads++
		return {
			version: 1,
			scope: 'session',
			sessionId: f.snapshot.target.sessionId,
			providerId: 'sidebar',
			sequence,
			sections: f.envelope().sidebar.sections,
			omittedProviders: 0,
		}
	}
	bus.on(SIDEBAR_INFORMATION_REQUEST, () => {
		requests++
		bus.emit(SIDEBAR_INFORMATION_READY, {
			version: 1,
			scope: 'session',
			sessionId: f.snapshot.target.sessionId,
			providerId: 'sidebar',
			readInformation: getter,
		})
	})
	bus.on(FOOTER_INFORMATION_REQUEST, () =>
		bus.emit(FOOTER_INFORMATION_READY, {
			version: 1,
			scope: 'session',
			sessionId: f.snapshot.target.sessionId,
			providerId: 'footer',
			readInformation: () => {
				if (footerFails) throw new Error('private error')
				return {
					version: 1,
					scope: 'session',
					sessionId: f.snapshot.target.sessionId,
					providerId: 'footer',
					sequence: 1,
					available: true,
					cwd: 'Fixture',
					trusted: false,
					sessionName: 'Conversation',
					model: 'Model',
					thinking: 'high',
					inputTokens: 0,
					outputTokens: null,
					contextTokens: null,
					contextWindow: null,
					contextPercent: null,
					goalAvailable: false,
					goalPhase: null,
					omittedStatuses: null,
					omitted: 0,
				}
			},
		}),
	)
	const pi = {
		on: (event: string, fn: (e: unknown, c: unknown) => void) => handlers.set(event, fn),
		registerCommand: (name: string, command: { handler: (s: string, c: unknown) => Promise<void> }) =>
			commands.set(name, command.handler),
		getSessionName: () => 'Fixture',
		sendUserMessage: () => assert.fail('No command effects'),
		events: {
			on: (name: string, fn: (v: unknown) => void) => {
				bus.on(name, fn)
				return () => {
					bus.off(name, fn)
				}
			},
			emit: (name: string, v: unknown) => {
				bus.emit(name, v)
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
	writeFileSync(path, JSON.stringify(f.file), { mode: 0o600 })
	f.hideSupport(true) // Old host accepts the strict exchange but does not negotiate information.
	helmRemoteBridge(pi as never)
	assert.equal(requests, 0)
	handlers.get('session_start')?.({}, context)
	await commands.get('helm-remote-connect')?.(path, context)
	async function available() {
		for (let n = 0; n < 150; n++) {
			const directory = (await fetch(`${f.origin}/v1/sessions`, { headers: f.headers }).then(r => r.json())) as {
				sessions: Array<{ target: RemoteSnapshot['target'] }>
			}
			if (directory.sessions[0]) f.snapshot.target = directory.sessions[0].target
			const response = await f.read()
			if (response.status === 200) {
				const value = informationResponseSchema.parse(await response.json())
				if (value.status === 'available') return value
			}
			await delay(10)
		}
		throw new Error('No information')
	}
	await delay(650)
	assert.equal(f.informationPosts(), 0)
	f.hideSupport(false)
	const first = await available()
	assert.equal(first.information?.sidebar.availability, 'available')
	assert.equal(first.information?.footer.availability, 'available')
	assert.equal(first.information?.footer.fields?.inputTokens, 0)
	assert.equal(first.information?.footer.fields?.trusted, false)
	assert.equal(requests, 1)
	f.hideSupport(true)
	await delay(650)
	const postsAtLoss = f.informationPosts()
	await delay(1100)
	assert.equal(f.informationPosts(), postsAtLoss)
	f.hideSupport(false)
	footerFails = true
	sequence = 0 // Replay invalidation must survive replacement transport.
	await delay(1100)
	await commands.get('helm-remote-disconnect')?.('', context)
	f.advance(6000)
	const next = { ...f.file, enrollmentId: randomUUID(), capability: createScopedCapability() }
	f.host.issueEnrollment({
		id: next.enrollmentId,
		capabilityHash: hashScopedCapability(next.capability),
		scopeId: null,
		generation: 1,
	})
	writeFileSync(path, JSON.stringify(next), { mode: 0o600 })
	await commands.get('helm-remote-connect')?.(path, context)
	const reconnected = await available()
	assert.equal(requests, 1)
	assert.equal(reconnected.information?.sidebar.availability, 'unavailable')
	assert.equal(reconnected.information?.footer.availability, 'unavailable')
	handlers.get('session_before_tree')?.({}, context)
	const readsAtFence = reads
	await delay(1100)
	assert.equal(reads, readsAtFence)
	assert.equal(bus.listenerCount(SIDEBAR_INFORMATION_READY), 0)
	await commands.get('helm-remote-connect')?.(path, context)
	assert.equal(requests, 1)
	handlers.get('session_tree')?.({}, context)
	assert.equal(requests, 2)
	handlers.get('session_shutdown')?.({}, context)
	assert.equal(bus.listenerCount(SIDEBAR_INFORMATION_READY), 0)
})

test('production UDS publisher caps acknowledgements, aborts truncation and absolute deadlines, and never buffers oversize publish', async t => {
	const f = await fixture(t)
	let mode: 'ok' | 'oversize' | 'truncated' | 'legacy' | 'timeout' = 'ok'
	let calls = 0
	const socketPath = join(f.root, 'ack.sock')
	const server = createServer((req, res) => {
		calls++
		assert.equal(req.url, '/extension-information')
		assert.equal(req.headers[INFORMATION_HEADER.toLowerCase()], '1')
		req.resume()
		res.setHeader(INFORMATION_HEADER, '1')
		if (mode === 'timeout') return
		if (mode === 'legacy') res.removeHeader(INFORMATION_HEADER)
		if (mode === 'oversize') {
			res.end('x'.repeat(1025))
			return
		}
		if (mode === 'truncated') {
			res.setHeader('Content-Length', '100')
			res.write('{}')
			res.socket?.destroy()
			return
		}
		res.end('{"ok":true}')
	})
	await new Promise<void>(resolve => server.listen(socketPath, resolve))
	t.after(async () => {
		server.closeAllConnections()
		await new Promise<void>(resolve => server.close(() => resolve()))
	})
	const file = { ...f.file, socketPath }
	const body = JSON.stringify(f.envelope())
	await postInformation(file, body, new AbortController().signal)
	for (const next of ['oversize', 'truncated', 'legacy', 'timeout'] as const) {
		mode = next
		await assert.rejects(postInformation(file, body, new AbortController().signal))
	}
	const before = calls
	await assert.rejects(postInformation(file, 'x'.repeat(INFORMATION_PUBLISH_BYTES + 1), new AbortController().signal))
	assert.equal(calls, before)
	mode = 'ok'
	let current = true
	const value = informationResponseSchema.parse({
		version: 1,
		hostEpoch: f.host.epoch,
		target: f.snapshot.target,
		status: 'available',
		freshForMs: 5000,
		information: f.envelope(),
	}).information
	assert.ok(value)
	const publisher = new RemoteInformationPublisher(
		file,
		f.snapshot.target,
		() => value,
		() => current,
	)
	publisher.publish()
	assert.equal(calls, before) // no negotiation, no source publication
	publisher.negotiate(f.host.epoch, true)
	for (let n = 0; n < 20; n++) publisher.publish()
	await delay(30)
	assert.equal(calls, before + 1)
	publisher.publish()
	await delay(30)
	assert.equal(calls, before + 1) // settled requests still honor the 1Hz bound
	publisher.dispose()
	await delay(1000)
	publisher.publish()
	assert.equal(calls, before + 1)
	const reentrant = new RemoteInformationPublisher(
		file,
		f.snapshot.target,
		() => {
			current = false
			return value
		},
		() => current,
	)
	reentrant.negotiate(f.host.epoch, true)
	reentrant.publish()
	await delay(30)
	assert.equal(calls, before + 1) // producer callback cannot cross lifecycle loss
	reentrant.dispose()
})

test('information receipts never renew liveness and complete owner replacement rejects old target', async t => {
	const f = await fixture(t)
	await f.exchange()
	f.advance(4900)
	assert.equal((await f.uds('/extension-information', f.envelope())).status, 200)
	f.advance(101)
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).status, 'unavailable')
	const oldUrl = f.url()
	const next = { ...f.file, enrollmentId: randomUUID(), capability: createScopedCapability() }
	f.host.issueEnrollment({
		id: next.enrollmentId,
		capabilityHash: hashScopedCapability(next.capability),
		scopeId: null,
		generation: 1,
	})
	f.snapshot.target = { ...f.snapshot.target, incarnation: randomUUID() }
	const result = await f.uds(
		'/exchange',
		{ ...f.exchangeBody(), enrollmentId: next.enrollmentId },
		{ Authorization: `Bearer ${next.capability}`, 'X-Helm-Enrollment': next.enrollmentId },
	)
	assert.equal(result.status, 200)
	assert.equal((await f.uds('/extension-information', f.envelope(2))).status, 401)
	const query = new URL(oldUrl).searchParams
	assert.equal(
		(await fetch(`${f.origin}/v1/sessions/${f.snapshot.target.sessionId}/information?${query}`, { headers: f.headers }))
			.status,
		409,
	)
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).status, 'unavailable')
})

test('discovery callbacks cannot reopen a before-navigation fence during production lifecycle construction', async t => {
	const old = process.env.HELM_REMOTE_DISABLE_AUTO
	process.env.HELM_REMOTE_DISABLE_AUTO = '1'
	const handlers = new Map<string, (e: unknown, ctx: unknown) => void>()
	const bus = new EventEmitter()
	const ctx = { mode: 'tui', sessionManager: { getSessionId: () => randomUUID() } }
	const sessionId = randomUUID()
	ctx.sessionManager.getSessionId = () => sessionId
	let sidebarRequests = 0
	bus.on(FOOTER_INFORMATION_REQUEST, () => handlers.get('session_before_tree')?.({}, ctx))
	bus.on(SIDEBAR_INFORMATION_REQUEST, () => {
		sidebarRequests++
	})
	helmRemoteBridge({
		on: (name: string, fn: (e: unknown, c: unknown) => void) => handlers.set(name, fn),
		registerCommand() {},
		events: {
			on(name: string, fn: (v: unknown) => void) {
				bus.on(name, fn)
				return () => {
					bus.off(name, fn)
				}
			},
			emit(name: string, value: unknown) {
				bus.emit(name, value)
			},
		},
	} as never)
	t.after(() => {
		handlers.get('session_shutdown')?.({}, ctx)
		if (old === undefined) Reflect.deleteProperty(process.env, 'HELM_REMOTE_DISABLE_AUTO')
		else process.env.HELM_REMOTE_DISABLE_AUTO = old
	})
	handlers.get('session_start')?.({}, ctx)
	assert.equal(sidebarRequests, 0)
	assert.equal(bus.listenerCount(FOOTER_INFORMATION_READY), 0)
	assert.equal(bus.listenerCount(SIDEBAR_INFORMATION_READY), 0)
})

test('in-flight production publisher aborts on support loss, host epoch change and disposal', async t => {
	const f = await fixture(t)
	const socketPath = join(f.root, 'pending.sock')
	let started: (() => void) | undefined
	let closed: (() => void) | undefined
	let calls = 0
	const server = createServer((req, res) => {
		calls++
		req.resume()
		res.on('close', () => closed?.())
		started?.()
	})
	await new Promise<void>(resolve => server.listen(socketPath, resolve))
	t.after(async () => {
		server.closeAllConnections()
		await new Promise<void>(resolve => server.close(() => resolve()))
	})
	for (const action of ['support', 'epoch', 'dispose'] as const) {
		const start = new Promise<void>(resolve => {
			started = resolve
		})
		const close = new Promise<void>(resolve => {
			closed = resolve
		})
		const value = informationResponseSchema.parse({
			version: 1,
			hostEpoch: f.host.epoch,
			target: f.snapshot.target,
			status: 'available',
			freshForMs: 5000,
			information: f.envelope(),
		}).information
		assert.ok(value)
		const publisher = new RemoteInformationPublisher(
			{ ...f.file, socketPath },
			f.snapshot.target,
			() => value,
			() => true,
		)
		publisher.negotiate(f.host.epoch, true)
		publisher.publish()
		await start
		const before = calls
		for (let n = 0; n < 10; n++) publisher.publish()
		assert.equal(calls, before)
		if (action === 'support') publisher.negotiate(f.host.epoch, false)
		else if (action === 'epoch') publisher.negotiate(randomUUID(), true)
		else publisher.dispose()
		await close
		publisher.dispose()
	}
})

test('reachable maximum encoded producer payload passes actual private and browser response byte caps', async t => {
	const f = await fixture(t)
	await f.exchange()
	let sidebar: ReturnType<typeof projectSidebarSource> = null
	let bytes = 0
	for (let width = 1; width <= 80; width++) {
		const source = {
			version: 1,
			scope: 'session',
			sessionId: 'S'.repeat(1024),
			providerId: 'P'.repeat(128),
			sequence: Number.MAX_SAFE_INTEGER,
			omittedProviders: 10000,
			sections: [24, 24, 24, 11, 0, 0, 0].map(count => ({
				title: 'T'.repeat(80),
				scope: 'session',
				availability: 'available',
				coverage: 'limited',
				omitted: 10000,
				rows: Array.from({ length: count }, () => ({ label: '"'.repeat(80), value: '😀'.repeat(width) })),
			})),
		}
		const projected = projectSidebarSource(source)
		if (projected) {
			sidebar = projected
			bytes = Buffer.byteLength(JSON.stringify(source))
		}
	}
	assert.ok(sidebar)
	assert.ok(bytes > 20 * 1024 - 4 * 83)
	const footer = projectFooterSource({
		version: 1,
		scope: 'session',
		sessionId: 'S'.repeat(1024),
		providerId: 'F'.repeat(128),
		sequence: Number.MAX_SAFE_INTEGER,
		available: true,
		cwd: '😀'.repeat(80),
		trusted: false,
		sessionName: '😀'.repeat(80),
		model: '😀'.repeat(80),
		thinking: 'xhigh',
		inputTokens: Number.MAX_SAFE_INTEGER,
		outputTokens: Number.MAX_SAFE_INTEGER,
		contextTokens: Number.MAX_SAFE_INTEGER,
		contextWindow: Number.MAX_SAFE_INTEGER,
		contextPercent: 100,
		goalAvailable: false,
		goalPhase: null,
		omittedStatuses: 10000,
		omitted: 10000,
	})
	assert.ok(footer)
	const envelope = { ...f.envelope(Number.MAX_SAFE_INTEGER), footer: footer.information, sidebar: sidebar.information }
	const body = JSON.stringify(envelope)
	assert.ok(Buffer.byteLength(body) < INFORMATION_PUBLISH_BYTES)
	await postInformation(f.file, body, new AbortController().signal)
	const response = await (await f.read()).text()
	assert.ok(Buffer.byteLength(response) <= INFORMATION_RESPONSE_BYTES)
	assert.deepEqual(informationResponseSchema.parse(JSON.parse(response)).information, envelope)
	const oversized = {
		...envelope,
		sidebar: {
			...envelope.sidebar,
			sections: envelope.sidebar.sections.map(section => ({
				...section,
				rows: section.rows.map(row => ({ ...row, value: '😀'.repeat(80) })),
			})),
		},
	}
	// The already-proved actual 31KiB+ UDS case owns early socket rejection.
	// This unreachable 44KiB+ schema adversary uses the production body seam;
	// do not race a fixture's large pending client write against early413 teardown.
	const rejected = await f.host.local.fetch(
		new Request('http://localhost/extension-information', {
			method: 'POST',
			headers: f.localHeaders,
			body: JSON.stringify(oversized),
		}),
	)
	assert.equal(rejected.status, 413)
})

test('aborted/truncated real UDS upload and stalled body deadline leave admission unchanged and server usable', async t => {
	const f = await fixture(t)
	await f.exchange()
	await new Promise<void>((resolve, reject) => {
		const req = request(
			{
				socketPath: f.file.socketPath,
				path: '/extension-information',
				agent: false,
				method: 'POST',
				headers: { ...f.localHeaders, 'Content-Length': '1000' },
			},
			res => {
				res.resume()
			},
		)
		req.on('error', error => {
			if (error.message !== 'fixture_abort') reject(error)
		})
		req.on('close', resolve)
		req.write('{')
		setTimeout(() => req.destroy(new Error('fixture_abort')), 20)
	})
	const pending = f.host.local.fetch(
		new Request('http://localhost/extension-information', {
			method: 'POST',
			headers: f.localHeaders,
			body: new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode('{'))
				},
			}),
			duplex: 'half',
		} as RequestInit),
	)
	assert.equal((await pending).status, 400)
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).status, 'unavailable')
	assert.equal((await f.uds('/extension-information', f.envelope())).status, 200)
	assert.equal(informationResponseSchema.parse(await (await f.read()).json()).status, 'available')
})

test('production browser decoder composes with isolated HTTP host and private UDS publication', async t => {
	const f = await fixture(t)
	await f.exchange()
	assert.equal((await f.uds('/extension-information', f.envelope())).status, 200)
	const originalFetch = globalThis.fetch
	// Only resolve the browser-relative URL; bytes/auth/negotiation traverse the real HTTP host.
	t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) =>
		originalFetch(typeof input === 'string' && input.startsWith('/') ? `${f.origin}${input}` : input, init),
	)
	const { createRemoteTransport, RemoteAccessError } = browserTransport
	const transport = createRemoteTransport(f.headers.Authorization.slice('Bearer '.length))
	const readInformation = transport.information
	assert.ok(readInformation)
	const owner = { hostEpoch: f.host.epoch, target: f.snapshot.target }
	const value = await readInformation(owner, new AbortController().signal)
	assert.equal(value.status, 'available')
	assert.equal(value.information?.sidebar.sections[0]?.rows[0]?.value, 0)
	f.advance(5000)
	await f.exchange()
	assert.equal((await readInformation(owner, new AbortController().signal)).status, 'unavailable')
	await f.exchange(false)
	assert.equal((await readInformation(owner, new AbortController().signal)).status, 'unsupported')
	await assert.rejects(
		() => readInformation({ ...owner, target: { ...owner.target, generation: 2 } }, new AbortController().signal),
		error => error instanceof Error && error instanceof RemoteAccessError && 'status' in error && error.status === 409,
	)
})
