import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchAssessmentImages } from '../src/items/assess.js'
import type { TaskContext } from '../src/providers/provider.js'
import { isSafePublicHttpUrl } from '../src/util/ssrf.js'

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}

const LIMIT = 4_500_000
const context = (...urls: string[]): TaskContext => ({
	title: 'Screenshot',
	descriptionBlocks: urls.map(url => ({ type: 'image', url })),
})
const image = context('https://images.example.test/a.png')
const publicDns = async () => true

function streamed(sizes: number[], headers: Record<string, string> = {}, status = 200) {
	let reads = 0
	let cancelled = false
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const size = sizes[reads++]
				if (size === undefined) controller.close()
				else controller.enqueue(new Uint8Array(size).fill(42))
			},
			cancel() {
				cancelled = true
			},
		},
		{ highWaterMark: 0 },
	)
	return {
		response: new Response(body, { status, headers: { 'content-type': 'image/png', ...headers } }),
		reads: () => reads,
		cancelled: () => cancelled,
	}
}

const lengthHeaders: Record<string, string>[] = [{}, { 'content-length': '1' }]
for (const headers of lengthHeaders) {
	test(`assessment streams exact limit with headers ${JSON.stringify(headers)}`, async () => {
		const source = streamed([LIMIT - 1, 1], headers)
		const result = await fetchAssessmentImages(image, undefined, {
			fetch: async () => source.response,
			isSafePublicHttpUrl: publicDns,
		})
		assert.equal(result.length, 1)
		assert.deepEqual(Buffer.from(result[0].data, 'base64'), Buffer.alloc(LIMIT, 42))
	})

	test(`assessment cancels actual oversize before reading remaining chunks ${JSON.stringify(headers)}`, async () => {
		const source = streamed([LIMIT, 1, LIMIT], headers)
		assert.deepEqual(
			await fetchAssessmentImages(image, undefined, {
				fetch: async () => source.response,
				isSafePublicHttpUrl: publicDns,
			}),
			[],
		)
		assert.equal(source.reads(), 2)
		assert.equal(source.cancelled(), true)
	})
}

const unusedResponses: Array<{ status: number; headers: Record<string, string> }> = [
	{ status: 200, headers: { 'content-length': String(LIMIT + 1) } },
	{ status: 500, headers: {} },
	{ status: 302, headers: {} },
]
for (const scenario of unusedResponses) {
	test(`assessment disposes unused response ${JSON.stringify(scenario)}`, async () => {
		const source = streamed([1], scenario.headers, scenario.status)
		assert.deepEqual(
			await fetchAssessmentImages(image, undefined, {
				fetch: async () => source.response,
				isSafePublicHttpUrl: publicDns,
			}),
			[],
		)
		assert.equal(source.reads(), 0)
		assert.equal(source.cancelled(), true)
	})
}

test('assessment disposes redirects and revalidates each hop, including private destinations', async () => {
	const first = streamed([1], { location: 'https://8.8.8.8/b.png' }, 302)
	const second = streamed([1], { location: 'http://127.0.0.1/private.png' }, 302)
	const urls: string[] = []
	let calls = 0
	assert.deepEqual(
		await fetchAssessmentImages(context('https://8.8.8.8/a.png'), undefined, {
			fetch: async (_, init) => {
				assert.equal(init?.redirect, 'manual')
				return calls++ === 0 ? first.response : second.response
			},
			isSafePublicHttpUrl: async url => {
				urls.push(url)
				return isSafePublicHttpUrl(url)
			},
		}),
		[],
	)
	assert.equal(calls, 2)
	assert.equal(urls.length, 3)
	assert.equal(first.cancelled(), true)
	assert.equal(second.cancelled(), true)
})

test('assessment admits at most three unique downloads and preserves ordered results', async () => {
	const releases: Array<() => void> = []
	let active = 0
	let peak = 0
	const ready = deferred<void>()
	const result = fetchAssessmentImages(
		context(...['a', 'a', 'b', 'c', 'd'].map(x => `https://images.example.test/${x}.png`)),
		undefined,
		{
			isSafePublicHttpUrl: publicDns,
			fetch: async () => {
				active++
				peak = Math.max(peak, active)
				await new Promise<void>(resolve => {
					releases.push(resolve)
					if (releases.length === 3) ready.resolve()
				})
				active--
				return streamed([1]).response
			},
		},
	)
	await ready.promise
	assert.equal(peak, 3)
	for (const release of releases) release()
	assert.equal((await result).length, 3)
	assert.equal(releases.length, 3)
})

