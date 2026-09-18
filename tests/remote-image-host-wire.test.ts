import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { Agent, ServerResponse, createServer, request as httpRequest } from 'node:http'
import type { ClientRequest } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { getRequestListener } from '@hono/node-server'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAccess } from '../src/remote/access.js'
import { RemoteHost } from '../src/remote/host.js'
import { ImageResponseError, RemoteImageBody } from '../src/remote/image-body.js'
import { imageUploadEnvelopeSchema } from '../src/remote/image-input-protocol.js'
import type { ImageStoreBinding } from '../src/remote/image-input-protocol.js'
import { RemoteImageStore } from '../src/remote/image-store.js'
import type { RemoteCommand, RemoteImageReadRequest, RemoteReceipt, RemoteSnapshot } from '../src/remote/protocol.js'
import { baselineJpeg } from './fixtures/remote-image-input.js'

function deferred<T>() {
	const callbacks: { resolve?: (value: T | PromiseLike<T>) => void; reject?: (reason?: unknown) => void } = {}
	const promise = new Promise<T>((resolve, reject) => Object.assign(callbacks, { resolve, reject }))
	assert.ok(callbacks.resolve)
	assert.ok(callbacks.reject)
	return { promise, resolve: callbacks.resolve, reject: callbacks.reject }
}

async function hostFixture(now: () => number = Date.now, access?: RemoteAccess, credential?: string) {
	const localToken = createScopedCapability()
	const browserToken = createScopedCapability()
	const enrollment = {
		id: randomUUID(),
		capabilityHash: hashScopedCapability(localToken),
		scopeId: null,
		generation: 1,
	}
	const origin = 'http://127.0.0.1:8491'
	const host = new RemoteHost({
		origin,
		enrollments: [enrollment],
		...(access ? { access } : { browserCapabilityHash: hashScopedCapability(browserToken) }),
		now,
	})
	const snapshot: RemoteSnapshot = {
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
		revision: 1,
		label: 'Synthetic image wire fixture',
		workspace: 'Fixture',
		model: 'Fixture vision',
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: false },
		question: null,
		messages: [],
		historyTruncated: false,
		imageInput: { version: 1, available: true },
	}
	const headers = {
		Host: new URL(origin).host,
		Origin: origin,
		Authorization: `Bearer ${browserToken}`,
		...(credential ? { Cookie: `__Host-helm-remote=${credential}` } : {}),
		'X-Helm-Remote': '1',
		'X-Helm-Image-Input': '1',
	}
	const localHeaders = {
		Authorization: `Bearer ${localToken}`,
		'X-Helm-Enrollment': enrollment.id,
		'Content-Type': 'application/json',
		'X-Helm-Image-Input': '1',
	}
	const exchange = (receipts: RemoteReceipt[] = []) =>
		host.local.request('/exchange', {
			method: 'POST',
			headers: localHeaders,
			body: JSON.stringify({
				protocol: 1,
				enrollmentId: enrollment.id,
				snapshot: { ...snapshot, revision: snapshot.revision++ },
				receipts,
			}),
		})
	assert.equal((await exchange()).status, 200)
	const query = new URLSearchParams({
		hostEpoch: host.epoch,
		incarnation: snapshot.target.incarnation,
		scopeId: '',
		generation: '1',
	})
	const upload = await host.browser.request(`/v1/sessions/${snapshot.target.sessionId}/images?${query}`, {
		method: 'POST',
		headers: { ...headers, 'Content-Type': 'image/jpeg', 'Content-Length': String(baselineJpeg.length) },
		body: baselineJpeg,
	})
	assert.equal(upload.status, 201)
	const { image } = imageUploadEnvelopeSchema.parse(await upload.json())
	const command: RemoteCommand = {
		protocol: 1,
		hostEpoch: host.epoch,
		commandId: randomUUID(),
		target: snapshot.target,
		operation: { kind: 'prompt', delivery: 'followUp', text: '', images: [image] },
	}
	assert.equal(
		(
			await host.browser.request('/v1/commands', {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify(command),
			})
		).status,
		202,
	)
	const descriptor: RemoteImageReadRequest = {
		protocol: 1,
		hostEpoch: host.epoch,
		target: snapshot.target,
		commandId: command.commandId,
		image,
	}
	const metadata = async (
		body: NonNullable<RequestInit['body']>,
		extra: Record<string, string> = {},
		signal?: AbortSignal,
	) =>
		host.local.request('/image-input', {
			method: 'POST',
			headers: { ...localHeaders, ...extra },
			body,
			signal,
			duplex: 'half',
		} as RequestInit)
	const read = (value = descriptor) => metadata(JSON.stringify(value))
	return { host, snapshot, localHeaders, headers, command, descriptor, exchange, metadata, read }
}

