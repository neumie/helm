import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import type { UsageProvider } from '../src/remote/usage-protocol.js'
import {
	type UsageEnvironment,
	type UsageResult,
	defaultUsageEnvironment,
	readClaudeUsage,
	readCodexLocalUsage,
	readCodexUsage,
} from '../src/remote/usage-sources.js'
import { RemoteUsage } from '../src/remote/usage.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}

function scratch(t: { after(fn: () => void): void }): string {
	const root = realpathSync(mkdtempSync('/tmp/hr-usage-bound-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return root
}

function environment(home: string, overrides: Partial<UsageEnvironment> = {}): UsageEnvironment {
	return {
		home,
		now: () => 1_000,
		fetch: async () => {
			throw new Error('Unexpected fetch')
		},
		keychain: async () => null,
		request: async () => null,
		...overrides,
	}
}

function claudeHome(home: string): void {
	mkdirSync(join(home, '.claude'))
	writeFileSync(
		join(home, '.claude', '.credentials.json'),
		JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-only', subscriptionType: 'pro' } }),
	)
}

const claudeBody = JSON.stringify({ five_hour: { utilization: 23, resets_at: null } })
const provider: UsageProvider = {
	id: 'codex',
	name: 'Codex',
	plan: 'pro',
	windows: [],
	source: null,
	observedAt: null,
	message: null,
}

// No live credentials, account files, endpoints or Keychain are used by this suite.
test('shared refresh settles by absolute deadline, releases admission and ignores a late success', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const old = deferred<UsageProvider[]>()
	let reads = 0
	let signal: AbortSignal | undefined
	const usage = new RemoteUsage({
		timeoutMs: 25,
		now: () => 1_000,
		read: active => {
			signal = active
			reads += 1
			return reads === 1 ? old.promise : Promise.resolve([provider])
		},
	})
	const first = usage.providers()
	const joined = usage.providers()
	await Promise.resolve()
	assert.equal(reads, 1)
	t.mock.timers.tick(25)
	assert.deepEqual((await first).providers, [])
	assert.deepEqual(await joined, await first)
	assert.equal(signal?.aborted, true)
	assert.deepEqual((await usage.providers()).providers, [provider])
	old.resolve([{ ...provider, plan: 'stale' }])
	await Promise.resolve()
	assert.deepEqual((await usage.providers()).providers, [provider])
	assert.equal(reads, 2)
	usage.dispose()
})

test('dispose cancels a hung shared refresh without further reads or late cache publication', async () => {
	const old = deferred<UsageProvider[]>()
	let reads = 0
	let signal: AbortSignal | undefined
	const usage = new RemoteUsage({
		read: active => {
			reads += 1
			signal = active
			return old.promise
		},
	})
	const pending = usage.providers()
	await Promise.resolve()
	usage.dispose()
	assert.equal(signal?.aborted, true)
	assert.deepEqual((await pending).providers, [])
	old.resolve([provider])
	assert.deepEqual((await usage.providers()).providers, [])
	assert.equal(reads, 1)
})

test('late credential dependency cannot start fetch after provider cancellation', async t => {
	const home = scratch(t)
	const secret = deferred<string | null>()
	const entered = deferred<void>()
	const controller = new AbortController()
	let fetched = false
	const pending = readClaudeUsage(
		environment(home, {
			signal: controller.signal,
			keychain: () => {
				entered.resolve()
				return secret.promise
			},
			fetch: async () => {
				fetched = true
				return new Response(claudeBody)
			},
		}),
	)
	await entered.promise
	controller.abort()
	assert.equal((await pending).source, null)
	secret.resolve(JSON.stringify({ claudeAiOauth: { accessToken: 'late-fixture' } }))
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(fetched, false)
})

test('hung Codex request settles on cancellation and late failure never starts its retry', async t => {
	const home = scratch(t)
	mkdirSync(join(home, '.codex'))
	writeFileSync(
		join(home, '.codex', 'auth.json'),
		JSON.stringify({ tokens: { access_token: 'fixture', account_id: 'fixture' } }),
	)
	const response = deferred<UsageResult | null>()
	const entered = deferred<void>()
	const controller = new AbortController()
	let requests = 0
	const pending = readCodexUsage(
		environment(home, {
			signal: controller.signal,
			request: () => {
				requests += 1
				entered.resolve()
				return response.promise
			},
		}),
	)
	await entered.promise
	controller.abort()
	assert.equal((await pending).source, null)
	response.resolve({ status: 403, body: null })
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(requests, 1)
})

test('Claude actual bytes accept the exact cap and reject multibyte oversize despite understated headers', async t => {
	const home = scratch(t)
	claudeHome(home)
	const exact = `${claudeBody}${' '.repeat(64 * 1024 - Buffer.byteLength(claudeBody))}`
	assert.equal((await readClaudeUsage(environment(home, { fetch: async () => new Response(exact) }))).source, 'live')
	let cancelled = false
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(Buffer.from(claudeBody))
			controller.enqueue(Buffer.from('é'.repeat(33 * 1024)))
		},
		cancel() {
			cancelled = true
		},
	})
	const result = await readClaudeUsage(
		environment(home, { fetch: async () => new Response(stream, { headers: { 'Content-Length': '1' } }) }),
	)
	assert.equal(result.source, null)
	assert.equal(cancelled, true)
})

