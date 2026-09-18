import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import transportModule from '../app/src/renderer/remote/transport.js'
import type { HistoryRequest } from '../src/remote/history-protocol.js'

const { createRemoteTransport, RemoteHistoryError } = transportModule
const input = (): HistoryRequest => ({
	version: 1,
	hostEpoch: randomUUID(),
	target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
	viewId: randomUUID(),
	sequence: 0,
	action: { kind: 'open' },
})

test('production browser history transport treats old-host 404 as unsupported without command or retry traffic', async t => {
	const calls: Array<{ url: string; options?: RequestInit }> = []
	t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
		calls.push({ url, options })
		return Response.json({ error: 'not_found' }, { status: 404 })
	})
	const history = createRemoteTransport().history
	assert.ok(history)
	await assert.rejects(
		history(input(), new AbortController().signal),
		error => error instanceof RemoteHistoryError && error.reason === 'unsupported' && error.status === 404,
	)
	assert.equal(calls.length, 1)
	assert.equal(calls[0].url, '/v1/history/read')
	assert.equal(calls[0].options?.credentials, 'same-origin')
	assert.equal(calls[0].options?.cache, 'no-store')
	assert.equal(calls[0].options?.redirect, 'error')
	assert.equal(new Headers(calls[0].options?.headers).get('X-Helm-Remote'), '1')
})

test('production browser transport bounds result/error bodies and propagates caller cancellation', async t => {
	for (const failure of ['oversize-result', 'oversize-error', 'truncated', 'abort'])
		await t.test(failure, async sub => {
			let cancelled = false
			sub.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
				if (failure === 'abort')
					return new Promise<Response>((_resolve, reject) => {
						options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
					})
				if (failure === 'truncated') return new Response('{"version":1')
				return new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(new Uint8Array(failure === 'oversize-error' ? 4097 : 96 * 1024 + 1))
						},
						cancel() {
							cancelled = true
						},
					}),
					{ status: failure === 'oversize-error' ? 503 : 200 },
				)
			})
			const history = createRemoteTransport().history
			assert.ok(history)
			const controller = new AbortController()
			const pending = history(input(), controller.signal)
			if (failure === 'abort') controller.abort()
			await assert.rejects(pending)
			if (failure.startsWith('oversize')) assert.equal(cancelled, true)
		})
})