/** Real adapter/socket; only end() is held to deterministically expose prefetched EOF. */
async function nodeFixture(f: Awaited<ReturnType<typeof hostFixture>>, uds = false, holdCount = 0) {
	const root = uds ? realpathSync(mkdtempSync('/tmp/hr-img-wire-')) : undefined
	const held: Array<{ outgoing: ServerResponse; release: () => void }> = []
	const arrived = Array.from({ length: holdCount }, () => deferred<void>())
	const requests: ClientRequest[] = []
	const agents: Agent[] = []
	const server = createServer(
		getRequestListener(async (request, env) => {
			const response = await f.host.local.fetch(request, env)
			if (response.status === 200 && held.length < holdCount) {
				const outgoing = env.outgoing
				assert.ok(outgoing instanceof ServerResponse)
				const end = outgoing.end
				outgoing.end = (...args: unknown[]) => {
					const index = held.length
					held.push({
						outgoing,
						release: () => (end as (...values: unknown[]) => ServerResponse).apply(outgoing, args),
					})
					arrived[index]?.resolve()
					return outgoing
				}
			}
			return response
		}),
	)
	const listening = once(server, 'listening')
	if (root) server.listen(join(root, 's'))
	else server.listen(0, '127.0.0.1')
	await listening
	const address = server.address()
	assert.ok(address)
	const endpoint = typeof address === 'string' ? { socketPath: address } : { host: '127.0.0.1', port: address.port }
	const send = (body = JSON.stringify(f.descriptor), end = true, extra: Record<string, string> = {}) => {
		const result = deferred<{ status: number; bytes: Buffer }>()
		// Observe failures immediately; callers may first await the held-end signal.
		void result.promise.catch(() => {})
		// Separate keep-alive clients avoid both pipelining and automatic client
		// FIN after Content-Length bytes (the held outgoing has not finished yet).
		const agent = new Agent({ keepAlive: true })
		agents.push(agent)
		const request = httpRequest(
			{ ...endpoint, path: '/image-input', method: 'POST', agent, headers: { ...f.localHeaders, ...extra } },
			response => {
				const chunks: Buffer[] = []
				response.on('data', chunk => chunks.push(chunk))
				response.once('error', result.reject)
				response.once('end', () => result.resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks) }))
			},
		)
		requests.push(request)
		request.once('error', result.reject)
		if (end) request.end(body)
		else request.write(body)
		return { request, result: result.promise }
	}
	const close = async () => {
		for (const item of held) if (!item.outgoing.destroyed) item.release()
		for (const request of requests) request.destroy()
		for (const agent of agents) agent.destroy()
		const closed = new Promise<void>(resolve => server.close(() => resolve()))
		server.closeAllConnections()
		await closed
		assert.equal(server.listening, false)
		if (root) rmSync(root, { recursive: true, force: true })
	}
	return { held, arrived, send, close }
}

test('real HTTP prefetched EOF retains two principal slots until outgoing finish', { timeout: 10_000 }, async () => {
	const f = await hostFixture()
	const wire = await nodeFixture(f, false, 2)
	try {
		assert.equal((await f.exchange()).status, 200)
		const first = wire.send()
		await wire.arrived[0].promise
		const second = wire.send()
		await wire.arrived[1].promise
		assert.ok(
			wire.held.every(({ outgoing }) => !outgoing.writableEnded && !outgoing.writableFinished && !outgoing.destroyed),
		)
		const refused = await f.read()
		try {
			assert.equal(refused.status, 429)
		} finally {
			await refused.body?.cancel()
		}
		const finished = once(wire.held[0].outgoing, 'finish')
		wire.held[0].release()
		await finished
		assert.deepEqual((await first.result).bytes, baselineJpeg)
		const recovered = await f.read()
		assert.equal(recovered.status, 200)
		assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), baselineJpeg)
		wire.held[1].release()
		assert.deepEqual((await second.result).bytes, baselineJpeg)
	} finally {
		await wire.close()
		f.host.revoke()
	}
})

