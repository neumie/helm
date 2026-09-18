import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { RemoteAccess } from '../src/remote/access.js'
import { RemoteHost } from '../src/remote/host.js'
import { parseClaudeWindows, parseCodexWindows } from '../src/remote/provider-usage.js'
import { USAGE_HEADER, usageResponseSchema } from '../src/remote/usage-protocol.js'
import { type UsageEnvironment, readClaudeUsage, readCodexUsage } from '../src/remote/usage-sources.js'
import { RemoteUsage } from '../src/remote/usage.js'

const NOW = Date.parse('2026-09-18T18:00:00.000Z')

function scratch(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync('/tmp/hr-usage-'))
	chmodSync(root, 0o700)
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return root
}

/** The exact shape Anthropic returns for an OAuth usage read. */
function claudePayload(overrides: Record<string, unknown> = {}) {
	return {
		five_hour: { utilization: 23, resets_at: '2026-09-18T20:50:00.565433+00:00' },
		seven_day: { utilization: 14, resets_at: '2026-09-19T11:00:00.565455+00:00' },
		seven_day_opus: null,
		limits: [
			{ kind: 'session', group: 'session', percent: 23, resets_at: '2026-09-18T20:50:00.565433+00:00', scope: null },
			{ kind: 'weekly_all', group: 'weekly', percent: 14, resets_at: '2026-09-19T11:00:00.565455+00:00', scope: null },
			{
				kind: 'weekly_scoped',
				group: 'weekly',
				percent: 0,
				resets_at: '2026-09-19T11:00:00+00:00',
				scope: { model: { id: null, display_name: 'Fable' } },
				is_active: false,
			},
		],
		...overrides,
	}
}

function environment(overrides: Partial<UsageEnvironment> = {}): UsageEnvironment {
	return {
		home: '/nonexistent-home',
		fetch: (async () => {
			throw new Error('fetch was not expected')
		}) as unknown as typeof globalThis.fetch,
		now: () => NOW,
		keychain: async () => null,
		...overrides,
	}
}

function credentials(expiresAt: number, token = 'file-token', plan = 'max') {
	return JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt, subscriptionType: plan } })
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('Claude windows come from the limits array, keep their reset anchor, and hide unused scoped buckets', () => {
	const windows = parseClaudeWindows(claudePayload(), NOW)
	assert.deepEqual(
		windows.map(value => [value.label, value.usedPercent]),
		[
			['5-hour', 23],
			['Weekly', 14],
		],
	)
	const [session] = windows
	assert.equal(session?.resetsAt, Date.parse('2026-09-18T20:50:00.565433+00:00'))
	assert.equal(session?.windowSeconds, 5 * 3600)
	// 2h50m remain of a 5h window: 43% elapsed against 23% spent.
	assert.equal(Math.round(session?.elapsedPercent ?? 0), 43)

	const active = claudePayload({
		limits: [
			...claudePayload().limits.slice(0, 2),
			{
				kind: 'weekly_scoped',
				group: 'weekly',
				percent: 8,
				resets_at: '2026-09-19T11:00:00+00:00',
				scope: { model: { display_name: 'Fable' } },
				is_active: true,
			},
		],
	})
	assert.deepEqual(
		parseClaudeWindows(active, NOW).map(value => value.label),
		['5-hour', 'Weekly', 'Weekly · Fable'],
	)
})

test('an authoritative limits percentage overrides the tier utilization it shadows', () => {
	const windows = parseClaudeWindows(
		claudePayload({
			limits: [{ kind: 'session', group: 'session', percent: 61, resets_at: null, scope: null }],
		}),
		NOW,
	)
	assert.deepEqual(
		windows.map(value => [value.label, value.usedPercent]),
		[
			['5-hour', 61],
			['Weekly', 14],
		],
	)
	// A limit without its own anchor keeps the tier's reset point rather than losing it.
	assert.equal(windows[0]?.resetsAt, Date.parse('2026-09-18T20:50:00.565433+00:00'))
})

test('Codex live and on-disk spellings describe the same window', () => {
	const resetAt = Math.round((NOW + 3 * 3600 * 1000) / 1000)
	const live = parseCodexWindows(
		{ primary: { used_percent: 91, limit_window_seconds: 10080 * 60, reset_at: resetAt }, secondary: null },
		NOW,
	)
	const local = parseCodexWindows(
		{ primary: { used_percent: 91, window_minutes: 10080, resets_at: resetAt }, secondary: null },
		NOW,
	)
	assert.deepEqual(live, local)
	assert.deepEqual(
		live.map(value => [value.label, value.usedPercent, value.resetsAt]),
		[['Weekly', 91, resetAt * 1000]],
	)
	assert.deepEqual(parseCodexWindows({ primary: null, secondary: null }, NOW), [])
})

