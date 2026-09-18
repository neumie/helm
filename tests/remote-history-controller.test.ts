import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import controllerModule from '../app/src/renderer/remote/history-controller.js'
import transportModule from '../app/src/renderer/remote/transport.js'
import type { HistoryEntry } from '../src/remote/history-projection.js'
import type { HistoryRequest, HistoryResult } from '../src/remote/history-protocol.js'
import { RemoteHistoryReader } from '../src/remote/history-reader.js'
const { RemoteHistoryController } = controllerModule
const { RemoteHistoryError } = transportModule
const target = { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 }
const hostEpoch = randomUUID()
const id = (n: number) => n.toString(16).padStart(8, '0')
function setup(count = 640) {
	let now = 1
	let head = count
	const entries = new Map<string, HistoryEntry>(
		Array.from({ length: count }, (_, index) => {
			const n = index + 1
			return [
				id(n),
				{
					id: id(n),
					parentId: n > 1 ? id(n - 1) : null,
					type: 'message',
					message: { role: 'user', content: 'Identical text' },
				},
			]
		}),
	)
	const backend = new RemoteHistoryReader(
		target,
		hostEpoch,
		() => ({ getLeafId: () => id(head), getEntry: key => entries.get(key) }),
		() => now,
	)
	const requests: HistoryRequest[] = []
	let reply: ((request: HistoryRequest, result: HistoryResult) => Promise<HistoryResult>) | null = null
	const transport = {
		async history(request: HistoryRequest) {
			requests.push(request)
			const result = backend.execute({
				requestId: randomUUID(),
				principalKey: 'device',
				expiresAt: now + 4000,
				request,
			})
			return reply ? reply(request, result) : result
		},
		access: async () => {
			throw new Error('not used')
		},
		directory: async () => {
			throw new Error('not used')
		},
		catalog: async () => {
			throw new Error('not used')
		},
		detail: async () => {
			throw new Error('not used')
		},
		send: async () => {
			throw new Error('effects forbidden')
		},
		receipt: async () => {
			throw new Error('effects forbidden')
		},
	}
	const reader = new RemoteHistoryController(transport, { target, hostEpoch })
	reader.setAvailable(true)
	return {
		reader,
		backend,
		entries,
		requests,
		expire: () => {
			now += 60_001
		},
		append: () => {
			head++
			entries.set(id(head), { id: id(head), parentId: id(head - 1), type: 'compaction' })
		},
		reply: (value: typeof reply) => {
			reply = value
		},
	}
}
async function settle(reader: InstanceType<typeof RemoteHistoryController>) {
	for (let n = 0; n < 30 && reader.getSnapshot().phase === 'loading'; n++)
		await new Promise(resolve => setImmediate(resolve))
	assert.notEqual(reader.getSnapshot().phase, 'loading')
}
async function finish(reader: InstanceType<typeof RemoteHistoryController>) {
	await settle(reader)
	for (let n = 0; n < 100 && reader.getSnapshot().phase === 'progress'; n++) {
		reader.continue()
		await settle(reader)
	}
	assert.equal(reader.getSnapshot().phase, 'idle')
}
test('real bounded reader: actually older, three pages, uncached Newer, sealed evicted anchor and fixed-head append', async () => {
	const f = setup()
	try {
		f.reader.open(id(601))
		await finish(f.reader)
		const first = f.reader.getSnapshot().current?.page
		assert.ok(first)
		assert.equal(first.newest, id(600))
		const anchor = { range: first.reread, id: id(580), offset: -12.5 }
		f.reader.remember(anchor)
		for (let n = 0; n < 9; n++) {
			f.reader.move('older')
			await finish(f.reader)
			assert.ok(f.reader.debug().pages <= 3)
			assert.ok(f.reader.debug().records <= 120)
		}
		f.append()
		for (let n = 0; n < 9; n++) {
			f.reader.move('newer')
			await finish(f.reader)
		}
		assert.ok(f.requests.some(request => request.action.kind === 'newer'))
		assert.ok(f.requests.some(request => request.action.kind === 'continue'))
		f.reader.reread()
		await finish(f.reader)
		assert.deepEqual(f.reader.getSnapshot().current?.page.records, first.records)
		assert.deepEqual(f.reader.getSnapshot().current?.anchor, anchor)
		assert.equal(f.reader.debug().pages, 3)
	} finally {
		f.reader.dispose()
		f.backend.dispose()
	}
})
test('root empty page keeps Newer and sparse activity/metadata pages still navigate', async () => {
	const f = setup(500)
	try {
		for (let n = 2; n <= 300; n++) f.entries.set(id(n), { id: id(n), parentId: id(n - 1), type: 'session_info' })
		f.reader.open(id(1))
		await finish(f.reader)
		assert.equal(f.reader.getSnapshot().current?.page.records.length, 0)
		assert.equal(f.reader.getSnapshot().current?.page.older, null)
		assert.ok(f.reader.getSnapshot().current?.page.newer)
		f.reader.move('newer')
		await finish(f.reader)
		assert.ok(f.reader.getSnapshot().current?.page.newer)
	} finally {
		f.reader.dispose()
		f.backend.dispose()
	}
})
test('late replies after cancel/latest/disposal/access change never publish', async () => {
	for (const action of ['cancel', 'latest', 'dispose', 'unavailable'] as const) {
		const f = setup()
		let release: (() => void) | undefined
		f.reply(async (_request, result) => {
			await new Promise<void>(resolve => {
				release = resolve
			})
			return result
		})
		f.reader.open(id(601))
		if (action === 'unavailable') f.reader.setAvailable(false)
		else f.reader[action]()
		const before = f.reader.getSnapshot()
		release?.()
		await new Promise(resolve => setImmediate(resolve))
		assert.equal(f.reader.getSnapshot(), before)
		assert.equal(f.reader.getSnapshot().current, null)
		f.reader.dispose()
		f.backend.dispose()
	}
})
test('lost response retries exact valid sequence; expiry restarts and unsupported/401 remain truthful', async () => {
	const f = setup()
	try {
		let fail = true
		f.reply(async (_request, result) => {
			if (fail) {
				fail = false
				throw new Error('lost response')
			}
			return result
		})
		f.reader.open(id(601))
		await settle(f.reader)
		assert.equal(f.reader.getSnapshot().issue, 'unavailable')
		f.reader.retry()
		await finish(f.reader)
		assert.deepEqual(f.requests[0], f.requests[1])
		f.expire()
		f.reader.move('older')
		await settle(f.reader)
		assert.equal(f.reader.getSnapshot().issue, 'expired')
		f.reader.open(id(601))
		await finish(f.reader)
		f.reply(async () => {
			throw new RemoteHistoryError(401, 'unauthorized')
		})
		f.reader.move('older')
		await settle(f.reader)
		assert.equal(f.reader.getSnapshot().issue, 'access-ended')
		assert.equal(f.reader.getSnapshot().current, null)
		assert.equal(f.reader.debug().pages, 0)
		f.reader.setAvailable(false)
		assert.equal(f.reader.getSnapshot().issue, 'access-ended')
	} finally {
		f.reader.dispose()
		f.backend.dispose()
	}
})
test('stub transport: successor waits for close completion (ordering only, not host admission)', async () => {
	const requests: HistoryRequest[] = []
	let releaseClose: (() => void) | undefined
	const transport = {
		history: async (request: HistoryRequest) => {
			requests.push(request)
			if (request.action.kind === 'close') {
				await new Promise<void>(resolve => {
					releaseClose = resolve
				})
			}
			return {
				version: 1 as const,
				requestId: randomUUID(),
				viewId: request.viewId,
				sequence: request.sequence,
				hostEpoch,
				target,
				input: request.action,
				state: 'page' as const,
				examined: 1,
				continuation: null,
				page: {
					records: [],
					older: null,
					newer: null,
					reread: randomUUID(),
					newest: null,
					omissions: { clipped: 0, images: 0, unsupported: 0 },
				},
			}
		},
		access: async () => {
			throw new Error('not used')
		},
		directory: async () => {
			throw new Error('not used')
		},
		catalog: async () => {
			throw new Error('not used')
		},
		detail: async () => {
			throw new Error('not used')
		},
		send: async () => {
			throw new Error('effects forbidden')
		},
		receipt: async () => {
			throw new Error('effects forbidden')
		},
	}
	const reader = new RemoteHistoryController(transport, { target, hostEpoch })
	reader.setAvailable(true)
	reader.open()
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(requests.length, 1)
	reader.open()
	await new Promise(resolve => setImmediate(resolve))
	assert.deepEqual(
		requests.map(request => request.action.kind),
		['open', 'close'],
	)
	releaseClose?.()
	for (let n = 0; n < 20 && requests.length < 3; n++) await new Promise(resolve => setImmediate(resolve))
	assert.deepEqual(
		requests.map(request => request.action.kind),
		['open', 'close', 'open'],
	)
	reader.dispose()
})

test('forged response identity and provisional anchor cannot become canonical history', async () => {
	const f = setup()
	try {
		f.reply(async (_request, result) => ({ ...result, sequence: result.sequence + 1 }))
		f.reader.open('current')
		await settle(f.reader)
		assert.deepEqual(f.requests[0]?.action, { kind: 'open' })
		assert.equal(f.reader.getSnapshot().issue, 'unavailable')
		assert.equal(f.reader.debug().pages, 0)
	} finally {
		f.reader.dispose()
		f.backend.dispose()
	}
})