function heldMetadata() {
	const started = deferred<void>()
	let pulls = 0
	let finished = false
	let controller: ReadableStreamDefaultController<Uint8Array>
	const body = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value
			},
			pull() {
				pulls++
				started.resolve()
			},
		},
		{ highWaterMark: 0 },
	)
	return {
		body,
		started: started.promise,
		pulls: () => pulls,
		finish(text: string | Uint8Array = '{}') {
			if (finished) return
			finished = true
			controller.enqueue(typeof text === 'string' ? Buffer.from(text) : text)
			controller.close()
		},
	}
}

test('metadata and unread responses share four slots; unknown setups are not development principals', async () => {
	const f = await hostFixture()
	const held = Array.from({ length: 3 }, heldMetadata)
	const pending: Array<Promise<Response>> = []
	const responses: Response[] = []
	try {
		await f.exchange()
		for (const value of held) {
			pending.push(f.metadata(value.body))
			await value.started
		}
		const published = await f.read()
		responses.push(published)
		assert.equal(published.status, 200, 'unknown setups must not count as known development responses')
		const refusedBody = heldMetadata()
		const refused = await f.metadata(refusedBody.body)
		assert.equal(refused.status, 429)
		assert.equal(refusedBody.pulls(), 0, 'no metadata read after combined capacity is exhausted')
		refusedBody.finish()
	} finally {
		for (const value of held) value.finish()
		await Promise.all(pending)
		for (const response of responses) await response.body?.cancel()
		f.host.revoke()
	}
})

test('two responses plus two metadata awaiters exhaust combined global capacity', async () => {
	const f = await hostFixture()
	const held = Array.from({ length: 2 }, heldMetadata)
	const pending: Array<Promise<Response>> = []
	const responses: Response[] = []
	try {
		await f.exchange()
		for (let index = 0; index < 2; index++) {
			const response = await f.read()
			responses.push(response)
			assert.equal(response.status, 200)
		}
		for (const value of held) {
			pending.push(f.metadata(value.body))
			await value.started
		}
		const overflow = heldMetadata()
		const refused = f.metadata(overflow.body)
		// Release the body so buggy admission fails promptly rather than by a test timeout.
		overflow.finish()
		assert.equal((await refused).status, 429)
		assert.equal(overflow.pulls(), 0)
	} finally {
		for (const value of held) value.finish()
		await Promise.all(pending)
		for (const response of responses) await response.body?.cancel()
		f.host.revoke()
	}
})

test('private descriptors refuse wrong epoch, full reference, undelivered and terminal commands', async () => {
	const f = await hostFixture()
	try {
		assert.equal((await f.read()).status, 409, 'not delivered')
		await f.exchange()
		const good = await f.read()
		assert.equal(good.status, 200)
		assert.deepEqual(Buffer.from(await good.arrayBuffer()), baselineJpeg)
		for (const change of [
			{ hostEpoch: randomUUID() },
			{ commandId: randomUUID() },
			{ target: { ...f.descriptor.target, incarnation: randomUUID() } },
			...Object.entries({
				handle: randomUUID(),
				sha256: '0'.repeat(64),
				bytes: baselineJpeg.length + 1,
				width: 193,
				height: 193,
			}).map(([key, value]) => ({ image: { ...f.descriptor.image, [key]: value } })),
		])
			assert.equal((await f.read({ ...f.descriptor, ...change })).status, 409)
		await f.exchange([{ commandId: f.descriptor.commandId, status: 'dispatched' }])
		assert.equal((await f.read()).status, 409, 'terminal')
	} finally {
		f.host.revoke()
	}
})

test('private streaming guard refuses native prompt loss after publication', async () => {
	const f = await hostFixture()
	try {
		await f.exchange()
		const response = await f.read()
		assert.equal(response.status, 200)
		f.snapshot.capabilities.prompt = false
		assert.equal((await f.exchange()).status, 200)
		await assert.rejects(response.arrayBuffer(), /image_read_closed/)
	} finally {
		f.host.revoke()
	}
})