test('Claude credentials prefer the private file and fall back to the Keychain when it is expired', async t => {
	const home = scratch(t)
	mkdirSync(join(home, '.claude'))
	writeFileSync(join(home, '.claude', '.credentials.json'), credentials(NOW + 60_000))
	const seen: string[] = []
	const fetched = (async (_url: string, init: RequestInit) => {
		seen.push(String((init.headers as Record<string, string>).Authorization))
		return json(claudePayload())
	}) as unknown as typeof globalThis.fetch

	const fromFile = await readClaudeUsage(environment({ home, fetch: fetched }))
	assert.equal(fromFile.plan, 'max')
	assert.equal(fromFile.source, 'live')
	assert.equal(fromFile.windows.length, 2)

	writeFileSync(join(home, '.claude', '.credentials.json'), credentials(NOW - 1))
	const fromKeychain = await readClaudeUsage(
		environment({ home, fetch: fetched, keychain: async () => credentials(NOW + 60_000, 'keychain-token', 'pro') }),
	)
	assert.equal(fromKeychain.plan, 'pro')
	assert.deepEqual(seen, ['Bearer file-token', 'Bearer keychain-token'])

	const signedOut = await readClaudeUsage(environment({ home: join(home, 'missing') }))
	assert.deepEqual(signedOut.windows, [])
	assert.equal(signedOut.source, null)
	assert.match(signedOut.message ?? '', /Sign in to Claude Code/)
})

test('an unusable Claude response reports the status instead of inventing a percentage', async t => {
	const home = scratch(t)
	mkdirSync(join(home, '.claude'))
	writeFileSync(join(home, '.claude', '.credentials.json'), credentials(NOW + 60_000))
	const denied = await readClaudeUsage(
		environment({ home, fetch: (async () => json({ error: 'nope' }, 403)) as unknown as typeof globalThis.fetch }),
	)
	assert.deepEqual(denied.windows, [])
	assert.equal(denied.message, 'Anthropic returned 403.')
	assert.equal(denied.plan, 'max')
})

function writeRollout(home: string, day: string, name: string, usedPercent: number, timestamp: string) {
	const directory = join(home, '.codex', 'sessions', ...day.split('/'))
	mkdirSync(directory, { recursive: true })
	const noise = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', text: 'x'.repeat(2048) } })
	const event = JSON.stringify({
		type: 'event_msg',
		timestamp,
		payload: {
			type: 'token_count',
			rate_limits: {
				primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: Math.round(NOW / 1000) + 600 },
				secondary: null,
				plan_type: 'pro',
			},
		},
	})
	writeFileSync(join(directory, name), `${noise}\n${event}\n`)
}

test('Codex falls back to the newest on-disk snapshot without rotating the sign-in', async t => {
	const home = scratch(t)
	mkdirSync(join(home, '.codex'))
	writeFileSync(
		join(home, '.codex', 'auth.json'),
		JSON.stringify({ tokens: { access_token: 'codex-token', refresh_token: 'refresh', account_id: 'acct' } }),
	)
	writeRollout(home, '2026/09/14', 'rollout-2026-09-14T09-00-00-a.jsonl', 40, '2026-09-14T09:00:10.000Z')
	writeRollout(home, '2026/09/18', 'rollout-2026-09-18T15-16-28-b.jsonl', 91, '2026-09-18T13:16:37.497Z')
	const before = new Set<string>()
	const usage = await readCodexUsage(
		environment({
			home,
			fetch: (async (url: string, init: RequestInit) => {
				before.add(String((init.headers as Record<string, string>)['chatgpt-account-id']))
				assert.match(url, /backend-api\/codex\/usage/)
				return json({ error: 'forbidden' }, 403)
			}) as unknown as typeof globalThis.fetch,
		}),
	)
	assert.deepEqual([...before], ['acct'])
	assert.equal(usage.source, 'local')
	assert.equal(usage.plan, 'pro')
	assert.equal(usage.observedAt, Date.parse('2026-09-18T13:16:37.497Z'))
	assert.deepEqual(
		usage.windows.map(value => [value.label, value.usedPercent]),
		[['Weekly', 91]],
	)

	const live = await readCodexUsage(
		environment({
			home,
			fetch: (async () =>
				json({
					rate_limits: {
						primary: { used_percent: 12, limit_window_seconds: 18_000, reset_at: Math.round(NOW / 1000) + 60 },
						plan_type: 'pro',
					},
				})) as unknown as typeof globalThis.fetch,
		}),
	)
	assert.equal(live.source, 'live')
	assert.deepEqual(
		live.windows.map(value => [value.label, value.usedPercent]),
		[['5-hour', 12]],
	)
})

