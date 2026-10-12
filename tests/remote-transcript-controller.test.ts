import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import controllerModule from '../app/src/renderer/remote/transcript-controller.js'
import type { HistoryEntry } from '../src/remote/history-projection.js'
import type { HistoryRequest, HistoryResult } from '../src/remote/history-protocol.js'
import { RemoteHistoryReader } from '../src/remote/history-reader.js'
const { RemoteTranscriptController } = controllerModule
const target = { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 }
const id = (n: number) => n.toString(16).padStart(8, '0')
async function tick() {
	await new Promise(resolve => setImmediate(resolve))
}
function setup(hold = false) {
	let release: () => void = () => {}
	const held = new Promise<void>(resolve => {
		release = resolve
	})
	const entries = new Map<string, HistoryEntry>()
	for (let n = 1; n <= 240; n++)
		entries.set(id(n), {
			id: id(n),
			parentId: n > 1 ? id(n - 1) : null,
			type: 'message',
			message: { role: 'user', content: `m${n}` },
		})
	const hostEpoch = randomUUID()
	const backend = new RemoteHistoryReader(target, hostEpoch, () => ({
		getLeafId: () => id(240),
		getEntry: key => entries.get(key),
	}))
	const calls: HistoryRequest[] = []
	let rejectNext = false
	const transport = {
		history: async (request: HistoryRequest) => {
			calls.push(request)
			if (rejectNext) {
				rejectNext = false
				throw new Error('temporary')
			}
			const result = backend.execute({
				requestId: randomUUID(),
				principalKey: 'test',
				expiresAt: Date.now() + 4000,
				request,
			})
			if (hold) await held
			return result
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
			throw new Error('effect')
		},
		receipt: async () => {
			throw new Error('effect')
		},
	}
	const controller = new RemoteTranscriptController(transport, { target, hostEpoch }, { scheduler: task => task() })
	controller.setAvailable(true)
	return {
		controller,
		backend,
		calls,
		release,
		fail: () => {
			rejectNext = true
		},
	}
}
test('explicit expansion prepends through the real in-memory reader and keeps live suffix', async () => {
	const f = setup()
	try {
		f.controller.observeLive({ records: [], historyTruncated: true, revision: 1 })
		f.controller.loadEarlier(id(201))
		await tick()
		assert.equal(f.calls[0]?.action.kind, 'open')
		assert.equal(f.controller.getSnapshot().chunks.length, 1)
		f.controller.loadEarlier()
		await tick()
		assert.equal(f.controller.getSnapshot().chunks.length, 2)
		assert.equal(f.controller.getSnapshot().live.length, 0)
		assert.ok(f.controller.debug().residentBytes > 0)
	} finally {
		f.controller.dispose()
		f.backend.dispose()
	}
})
test('equal live snapshots do not read, retry is exact, and late cancellation is fenced', async () => {
	const f = setup()
	try {
		const live = { records: [], historyTruncated: false, revision: 4 }
		f.controller.observeLive(live)
		f.controller.observeLive(live)
		assert.equal(f.calls.length, 0)
		f.fail()
		f.controller.loadEarlier(id(100))
		await tick()
		assert.equal(f.controller.getSnapshot().issue, 'unavailable')
		f.controller.retry()
		await tick()
		assert.deepEqual(f.calls[0], f.calls[1])
		f.controller.cancel()
		assert.equal(f.controller.getSnapshot().phase, 'idle')
	} finally {
		f.controller.dispose()
		f.backend.dispose()
	}
})
test('continued history admits its page through the captured model ticket', async () => {
	const f = setup()
	try {
		f.controller.loadEarlier(id(100))
		await tick()
		assert.equal(f.controller.getSnapshot().phase, 'progress')
		assert.equal(f.controller.getSnapshot().chunks.length, 0)
		f.controller.continue()
		await tick()
		assert.equal(f.calls[1]?.action.kind, 'continue')
		assert.equal(f.controller.getSnapshot().chunks.length, 1)
	} finally {
		f.controller.dispose()
		f.backend.dispose()
	}
})
for (const retirement of ['cancel', 'owner', 'dispose'] as const) {
	test(`late history page cannot publish after ${retirement}`, async () => {
		const f = setup(true)
		try {
			f.controller.loadEarlier(id(201))
			await tick()
			assert.equal(f.calls.length, 1)
			if (retirement === 'cancel') f.controller.cancel()
			else if (retirement === 'owner')
				f.controller.setIdentity({ target: { ...target, incarnation: randomUUID() }, hostEpoch: randomUUID() })
			else f.controller.dispose()
			f.release()
			await tick()
			assert.equal(f.controller.getSnapshot().chunks.length, 0)
		} finally {
			f.release()
			f.controller.dispose()
			f.backend.dispose()
		}
	})
}
test('owner replacement clears all payload and viewport never admits history', async () => {
	const f = setup()
	try {
		f.controller.loadEarlier(id(180))
		await tick()
		assert.equal(f.controller.getSnapshot().chunks.length, 1)
		const next = { target: { ...target, incarnation: randomUUID() }, hostEpoch: randomUUID() }
		f.controller.setIdentity(next)
		assert.equal(f.controller.getSnapshot().chunks.length, 0)
		f.controller.viewport({ scrollTop: 10, height: 100, width: 300, activity: false, readingVisible: true })
		await tick()
		assert.equal(f.calls.length, 2) // the second call is the authenticated close cleanup
	} finally {
		f.controller.dispose()
		f.backend.dispose()
	}
})