for (const uds of [false, true]) {
	test(
		`real ${uds ? 'UDS' : 'HTTP'} serves exact JPEG and rejects before incoming completion`,
		{ timeout: 10_000 },
		async () => {
			const f = await hostFixture()
			const wire = await nodeFixture(f, uds)
			try {
				await f.exchange()
				const good = await wire.send().result
				assert.equal(good.status, 200)
				assert.deepEqual(good.bytes, baselineJpeg)
				const open = wire.send('{}', false, { 'Content-Length': '4097' })
				const refused = await open.result
				assert.equal(refused.status, 413)
				assert.equal(open.request.writableEnded, false, 'handled JSON arrives while request is unfinished')
				assert.equal(JSON.parse(refused.bytes.toString()).error, 'payload_too_large')
			} finally {
				await wire.close()
				f.host.revoke()
			}
		},
	)
}

test('real UDS client disconnect closes its response and recovers capacity', { timeout: 10_000 }, async () => {
	const f = await hostFixture()
	const wire = await nodeFixture(f, true, 2)
	try {
		await f.exchange()
		const first = wire.send()
		await wire.arrived[0].promise
		const second = wire.send()
		await wire.arrived[1].promise
		assert.equal((await f.read()).status, 429)
		const closed = new Promise<void>(resolve => wire.held[0].outgoing.once('close', resolve))
		first.request.socket?.destroy()
		await closed
		const recovered = await f.read()
		assert.equal(recovered.status, 200)
		assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), baselineJpeg)
		wire.held[1].release()
		await Promise.allSettled([first.result, second.result])
	} finally {
		await wire.close()
		f.host.revoke()
	}
})

test(
	'real Node timeout after copied EOF retains slots through requested but delayed socket teardown',
	{ timeout: 10_000 },
	async () => {
		const f = await hostFixture()
		const wire = await nodeFixture(f, false, 2)
		const release: Array<() => void> = []
		try {
			await f.exchange()
			wire.send()
			await wire.arrived[0].promise
			wire.send()
			await wire.arrived[1].promise
			const requests = wire.held.map(({ outgoing }) => {
				const destroy = outgoing.destroy
				const requested = deferred<void>()
				// Deterministic instrumentation of the exact real outgoing's destroy
				// request/flag, not a fake writable or natural OS-backpressure proof.
				let error: Error | undefined
				outgoing.destroy = reason => {
					outgoing.destroyed = true
					error = reason
					requested.resolve()
					return outgoing
				}
				release.push(() => {
					outgoing.destroy = destroy
					outgoing.destroyed = false
					destroy.call(outgoing, error)
				})
				return requested.promise
			})
			await Promise.all(requests)
			assert.ok(wire.held.every(({ outgoing }) => outgoing.destroyed && !outgoing.closed && !outgoing.writableFinished))
			assert.equal((await f.read()).status, 429, 'destroy request cannot release either response slot')
			const closed = wire.held.map(({ outgoing }) => new Promise<void>(resolve => outgoing.once('close', resolve)))
			for (const finish of release.splice(0)) finish()
			await Promise.all(closed)
			const recovered = await f.read()
			assert.equal(recovered.status, 200)
			assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), baselineJpeg)
		} finally {
			for (const finish of release) finish()
			await wire.close()
			f.host.revoke()
		}
	},
)

test('real Node support loss terminates exact unfinished outgoing after Web EOF', { timeout: 10_000 }, async () => {
	const f = await hostFixture()
	const wire = await nodeFixture(f, false, 1)
	try {
		await f.exchange()
		const client = wire.send()
		await wire.arrived[0].promise
		const outgoing = wire.held[0].outgoing
		const closed = new Promise<void>(resolve => outgoing.once('close', resolve))
		f.snapshot.imageInput = { version: 1, available: false }
		assert.equal((await f.exchange()).status, 200)
		await closed
		assert.equal(outgoing.destroyed, true)
		assert.equal(outgoing.writableFinished, false)
		await Promise.allSettled([client.result])
	} finally {
		await wire.close()
		f.host.revoke()
	}
})

test('slow metadata keeps original deadline and never-read direct reader is errored', { timeout: 8_000 }, async () => {
	const f = await hostFixture()
	const held = heldMetadata()
	try {
		await f.exchange()
		const pending = f.metadata(held.body)
		await held.started
		await delay(1200)
		held.finish(JSON.stringify(f.descriptor))
		const response = await pending
		assert.equal(response.status, 200)
		const reader = response.body?.getReader()
		assert.ok(reader)
		const result = reader.closed.then(
			() => 'closed',
			() => 'errored',
		)
		assert.equal(await Promise.race([result, delay(1300, 'fresh-deadline')]), 'errored')
		assert.deepEqual(Buffer.from(await (await f.read()).arrayBuffer()), baselineJpeg)
	} finally {
		f.host.revoke()
	}
})