test('one cached read serves every device and a barren read is retried sooner than a healthy one', async () => {
	let reads = 0
	let now = NOW
	let windows = 0
	const usage = new RemoteUsage({
		now: () => now,
		ttlMs: 300_000,
		retryMs: 30_000,
		read: async () => {
			reads += 1
			await Promise.resolve()
			return [
				{
					id: 'codex' as const,
					name: 'Codex',
					plan: null,
					windows: Array.from({ length: windows }, () => ({
						label: 'Weekly',
						usedPercent: 91,
						resetsAt: null,
						windowSeconds: 604_800,
						elapsedPercent: null,
					})),
					source: windows ? ('live' as const) : null,
					observedAt: windows ? now : null,
					message: null,
				},
			]
		},
	})

	const [first, second] = await Promise.all([usage.providers(), usage.providers()])
	assert.equal(reads, 1)
	assert.deepEqual(first, second)
	now += 29_000
	await usage.providers()
	assert.equal(reads, 1, 'a barren read still holds for the retry window')
	now += 2_000
	windows = 1
	const refreshed = await usage.providers()
	assert.equal(reads, 2)
	assert.equal(refreshed.providers[0]?.windows.length, 1)
	now += 299_000
	await usage.providers()
	assert.equal(reads, 2, 'a healthy read is not refetched inside its lifetime')
})

test('a failed read keeps the last good answer rather than blanking the view', async () => {
	let fail = false
	const usage = new RemoteUsage({
		ttlMs: 0,
		retryMs: 0,
		read: async () => {
			if (fail) throw new Error('upstream down')
			return [
				{
					id: 'claude' as const,
					name: 'Claude Code',
					plan: 'max',
					windows: [{ label: '5-hour', usedPercent: 23, resetsAt: null, windowSeconds: 18_000, elapsedPercent: null }],
					source: 'live' as const,
					observedAt: NOW,
					message: null,
				},
			]
		},
	})
	const good = await usage.providers()
	fail = true
	assert.deepEqual(await usage.providers(), good)
})

test('usage is served to any admitted device, stays hidden without the feature header, and never polls upstream per request', async t => {
	const root = scratch(t)
	const access = new RemoteAccess(join(root, 'devices.json'))
	let reads = 0
	const usage = new RemoteUsage({
		read: async () => {
			reads += 1
			return [
				{
					id: 'claude' as const,
					name: 'Claude Code',
					plan: 'max',
					windows: [
						{ label: '5-hour', usedPercent: 23, resetsAt: NOW + 600_000, windowSeconds: 18_000, elapsedPercent: 43 },
					],
					source: 'live' as const,
					observedAt: NOW,
					message: null,
				},
			]
		},
	})
	const host = new RemoteHost({ origin: 'https://remote.example', access, usage })
	t.after(() => host.revoke())
	const pairing = access.createPairing('fixture', {
		personalCurrentAndFuture: true,
		scopeIds: [],
		operations: { read: true, prompt: false, interrupt: false, answer: false },
	})
	const device = access.redeem({ qrCapability: pairing.qrCapability })
	assert.ok(device)
	const request = (headers: Record<string, string> = {}) =>
		host.browser.request('/v1/usage', {
			headers: {
				Host: 'remote.example',
				Cookie: `__Host-helm-remote=${device.credential}`,
				[USAGE_HEADER]: '1',
				...headers,
			},
		})

	const response = await request()
	assert.equal(response.status, 200)
	assert.equal(response.headers.get(USAGE_HEADER), '1')
	const body = usageResponseSchema.parse(await response.json())
	assert.equal(body.providers[0]?.windows[0]?.usedPercent, 23)
	assert.notEqual(body.hostEpoch, randomUUID())

	assert.equal((await request()).status, 200)
	assert.equal(reads, 1, 'a second device read is served from the shared cache')
	assert.equal((await request({ [USAGE_HEADER]: '' })).status, 404)
	assert.equal(
		(await host.browser.request('/v1/usage', { headers: { Host: 'remote.example', [USAGE_HEADER]: '1' } })).status,
		401,
	)
})
