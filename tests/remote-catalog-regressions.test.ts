import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { getRequestListener } from '@hono/node-server'
import transportModule from '../app/src/renderer/remote/transport.js'
const { createRemoteTransport }: typeof import('../app/src/renderer/remote/transport.js') = transportModule
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAccess } from '../src/remote/access.js'
import { SessionSelector } from '../src/remote/catalog-selector.js'
import { PiSessionCatalog, type PiSessionCatalogOptions } from '../src/remote/catalog.js'
import { createRemoteAssets } from '../src/remote/development.js'
import { RemoteHost } from '../src/remote/host.js'

const epoch = '10000000-0000-4000-8000-000000000000'
const request = { viewId: 'parent-proof', principalId: 'parent-device', sequence: 1 }
const yieldTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function fixture(t: TestContext, options: PiSessionCatalogOptions = {}) {
	const root = realpathSync(mkdtempSync('/tmp/hr-catalog-reg-'))
	const project = join(root, 'project')
	mkdirSync(project, { mode: 0o700 })
	const catalog = new PiSessionCatalog([root], options)
	t.after(async () => {
		try {
			await catalog.stop()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
	return {
		root,
		project,
		catalog,
		add(name: string, label: string, order = 0, info?: string) {
			const id = randomUUID()
			const header = JSON.stringify({ type: 'session', id, timestamp: '2024-01-01T00:00:00.000Z' })
			const path = join(project, `${name}.jsonl`)
			writeFileSync(path, `${header}\n${info ?? JSON.stringify({ type: 'session_info', name: label })}\n`, {
				mode: 0o600,
			})
			utimesSync(path, 1_700_000_000 + order, 1_700_000_000 + order)
			return id
		},
	}
}

async function settle(catalog: PiSessionCatalog, cursor?: string, query = '', identity = request) {
	for (let attempt = 0; attempt < 1500; attempt++) {
		const result = catalog.page(epoch, cursor, query, new Set(), identity)
		if (result.state !== 'pending') return result
		await yieldTurn()
	}
	throw new Error('A tiny catalog request never exposed a settled result or filesystem error')
}

test('a final catalog page has no phantom More cursor and Previous reaches a real first-page boundary', async t => {
	const f = fixture(t, { pageSize: 2 })
	f.add('a', 'alpha', 1)
	f.add('b', 'bravo', 2)
	f.add('c', 'charlie', 3)
	const first = await settle(f.catalog)
	assert.equal(first.state, 'ready')
	assert.equal(first.previousCursor, null)
	assert.ok(first.nextCursor)
	const last = await settle(f.catalog, first.nextCursor, '', { ...request, sequence: 2 })
	assert.deepEqual(
		last.rows.map(row => row.label),
		['alpha'],
	)
	assert.equal(last.nextCursor, null, 'More must not lead to an empty page with no way back')
	assert.ok(last.previousCursor)
	const previous = await settle(f.catalog, last.previousCursor, '', { ...request, sequence: 3 })
	assert.deepEqual(
		previous.rows.map(row => row.label),
		['charlie', 'bravo'],
	)
	assert.equal(previous.previousCursor, null)
})

test('catalog names decode JSON unicode and whitespace escapes before display normalization', async t => {
	const f = fixture(t, { bytesPerSlice: 7 })
	f.add('escaped', '', 0, '{"type":"session_info","name":"caf\\u00e9\\nline"}')
	const result = await settle(f.catalog)
	assert.equal(result.state, 'ready')
	assert.deepEqual(
		result.rows.map(row => row.label),
		['café line'],
	)
})

test('an observed filesystem read failure is surfaced rather than endlessly restarted as pending', async t => {
	const f = fixture(t, {
		onBarrier(point) {
			if (point === 'before_file_read') throw new Error('controlled metadata read failure')
		},
	})
	f.add('one', 'inside')
	const result = await settle(f.catalog)
	assert.equal(result.state, 'unavailable')
	assert.equal(result.reason, 'filesystem_error')
})

test('older view requests cannot supersede an already-ready newer search', async t => {
	const f = fixture(t)
	f.add('a', 'alpha')
	f.add('b', 'bravo')
	const newest = { ...request, sequence: 2 }
	const ready = await settle(f.catalog, undefined, 'bravo', newest)
	assert.equal(ready.state, 'ready')
	f.catalog.page(epoch, undefined, 'alpha', new Set(), { ...request, sequence: 1 })
	const stillCurrent = f.catalog.page(epoch, undefined, 'bravo', new Set(), newest)
	assert.equal(stillCurrent.state, 'ready', 'An obsolete HTTP request must not restart the current scan')
	assert.deepEqual(
		stillCurrent.rows.map(row => row.label),
		['bravo'],
	)
})

test('abandoned ready browser views do not permanently consume all catalog admission slots', async t => {
	let now = Date.now()
	t.mock.method(Date, 'now', () => now)
	const f = fixture(t, { maxViews: 1, maxViewsPerPrincipal: 1 })
	f.add('one', 'inside')
	assert.equal((await settle(f.catalog)).state, 'ready')
	now += 24 * 60 * 60 * 1000
	const replacement = { ...request, viewId: 'reloaded-browser' }
	for (let attempt = 0; attempt < 100; attempt++) {
		const result = f.catalog.page(epoch, undefined, '', new Set(), replacement)
		if (result.state !== 'busy') {
			assert.equal((await settle(f.catalog, undefined, '', replacement)).state, 'ready')
			return
		}
		await yieldTurn()
	}
	assert.fail('An abandoned view still exhausts admission after a day without polling')
})

test('detected project substitution invalidates the observation instead of certifying an empty inventory', async t => {
	let reached!: () => void
	let release!: () => void
	const reading = new Promise<void>(resolve => {
		reached = resolve
	})
	const barrier = new Promise<void>(resolve => {
		release = resolve
	})
	const f = fixture(t, {
		onBarrier: async point => {
			if (point === 'before_file_read') {
				reached()
				await barrier
			}
		},
	})
	f.add('inside', 'inside metadata')
	const outside = realpathSync(mkdtempSync('/tmp/hr-outside-reg-'))
	t.after(() => rmSync(outside, { recursive: true, force: true }))
	writeFileSync(
		join(outside, 'inside.jsonl'),
		`${JSON.stringify({ type: 'session', id: randomUUID(), timestamp: '2024-01-01' })}\n${JSON.stringify({ type: 'session_info', name: 'outside metadata' })}\n`,
		{ mode: 0o600 },
	)
	f.catalog.page(epoch, undefined, '', new Set(), request)
	await reading
	try {
		renameSync(f.project, join(outside, 'original'))
		symlinkSync(outside, f.project)
	} finally {
		release()
	}
	const result = await settle(f.catalog)
	assert.ok(result.state === 'unavailable' || result.state === 'invalidated')
	assert.ok(!result.rows.some(row => row.label === 'outside metadata'))
})

test('short and exact-multiple inventories stop at both real cursor edges', async t => {
	for (const count of [0, 1, 2, 4]) {
		const f = fixture(t, { pageSize: 2 })
		for (let index = 0; index < count; index++) f.add(String(index), `row ${index}`, index)
		let page = await settle(f.catalog)
		assert.equal(page.previousCursor, null)
		let sequence = 1
		let seen = page.rows.length
		while (page.nextCursor) {
			page = await settle(f.catalog, page.nextCursor, '', { ...request, sequence: ++sequence })
			assert.ok(page.rows.length > 0)
			seen += page.rows.length
		}
		assert.equal(seen, count)
		while (page.previousCursor)
			page = await settle(f.catalog, page.previousCursor, '', { ...request, sequence: ++sequence })
		assert.equal(page.previousCursor, null)
		assert.equal(page.rows.length, Math.min(count, 2))
	}
})

test('valid split UTF-8/escapes, incremental long-name normalization and latest absent clear', async t => {
	const f = fixture(t, { bytesPerSlice: 3 })
	f.add('unicode', '', 1, '{"type":"session_info","name":"é😀 \\ud83d\\ude00\\t\\"quoted\\"\\\\end"}')
	f.add('long', '', 2, JSON.stringify({ type: 'session_info', name: `${' '.repeat(1200)}${'é😀\n'.repeat(300)}` }))
	f.add('clear', '', 3, '{"type":"session_info","name":"old"}\n{"type":"session_info"}')
	const page = await settle(f.catalog)
	assert.equal(page.state, 'ready')
	assert.deepEqual(
		page.rows.map(row => row.label),
		['Pi conversation', 'é😀 '.repeat(40).trimEnd(), 'é😀 😀 "quoted"\\end'],
	)
	assert.ok(f.catalog.diagnostics().maxParserCharacters < 1600)
})

test('malformed and unsupported records are explicit, including skipped payload grammar and header-first rules', async t => {
	for (const invalid of [
		'{"type":"message","payload":[1,]}',
		'{"type":"message" "x":1}',
		'{"type":"message","x":01}',
		'{"type":"message","x":1e}',
		'{"type":"message","x":"\\q"}',
		'{"type":"message","x":"unfinished',
		`{"type":"message","x":${'['.repeat(65)}0${']'.repeat(65)}}`,
		'{"type":"session","id":"bad"}',
	]) {
		const f = fixture(t, { bytesPerSlice: 7 })
		f.add('invalid', '', 0, invalid)
		f.add('valid', 'reachable beside invalid', 1)
		const result = await settle(f.catalog)
		assert.equal(result.state, 'ready', invalid)
		assert.equal(result.omissions.malformed + result.omissions.unsupported, 1)
		assert.deepEqual(
			result.rows.map(row => row.label),
			['reachable beside invalid'],
		)
		assert.equal(f.catalog.diagnostics().cache, 1)
	}
	const f = fixture(t)
	writeFileSync(join(f.project, 'no-header.jsonl'), '{"type":"message","x":true}\n')
	const result = await settle(f.catalog)
	assert.equal(result.state, 'ready')
	assert.deepEqual(result.omissions, { malformed: 0, unsupported: 1 })
})

test('refresh errors retain only the exact request evidence and bounded retry recovers', async t => {
	let fail = false
	const f = fixture(t, {
		onBarrier(point) {
			if (point === 'before_publication' && fail) throw new Error('refresh failure')
		},
	})
	f.add('alpha', 'alpha')
	const first = await settle(f.catalog)
	assert.equal(first.state, 'ready')
	fail = true
	await f.catalog.refresh()
	const failed = await settle(f.catalog)
	assert.equal(failed.state, 'unavailable')
	assert.deepEqual(failed.rows, first.rows)
	const other = f.catalog.page(epoch, undefined, 'different', new Set(), { ...request, sequence: 2 })
	assert.deepEqual(other.rows, [])
	fail = false
	assert.equal((await settle(f.catalog, undefined, 'different', { ...request, sequence: 2 })).state, 'ready')
})

test('concurrent tiny-budget views include iterators, scratch handles, candidates, replacements and previous pages in bounds', async t => {
	const f = fixture(t, {
		pageSize: 3,
		cacheSize: 2,
		maxViews: 2,
		entryAttemptsPerSlice: 1,
		fileAttemptsPerSlice: 1,
		metadataOpsPerSlice: 1,
		bytesPerSlice: 31,
	})
	for (let index = 0; index < 12; index++) f.add(String(index), `row ${index}`, index)
	const second = { ...request, viewId: 'second' }
	f.catalog.page(epoch, undefined, '', new Set(), request)
	f.catalog.page(epoch, undefined, '', new Set(), second)
	const busy = f.catalog.page(epoch, undefined, '', new Set(), { ...request, viewId: 'third' })
	assert.equal(busy.state, 'busy')
	f.catalog.page(epoch, undefined, 'row', new Set(), { ...request, sequence: 2 })
	assert.equal(f.catalog.page(epoch, undefined, 'obsolete', new Set(), request).state, 'superseded')
	const [one, two] = await Promise.all([
		settle(f.catalog, undefined, 'row', { ...request, sequence: 2 }),
		settle(f.catalog, undefined, '', second),
	])
	assert.equal(one.state, 'ready')
	assert.equal(two.state, 'ready')
	await f.catalog.refresh()
	await Promise.all([
		settle(f.catalog, undefined, 'row', { ...request, sequence: 2 }),
		settle(f.catalog, undefined, '', second),
	])
	const d = f.catalog.diagnostics()
	assert.ok(d.maxOpenHandles >= 9, JSON.stringify(d))
	assert.ok(d.maxOpenHandles <= 10, JSON.stringify(d))
	assert.ok(d.maxRetainedRecords <= 2 + 2 * (2 * 3 + 2), JSON.stringify(d))
	assert.ok(d.maxRequests <= 4)
	assert.equal(d.maxSliceOperations, 1)
	assert.ok(d.maxSliceBytes <= 31)
	assert.ok(d.totalFileAttempts >= 48)
	assert.ok(d.totalEntries > d.totalFileAttempts)
	await f.catalog.stop()
	assert.equal(f.catalog.diagnostics().openHandles, 0)
})

test('in-flight abandonment drains under pressure, while polled progressing work renews its lease', async t => {
	let now = Date.now()
	t.mock.method(Date, 'now', () => now)
	let reads = 0
	const f = fixture(t, {
		maxViews: 1,
		maxViewsPerPrincipal: 1,
		bytesPerSlice: 7,
		onBarrier(point) {
			if (point === 'before_file_read') reads++
		},
	})
	f.add('long', '', 0, JSON.stringify({ type: 'message', text: 'x'.repeat(1000) }))
	f.catalog.page(epoch, undefined, '', new Set(), request)
	while (reads === 0) await yieldTurn()
	now += 120_000
	const replacement = { ...request, viewId: 'replacement' }
	for (let attempt = 0; attempt < 500; attempt++) {
		const result = f.catalog.page(epoch, undefined, '', new Set(), replacement)
		if (result.state !== 'busy') break
		await yieldTurn()
	}
	for (let attempt = 0; attempt < 1000; attempt++) {
		now += 30_000 // Total duration exceeds the idle lease many times.
		const result = f.catalog.page(epoch, undefined, '', new Set(), replacement)
		if (result.state === 'ready') {
			assert.equal(result.rows.length, 1)
			return
		}
		assert.equal(result.state, 'pending')
		await yieldTurn()
	}
	assert.fail('Actively polled file was repeatedly abandoned')
})

for (const point of [
	'before_project_open',
	'after_project_handle',
	'after_project_iterator',
	'after_file_open',
	'after_file_read',
	'before_publication',
]) {
	test(`persistent project substitution at ${point} never publishes or caches outside metadata`, async t => {
		let changed = false
		const f = fixture(t, {
			bytesPerSlice: 23,
			onBarrier(at) {
				if (at !== point || changed) return
				changed = true
				renameSync(f.project, `${f.project}-old`)
				mkdirSync(f.project)
				writeFileSync(
					join(f.project, 'one.jsonl'),
					`${JSON.stringify({ type: 'session', id: randomUUID(), timestamp: '2024-01-01' })}\n${JSON.stringify({ type: 'session_info', name: 'outside metadata' })}\n`,
				)
			},
		})
		f.add('one', 'inside metadata')
		const result = await settle(f.catalog)
		assert.equal(result.state, 'unavailable')
		assert.deepEqual(result.rows, [])
		assert.equal(f.catalog.diagnostics().cache, 0)
		assert.equal(f.catalog.diagnostics().openHandles, 0)
	})
}

for (const point of ['before_file_read', 'after_file_read', 'before_publication']) {
	test(`stop drains the admitted ${point} chain with no subsequent IO`, async t => {
		let reached!: () => void
		let release!: () => void
		const ready = new Promise<void>(resolve => {
			reached = resolve
		})
		const barrier = new Promise<void>(resolve => {
			release = resolve
		})
		let paused = false
		const f = fixture(t, {
			bytesPerSlice: 23,
			onBarrier: async at => {
				if (at === point && !paused) {
					paused = true
					reached()
					await barrier
				}
			},
		})
		f.add('one', 'inside metadata')
		f.catalog.page(epoch, undefined, '', new Set(), request)
		await ready
		const operations = f.catalog.diagnostics().totalOperations
		let stopped = false
		const stopping = f.catalog.stop().then(() => {
			stopped = true
		})
		await yieldTurn()
		assert.equal(stopped, false)
		release()
		await stopping
		assert.equal(f.catalog.diagnostics().totalOperations, operations)
		assert.equal(f.catalog.diagnostics().openHandles, 0)
		assert.equal(f.catalog.page(epoch).state, 'unavailable')
	})
}

test('returning to running A supersedes an intervening desired B without rejecting the newer A', async t => {
	let entered!: () => void
	let release!: () => void
	const reached = new Promise<void>(resolve => {
		entered = resolve
	})
	const held = new Promise<void>(resolve => {
		release = resolve
	})
	let first = true
	const f = fixture(t, {
		onBarrier: async point => {
			if (point === 'before_file_read' && first) {
				first = false
				entered()
				await held
			}
		},
	})
	f.add('a', 'alpha')
	f.add('b', 'bravo')
	try {
		f.catalog.page(epoch, undefined, 'alpha', new Set(), request)
		await reached
		f.catalog.page(epoch, undefined, 'bravo', new Set(), { ...request, sequence: 2 })
		const latest = { ...request, sequence: 3 }
		f.catalog.page(epoch, undefined, 'alpha', new Set(), latest)
		release()
		for (let attempt = 0; attempt < 1500; attempt++) {
			const status = f.catalog.diagnostics()
			if (!status.active && status.queued === 0) break
			await yieldTurn()
		}
		const result = await settle(f.catalog, undefined, 'alpha', latest)
		assert.equal(result.state, 'ready')
		assert.deepEqual(
			result.rows.map(row => row.label),
			['alpha'],
		)
	} finally {
		release()
	}
})

test('parser depth high-water observes nested skipped containers within one read chunk', () => {
	const parser = new SessionSelector()
	parser.push(
		Buffer.from(
			`${JSON.stringify({ type: 'session', id: randomUUID(), timestamp: '2024-01-01' })}\n{"type":"message","payload":[[[0]]]}\n`,
		),
	)
	parser.finish()
	assert.equal(parser.diagnostics().depth, 4)
})

test('long Unicode names obey the existing UTF-16 limit through real HTTP and production transport', async t => {
	const f = fixture(t)
	f.add('emoji', '😀'.repeat(160), 2)
	f.add('prefix', `${'a'.repeat(159)}😀z`, 1)
	const h = await httpHost(t, f.catalog)
	const realFetch = globalThis.fetch
	t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) =>
		realFetch(new URL(String(url), h.origin), init),
	)
	const transport = createRemoteTransport(h.token)
	const signal = new AbortController().signal
	for (let attempt = 0; attempt < 1500; attempt++) {
		const result = await transport.catalog(null, '', signal)
		if (result.state === 'pending') {
			await yieldTurn()
			continue
		}
		assert.equal(result.state, 'ready')
		assert.deepEqual(
			result.rows.map(row => row.label),
			['😀'.repeat(80), 'a'.repeat(159)],
		)
		return
	}
	assert.fail('Unicode HTTP catalog did not settle')
})

async function httpHost(t: TestContext, catalog: PiSessionCatalog, access?: RemoteAccess) {
	const token = createScopedCapability()
	const assets = createRemoteAssets(resolve('app/remote-dist'))
	let directoryBarrier: Promise<void> | undefined
	const server = createServer(
		getRequestListener(async request => {
			if (new URL(request.url).pathname === '/v1/sessions') await directoryBarrier
			return assets(request) ?? host.browser.fetch(request)
		}),
	)
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	assert.ok(address && typeof address !== 'string')
	const origin = `http://127.0.0.1:${address.port}`
	const host: RemoteHost = new RemoteHost({
		origin,
		catalog,
		...(access ? { access } : { browserCapabilityHash: hashScopedCapability(token) }),
	})
	t.after(async () => {
		host.revoke()
		server.closeAllConnections()
		await new Promise<void>(resolve => server.close(() => resolve()))
	})
	return {
		host,
		origin,
		token,
		holdDirectory(value: Promise<void> | undefined) {
			directoryBarrier = value
		},
	}
}

async function enroll(host: RemoteHost, sessionId: string) {
	const enrollmentId = randomUUID()
	const capability = createScopedCapability()
	host.issueEnrollment({
		id: enrollmentId,
		capabilityHash: hashScopedCapability(capability),
		scopeId: null,
		generation: 1,
		sessionId,
	})
	const snapshot = {
		target: { sessionId, incarnation: randomUUID(), scopeId: null, generation: 1 },
		revision: 1,
		label: 'Authorized live owner',
		workspace: 'fixture',
		model: null,
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: false },
		question: null,
		messages: [],
		historyTruncated: false,
	}
	assert.equal(
		(
			await host.local.request('/exchange', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${capability}`,
					'X-Helm-Enrollment': enrollmentId,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ protocol: 1, enrollmentId, snapshot, receipts: [] }),
			})
		).status,
		200,
	)
}

test('real HTTP and production transport enforce cursor/query/principal auth and exact live overlay', async t => {
	const f = fixture(t, { pageSize: 2 })
	const liveId = f.add('live', 'same title', 4)
	f.add('peer', 'same title', 3)
	f.add('older', 'older title', 2)
	const access = new RemoteAccess(join(f.root, 'devices.json'))
	const grant = {
		personalCurrentAndFuture: true,
		scopeIds: [],
		operations: { read: true, prompt: true, interrupt: true, answer: true },
	}
	const first = access.redeem({ code: access.createPairing('first', grant).code })
	const second = access.redeem({ code: access.createPairing('second', grant).code })
	assert.ok(first && second)
	const h = await httpHost(t, f.catalog, access)
	const realFetch = globalThis.fetch
	let credential = first.credential
	t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers)
		headers.set('Cookie', `__Host-helm-remote=${credential}`)
		return realFetch(new URL(String(url), h.origin), { ...init, headers })
	})
	const transport = createRemoteTransport()
	const signal = new AbortController().signal
	async function read(cursor: string | null = null, query = '') {
		for (let attempt = 0; attempt < 1500; attempt++) {
			const result = await transport.catalog(cursor, query, signal)
			if (result.state !== 'pending') return result
			await yieldTurn()
		}
		throw new Error('HTTP catalog never settled')
	}
	assert.equal((await realFetch(`${h.origin}/v1/catalog`)).status, 401)
	const initial = await read()
	assert.equal(initial.state, 'ready')
	assert.ok(initial.pageCursor)
	credential = second.credential
	assert.equal(
		(await read(initial.pageCursor)).state,
		'invalidated',
		'Cursor must be principal-bound even with the same overlay',
	)
	credential = first.credential
	assert.equal((await read(`${initial.pageCursor}x`)).state, 'invalidated')
	assert.equal((await read(initial.pageCursor, 'other query')).state, 'invalidated')
	await enroll(h.host, liveId)
	const directory = await transport.directory(signal)
	assert.equal(directory.sessions.length, 1)
	assert.equal((await read(initial.pageCursor)).state, 'invalidated')
	const overlay = await read()
	assert.equal(overlay.state, 'ready')
	assert.equal(overlay.overlayStamp, directory.overlayStamp)
	assert.equal(overlay.rows.filter(row => row.label === 'same title').length, 1)
	assert.ok(overlay.rows.some(row => row.label === 'older title'))
	assert.ok(!JSON.stringify(overlay).includes(liveId))
	assert.ok(!JSON.stringify(overlay).includes(f.root))
	assert.ok(overlay.rows.every(row => row.readOnly && !('target' in row)))
})

test(
	'rendered production HTTP workspace is live-only and never requests catalog pages',
	{ timeout: 90_000 },
	async t => {
		const f = fixture(t, { pageSize: 2 })
		const liveId = f.add('live', 'Previously recorded live owner', 1)
		f.add('history', 'Historical catalog must not appear', 2)
		await settle(f.catalog)
		const h = await httpHost(t, f.catalog)
		await enroll(h.host, liveId)
		const { chromium } = await import('playwright')
		const browser = await chromium.launch({ headless: true })
		t.after(() => browser.close())
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
		const requests: string[] = []
		page.on('request', request => requests.push(new URL(request.url()).pathname))
		const { expect } = await import('playwright/test')
		await page.goto(h.origin)
		await page.getByLabel('Access token').fill(h.token)
		await page.getByRole('button', { name: 'Connect', exact: true }).click()
		const row = page.getByRole('button', { name: /Authorized live owner/ })
		await expect(row).toBeVisible()
		await expect(page.getByRole('navigation', { name: 'App navigation' })).toHaveCount(0)
		await expect(page.locator('.remote-catalog-row')).toHaveCount(0)
		await expect(page.getByText('Historical catalog must not appear')).toHaveCount(0)
		await page.getByPlaceholder('Search live conversations').fill('no match')
		await expect(row).toHaveCount(0)
		await page.getByPlaceholder('Search live conversations').fill('Authorized')
		await expect(row).toBeVisible()
		await row.click()
		await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
		await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
		await expect(row).toBeVisible()
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
		assert.ok(requests.includes('/v1/sessions'), 'proof must actually read the production directory')
		assert.equal(
			requests.some(path => /catalog|history/.test(path)),
			false,
			'live workspace must not request catalog/history',
		)
		await page.screenshot({ path: '/tmp/helm-interface-redesign-20260910/finish/remote-production-live-only.png' })
	},
)

test('incomplete trailing records remain unavailable, not permanently omitted', async t => {
	const f = fixture(t)
	f.add('good', 'history')
	writeFileSync(
		join(f.project, 'partial.jsonl'),
		`${JSON.stringify({ type: 'session', id: randomUUID(), timestamp: '2024-01-01' })}\n{"type":"message","text":"incomplete`,
	)
	const result = await settle(f.catalog)
	assert.equal(result.state, 'unavailable')
	assert.deepEqual(result.omissions, { malformed: 0, unsupported: 0 })
})

for (const target of ['root', 'file', 'version-after-malformed']) {
	test(`observed ${target} replacement/change never becomes an omission or ready-empty`, async t => {
		let changed = false
		const f = fixture(t, {
			bytesPerSlice: 1024,
			onBarrier(point) {
				if (point !== 'after_file_read' || changed) return
				changed = true
				if (target === 'root') {
					renameSync(f.root, `${f.root}-old`)
					mkdirSync(f.root)
					t.after(() => rmSync(`${f.root}-old`, { recursive: true, force: true }))
				} else if (target === 'file') {
					renameSync(join(f.project, 'one.jsonl'), join(f.project, 'old'))
					writeFileSync(join(f.project, 'one.jsonl'), '{"type":"message"}\n')
				} else writeFileSync(join(f.project, 'one.jsonl'), 'changed malformed bytes')
			},
		})
		f.add(
			'one',
			'',
			0,
			target === 'version-after-malformed' ? '{"type":"message",bad}' : '{"type":"session_info","name":"inside"}',
		)
		const result = await settle(f.catalog)
		assert.equal(result.state, 'unavailable')
		assert.deepEqual(result.rows, [])
		assert.deepEqual(result.omissions, { malformed: 0, unsupported: 0 })
		assert.equal(f.catalog.diagnostics().cache, 0)
	})
}

test('rejected entry/file attempts consume tiny budgets without counting them as successful EOF', async t => {
	const f = fixture(t, { entryAttemptsPerSlice: 1, fileAttemptsPerSlice: 1, metadataOpsPerSlice: 1, bytesPerSlice: 23 })
	f.add('valid', 'reachable')
	f.add('malformed', '', 0, '{"type":"message",bad}')
	writeFileSync(join(f.root, 'hard-source'), 'not metadata')
	linkSync(join(f.root, 'hard-source'), join(f.project, 'hard.jsonl'))
	symlinkSync(join(f.project, 'valid.jsonl'), join(f.project, 'symlink.jsonl'))
	mkdirSync(join(f.project, 'directory.jsonl'))
	writeFileSync(join(f.project, 'irrelevant.txt'), 'not metadata')
	const result = await settle(f.catalog)
	assert.equal(result.state, 'ready')
	assert.deepEqual(
		result.rows.map(row => row.label),
		['reachable'],
	)
	assert.deepEqual(result.omissions, { malformed: 1, unsupported: 0 })
	const d = f.catalog.diagnostics()
	assert.equal(d.totalFileAttempts, 3)
	assert.equal(d.totalEntries, 10) // root: project + hard-source + EOF; project: six entries + EOF.
	assert.equal(d.maxSliceOperations, 1)
	assert.ok(d.maxSliceBytes <= 23)
	assert.equal(d.openHandles, 0)
})