for (const loss of ['abort', 'support', 'owner', 'stop'] as const) {
	test(`stalled metadata settles promptly on ${loss} without cancelling incoming`, { timeout: 5_000 }, async () => {
		let now = Date.now()
		const f = await hostFixture(() => now)
		const held = heldMetadata()
		const abort = new AbortController()
		try {
			const pending = f.metadata(held.body, {}, abort.signal)
			await held.started
			if (loss === 'abort') abort.abort()
			if (loss === 'support') {
				f.snapshot.imageInput = { version: 1, available: false }
				await f.exchange()
			}
			if (loss === 'owner') {
				now += 6000
				f.host.issueEnrollment({
					id: randomUUID(),
					capabilityHash: hashScopedCapability(createScopedCapability()),
					scopeId: null,
					generation: 1,
				})
			}
			if (loss === 'stop') f.host.revoke()
			const response = await Promise.race([pending, delay(500, undefined)])
			assert.ok(response, 'must not wait for the two-second timeout')
			assert.notEqual(response.status, 200)
			assert.notEqual(response.status, 500)
			assert.equal(held.body.locked, false)
			held.finish()
		} finally {
			f.host.revoke()
		}
	})
}

test('descriptor early refusals survive deadlines in a disposable Node process', { timeout: 30_000 }, async () => {
	const script = `
		import assert from 'node:assert/strict';
		import { randomUUID } from 'node:crypto';
		import { setTimeout as delay } from 'node:timers/promises';
		import { RemoteHost } from ${JSON.stringify(new URL('../src/remote/host.ts', import.meta.url).href)};
		import { createScopedCapability, hashScopedCapability } from ${JSON.stringify(new URL('../src/auth/scoped-capability.ts', import.meta.url).href)};
		const token = createScopedCapability();
		const enrollment = { id: randomUUID(), capabilityHash: hashScopedCapability(token), scopeId: null, generation: 1 };
		const host = new RemoteHost({ origin: 'http://127.0.0.1:8491', enrollments: [enrollment], browserCapabilityHash: hashScopedCapability(createScopedCapability()) });
		const headers = { Authorization: 'Bearer ' + token, 'X-Helm-Enrollment': enrollment.id, 'Content-Type': 'application/json', 'X-Helm-Image-Input': '1' };
		try {
			const snapshot = { target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 }, revision: 1, label: 'Process fixture', workspace: 'Fixture', model: null, activity: 'idle', capabilities: { prompt: true, interrupt: true, answer: false }, question: null, messages: [], historyTruncated: false, imageInput: { version: 1, available: true } };
			assert.equal((await host.local.request('/exchange', { method: 'POST', headers, body: JSON.stringify({ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] }) })).status, 200);
			assert.equal(process.listenerCount('unhandledRejection'), 0);
			for (const [length, status] of [['4097', 413], ['2', 400], ['invalid', 400], ['02', 400], ['0', 400]]) {
				const response = await host.local.request('/image-input', { method: 'POST', headers: { ...headers, 'Content-Length': length }, body: '{}' });
				assert.equal(response.status, status);
			}
			await delay(2200);
			console.log('survived descriptor deadlines');
		} finally { host.revoke() }
	`
	const root = realpathSync(mkdtempSync('/tmp/hr-img-process-'))
	try {
		const path = join(root, 'descriptor.mts')
		writeFileSync(path, script, { mode: 0o600 })
		const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', path], { timeout: 25_000 })
		assert.match(stdout, /survived descriptor deadlines/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

// Genuine baseline JPEG with valid COM segments; pixel data is unchanged and
// the SOF/dimension proof remains inside the 256KiB structural validation budget.
function largeJpeg(): Buffer {
	const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, 0xff]), Buffer.alloc(65_533, 0x20)])
	return Buffer.concat([baselineJpeg.subarray(0, 2), comment, comment, baselineJpeg.subarray(2)])
}

