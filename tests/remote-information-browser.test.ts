import assert from 'node:assert/strict'
import { test } from 'node:test'
import controllerModule from '../app/src/renderer/remote/information-controller.js'
import type { InformationClock } from '../app/src/renderer/remote/information-controller.js'
import fixtureModule from '../app/src/renderer/remote/information-fixture.js'
import transportModule from '../app/src/renderer/remote/transport.js'
import type { RemoteTransport } from '../app/src/renderer/remote/transport.js'
import { INFORMATION_HEADER } from '../src/remote/information-protocol.js'
import type { InformationResponse } from '../src/remote/information-protocol.js'
const { createRemoteTransport, RemoteAccessError } = transportModule
const { RemoteInformationController } = controllerModule
const { informationFixture } = fixtureModule
function informationRead() {
	const read = createRemoteTransport().information
	assert.ok(read)
	return read
}
const owner = {
	hostEpoch: '10000000-0000-4000-8000-000000000000',
	target: {
		sessionId: '10000000-0000-4000-8000-000000000001',
		incarnation: '20000000-0000-4000-8000-000000000001',
		scopeId: null,
		generation: 1,
	},
}
const response = (value: unknown, ack = true) =>
	new Response(JSON.stringify(value), { headers: ack ? { [INFORMATION_HEADER]: '1' } : {} })
const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve()
}
function fakeClock() {
	let now = 0
	let id = 0
	const timers = new Map<number, { at: number; run: () => void }>()
	const clock: InformationClock = {
		now: () => now,
		set: (run, ms) => {
			timers.set(++id, { at: now + ms, run })
			return id as unknown as ReturnType<typeof setTimeout>
		},
		clear: timer => {
			timers.delete(timer as unknown as number)
		},
	}
	return {
		clock,
		async advance(ms: number) {
			const end = now + ms
			while (true) {
				const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
				if (!next) break
				now = next[1].at
				timers.delete(next[0])
				next[1].run()
				await flush()
			}
			now = end
			await flush()
		},
	}
}
function controller(read: NonNullable<RemoteTransport['information']>) {
	const time = fakeClock()
	const value = new RemoteInformationController({ information: read } as RemoteTransport, owner, time.clock)
	value.setAvailable(true)
	return { value, ...time }
}

test('production information transport negotiates exact owner and existing credentials', async t => {
	t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
		const url = new URL(path, 'https://fixture.invalid')
		assert.equal(url.pathname, `/v1/sessions/${owner.target.sessionId}/information`)
		assert.equal(url.searchParams.get('scopeId'), '')
		assert.equal(url.searchParams.get('hostEpoch'), owner.hostEpoch)
		assert.equal(url.searchParams.get('incarnation'), owner.target.incarnation)
		assert.equal(url.searchParams.get('generation'), '1')
		assert.equal(new Headers(init.headers).get(INFORMATION_HEADER), '1')
		assert.equal(init.credentials, 'same-origin')
		assert.equal(init.cache, 'no-store')
		return response(informationFixture(owner))
	})
	const result = await createRemoteTransport().information?.(owner, new AbortController().signal)
	assert.equal(result?.information?.footer.fields?.inputTokens, 0)
	assert.equal(result?.information?.footer.fields?.trusted, false)
})
for (const kind of [
	'no-ack',
	'malformed',
	'oversize',
	'wrong-epoch',
	'wrong-generation',
	'wrong-incarnation',
	'wrong-session',
	'wrong-scope',
	'inner-owner',
	'invalid-ttl',
]) {
	test(`production decoder refuses ${kind}`, async t => {
		const data = informationFixture(owner)
		if (kind === 'wrong-epoch') data.hostEpoch = '90000000-0000-4000-8000-000000000000'
		if (kind === 'wrong-generation') data.target = { ...data.target, generation: 2 }
		if (kind === 'wrong-incarnation')
			data.target = { ...data.target, incarnation: '90000000-0000-4000-8000-000000000000' }
		if (kind === 'wrong-session') data.target = { ...data.target, sessionId: '90000000-0000-4000-8000-000000000000' }
		if (kind === 'wrong-scope') data.target = { ...data.target, scopeId: '40000000-0000-4000-8000-000000000001' }
		if (kind.startsWith('wrong-') && data.information) {
			data.information.hostEpoch = data.hostEpoch
			data.information.target = data.target
		}
		if (kind === 'inner-owner' && data.information) data.information.hostEpoch = '90000000-0000-4000-8000-000000000000'
		if (kind === 'invalid-ttl') data.freshForMs = 0
		t.mock.method(globalThis, 'fetch', async () =>
			kind === 'oversize'
				? new Response(' '.repeat(32769), { headers: { [INFORMATION_HEADER]: '1', 'Content-Length': '1' } })
				: response(kind === 'malformed' ? {} : data, kind !== 'no-ack'),
		)
		await assert.rejects(() => informationRead()(owner, new AbortController().signal))
	})
}
for (const status of [401, 403, 404, 409, 500])
	test(`HTTP ${status} is not unsupported`, async t => {
		t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }))
		await assert.rejects(
			() => informationRead()(owner, new AbortController().signal),
			error =>
				error instanceof Error && error instanceof RemoteAccessError && 'status' in error && error.status === status,
		)
	})