for (const cause of ['abort', 'deadline'] as const) {
	test(`assessment ${cause} settles a stalled read and disposes its body`, async t => {
		const controller = new AbortController()
		if (cause === 'deadline')
			t.mock.method(AbortSignal, 'timeout', (ms: number) => {
				assert.equal(ms, 10_000)
				return controller.signal
			})
		const reading = deferred<void>()
		let cancelled = false
		const result = fetchAssessmentImages(image, cause === 'abort' ? controller.signal : undefined, {
			isSafePublicHttpUrl: publicDns,
			fetch: async () =>
				new Response(
					new ReadableStream(
						{
							pull() {
								reading.resolve()
							},
							cancel() {
								cancelled = true
							},
						},
						{ highWaterMark: 0 },
					),
					{ headers: { 'content-type': 'image/png' } },
				),
		})
		await reading.promise
		controller.abort()
		assert.deepEqual(await result, [])
		assert.equal(cancelled, true)
	})
}

test('assessment abort while resolving DNS never starts a fetch', async () => {
	const controller = new AbortController()
	const resolving = deferred<void>()
	const dns = deferred<boolean>()
	let calls = 0
	const result = fetchAssessmentImages(image, controller.signal, {
		isSafePublicHttpUrl: () => {
			resolving.resolve()
			return dns.promise
		},
		fetch: async () => {
			calls++
			return streamed([1]).response
		},
	})
	await resolving.promise
	controller.abort()
	assert.deepEqual(await result, [])
	dns.resolve(true)
	await Promise.resolve()
	assert.equal(calls, 0)
})

test('assessment disposes a response arriving after cancellation', async () => {
	const controller = new AbortController()
	const started = deferred<void>()
	const response = deferred<Response>()
	const source = streamed([1])
	const result = fetchAssessmentImages(image, controller.signal, {
		isSafePublicHttpUrl: publicDns,
		fetch: () => {
			started.resolve()
			return response.promise
		},
	})
	await started.promise
	controller.abort()
	assert.deepEqual(await result, [])
	response.resolve(source.response)
	await Promise.resolve()
	assert.equal(source.cancelled(), true)
})

test('assessment keeps one absolute deadline across redirects', async t => {
	const deadline = new AbortController()
	let deadlines = 0
	t.mock.method(AbortSignal, 'timeout', () => {
		deadlines++
		return deadline.signal
	})
	const secondHop = deferred<void>()
	let calls = 0
	const result = fetchAssessmentImages(image, undefined, {
		isSafePublicHttpUrl: publicDns,
		fetch: async (_, init) => {
			assert.equal(init?.signal, deadline.signal)
			if (calls++ === 0) return streamed([1], { location: '/next.png' }, 302).response
			secondHop.resolve()
			return new Promise<Response>(() => {})
		},
	})
	await secondHop.promise
	deadline.abort()
	assert.deepEqual(await result, [])
	assert.equal(deadlines, 1)
	assert.equal(calls, 2)
})

test('assessment cancels the final redirect response at the existing hop bound', async () => {
	const responses: ReturnType<typeof streamed>[] = []
	assert.deepEqual(
		await fetchAssessmentImages(image, undefined, {
			isSafePublicHttpUrl: publicDns,
			fetch: async () => {
				const source = streamed([1], { location: '/again.png' }, 302)
				responses.push(source)
				return source.response
			},
		}),
		[],
	)
	assert.equal(responses.length, 4)
	assert(responses.every(source => source.cancelled() && source.reads() === 0))
})

test('assessment refuses unsupported media without consuming it and falls back on stream errors', async () => {
	const unsupported = streamed([1], { 'content-type': 'text/plain' })
	assert.deepEqual(
		await fetchAssessmentImages(context('https://images.example.test/no-extension'), undefined, {
			isSafePublicHttpUrl: publicDns,
			fetch: async () => unsupported.response,
		}),
		[],
	)
	assert.equal(unsupported.cancelled(), true)
	assert.equal(unsupported.reads(), 0)
	assert.deepEqual(
		await fetchAssessmentImages(image, undefined, {
			isSafePublicHttpUrl: publicDns,
			fetch: async () =>
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.error(new Error('broken body'))
						},
					}),
					{ headers: { 'content-type': 'image/png' } },
				),
		}),
		[],
	)
})

test('assessment pre-abort admits neither DNS nor download', async () => {
	const controller = new AbortController()
	controller.abort()
	assert.deepEqual(
		await fetchAssessmentImages(image, controller.signal, {
			isSafePublicHttpUrl: async () => {
				assert.fail('DNS admitted after abort')
			},
			fetch: async () => {
				assert.fail('fetch admitted after abort')
			},
		}),
		[],
	)
})