function helperFixture(bytes: Uint8Array = baselineJpeg, live: () => boolean = () => true) {
	const owner = binding()
	const store = new RemoteImageStore({ isBindingLive: live })
	const body = new RemoteImageBody(store)
	const reservation = store.reserve(owner, bytes.length)
	reservation.append(bytes)
	const ref = reservation.commit()
	const commandId = randomUUID()
	const deadline = Date.now() + 10_000
	assert.equal(store.bind([ref], owner, commandId, deadline), true)
	const response = (valid: () => boolean = () => true) =>
		body.response(ref, owner, undefined, commandId, ref.bytes, deadline, valid)
	return {
		owner,
		store,
		body,
		ref,
		commandId,
		response,
		close() {
			body.dispose()
			store.dispose()
		},
	}
}

test('partial direct image retirement errors rather than returning truncated success', async () => {
	const f = helperFixture(largeJpeg())
	try {
		const response = f.response()
		const reader = response.body?.getReader()
		assert.ok(reader)
		const first = await reader.read()
		assert.equal(first.value?.byteLength, 64 * 1024)
		f.store.retireCommand(f.owner, f.commandId)
		await assert.rejects(reader.read(), /image_read_closed/)
		assert.equal(f.store.usage().reads, 0)
	} finally {
		f.close()
	}
})

for (const failure of ['early-eof', 'oversize-chunk', 'overrun', 'throwing-guard'] as const) {
	test(`response defensive lease boundary rejects ${failure}`, async () => {
		const f = helperFixture()
		let valid = true
		try {
			const open = f.store.openRead.bind(f.store)
			if (failure !== 'throwing-guard')
				f.store.openRead = (...args) => {
					const lease = open(...args)
					assert.ok(lease)
					return {
						release: () => lease.release(),
						nextChunk: () =>
							failure === 'early-eof' ? null : new Uint8Array(failure === 'overrun' ? baselineJpeg.length + 1 : 65_537),
					}
				}
			const response = f.response(() => {
				if (!valid) throw new Error('synthetic guard failure')
				return true
			})
			if (failure === 'throwing-guard') valid = false
			await assert.rejects(response.arrayBuffer(), /image_read_closed/)
			assert.equal(f.store.usage().reads, 0)
		} finally {
			f.close()
		}
	})
}

test('reentrant lease opening cannot publish or retain a late store lease after disposal', () => {
	let onLive = () => {}
	const f = helperFixture(baselineJpeg, () => {
		onLive()
		return true
	})
	try {
		onLive = () => f.body.dispose()
		assert.throws(
			() => f.response(),
			error => error instanceof ImageResponseError && error.status === 409,
		)
		assert.equal(f.store.usage().reads, 0, 'late lease was released')
	} finally {
		f.close()
	}
})

test('response quotas separate known principals and recover after exact direct completion', async () => {
	const store = new RemoteImageStore({ isBindingLive: () => true })
	const body = new RemoteImageBody(store)
	const responses: Response[] = []
	const open = (deviceId: string) => {
		const owner = { ...binding(), deviceId, grantRevision: 1 }
		const reservation = store.reserve(owner, baselineJpeg.length)
		reservation.append(baselineJpeg)
		const ref = reservation.commit()
		const command = randomUUID()
		assert.equal(store.bind([ref], owner, command, Date.now() + 10_000), true)
		return () => body.response(ref, owner, deviceId, command, ref.bytes, Date.now() + 10_000, () => true)
	}
	try {
		const a = open('a')
		const b = open('b')
		const c = open('c')
		responses.push(a(), a())
		assert.throws(a, error => error instanceof ImageResponseError && error.status === 429)
		responses.push(b(), b())
		assert.throws(c, error => error instanceof ImageResponseError && error.status === 429)
		assert.deepEqual(Buffer.from(await responses[0].arrayBuffer()), baselineJpeg)
		responses.push(c())
		assert.equal(responses[4].status, 200)
	} finally {
		for (const response of responses) if (!response.bodyUsed) await response.body?.cancel()
		body.dispose()
		store.dispose()
	}
})

test('private read refuses an expired command even after a fresh owner heartbeat', async () => {
	let now = Date.now()
	const f = await hostFixture(() => now)
	try {
		await f.exchange()
		now += 10_001
		await f.exchange()
		assert.equal((await f.read()).status, 409)
	} finally {
		f.host.revoke()
	}
})

