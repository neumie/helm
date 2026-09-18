import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAccess } from '../src/remote/access.js'
import { FAVORITES_HEADER, MAX_REMOTE_FAVORITES, favoritesResponseSchema } from '../src/remote/favorites-protocol.js'
import { FavoriteCapacityError, RemoteFavorites } from '../src/remote/favorites.js'
import { RemoteHost } from '../src/remote/host.js'
import type { RemoteSnapshot } from '../src/remote/protocol.js'
import { startRemoteRuntime } from '../src/remote/runtime.js'

function scratch(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync('/tmp/hr-fav-'))
	chmodSync(root, 0o700)
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return root
}
function snapshot(scopeId: string | null = null): RemoteSnapshot {
	return {
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId, generation: 1 },
		revision: 1,
		label: 'Favorite test',
		workspace: 'fixture',
		model: 'model',
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: false },
		messages: [],
		question: null,
		historyTruncated: false,
	}
}
async function enroll(host: RemoteHost, value: RemoteSnapshot) {
	const capability = createScopedCapability()
	const id = randomUUID()
	host.issueEnrollment({
		id,
		capabilityHash: hashScopedCapability(capability),
		...{ scopeId: value.target.scopeId, generation: value.target.generation },
	})
	const response = await host.local.request('/exchange', {
		method: 'POST',
		headers: { Authorization: `Bearer ${capability}`, 'X-Helm-Enrollment': id, 'Content-Type': 'application/json' },
		body: JSON.stringify({ protocol: 1, enrollmentId: id, snapshot: value, receipts: [] }),
	})
	assert.equal(response.status, 200)
	return { id, capability }
}
function fixture(t: { after(fn: () => void): void }) {
	const root = scratch(t)
	const access = new RemoteAccess(join(root, 'devices.json'))
	const favorites = new RemoteFavorites(join(root, 'favorites.json'))
	const host = new RemoteHost({ origin: 'https://remote.example', access, favorites })
	t.after(() => host.revoke())
	function device(prompt = true, personalCurrentAndFuture = true, scopeIds: string[] = []) {
		const pairing = access.createPairing('fixture', {
			personalCurrentAndFuture,
			scopeIds,
			operations: { read: true, prompt, interrupt: prompt, answer: prompt },
		})
		const value = access.redeem({ qrCapability: pairing.qrCapability })
		assert.ok(value)
		return value
	}
	function request(credential: string, body?: unknown, headers: Record<string, string> = {}) {
		return host.browser.request('/v1/favorites', {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				Host: 'remote.example',
				Cookie: `__Host-helm-remote=${credential}`,
				[FAVORITES_HEADER]: '1',
				...(body === undefined
					? {}
					: { Origin: 'https://remote.example', 'Content-Type': 'application/json', 'X-Helm-Remote': '1' }),
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
	}
	return { root, access, favorites, host, device, request }
}

test('favorites persist only stable conversation/scope identity, remove idempotently, and survive reload', t => {
	const root = scratch(t)
	const path = join(root, 'favorites.json')
	const store = new RemoteFavorites(path)
	const value = snapshot().target
	store.set(value, true)
	assert.equal(statSync(path).mode & 0o777, 0o600)
	assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
		version: 1,
		favorites: [{ sessionId: value.sessionId, scopeId: null }],
	})
	const restored = new RemoteFavorites(path)
	const reconnected = { ...value, incarnation: randomUUID(), generation: 2 }
	assert.equal(restored.has(reconnected), true)
	assert.equal(restored.has({ ...value, scopeId: randomUUID() }), false)
	restored.set(value, false)
	restored.set(value, false)
	assert.equal(new RemoteFavorites(path).has(value), false)
})

test('failed persistence leaves memory and disk unchanged', t => {
	const path = join(scratch(t), 'favorites.json')
	const first = snapshot().target
	const second = snapshot().target
	new RemoteFavorites(path).set(first, true)
	const before = readFileSync(path)
	const store = new RemoteFavorites(path, () => {
		throw new Error('injected disk failure')
	})
	assert.throws(() => store.set(second, true))
	assert.throws(() => store.set(first, false))
	assert.equal(store.has(first), true)
	assert.equal(store.has(second), false)
	assert.deepEqual(readFileSync(path), before)
})

