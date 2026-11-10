import assert from 'node:assert/strict'
import test from 'node:test'
import { SlackApiError, SlackClient, SlackRateLimitError, SlackTransportError } from '../src/slack/web-api.js'

interface Call {
	url: string
	body: string
	cookie: string | null
	hasAuthHeader: boolean
}

function fakeFetch(handler: (call: Call) => { status?: number; headers?: Record<string, string>; json: unknown }) {
	const calls: Call[] = []
	const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
		const headers = new Headers(init.headers as HeadersInit)
		const call: Call = {
			url,
			body: String(init.body),
			cookie: headers.get('Cookie'),
			hasAuthHeader: headers.has('Authorization'),
		}
		calls.push(call)
		const result = handler(call)
		return new Response(JSON.stringify(result.json), {
			status: result.status ?? 200,
			headers: result.headers,
		})
	}
	return { calls, fetchImpl }
}

const creds = { token: 'xoxc-secret', cookie: 'xoxd-secret' }

test('web-api: posts token in body and d cookie in header, no auth header', async () => {
	const { calls, fetchImpl } = fakeFetch(() => ({ json: { ok: true, user: 'U1', team: 'T1' } }))
	const client = new SlackClient(creds, { fetch: fetchImpl })
	const result = await client.call<{ user: string }>('auth.test')
	assert.equal(result.user, 'U1')
	assert.equal(calls.length, 1)
	assert.match(calls[0].url, /slack\.com\/api\/auth\.test$/)
	assert.match(calls[0].body, /token=xoxc-secret/)
	assert.equal(calls[0].cookie, 'd=xoxd-secret')
	assert.equal(calls[0].hasAuthHeader, false)
})

test('web-api: ok:false maps to SlackApiError with the code', async () => {
	const { fetchImpl } = fakeFetch(() => ({ json: { ok: false, error: 'invalid_auth' } }))
	const client = new SlackClient(creds, { fetch: fetchImpl })
	await assert.rejects(client.call('auth.test'), (err: unknown) => {
		assert.ok(err instanceof SlackApiError)
		assert.equal(err.code, 'invalid_auth')
		return true
	})
})

test('web-api: 429 records a per-method backoff and the next call is refused locally', async () => {
	let fetches = 0
	const { fetchImpl } = fakeFetch(() => {
		fetches++
		return { status: 429, headers: { 'retry-after': '30' }, json: { ok: false, error: 'ratelimited' } }
	})
	let clock = 1_000
	const client = new SlackClient(creds, { fetch: fetchImpl, now: () => clock })
	await assert.rejects(client.call('conversations.history'), SlackRateLimitError)
	assert.equal(client.rateLimitRemaining('conversations.history'), 30_000)
	// Second call is refused without hitting the network.
	await assert.rejects(client.call('conversations.history'), SlackRateLimitError)
	assert.equal(fetches, 1)
	// A different method is unaffected.
	assert.equal(client.rateLimitRemaining('auth.test'), 0)
	// After the window, the block clears.
	clock += 30_000
	assert.equal(client.rateLimitRemaining('conversations.history'), 0)
})

test('web-api: ratelimited in body also backs off', async () => {
	const { fetchImpl } = fakeFetch(() => ({
		headers: { 'retry-after': '12' },
		json: { ok: false, error: 'ratelimited' },
	}))
	const client = new SlackClient(creds, { fetch: fetchImpl, now: () => 0 })
	await assert.rejects(client.call('search.messages'), SlackRateLimitError)
	assert.equal(client.rateLimitRemaining('search.messages'), 12_000)
})

test('web-api: non-JSON response is a transport error', async () => {
	const fetchImpl = async () => new Response('<html>nope</html>', { status: 200 })
	const client = new SlackClient(creds, { fetch: fetchImpl })
	await assert.rejects(client.call('auth.test'), SlackTransportError)
})

test('web-api: a non-loopback apiUrl override is ignored (token stays on slack.com)', async () => {
	const { calls, fetchImpl } = fakeFetch(() => ({ json: { ok: true } }))
	const client = new SlackClient(creds, { fetch: fetchImpl, apiUrl: 'https://evil.example.com/api/' })
	await client.call('auth.test')
	assert.match(calls[0].url, /^https:\/\/slack\.com\/api\//)
})

test('web-api: a loopback apiUrl override is honoured (for tests)', async () => {
	const { calls, fetchImpl } = fakeFetch(() => ({ json: { ok: true } }))
	const client = new SlackClient(creds, { fetch: fetchImpl, apiUrl: 'http://127.0.0.1:8099/api/' })
	await client.call('auth.test')
	assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:8099\/api\/auth\.test$/)
})
