import assert from 'node:assert/strict'
import test from 'node:test'
import detailModule from '../app/src/renderer/sidebar/detail-data.ts'
import selectionModule from '../app/src/renderer/sidebar/run-selection.ts'
import type { DashboardItem, HelmResult } from '../app/src/shared-helm.ts'

const { createItemDetailCache, fetchItemDetail } = detailModule
const { selectAgent, effectiveRunSelection, buildRunBody, buildPlanBody } = selectionModule
const result: HelmResult<DashboardItem> = { data: { id: 'fixture' } as DashboardItem }

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}

test('persisted untouched Max switches to an explicit Codex reset in both action bodies', () => {
	const item = { solverAgent: 'claude', solverEffort: 'max', solverModel: null, solverWorkspace: null } as DashboardItem
	const before = effectiveRunSelection(item, null)
	const draft = selectAgent({}, 'codex', null, before.model, before.effort)
	assert.equal(effectiveRunSelection(item, null, draft).effort, null)
	assert.equal(buildRunBody(draft)?.solverEffort, null)
	assert.equal(buildPlanBody(item, draft)?.solverEffort, null)
	assert.equal(selectAgent({}, 'codex', null, null, 'high').effort, undefined)
	assert.equal(selectAgent({ effort: 'low' }, 'codex', null, null, 'max').effort, 'low')
	assert.equal(selectAgent({ effort: null }, 'codex', null, null, 'max').effort, null)
	assert.equal(selectAgent({}, 'pi', null, null, 'max').effort, undefined)
})

test('detail cache retains 32 inactive settled entries in LRU order', async () => {
	const cache = createItemDetailCache()
	let reads = 0
	const read = async () => {
		reads++
		return result
	}
	for (let i = 0; i < 32; i++) await cache.fetch(String(i), 'v1', read)
	await cache.fetch('0', 'v1', read) // touch oldest
	await cache.fetch('32', 'v1', read)
	assert.equal(reads, 33)
	await cache.fetch('0', 'v1', read)
	assert.equal(reads, 33)
	await cache.fetch('1', 'v1', read)
	assert.equal(reads, 34)
})

test('active detail/task subscribers survive pressure and pending forced reads still deduplicate', async () => {
	const cache = createItemDetailCache()
	const first = cache.subscribe('active')
	const second = cache.subscribe('active')
	let reads = 0
	const read = async () => {
		reads++
		return result
	}
	await cache.fetch('active', 'v1', read)
	first()
	first() // cleanup is lease-owned/idempotent
	for (let i = 0; i < 80; i++) await cache.fetch(String(i), 'v1', read)
	await cache.fetch('active', 'v1', read)
	assert.equal(reads, 81)
	const held = deferred<HelmResult<DashboardItem>>()
	const pending = cache.fetch('active', 'v1', () => held.promise, true)
	second()
	for (let i = 80; i < 160; i++) await cache.fetch(String(i), 'v1', read)
	assert.equal(cache.fetch('active', 'v1', read, true), pending)
	held.resolve(result)
	await pending
	await cache.fetch('active', 'v1', read)
	assert.equal(reads, 161)
})

test('production request entry deduplicates and isolates replacement transports', async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
	const held = deferred<HelmResult<DashboardItem>>()
	let reads = 0
	const firstApi = {
		item: () => {
			reads++
			return held.promise
		},
	}
	const fixture = { helm: { daemon: firstApi } }
	Object.defineProperty(globalThis, 'window', { value: fixture, configurable: true })
	try {
		const first = fetchItemDetail('production', 'v1')
		assert.equal(fetchItemDetail('production', 'v1', true), first)
		await Promise.resolve()
		assert.equal(reads, 1)
		fixture.helm.daemon = {
			item: async () => {
				reads++
				return result
			},
		}
		const replacement = fetchItemDetail('production', 'v1')
		assert.notEqual(replacement, first)
		assert.equal(await replacement, result)
		held.resolve({ error: 'retired transport' })
		await first
		assert.equal(await fetchItemDetail('production', 'v1'), result)
		assert.equal(reads, 2)
	} finally {
		if (original) Object.defineProperty(globalThis, 'window', original)
		else Reflect.deleteProperty(globalThis, 'window')
	}
})

test('old-key settlement cannot replace a newer detail and failed reads remain retryable', async () => {
	const cache = createItemDetailCache()
	const held = deferred<HelmResult<DashboardItem>>()
	const old = cache.fetch('item', 'old', () => held.promise)
	const fresh = await cache.fetch('item', 'new', async () => result)
	held.resolve({ error: 'old unavailable' })
	await old
	assert.equal(
		await cache.fetch('item', 'new', async () => {
			throw new Error('unexpected reread')
		}),
		fresh,
	)
	await cache.fetch('error', 'v1', async () => ({ error: 'unavailable' }))
	assert.equal(await cache.fetch('error', 'v1', async () => result), result)
	await assert.rejects(
		cache.fetch('reject', 'v1', async () => {
			throw new Error('offline')
		}),
	)
	assert.equal(await cache.fetch('reject', 'v1', async () => result), result)
})
