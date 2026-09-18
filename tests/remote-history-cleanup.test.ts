import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import controllerModule from '../app/src/renderer/remote/history-controller.js'
import transportModule from '../app/src/renderer/remote/transport.js'
import type { HistoryRecord, HistoryRequest } from '../src/remote/history-protocol.js'
import { RemoteHistoryReader } from '../src/remote/history-reader.js'
import { RemoteHistoryReads } from '../src/remote/history-reads.js'
const { RemoteHistoryController } = controllerModule
const { RemoteHistoryError } = transportModule
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture() {
	const identity = {
		hostEpoch: randomUUID(),
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
	}
	let now = 1
	let gap = false
	const reads = new RemoteHistoryReads(() => now)
	const backend = new RemoteHistoryReader(
		identity.target,
		identity.hostEpoch,
		() => ({
			getLeafId: () => '00000002',
			getEntry: id =>
				gap
					? undefined
					: {
							id,
							parentId: id === '00000002' ? '00000001' : null,
							type: 'message',
							message: { role: 'user', content: 'Canonical' },
						},
		}),
		() => now,
	)
	const replacementIdentity = { ...identity, target: { ...identity.target, incarnation: randomUUID() } }
	const replacementBackend = new RemoteHistoryReader(
		replacementIdentity.target,
		replacementIdentity.hostEpoch,
		() => ({
			getLeafId: () => '00000003',
			getEntry: id => ({
				id,
				parentId: null,
				type: 'message',
				message: { role: 'user', content: 'Replacement owner' },
			}),
		}),
		() => now,
	)
	const requests: HistoryRequest[] = []
	let held = false
	let max = 0
	let busy = 0
	const transport = {
		async history(request: HistoryRequest, signal: AbortSignal) {
			requests.push(request)
			const pending = reads.request(request, 'principal', 'device', () => null, signal)
			max = Math.max(max, reads.size)
			const descriptor = reads.deliver(request)
			if (descriptor && descriptor.request === request && !(held && request.action.kind === 'close'))
				reads.complete(
					(request.target.incarnation === identity.target.incarnation ? backend : replacementBackend).execute(
						descriptor,
					),
				)
			const reply = await pending
			if ('error' in reply) {
				if (reply.error === 'busy') busy++
				throw new RemoteHistoryError(429, reply.error)
			}
			return reply.result
		},
		access: async () => {
			throw new Error('unused')
		},
		directory: async () => {
			throw new Error('unused')
		},
		catalog: async () => {
			throw new Error('unused')
		},
		detail: async () => {
			throw new Error('unused')
		},
		send: async () => {
			throw new Error('effect forbidden')
		},
		receipt: async () => {
			throw new Error('effect forbidden')
		},
	}
	const create = (owner = identity) => {
		const reader = new RemoteHistoryController(transport, owner)
		reader.setAvailable(true)
		return reader
	}
	return {
		create,
		requests,
		reads,
		transport,
		identity,
		replacementIdentity,
		stats: () => ({ max, busy }),
		gap: (value: boolean) => {
			gap = value
		},
		expire: () => {
			now += 60001
		},
		hold: () => {
			held = true
		},
		release: () => {
			held = false
			const d = reads.deliver(identity)
			if (d) assert.equal(reads.complete(backend.execute(d)), true)
		},
		cleanup: () => {
			reads.cancel(() => true)
			backend.dispose()
			replacementBackend.dispose()
		},
	}
}
async function opened(reader: InstanceType<typeof RemoteHistoryController>) {
	for (let i = 0; i < 30 && reader.getSnapshot().phase === 'loading'; i++) await tick()
	assert.equal(reader.getSnapshot().phase, 'idle')
	assert.ok(reader.getSnapshot().current)
}
for (const boundary of ['cancel', 'availability', 'latest', 'dispose'] as const)
	test(`production admission: held cleanup fences waiting open on ${boundary}`, async () => {
		const f = fixture()
		const r = f.create()
		try {
			r.open()
			await opened(r)
			f.hold()
			r.latest()
			r.open()
			await tick()
			assert.equal(f.reads.size, 1)
			if (boundary === 'availability') {
				r.setAvailable(false)
				r.setAvailable(true)
			} else r[boundary]()
			const before = r.getSnapshot()
			f.release()
			await tick()
			await tick()
			assert.equal(f.requests.filter(x => x.action.kind === 'open').length, 1)
			assert.equal(r.getSnapshot(), before)
			if (boundary !== 'dispose') {
				r.open()
				await opened(r)
				assert.equal(f.requests.filter(x => x.action.kind === 'open').length, 2)
			}
			assert.deepEqual(f.stats(), { max: 1, busy: 0 })
		} finally {
			r.dispose()
			f.cleanup()
		}
	})