test('decoder abort cancels a stalled body', async t => {
	let cancelled = false
	t.mock.method(
		globalThis,
		'fetch',
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true
					},
				}),
				{ headers: { [INFORMATION_HEADER]: '1' } },
			),
	)
	const abort = new AbortController()
	const read = informationRead()(owner, abort.signal)
	await flush()
	abort.abort()
	await assert.rejects(read)
	assert.equal(cancelled, true)
})
test('request-start TTL expires independently while next read hangs; semantic polling deduplicates', async () => {
	let calls = 0
	const c = controller(async () => {
		calls++
		if (calls > 2) return new Promise<InformationResponse>(() => {})
		const result = informationFixture(owner)
		assert.ok(result.information)
		result.information.sequence = calls
		return result
	})
	let updates = 0
	c.value.subscribe(() => updates++)
	await c.advance(0)
	assert.equal(calls, 1)
	const first = c.value.getSnapshot()
	await c.advance(2000)
	assert.equal(calls, 2)
	assert.equal(c.value.getSnapshot(), first)
	assert.equal(updates, 1)
	await c.advance(2000)
	assert.equal(calls, 3)
	await c.advance(3000)
	assert.equal(c.value.getSnapshot().status, 'unavailable')
	await c.advance(20000)
	assert.equal(calls, 3)
	c.value.dispose()
})
test('late result cannot extend TTL from response receipt', async () => {
	let resolve!: (value: InformationResponse) => void
	const c = controller(
		() =>
			new Promise(r => {
				resolve = r
			}),
	)
	await c.advance(0)
	await c.advance(5001)
	resolve(informationFixture(owner))
	await flush()
	assert.equal(c.value.getSnapshot().status, 'unavailable')
	c.value.dispose()
})
for (const boundary of ['unavailable', 'hidden', 'dispose'])
	test(`${boundary} aborts and fences late results`, async () => {
		let resolve!: (value: InformationResponse) => void
		let signal!: AbortSignal
		const c = controller((_owner, s) => {
			signal = s
			return new Promise(r => {
				resolve = r
			})
		})
		await c.advance(0)
		if (boundary === 'unavailable') c.value.setAvailable(false)
		if (boundary === 'hidden') c.value.setVisible(false)
		if (boundary === 'dispose') c.value.dispose()
		assert.equal(signal.aborted, true)
		resolve(informationFixture(owner))
		await flush()
		assert.equal(c.value.getSnapshot().information, null)
		c.value.dispose()
	})
test('visibility return rechecks, never overlaps, and does not exceed 1Hz', async () => {
	let calls = 0
	const c = controller(async () => {
		calls++
		return informationFixture(owner)
	})
	await c.advance(0)
	c.value.setVisible(false)
	assert.equal(c.value.getSnapshot().information, null)
	c.value.setVisible(true)
	await c.advance(999)
	assert.equal(calls, 1)
	await c.advance(1)
	assert.equal(calls, 2)
	c.value.dispose()
})
test('auth refusal permanently retires this selected reader', async () => {
	let calls = 0
	const c = controller(async () => {
		calls++
		throw new RemoteAccessError(401)
	})
	await c.advance(0)
	assert.equal(c.value.getSnapshot().status, 'access-ended')
	c.value.setAvailable(false)
	c.value.setAvailable(true)
	await c.advance(10000)
	assert.equal(calls, 1)
	assert.equal(c.value.getSnapshot().information, null)
	c.value.dispose()
})
test('valid unsupported is explicit; wrong owner remains unavailable', async () => {
	const c = controller(async () => ({ version: 1, ...owner, status: 'unsupported', information: null, freshForMs: 0 }))
	await c.advance(0)
	assert.equal(c.value.getSnapshot().status, 'unsupported')
	c.value.dispose()
	const wrong = controller(async () => informationFixture({ ...owner, target: { ...owner.target, generation: 2 } }))
	await wrong.advance(0)
	assert.equal(wrong.value.getSnapshot().status, 'unavailable')
	wrong.value.dispose()
})

test('production body deadline is absolute even without more stream bytes', async t => {
	let cancelled = false
	t.mock.method(
		globalThis,
		'fetch',
		async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true
					},
				}),
				{ headers: { [INFORMATION_HEADER]: '1' } },
			),
	)
	const keepAlive = setTimeout(() => {}, 3000)
	try {
		await assert.rejects(() => informationRead()(owner, new AbortController().signal))
		assert.equal(cancelled, true)
	} finally {
		clearTimeout(keepAlive)
	}
})