test('Claude stream errors and cancellation remain unavailable and cancel owned bodies', async t => {
	const home = scratch(t)
	claudeHome(home)
	const errored = await readClaudeUsage(
		environment(home, {
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error('truncated'))
						},
					}),
				),
		}),
	)
	assert.equal(errored.source, null)
	const controller = new AbortController()
	const reading = deferred<void>()
	let cancelled = false
	const pending = readClaudeUsage(
		environment(home, {
			signal: controller.signal,
			fetch: async () =>
				new Response(
					new ReadableStream({
						pull() {
							reading.resolve()
						},
						cancel() {
							cancelled = true
						},
					}),
				),
		}),
	)
	await reading.promise
	controller.abort()
	assert.equal((await pending).source, null)
	assert.equal(cancelled, true)
})

test('core HTTPS destroys oversized and truncated responses and an absolute deadline defeats trickle', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	let response: (EventEmitter & { statusCode: number; complete: boolean; destroy(): void }) | undefined
	let destroyed = false
	const replacement = ((_options: unknown, callback: (value: unknown) => void) => {
		const call = Object.assign(new EventEmitter(), {
			end() {
				response = Object.assign(new EventEmitter(), {
					statusCode: 200,
					complete: false,
					destroy() {
						destroyed = true
					},
				})
				callback(response)
			},
			destroy() {
				destroyed = true
			},
		})
		return call
	}) as unknown as typeof https.request
	t.mock.method(https, 'request', replacement)
	syncBuiltinESMExports()
	t.after(() => {
		t.mock.restoreAll()
		syncBuiltinESMExports()
	})
	const request = defaultUsageEnvironment().request
	const oversized = request('https://fixture.invalid/usage', {})
	await Promise.resolve()
	assert.ok(response)
	response.emit('data', Buffer.alloc(64 * 1024 + 1))
	assert.equal(await oversized, null)
	assert.equal(destroyed, true)
	const truncated = request('https://fixture.invalid/usage', {})
	await Promise.resolve()
	assert.ok(response)
	response.emit('data', Buffer.from(claudeBody))
	response.emit('end')
	assert.equal(await truncated, null)
	destroyed = false
	const trickle = request('https://fixture.invalid/usage', {})
	await Promise.resolve()
	for (let i = 0; i < 10; i += 1) {
		assert.ok(response)
		response.emit('data', Buffer.from(' '))
		t.mock.timers.tick(1_000)
	}
	assert.equal(await trickle, null)
	assert.equal(destroyed, true)
})

function rollout(directory: string, name = 'rollout.jsonl'): void {
	mkdirSync(directory, { recursive: true })
	writeFileSync(
		join(directory, name),
		`${JSON.stringify({
			type: 'event_msg',
			timestamp: '2026-09-18T12:00:00Z',
			payload: {
				type: 'token_count',
				rate_limits: { primary: { used_percent: 42, window_minutes: 10080 }, plan_type: 'pro' },
			},
		})}\n`,
	)
}

test('Codex fallback supports date partitions but refuses excessive depth and traversal entries', async t => {
	const normal = scratch(t)
	rollout(join(normal, '.codex', 'sessions', '2026', '09', '18'))
	assert.equal((await readCodexLocalUsage(environment(normal)))?.windows[0]?.usedPercent, 42)
	const deep = scratch(t)
	rollout(join(deep, '.codex', 'sessions', ...Array.from({ length: 17 }, () => 'd')))
	assert.equal(await readCodexLocalUsage(environment(deep)), null)
	const wide = scratch(t)
	const root = join(wide, '.codex', 'sessions')
	rollout(root)
	for (let i = 0; i < 1025; i += 1) mkdirSync(join(root, `empty-${i}`))
	assert.equal(
		await readCodexLocalUsage(environment(wide)),
		null,
		'incomplete discovery cannot publish even a matching root file',
	)
})

test('Codex fallback never follows directory/file links or parses more than 24 files', async t => {
	const home = scratch(t)
	const external = join(home, 'external')
	rollout(external)
	const root = join(home, '.codex', 'sessions')
	mkdirSync(root, { recursive: true })
	symlinkSync(external, join(root, 'linked-directory'))
	symlinkSync(join(external, 'rollout.jsonl'), join(root, 'linked.jsonl'))
	linkSync(join(external, 'rollout.jsonl'), join(root, 'hardlinked.jsonl'))
	assert.equal(await readCodexLocalUsage(environment(home)), null)
	rollout(root, '000-valid.jsonl')
	for (let i = 0; i < 24; i += 1) writeFileSync(join(root, `z-${String(i).padStart(2, '0')}.jsonl`), 'not JSON\n')
	assert.equal(await readCodexLocalUsage(environment(home)), null, '25th file remains outside parse budget')
})

test('a fetch that ignores cancellation has its late response disposed without publication', async t => {
	const home = scratch(t)
	claudeHome(home)
	const response = deferred<Response>()
	const entered = deferred<void>()
	const controller = new AbortController()
	let cancelled = false
	const pending = readClaudeUsage(
		environment(home, {
			signal: controller.signal,
			fetch: async () => {
				entered.resolve()
				return response.promise
			},
		}),
	)
	await entered.promise
	controller.abort()
	assert.equal((await pending).source, null)
	response.resolve(
		new Response(
			new ReadableStream({
				cancel() {
					cancelled = true
				},
			}),
		),
	)
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(cancelled, true)
})