test('production admission: repeated latest/open coalesces to one actual cleanup and one successor', async () => {
	const f = fixture()
	const r = f.create()
	try {
		r.open()
		await opened(r)
		f.hold()
		for (let i = 0; i < 100; i++) {
			r.latest()
			r.open()
		}
		await tick()
		assert.equal(f.reads.size, 1)
		assert.equal(f.requests.length, 2)
		f.release()
		await opened(r)
		assert.deepEqual(
			f.requests.map(x => x.action.kind),
			['open', 'close', 'open'],
		)
		assert.deepEqual(f.stats(), { max: 1, busy: 0 })
	} finally {
		r.dispose()
		f.cleanup()
	}
})
test('production admission: disposal/new controller shares cleanup ownership', async () => {
	const f = fixture()
	const old = f.create()
	let next: ReturnType<typeof f.create> | undefined
	try {
		old.open()
		await opened(old)
		f.hold()
		old.dispose()
		next = f.create()
		next.open()
		await tick()
		assert.deepEqual(
			f.requests.map(x => x.action.kind),
			['open', 'close'],
		)
		f.release()
		await opened(next)
		assert.deepEqual(
			f.requests.map(x => x.action.kind),
			['open', 'close', 'open'],
		)
		assert.deepEqual(f.stats(), { max: 1, busy: 0 })
	} finally {
		old.dispose()
		next?.dispose()
		f.cleanup()
	}
})
test('production admission: expiry restart waits behind actual delivered close', async () => {
	const f = fixture()
	const r = f.create()
	try {
		r.open()
		await opened(r)
		f.expire()
		r.reread()
		await tick()
		assert.equal(r.getSnapshot().issue, 'expired')
		f.hold()
		r.open()
		await tick()
		assert.equal(f.reads.size, 1)
		f.release()
		await opened(r)
		assert.deepEqual(f.stats(), { max: 1, busy: 0 })
	} finally {
		r.dispose()
		f.cleanup()
	}
})

test('production admission: gap restart closes the broken view before a real successor', async () => {
	const f = fixture()
	const r = f.create()
	try {
		f.gap(true)
		r.open()
		await tick()
		assert.equal(r.getSnapshot().issue, 'gap')
		f.gap(false)
		f.hold()
		r.open()
		await tick()
		assert.equal(f.reads.size, 1)
		f.release()
		await opened(r)
		assert.deepEqual(f.stats(), { max: 1, busy: 0 })
	} finally {
		r.dispose()
		f.cleanup()
	}
})
test('production admission: separate transport still observes real cross-tab busy', async () => {
	const f = fixture()
	const r = f.create()
	const other = new RemoteHistoryController({ ...f.transport }, f.identity)
	other.setAvailable(true)
	try {
		r.open()
		await opened(r)
		f.hold()
		r.latest()
		await tick()
		other.open()
		await tick()
		assert.equal(other.getSnapshot().issue, 'busy')
		f.release()
		other.retry()
		await opened(other)
		assert.deepEqual(f.stats(), { max: 1, busy: 1 })
	} finally {
		r.dispose()
		other.dispose()
		f.cleanup()
	}
})

test('production admission: owner replacement retires an old waiting open before successor admission', async () => {
	const f = fixture()
	const old = f.create()
	let next: ReturnType<typeof f.create> | undefined
	try {
		old.open()
		await opened(old)
		assert.deepEqual(
			old
				.getSnapshot()
				.current?.page.records.map((record: HistoryRecord) =>
					record.kind === 'message' ? [record.message.id, record.message.text] : record,
				),
			[
				['00000001', 'Canonical'],
				['00000002', 'Canonical'],
			],
		)
		assert.deepEqual(old.getSnapshot().current?.page.omissions, { clipped: 0, images: 0, unsupported: 0 })
		f.hold()
		old.latest()
		old.open()
		await tick()
		old.dispose()
		next = f.create(f.replacementIdentity)
		next.open()
		await tick()
		assert.equal(f.requests.length, 2)
		f.release()
		await opened(next)
		assert.deepEqual(
			f.requests.map(r => r.action.kind),
			['open', 'close', 'open'],
		)
		assert.equal(f.requests[2].target.incarnation, f.replacementIdentity.target.incarnation)
		assert.deepEqual(next.getSnapshot().current?.page.records, [
			{
				kind: 'message',
				message: {
					id: '00000003',
					role: 'user',
					text: 'Replacement owner',
					thinking: '',
					toolCalls: '',
					truncated: false,
				},
			},
		])
		assert.deepEqual(next.getSnapshot().current?.page.omissions, { clipped: 0, images: 0, unsupported: 0 })
		assert.deepEqual(f.stats(), { max: 1, busy: 0 })
	} finally {
		old.dispose()
		next?.dispose()
		f.cleanup()
	}
})