test('four active uploads do not consume the independent metadata response pool', async () => {
	const store = new RemoteImageStore({ isBindingLive: () => true })
	const body = new RemoteImageBody(store)
	const held = Array.from({ length: 4 }, heldMetadata)
	const uploads: Array<Promise<unknown>> = []
	const setups: Array<ReturnType<RemoteImageBody['beginSetup']>> = []
	try {
		for (let index = 0; index < 4; index++) {
			const owner = { ...binding(), deviceId: index < 2 ? 'a' : 'b', grantRevision: 1 }
			uploads.push(
				body.upload(
					new Request('http://localhost/upload', {
						method: 'POST',
						body: held[index].body,
						duplex: 'half',
					} as RequestInit),
					owner,
					owner.deviceId,
				),
			)
			await held[index].started
		}
		for (let index = 0; index < 4; index++) setups.push(body.beginSetup(binding()))
		assert.throws(
			() => body.beginSetup(binding()),
			error => error instanceof ImageResponseError && error.status === 429,
		)
	} finally {
		for (const setup of setups) body.finishSetup(setup)
		for (const value of held) value.finish(baselineJpeg)
		await Promise.all(uploads)
		body.dispose()
		store.dispose()
	}
})

test('supplementary owner seam: Web cancellation and repeated invalidation wait for Node close', async () => {
	class PendingOutgoing extends EventEmitter {
		destroyed = false
		destroy() {
			this.destroyed = true
			return this
		}
	}
	const f = helperFixture()
	const outgoing = [new PendingOutgoing(), new PendingOutgoing()]
	const owners = outgoing.map(() => f.body.beginSetup(f.owner))
	const publish = (index: number) =>
		f.body.response(
			f.ref,
			f.owner,
			undefined,
			f.commandId,
			f.ref.bytes,
			Date.now() + 10_000,
			() => true,
			outgoing[index],
			owners[index],
		)
	try {
		const responses = outgoing.map((_, index) => publish(index))
		await Promise.all(responses.map(response => response.body?.cancel()))
		f.body.invalidate(() => true)
		f.body.invalidate(() => true)
		assert.ok(outgoing.every(value => value.destroyed))
		assert.throws(
			() => f.response(),
			error => error instanceof ImageResponseError && error.status === 429,
		)
		outgoing[0].emit('close')
		assert.equal(outgoing[0].listenerCount('finish'), 0)
		assert.equal(outgoing[0].listenerCount('close'), 0)
		assert.equal(outgoing[0].listenerCount('error'), 0)
		assert.equal(owners[0].binding, undefined)
		assert.equal(owners[0].outgoing, undefined)
		assert.equal(owners[0].valid, undefined)
		assert.equal(owners[0].streamController, undefined)
		assert.equal(owners[0].lease, undefined)
		assert.equal(owners[0].timer, undefined)
		const recovered = f.response()
		assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), baselineJpeg)
	} finally {
		for (const value of outgoing) value.emit('close')
		f.close()
	}
})

