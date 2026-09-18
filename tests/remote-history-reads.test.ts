import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { HistoryDescriptor, HistoryRequest, HistoryResult } from '../src/remote/history-protocol.js'
import { type HistoryReadFailure, RemoteHistoryReads } from '../src/remote/history-reads.js'

function request(): HistoryRequest {
	return {
		version: 1,
		hostEpoch: randomUUID(),
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
		viewId: randomUUID(),
		sequence: 0,
		action: { kind: 'open' },
	}
}
function result(descriptor: HistoryDescriptor): HistoryResult {
	const { requestId, request } = descriptor
	return {
		version: 1,
		requestId,
		hostEpoch: request.hostEpoch,
		target: request.target,
		viewId: request.viewId,
		sequence: request.sequence,
		input: request.action,
		state: 'page',
		page: {
			newest: null,
			oldest: null,
			records: [],
			omissions: { clipped: 0, images: 0, unsupported: 0 },
			reread: 'sealed',
			older: null,
			newer: null,
			stopped: 'root',
		},
		continuation: null,
		attempts: 0,
		examined: 0,
	}
}

test('history coordinator bounds global, target and device admission without a backlog', async () => {
	const reads = new RemoteHistoryReads(() => 1000)
	const requests = Array.from({ length: 9 }, request)
	const controllers = requests.map(() => new AbortController())
	const pending = requests
		.slice(0, 8)
		.map((request, index) =>
			reads.request(request, `principal-${index}`, `device-${index}`, () => null, controllers[index].signal),
		)
	assert.equal(reads.size, 8)
	assert.deepEqual(await reads.request(requests[8], 'extra', 'extra', () => null, controllers[8].signal), {
		error: 'busy',
	})
	controllers[0].abort()
	assert.deepEqual(await pending[0], { error: 'cancelled' })
	assert.equal(reads.size, 7)
	assert.deepEqual(await reads.request(requests[1], 'extra', 'extra', () => null, controllers[8].signal), {
		error: 'busy',
	})
	assert.deepEqual(await reads.request(requests[8], 'extra', 'device-1', () => null, controllers[8].signal), {
		error: 'busy',
	})
	reads.cancel(() => true)
	assert.equal(reads.size, 0)
	assert.deepEqual(
		await Promise.all(pending.slice(1)),
		Array.from({ length: 7 }, () => ({ error: 'stale_target' })),
	)
})

test('history results bind every request identity and accept only the outstanding response once', async () => {
	const reads = new RemoteHistoryReads(() => 1000)
	const input = request()
	const controller = new AbortController()
	const pending = reads.request(input, 'principal', 'device', () => null, controller.signal)
	const descriptor = required(reads.deliver(input))
	assert.deepEqual(reads.deliver(input), descriptor)
	const value = result(descriptor)
	for (const changed of [
		{ requestId: randomUUID() },
		{ hostEpoch: randomUUID() },
		{ viewId: randomUUID() },
		{ sequence: 1 },
		{ target: { ...input.target, incarnation: randomUUID() } },
		{ target: { ...input.target, generation: 2 } },
		{ target: { ...input.target, scopeId: randomUUID() } },
		{ input: { kind: 'close' as const } },
	])
		assert.equal(reads.complete({ ...value, ...changed }), false)
	assert.equal(reads.size, 1)
	assert.equal(reads.complete(value), true)
	assert.deepEqual(await pending, { result: value })
	assert.equal(reads.complete(value), false)
	assert.equal(reads.size, 0)
})

test('history admission, delivery and disclosure revalidate authority and deadlines; late results are fenced', async () => {
	for (const phase of ['delivery', 'result']) {
		for (const failure of ['unauthorized', 'disconnected', 'unsupported', 'stale_target'] as HistoryReadFailure[]) {
			let invalid: HistoryReadFailure | null = null
			const reads = new RemoteHistoryReads(() => 1000)
			const input = request()
			const pending = reads.request(input, 'principal', 'device', () => invalid, new AbortController().signal)
			const value = result(required(reads.deliver(input)))
			invalid = failure
			if (phase === 'delivery') assert.equal(reads.deliver(input), undefined)
			else assert.equal(reads.complete(value), true)
			assert.deepEqual(await pending, { error: failure })
			assert.equal(reads.complete(value), false)
			assert.equal(reads.size, 0)
		}
	}
	let now = 1000
	const reads = new RemoteHistoryReads(() => now)
	const input = request()
	const pending = reads.request(input, 'principal', 'device', () => null, new AbortController().signal)
	const value = result(required(reads.deliver(input)))
	now += 4000
	assert.equal(reads.complete(value), true)
	assert.deepEqual(await pending, { error: 'timeout' })
	const aborted = new AbortController()
	aborted.abort()
	assert.deepEqual(await reads.request(input, 'principal', 'device', () => null, aborted.signal), {
		error: 'cancelled',
	})
	assert.equal(reads.size, 0)
})

test('history result byte bounds include JSON escaping and rejected results leave admission cancellable', async () => {
	const reads = new RemoteHistoryReads(() => 1000)
	const input = request()
	const controller = new AbortController()
	const pending = reads.request(input, 'principal', 'device', () => null, controller.signal)
	const value = result(required(reads.deliver(input)))
	required(value.page).records = [
		{
			kind: 'message',
			message: {
				id: '00000001',
				role: 'assistant',
				text: '\0'.repeat(8192),
				thinking: '\0'.repeat(8192),
				truncated: false,
			},
		},
	]
	assert.equal(reads.complete(value), false)
	assert.equal(reads.size, 1)
	controller.abort()
	assert.deepEqual(await pending, { error: 'cancelled' })
})

function required<T>(value: T | null | undefined): T {
	assert.ok(value !== null && value !== undefined, 'Expected fixture value')
	return value
}