test('private favorites reject symlinks, hard links, oversized/invalid documents and duplicate identities', t => {
	const root = scratch(t)
	const original = join(root, 'original.json')
	const target = snapshot().target
	new RemoteFavorites(original).set(target, true)
	const link = join(root, 'link.json')
	symlinkSync(original, link)
	assert.throws(() => new RemoteFavorites(link))
	rmSync(link)
	linkSync(original, link)
	assert.throws(() => new RemoteFavorites(link))
	rmSync(link)
	for (const content of [
		'x'.repeat(32769),
		'{}',
		JSON.stringify({
			version: 1,
			favorites: [0, 1].map(() => ({ sessionId: target.sessionId, scopeId: target.scopeId })),
		}),
	]) {
		writeFileSync(original, content, { mode: 0o600 })
		assert.throws(() => new RemoteFavorites(original))
	}
})

test('bounded preference capacity never silently evicts favorites', () => {
	const store = new RemoteFavorites()
	const values = Array.from({ length: MAX_REMOTE_FAVORITES }, () => snapshot().target)
	for (const value of values) store.set(value, true)
	assert.throws(() => store.set(snapshot().target, true), FavoriteCapacityError)
	const first = values[0]
	assert.ok(first)
	assert.equal(store.has(first), true)
	store.set(first, false)
	store.set(snapshot().target, true)
})