test('paired principal exact read, foreign reuse refusal and revoked private read', async () => {
	const root = realpathSync(mkdtempSync('/tmp/hr-img-principal-'))
	const access = new RemoteAccess(join(root, 'devices.json'))
	const pair = () => {
		const presentation = access.createPairing('Synthetic image fixture', {
			personalCurrentAndFuture: true,
			scopeIds: [],
			operations: { read: true, prompt: true, interrupt: true, answer: true },
		})
		const device = access.redeem({ qrCapability: presentation.qrCapability })
		assert.ok(device)
		return device
	}
	const original = pair()
	const foreign = pair()
	const f = await hostFixture(Date.now, access, original.credential)
	try {
		await f.exchange()
		const positive = await f.read()
		assert.equal(positive.status, 200)
		assert.deepEqual(Buffer.from(await positive.arrayBuffer()), baselineJpeg)
		const wrong = await f.host.browser.request('/v1/commands', {
			method: 'POST',
			headers: { ...f.headers, Cookie: `__Host-helm-remote=${foreign.credential}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...f.command, commandId: randomUUID() }),
		})
		assert.equal(wrong.status, 409)
		assert.equal(access.revoke(original.principal.deviceId), true)
		assert.equal((await f.read()).status, 409)
	} finally {
		f.host.revoke()
		rmSync(root, { recursive: true, force: true })
	}
})

function binding(): ImageStoreBinding {
	return {
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
		hostEpoch: randomUUID(),
		supportRevision: Symbol(),
	}
}

test('unknown-length upload reservations consume full capacity before body allocation', () => {
	const live = new Set<string>()
	const owner = binding()
	live.add(owner.target.sessionId)
	const store = new RemoteImageStore({ isBindingLive: value => live.has(value.target.sessionId) })
	const reservations = []
	try {
		for (let index = 0; index < 5; index++) {
			const reservation = store.reserve(owner)
			reservation.append(baselineJpeg)
			reservations.push(reservation)
			reservation.commit()
		}
		assert.throws(() => store.reserve(owner), /image_capacity/)
		assert.equal(store.usage().allocatedBytes, 5 * 1_572_864)
	} finally {
		store.invalidate(() => true)
		store.dispose()
	}
})

test('Host unknown-length uploads reserve full backing capacity before a sixth body read', async () => {
	const f = await hostFixture()
	try {
		await f.exchange()
		await f.exchange([{ commandId: f.command.commandId, status: 'rejected' }])
		const query = new URLSearchParams({
			hostEpoch: f.host.epoch,
			incarnation: f.snapshot.target.incarnation,
			scopeId: '',
			generation: String(f.snapshot.target.generation),
		})
		const path = `/v1/sessions/${f.snapshot.target.sessionId}/images?${query}`
		for (let index = 0; index < 5; index++) {
			const response = await f.host.browser.request(path, {
				method: 'POST',
				headers: { ...f.headers, 'Content-Type': 'image/jpeg' },
				body: baselineJpeg,
			})
			assert.equal(response.status, 201)
		}
		let pulls = 0
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++
				controller.enqueue(baselineJpeg)
			},
		})
		const refused = await f.host.browser.request(path, {
			method: 'POST',
			headers: { ...f.headers, 'Content-Type': 'image/jpeg' },
			body,
			duplex: 'half',
		} as RequestInit)
		assert.equal(refused.status, 429)
		assert.equal(pulls, 1, 'Request construction may prefetch one chunk; the Host must not pull another')
	} finally {
		f.host.revoke()
	}
})

test('Host rejects duplicate or missing upload identity query keys before reading bytes', async () => {
	const f = await hostFixture()
	try {
		const base = `/v1/sessions/${f.snapshot.target.sessionId}/images`
		for (const query of [
			`hostEpoch=${f.host.epoch}&incarnation=${f.snapshot.target.incarnation}&scopeId=&generation=1&generation=1`,
			`hostEpoch=${f.host.epoch}&incarnation=${f.snapshot.target.incarnation}&scopeId=`,
		]) {
			let pulls = 0
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls++
					controller.enqueue(baselineJpeg)
				},
			})
			const response = await f.host.browser.request(`${base}?${query}`, {
				method: 'POST',
				headers: { ...f.headers, 'Content-Type': 'image/jpeg' },
				body,
				duplex: 'half',
			} as RequestInit)
			assert.equal(response.status, 400)
			assert.equal(pulls, 1, 'Request construction may prefetch one chunk; the Host must not pull another')
		}
	} finally {
		f.host.revoke()
	}
})

test('response owner closes direct Web after exact final bytes without an extra EOF read', async () => {
	const current = binding()
	const store = new RemoteImageStore({ isBindingLive: value => value.supportRevision === current.supportRevision })
	const reservation = store.reserve(current, baselineJpeg.length)
	reservation.append(baselineJpeg)
	const ref = reservation.commit()
	const commandId = randomUUID()
	assert.equal(store.bind([ref], current, commandId, Date.now() + 10_000), true)
	const body = new RemoteImageBody(store)
	const response = body.response(ref, current, undefined, commandId, ref.bytes, Date.now() + 10_000, () => true)
	const reader = response.body?.getReader()
	assert.ok(reader)
	const chunk = (await reader.read()).value
	assert.ok(chunk)
	assert.deepEqual(Buffer.from(chunk), baselineJpeg)
	// closed resolves without another read request or explicit cancellation.
	await reader.closed
	assert.equal(store.usage().reads, 0)
	await reader.cancel()
	assert.equal(store.usage().reads, 0)
	body.dispose()
	store.dispose()
	assert.equal(store.usage().handles, 0)
})