test('two devices share favorites without receiving unauthorized scopes or creating Pi commands', async t => {
	const f = fixture(t)
	const one = f.device()
	const two = f.device()
	const readonly = f.device(false)
	const personal = snapshot()
	const privateSession = snapshot(randomUUID())
	const bridge = await enroll(f.host, personal)
	await enroll(f.host, privateSession)
	const body = { hostEpoch: f.host.epoch, target: personal.target, favorite: true }
	assert.equal((await f.request(one.credential, body)).status, 200)
	const result = favoritesResponseSchema.parse(await (await f.request(two.credential)).json())
	assert.deepEqual(result.entries, [{ target: personal.target, favorite: true, canEdit: true }])
	const readResult = favoritesResponseSchema.parse(await (await f.request(readonly.credential)).json())
	assert.equal(readResult.entries[0]?.canEdit, false)
	assert.equal((await f.request(readonly.credential, { ...body, favorite: false })).status, 403)
	assert.equal((await f.request(one.credential, { ...body, target: privateSession.target })).status, 404)
	const exchange = await f.host.local.request('/exchange', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${bridge.capability}`,
			'X-Helm-Enrollment': bridge.id,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ protocol: 1, enrollmentId: bridge.id, snapshot: personal, receipts: [] }),
	})
	assert.deepEqual((await exchange.json()).commands, [])
	assert.equal((await f.request(two.credential, { ...body, favorite: false })).status, 200)
	assert.equal(f.favorites.has(personal.target), false)
})

test('favorite writes reject stale complete owners, wrong epochs, CSRF, missing negotiation, bad bodies and revoked devices', async t => {
	const f = fixture(t)
	const device = f.device()
	const value = snapshot()
	await enroll(f.host, value)
	const body = { hostEpoch: f.host.epoch, target: value.target, favorite: true }
	for (const target of [
		{ ...value.target, incarnation: randomUUID() },
		{ ...value.target, generation: 2 },
		{ ...value.target, scopeId: randomUUID() },
	]) {
		assert.equal((await f.request(device.credential, { ...body, target })).status, 409)
	}
	assert.equal((await f.request(device.credential, { ...body, hostEpoch: randomUUID() })).status, 409)
	assert.equal((await f.request(device.credential, body, { Origin: 'https://evil.example' })).status, 403)
	assert.equal((await f.request(device.credential, body, { 'X-Helm-Remote': '' })).status, 403)
	assert.equal((await f.request(device.credential, body, { [FAVORITES_HEADER]: '' })).status, 404)
	assert.equal((await f.request(device.credential, { ...body, favorite: 'yes' })).status, 400)
	assert.equal((await f.request(device.credential, { ...body, padding: 'x'.repeat(2048) })).status, 413)
	f.access.revoke(device.principal.deviceId)
	assert.equal((await f.request(device.credential, body)).status, 401)
	assert.equal(f.favorites.has(value.target), false)
})

test('favorites follow reconnection but stale host requests cannot mutate the replacement', async t => {
	const f = fixture(t)
	const device = f.device()
	const value = snapshot()
	await enroll(f.host, value)
	const oldRequest = { hostEpoch: f.host.epoch, target: value.target, favorite: true }
	assert.equal((await f.request(device.credential, oldRequest)).status, 200)
	f.host.revoke()
	const browser = createScopedCapability()
	const host = new RemoteHost({
		origin: 'https://remote.example',
		browserCapabilityHash: hashScopedCapability(browser),
		favorites: new RemoteFavorites(join(f.root, 'favorites.json')),
	})
	t.after(() => host.revoke())
	const replacement = { ...value, target: { ...value.target, incarnation: randomUUID(), generation: 2 } }
	await enroll(host, replacement)
	const headers = { Host: 'remote.example', Authorization: `Bearer ${browser}`, [FAVORITES_HEADER]: '1' }
	const result = favoritesResponseSchema.parse(await (await host.browser.request('/v1/favorites', { headers })).json())
	assert.deepEqual(result.entries, [{ target: replacement.target, favorite: true, canEdit: true }])
	assert.equal(
		(
			await host.browser.request('/v1/favorites', {
				method: 'POST',
				headers: {
					...headers,
					Origin: 'https://remote.example',
					'Content-Type': 'application/json',
					'X-Helm-Remote': '1',
				},
				body: JSON.stringify({ ...oldRequest, favorite: false }),
			})
		).status,
		409,
	)
})

test(
	'device revocation during body parsing fences a previously admitted favorite write',
	{ timeout: 5000 },
	async t => {
		const f = fixture(t)
		const device = f.device()
		const value = snapshot()
		await enroll(f.host, value)
		const bytes = new TextEncoder().encode(
			JSON.stringify({ hostEpoch: f.host.epoch, target: value.target, favorite: true }),
		)
		let enter!: () => void
		let release!: () => void
		const entered = new Promise<void>(resolve => {
			enter = resolve
		})
		const ready = new Promise<void>(resolve => {
			release = resolve
		})
		const body = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					enter()
					await ready
					controller.enqueue(bytes)
					controller.close()
				},
			},
			{ highWaterMark: 0 },
		)
		const request = new Request('https://remote.example/v1/favorites', {
			method: 'POST',
			body,
			duplex: 'half',
			headers: {
				Host: 'remote.example',
				Origin: 'https://remote.example',
				Cookie: `__Host-helm-remote=${device.credential}`,
				'Content-Type': 'application/json',
				'Content-Length': String(bytes.length),
				'X-Helm-Remote': '1',
				[FAVORITES_HEADER]: '1',
			},
		} as RequestInit & { duplex: 'half' })
		const result = f.host.browser.fetch(request)
		await entered
		f.access.revoke(device.principal.deviceId)
		release()
		assert.equal((await result).status, 401)
		assert.equal(f.favorites.has(value.target), false)
	},
)

test('a corrupt optional favorites document does not prevent runtime startup or overwrite it', async t => {
	const root = scratch(t)
	const assets = join(root, 'assets')
	const state = join(root, 'state')
	mkdirSync(assets, { mode: 0o700 })
	mkdirSync(state, { mode: 0o700 })
	for (const name of ['index.html', 'remote.js', 'remote.css']) writeFileSync(join(assets, name), '')
	const path = join(state, 'favorites.json')
	writeFileSync(path, '{broken', { mode: 0o600 })
	const runtime = await startRemoteRuntime({
		root: state,
		origin: 'https://remote.example',
		assetsDirectory: assets,
		port: 0,
		piSessionRoots: [],
	})
	try {
		assert.equal(runtime.reused, false)
		assert.equal(readFileSync(path, 'utf8'), '{broken')
	} finally {
		await runtime.stop()
	}
})
