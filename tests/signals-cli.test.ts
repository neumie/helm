// `helm signal` (src/cli/signal.ts): a thin HTTP client of the daemon's /api/signals routes.
// Driven with injected deps and a fake fetch: no process, no daemon, no DB.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getFromDaemon, postToDaemon, requestDaemon, resolveBaseUrl } from '../src/cli/daemon-http.js'
import {
	BODY_FILE_MAX_BYTES,
	SIGNAL_HEARTBEAT_MS,
	buildSetBody,
	okenaTerminalLabel,
	okenaTerminalLookup,
	parseUntil,
	runSignalCli,
} from '../src/cli/signal.js'
import type {
	SignalAsk,
	SignalAskResult,
	SignalEvent,
	SignalFilteredPage,
	SignalSourceHealth,
	SignalThread,
	SignalsSnapshot,
} from '../src/signals/contract.js'
import { until } from './helpers/agent-dock.js'

const NOW = new Date('2026-11-05T10:00:00.000Z')
const BASE = 'http://daemon.test:7474'
const ENV = { HELM_URL: BASE } as NodeJS.ProcessEnv

function thread(overrides: Partial<SignalThread> & { id: number }): SignalThread {
	return {
		threadKey: `github:acme/widgets#${overrides.id}`,
		source: 'github',
		kind: 'review',
		reasons: ['review'],
		ref: `widgets#${overrides.id}`,
		fullRef: `acme/widgets#${overrides.id}`,
		title: 'Add a widget',
		head: 'review requested · alice',
		actor: 'alice',
		url: `https://github.com/acme/widgets/pull/${overrides.id}`,
		repo: 'acme/widgets',
		number: overrides.id,
		branch: 'feat/widget',
		state: 'new',
		owner: 'jakub',
		snoozedUntil: null,
		lastActivityAt: '2026-11-05T09:52:00.000Z',
		active: true,
		closedReason: null,
		note: null,
		noteAt: null,
		managedBy: null,
		routedAgent: null,
		routedHow: null,
		routedAt: null,
		body: null,
		links: [],
		askTerminal: null,
		reply: null,
		replyAt: null,
		createdAt: '2026-11-05T09:00:00.000Z',
		updatedAt: '2026-11-05T09:52:00.000Z',
		...overrides,
	}
}

const okSources: SignalSourceHealth[] = [
	{ source: 'github', status: 'ok', detail: null, lastPollAt: '2026-11-05T09:58:00.000Z', lastOkAt: null },
	{ source: 'mail', status: 'disabled', detail: null, lastPollAt: null, lastOkAt: null },
]

function snapshot(threads: SignalThread[], sources = okSources, seq = 41): SignalsSnapshot {
	return { threads, sources, seq, generatedAt: NOW.toISOString() }
}

interface Call {
	method: string
	url: string
	body: unknown
}

type Route = (call: Call, init: RequestInit) => Response | Promise<Response>

/** A fake daemon: records calls; `route` answers (throw → unreachable). */
function fakeDaemon(route: Route) {
	const calls: Call[] = []
	const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const call = {
			method: init.method ?? 'GET',
			url: String(input),
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		}
		calls.push(call)
		return route(call, init)
	}) as typeof globalThis.fetch
	return { calls, fetch }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })

function capture(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
	const out: string[] = []
	const err: string[] = []
	return {
		out,
		err,
		deps: {
			out: (line: string) => void out.push(line),
			err: (line: string) => void err.push(line),
			env: ENV,
			fetch,
			now: () => NOW,
			...extra,
		},
	}
}

// ---------------------------------------------------------------------------
// daemon-http
// ---------------------------------------------------------------------------

test('daemon-http keeps the base URL precedence and the envelope contract', async t => {
	assert.equal(resolveBaseUrl(['--url', 'http://cli:1/'], { HELM_URL: 'http://env:2' }), 'http://cli:1')
	assert.equal(resolveBaseUrl([], { HELM_URL: 'http://env:2//' }), 'http://env:2')
	assert.equal(resolveBaseUrl([], { VIGIL_URL: 'http://legacy:3' }), 'http://legacy:3')
	assert.equal(resolveBaseUrl([], {}), 'http://localhost:7474')
	assert.throws(() => resolveBaseUrl(['--url'], {}), { message: 'Missing value for --url' })

	const daemon = fakeDaemon(call =>
		call.url.endsWith('/bad') ? json({ error: 'Nope' }, 400) : json({ method: call.method, body: call.body }),
	)
	assert.deepEqual(await getFromDaemon(BASE, '/ok', { fetch: daemon.fetch }), { method: 'GET' })
	assert.deepEqual(await postToDaemon(BASE, '/ok', { a: 1 }, { fetch: daemon.fetch }), {
		method: 'POST',
		body: { a: 1 },
	})
	await assert.rejects(requestDaemon('POST', BASE, '/bad', { fetch: daemon.fetch }), {
		name: 'DaemonHttpError',
		message: 'Nope',
	})
	await assert.rejects(
		getFromDaemon(BASE, '/x', {
			fetch: (async () => {
				throw new Error('connect ECONNREFUSED')
			}) as typeof fetch,
		}),
		{ name: 'DaemonUnreachableError', message: /Could not reach the Helm daemon at http:\/\/daemon\.test:7474/ },
	)
	// The global fetch is still the default (tests mock it).
	t.mock.method(globalThis, 'fetch', async () => new Response('Internal Server Error', { status: 500 }))
	await assert.rejects(postToDaemon(BASE, '/api/items', {}), {
		message: 'Helm daemon error 500: Internal Server Error',
	})
})

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

test('ls prints health, then Needs you / Managed / Snoozed rows', async () => {
	const threads = [
		thread({ id: 12 }),
		thread({
			id: 14,
			kind: 'ci',
			state: 'seen',
			owner: 'managed',
			head: 'CI failing · build',
			note: 'fixing lint',
			managedBy: 'widgets-ci',
			lastActivityAt: '2026-11-05T08:55:00.000Z',
		}),
		thread({
			id: 9,
			state: 'snoozed',
			snoozedUntil: '2026-11-06T08:00:00.000Z',
			lastActivityAt: '2026-11-04T08:00:00.000Z',
		}),
		thread({ id: 3, state: 'done', closedReason: 'no longer open or requested', active: false }),
	]
	const daemon = fakeDaemon(() => json(snapshot(threads)))
	const run = capture(daemon.fetch)
	assert.equal(await runSignalCli(['ls'], run.deps), 0)
	assert.equal(daemon.calls[0]?.url, `${BASE}/api/signals`)
	const text = run.out.join('\n')
	const lines = text.split('\n')
	assert.equal(lines[0], 'github ok · polled 2m ago')
	assert.equal(lines[1], 'mail disabled')
	assert.equal(lines[2], 'NEEDS YOU')
	assert.match(lines[3] ?? '', /^ {2}#12 {2}new {6}review {2}widgets#12 {2}review requested · alice {2}8m$/)
	assert.equal(lines[4], 'MANAGED')
	assert.match(lines[5] ?? '', /#14 {2}seen .*CI failing · build {2}1h05 {2}→ fixing lint \(widgets-ci\)$/)
	assert.equal(lines[6], 'SNOOZED')
	assert.match(lines[7] ?? '', /#9 {3}snoozed .* until (Thu|Fri) \d\d:00$/)
	assert.doesNotMatch(text, /DONE|#3 /, 'done rows only with --all or --state done')
	assert.deepEqual(run.err, [])
})

test('ls --all shows done rows; filters reach the query string', async () => {
	const daemon = fakeDaemon(() =>
		json(snapshot([thread({ id: 3, state: 'done', closedReason: 'no longer open or requested', active: false })])),
	)
	const run = capture(daemon.fetch)
	assert.equal(
		await runSignalCli(
			['ls', '--all', '--owner', 'jakub', '--state', 'done,new', '--source', 'github', '--url', 'http://other:1/'],
			run.deps,
		),
		0,
	)
	assert.equal(daemon.calls[0]?.url, 'http://other:1/api/signals?owner=jakub&state=done%2Cnew&source=github&all=1')
	assert.match(run.out.join('\n'), /DONE\n {2}#3 .*\(no longer open or requested\)/)
})

test('ls never reports all-clear while a source is down', async () => {
	const sources: SignalSourceHealth[] = [
		okSources[0] as SignalSourceHealth,
		{
			source: 'mail',
			status: 'needs_permission',
			detail: 'Allow node to control Mail',
			lastPollAt: null,
			lastOkAt: null,
		},
	]
	const down = capture(fakeDaemon(() => json(snapshot([], sources))).fetch)
	assert.equal(await runSignalCli(['ls'], down.deps), 0)
	assert.match(down.out[0] ?? '', /mail needs permission: Allow node to control Mail/)
	assert.match(down.out[0] ?? '', /NEEDS YOU: unknown \(mail not ok\)/)
	assert.doesNotMatch(down.out[0] ?? '', /nothing/)

	const quiet = capture(fakeDaemon(() => json(snapshot([]))).fetch)
	assert.equal(await runSignalCli(['ls'], quiet.deps), 0)
	assert.match(quiet.out[0] ?? '', /NEEDS YOU: nothing/)
})

const filteredPage: SignalFilteredPage = {
	total: 3,
	retentionDays: 7,
	entries: [
		{
			id: 21,
			source: 'mail',
			senderName: 'Petra',
			senderAddress: 'petra_at_psyon_example_aa_bb@privaterelay.appleid.com',
			senderIdentity: 'petra@psyon.example',
			subject: 'Out of office\u202e',
			reason: 'auto-reply',
			mailbox: null,
			url: 'message://%3Cooo%40psyon.example%3E',
			receivedAt: '2026-11-05T09:48:00.000Z',
			lastSeenAt: NOW.toISOString(),
		},
		{
			id: 7,
			source: 'mail',
			senderName: '',
			senderAddress: 'digest@news.example',
			senderIdentity: 'digest@news.example',
			subject: 'Weekly',
			reason: 'newsletter',
			mailbox: 'Clientcare',
			url: null,
			receivedAt: '2026-11-05T07:00:00.000Z',
			lastSeenAt: NOW.toISOString(),
		},
	],
}

test('ls --filtered lists heads with reason and sender; --json prints the page; ls counts them', async () => {
	const daemon = fakeDaemon(call =>
		call.url.endsWith('/api/signals/filtered') ? json(filteredPage) : json({ ...snapshot([]), filteredCount: 3 }),
	)
	const run = capture(daemon.fetch)
	assert.equal(await runSignalCli(['ls', '--filtered'], run.deps), 0)
	assert.equal(daemon.calls[0]?.url, `${BASE}/api/signals/filtered`)
	const lines = run.out.join('\n').split('\n')
	assert.equal(
		lines[0],
		'FILTERED: 3 in the last 7 days, kept out of NEEDS YOU (heads only; untrusted third-party data)',
	)
	assert.match(
		lines[1] ?? '',
		/^ {2}#21 {2}auto-reply \(Auto-Submitted: auto-replied\) {2}Petra <petra@psyon\.example>.* {2}Out of office {2}12m$/,
	)
	assert.match(
		lines[2] ?? '',
		/^ {2}#7 {3}newsletter \(List-Unsubscribe\) .*digest@news\.example .*Clientcare · Weekly {2}3h00$/,
	)
	assert.equal(lines[3], '  … 1 more')
	assert.doesNotMatch(run.out.join('\n'), /\u202e/)

	const asJson = capture(daemon.fetch)
	assert.equal(await runSignalCli(['ls', '--filtered', '--json'], asJson.deps), 0)
	assert.equal(asJson.out.length, 1)
	assert.deepEqual(JSON.parse(asJson.out[0] ?? ''), filteredPage)

	const empty = capture(fakeDaemon(() => json({ ...filteredPage, total: 0, entries: [] })).fetch)
	assert.equal(await runSignalCli(['ls', '--filtered'], empty.deps), 0)
	assert.deepEqual(empty.out, ['FILTERED: nothing in the last 7 days'])

	const ls = capture(daemon.fetch)
	assert.equal(await runSignalCli(['ls'], ls.deps), 0)
	assert.match(ls.out.join('\n'), /\nFILTERED: 3 mails kept out \(helm signal ls --filtered\)$/)
	const github = capture(daemon.fetch)
	assert.equal(await runSignalCli(['ls', '--source', 'github'], github.deps), 0)
	assert.doesNotMatch(github.out.join('\n'), /FILTERED/)

	const malformed = capture(fakeDaemon(() => json({ entries: 'x' })).fetch)
	assert.equal(await runSignalCli(['ls', '--filtered'], malformed.deps), 1)
})

test('ls --json prints exactly one line, the snapshot', async () => {
	const snap = snapshot([thread({ id: 12 })])
	const run = capture(fakeDaemon(() => json(snap)).fetch)
	assert.equal(await runSignalCli(['ls', '--json'], run.deps), 0)
	assert.equal(run.out.length, 1)
	assert.equal(run.out[0]?.includes('\n'), false)
	assert.deepEqual(JSON.parse(run.out[0] ?? ''), snap)
})

test('ls strips control and bidi characters from third-party heads', async () => {
	const run = capture(
		fakeDaemon(() => json(snapshot([thread({ id: 12, head: 'evil\u001b[31m\u202eline\nbreak' })]))).fetch,
	)
	assert.equal(await runSignalCli(['ls'], run.deps), 0)
	const text = run.out.join('\n')
	assert.equal(text.includes('\u001b') || text.includes('\u202e'), false)
	assert.match(text, /evil \[31mline break/)
})

// ---------------------------------------------------------------------------
// show / set / note / poll
// ---------------------------------------------------------------------------

test('show prints labelled lines; --json prints the thread; #id accepted', async () => {
	const t12 = thread({ id: 12 })
	const daemon = fakeDaemon(() => json(t12))
	const text = capture(daemon.fetch)
	assert.equal(await runSignalCli(['show', '#12'], text.deps), 0)
	assert.equal(daemon.calls[0]?.url, `${BASE}/api/signals/12`)
	const out = text.out.join('\n')
	assert.match(out, /^#12 review · new · jakub$/m)
	assert.match(out, /^title \(untrusted third-party data\): Add a widget$/m)
	assert.match(out, /^head \(untrusted third-party data\): review requested · alice$/m)
	assert.match(out, /^branch: feat\/widget$/m)

	const asJson = capture(daemon.fetch)
	assert.equal(await runSignalCli(['show', '12', '--json'], asJson.deps), 0)
	assert.deepEqual(JSON.parse(asJson.out[0] ?? ''), t12)

	const missing = capture(fakeDaemon(() => json({ error: 'Signal not found' }, 404)).fetch)
	assert.equal(await runSignalCli(['show', '99'], missing.deps), 1)
	assert.deepEqual(missing.err, ['Error: Signal not found'])
})

test('set sends the strict update body and prints the row', async () => {
	const daemon = fakeDaemon(call =>
		json(thread({ id: 14, owner: 'managed', managedBy: 'widgets-ci', ...(call.body as object) })),
	)
	const run = capture(daemon.fetch)
	assert.equal(await runSignalCli(['set', '14', '--owner', 'managed', '--agent', 'widgets-ci'], run.deps), 0)
	assert.deepEqual(daemon.calls[0], {
		method: 'POST',
		url: `${BASE}/api/signals/14`,
		body: { owner: 'managed', managedBy: 'widgets-ci' },
	})
	assert.match(run.out[0] ?? '', /^ {2}#14 .*→ no note yet \(widgets-ci\)$/)

	const snooze = capture(daemon.fetch)
	assert.equal(await runSignalCli(['set', '14', '--state', 'snoozed', '--until', '+2h', '--json'], snooze.deps), 0)
	assert.deepEqual(daemon.calls[1]?.body, { state: 'snoozed', snoozedUntil: '2026-11-05T12:00:00.000Z' })
	assert.equal(JSON.parse(snooze.out[0] ?? '').id, 14)

	const clear = capture(daemon.fetch)
	assert.equal(await runSignalCli(['set', '14', '--no-agent', '--state', 'done'], clear.deps), 0)
	assert.deepEqual(daemon.calls[2]?.body, { state: 'done', managedBy: null })
})

test('note posts the outcome line; poll posts a request', async () => {
	const daemon = fakeDaemon(call =>
		call.url.endsWith('/poll')
			? json({ requested: true })
			: json(thread({ id: 14, owner: 'managed', note: (call.body as { note: string }).note })),
	)
	const run = capture(daemon.fetch)
	assert.equal(await runSignalCli(['note', '14', 'Fixed lint in #315'], run.deps), 0)
	assert.deepEqual(daemon.calls[0], {
		method: 'POST',
		url: `${BASE}/api/signals/14/note`,
		body: { note: 'Fixed lint in #315' },
	})
	assert.match(run.out[0] ?? '', /→ Fixed lint in #315$/)

	const dashed = capture(daemon.fetch)
	assert.equal(await runSignalCli(['note', '14', '--json', '--', '-x is fixed'], dashed.deps), 0)
	assert.deepEqual(daemon.calls[1]?.body, { note: '-x is fixed' })

	const poll = capture(daemon.fetch)
	assert.equal(await runSignalCli(['poll'], poll.deps), 0)
	assert.deepEqual(daemon.calls[2], { method: 'POST', url: `${BASE}/api/signals/poll`, body: undefined })
	assert.deepEqual(poll.out, ['Poll requested.'])
})

test('usage errors exit 1 before any request', async () => {
	const daemon = fakeDaemon(() => json({}))
	const cases: string[][] = [
		['frob'],
		['ls', '--bogus'],
		['ls', '--state', 'later'],
		['ls', '--owner', 'bob'],
		['ls', '--until', '+1h'],
		['show'],
		['show', 'abc'],
		['show', '0'],
		['set', '12'],
		['set', '12', '--state', 'snoozed'],
		['set', '12', '--until', '+1h'],
		['set', '12', '--agent', 'a', '--no-agent'],
		['set', '12', '--state', 'snoozed', '--until', 'yesterday'],
		['note', '12'],
		['note', '12', 'a', 'b'],
		['note', '12', 'x'.repeat(301)],
		['watch', '--after', '-1'],
		['watch', '--after', 'x'],
		['ls', '--filtered', '--state', 'new'],
		['ls', '--filtered', '--owner', 'jakub'],
		['ls', '--filtered', '--source', 'mail'],
		['ls', '--filtered', '--all'],
	]
	for (const args of cases) {
		const run = capture(daemon.fetch)
		assert.equal(await runSignalCli(args, run.deps), 1, args.join(' '))
		assert.match(run.err[0] ?? '', /Run helm signal help\.$/, args.join(' '))
	}
	assert.equal(daemon.calls.length, 0)
	const help = capture(daemon.fetch)
	assert.equal(await runSignalCli([], help.deps), 0)
	assert.match(help.out[0] ?? '', /^Usage: helm signal <command>/)
})

test('--until parsing', () => {
	const now = new Date(2026, 10, 5, 14, 30) // local Thu 14:30
	assert.equal(parseUntil('+30m', now), new Date(now.getTime() + 30 * 60_000).toISOString())
	assert.equal(parseUntil('+1d', now), new Date(now.getTime() + 86_400_000).toISOString())
	assert.equal(parseUntil('tomorrow', now), new Date(2026, 10, 6, 9, 0).toISOString())
	assert.equal(parseUntil('2026-11-09', now), new Date(2026, 10, 9, 9, 0).toISOString())
	assert.equal(parseUntil('2026-11-09T08:15:00Z', now), '2026-11-09T08:15:00.000Z')
	for (const bad of ['+0h', '+2w', 'soon', '2026-02-30', '2026-11-05T10:00:00Z', '2020-01-01'])
		assert.throws(() => parseUntil(bad, now), Error, bad)
	assert.throws(() => buildSetBody(new Map(), new Set(), now), /set needs/)
})

test('--until rejects impossible calendar dates and times instead of rolling them over', () => {
	const now = new Date(2026, 10, 5, 14, 30)
	// Date.parse alone would roll 2027-02-31 over to 3 March.
	for (const bad of [
		'2027-02-31T09:00',
		'2027-02-29T09:00Z',
		'2027-13-01T09:00',
		'2027-00-10T09:00',
		'2027-04-31T09:00:00Z',
		'2027-01-10T24:00',
		'2027-01-10T09:60',
		'2027-01-10T09:00:60Z',
	])
		assert.throws(() => parseUntil(bad, now), /--until must be an ISO time/, bad)
	assert.equal(parseUntil('2028-02-29T09:00:00Z', now), '2028-02-29T09:00:00.000Z')
	assert.equal(parseUntil('2027-01-31T23:59+01:00', now), '2027-01-31T22:59:00.000Z')
	const run = capture(fakeDaemon(() => json({})).fetch)
	return runSignalCli(['set', '12', '--state', 'snoozed', '--until', '2027-02-31T09:00'], run.deps).then(code => {
		assert.equal(code, 1)
		assert.match(run.err[0] ?? '', /--until must be an ISO time[\s\S]*Run helm signal help\.$/)
	})
})

// ---------------------------------------------------------------------------
// interruption and deadlines
// ---------------------------------------------------------------------------

test('Ctrl-C aborts a hung ls/show/set/note/poll request and exits 130', async () => {
	const commands: string[][] = [['ls'], ['show', '12'], ['set', '12', '--state', 'seen'], ['note', '12', 'x'], ['poll']]
	for (const args of commands) {
		const daemon = fakeDaemon((_call, init) => holdUntilAbort(init))
		const controller = new AbortController()
		const run = capture(daemon.fetch, { signal: controller.signal })
		const running = runSignalCli(args, run.deps)
		await until(() => daemon.calls.length === 1, `${args[0]} request`)
		controller.abort()
		assert.equal(await running, 130, args.join(' '))
		assert.deepEqual(run.err, [], args.join(' '))
		assert.deepEqual(run.out, [], args.join(' '))
	}
})

test('a daemon that never answers times out non-watch commands with exit 1', async () => {
	for (const args of [['ls'], ['poll'], ['set', '12', '--owner', 'managed']]) {
		const daemon = fakeDaemon((_call, init) => holdUntilAbort(init))
		const run = capture(daemon.fetch, { requestTimeoutMs: 20 })
		assert.equal(await runSignalCli(args, run.deps), 1, args.join(' '))
		assert.match(
			run.err[0] ?? '',
			/^Error: The Helm daemon at http:\/\/daemon\.test:7474 did not answer .* within 20 ms/,
		)
	}
})

test('watch: a stuck long poll times out, reports once, and keeps watching', async () => {
	let polls = 0
	const daemon = fakeDaemon((call, init) => {
		if (!call.url.includes('/events')) return json(snapshot([], okSources, 3))
		polls++
		if (polls <= 2) return holdUntilAbort(init)
		if (polls === 3) return json({ events: [event(4)], seq: 4 })
		return holdUntilAbort(init)
	})
	const controller = new AbortController()
	const run = capture(daemon.fetch, { signal: controller.signal, pollMs: 5, eventsTimeoutMs: 20 })
	const running = runSignalCli(['watch'], run.deps)
	await until(() => run.out.some(line => line.includes('"event"')), 'event after timeouts')
	controller.abort()
	assert.equal(await running, 0)
	assert.equal(run.err.length, 1, 'the same timeout is reported once')
	assert.match(
		run.err[0] ?? '',
		/^signal watch: The Helm daemon .* did not answer GET \/api\/signals\/events within 20 ms/,
	)
})

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

function event(seq: number, overrides: Partial<SignalEvent> = {}): SignalEvent {
	return { seq, threadId: 12, type: 'activity', detail: { owner: 'jakub' }, at: NOW.toISOString(), ...overrides }
}

/** Long-poll fake: answers queued pages, else holds until the request aborts. */
function holdUntilAbort(init: RequestInit): Promise<Response> {
	return new Promise((_, reject) => {
		const signal = init.signal
		if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
		signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
	})
}

test('watch: catch-up, events after the cursor, owner filter, abort exits 0', async () => {
	const pages: SignalEvent[][] = [
		[
			event(42),
			event(43, { threadId: 14, type: 'note', detail: { owner: 'managed', note: 'done' } }),
			event(44, { threadId: 14, type: 'owner', detail: { owner: 'jakub', from: 'managed', to: 'jakub' } }),
			event(45, { threadId: 20, type: 'created', detail: {} }),
		],
	]
	const daemon = fakeDaemon((call, init) => {
		if (call.url === `${BASE}/api/signals?owner=managed`)
			return json(
				snapshot([
					thread({ id: 14, owner: 'managed' }),
					thread({ id: 15, owner: 'managed', state: 'done' }),
					thread({ id: 12 }),
				]),
			)
		if (call.url === `${BASE}/api/signals/20`) return json(thread({ id: 20, owner: 'managed' }))
		const page = pages.shift()
		return page ? json({ events: page, seq: page.at(-1)?.seq ?? 0 }) : holdUntilAbort(init)
	})
	const controller = new AbortController()
	const run = capture(daemon.fetch, { signal: controller.signal, pollMs: 5 })
	const running = runSignalCli(['watch', '--owner', 'managed', '--after', '41'], run.deps)
	await until(() => run.out.length >= 4, 'events')
	const lines = run.out.map(line => JSON.parse(line))
	assert.deepEqual(lines[0], { t: 'catchup', seq: 41, at: NOW.toISOString(), open: [14] })
	assert.deepEqual(
		lines.slice(1).map(line => [line.t, line.seq]),
		[
			['event', 43],
			['event', 44],
			['event', 45],
		],
		'jakub-only activity dropped; owner change from managed kept; detail-less event resolved lazily',
	)
	await until(() => daemon.calls.some(call => call.url.includes('after=45&wait=20')), 'next long poll')
	controller.abort()
	assert.equal(await running, 0)
	assert.deepEqual(run.err, [])
})

test('watch: the cursor follows events, and jumps to page.seq only on an empty page', async () => {
	// The daemon's page.seq may be its GLOBAL high-water mark (seqs span profiles).
	let polls = 0
	const daemon = fakeDaemon((call, init) => {
		if (!call.url.includes('/events')) return json(snapshot([], okSources, 40))
		polls++
		if (polls === 1) return json({ events: [event(42), event(44)], seq: 99 })
		if (polls === 2) return json({ events: [event(50)], seq: 99 })
		if (polls === 3) return json({ events: [], seq: 120 })
		return holdUntilAbort(init)
	})
	const controller = new AbortController()
	const run = capture(daemon.fetch, { signal: controller.signal, pollMs: 5 })
	const running = runSignalCli(['watch'], run.deps)
	await until(() => polls >= 4, 'fourth long poll')
	controller.abort()
	assert.equal(await running, 0)
	assert.deepEqual(
		daemon.calls.filter(call => call.url.includes('/events')).map(call => new URL(call.url).searchParams.get('after')),
		['40', '44', '50', '120'],
	)
	assert.deepEqual(
		run.out.map(line => JSON.parse(line)).map(line => [line.t, line.seq]),
		[
			['catchup', 40],
			['event', 42],
			['event', 44],
			['event', 50],
		],
	)
})

test('watch: daemon offline once, retries, online again, heartbeat', async () => {
	let clock = NOW.getTime()
	let phase: 'up' | 'down' = 'up'
	let polls = 0
	const daemon = fakeDaemon((call, init) => {
		if (phase === 'down') throw new TypeError('fetch failed')
		if (!call.url.includes('/events')) return json(snapshot([thread({ id: 12 })], okSources, 7))
		polls++
		if (polls === 1) {
			phase = 'down'
			throw new TypeError('fetch failed')
		}
		if (polls === 2) return json({ events: [event(8)], seq: 8 })
		if (polls === 3) {
			clock += SIGNAL_HEARTBEAT_MS
			return json({ events: [], seq: 8 })
		}
		return holdUntilAbort(init)
	})
	const controller = new AbortController()
	const run = capture(daemon.fetch, { signal: controller.signal, pollMs: 5, now: () => new Date(clock) })
	const running = runSignalCli(['watch'], run.deps)
	await until(() => run.out.some(line => line.includes('daemon-offline')), 'offline')
	// Several failed retries stay a single offline line.
	await until(() => daemon.calls.length >= 4, 'retries')
	phase = 'up'
	await until(() => run.out.some(line => line.includes('heartbeat')), 'heartbeat')
	controller.abort()
	assert.equal(await running, 0)
	const types = run.out.map(line => JSON.parse(line).t)
	assert.deepEqual(types, ['catchup', 'daemon-offline', 'daemon-online', 'event', 'heartbeat'])
	assert.equal(JSON.parse(run.out[0] ?? '').seq, 7)
	assert.equal(JSON.parse(run.out[4] ?? '').seq, 8)
})

test('watch: daemon down at start waits for it; abort while offline exits 0', async () => {
	const daemon = fakeDaemon(() => {
		throw new TypeError('fetch failed')
	})
	const controller = new AbortController()
	const run = capture(daemon.fetch, { signal: controller.signal, pollMs: 5 })
	const running = runSignalCli(['watch'], run.deps)
	await until(() => daemon.calls.length >= 3, 'retries')
	controller.abort()
	assert.equal(await running, 0)
	assert.deepEqual(
		run.out.map(line => JSON.parse(line).t),
		['daemon-offline'],
	)
})

// ---------------------------------------------------------------------------
// agent asks: add / done / ls / show
// ---------------------------------------------------------------------------

const TERMINAL = '62e79683-4314-48ae-b687-e6c3e1ff8a30'
const STORY_1 = 'http://localhost:6006/?path=/story/views-signals-agent-asks--title-rows'
const STORY_2 = 'http://localhost:6006/?path=/story/views-signals-agent-asks--body-line'

function ask(overrides: Partial<SignalThread> & { id: number }): SignalThread {
	return thread({
		threadKey: `agent:ask-${overrides.id}`,
		source: 'agent',
		kind: 'ask',
		reasons: ['ask'],
		ref: 'dispatcher',
		fullRef: 'dispatcher · Okena terminal',
		title: 'Pick the row layout',
		head: 'Pick the row layout',
		actor: 'dispatcher',
		url: null,
		repo: null,
		number: null,
		branch: null,
		body: 'Both are in Storybook.\nReply 1 or 2.',
		links: [STORY_1, STORY_2],
		askTerminal: TERMINAL,
		...overrides,
	})
}

/** A daemon answering asks routes: echoes the posted ask as a thread with `outcome`. */
function askDaemon(outcome: SignalAskResult['outcome'] = 'created') {
	return fakeDaemon(call => {
		const posted = (call.body ?? {}) as Partial<SignalAsk>
		return json({
			outcome,
			thread: ask({
				id: 12,
				title: posted.title ?? 'x',
				head: posted.title ?? 'x',
				ref: posted.from ?? 'agent',
				body: posted.body ?? null,
				links: posted.links ?? [],
				askTerminal: posted.terminal ?? null,
				choices: posted.choices ?? [],
				...(posted.kind === 'answer' ? { kind: 'answer' as const, reasons: ['answer' as const] } : {}),
				lastActivityAt: NOW.toISOString(),
			}),
		})
	})
}

test('add sends every option, the terminal and the --from looked up in Okena', async () => {
	const daemon = askDaemon()
	const lookups: string[] = []
	const run = capture(daemon.fetch, {
		env: { ...ENV, OKENA_TERMINAL_ID: TERMINAL.toUpperCase() },
		okenaTerminalName: async (id: string) => {
			lookups.push(id)
			return 'Signals asks'
		},
	})
	const args = [
		'add',
		'--title',
		'  Pick the row layout  ',
		'--body',
		' Both are in Storybook.\nReply 1 or 2. ',
		'--link',
		STORY_1,
		'--link',
		STORY_2,
		'--key',
		'signals-row-layout',
	]
	assert.equal(await runSignalCli(args, run.deps), 0)
	assert.deepEqual(lookups, [TERMINAL])
	assert.deepEqual(daemon.calls, [
		{
			method: 'POST',
			url: `${BASE}/api/signals/asks`,
			body: {
				key: 'signals-row-layout',
				title: 'Pick the row layout',
				body: 'Both are in Storybook.\nReply 1 or 2.',
				links: [STORY_1, STORY_2],
				from: 'Signals asks',
				terminal: TERMINAL,
			},
		},
	])
	assert.deepEqual(run.err, [])
	const [head, row] = (run.out[0] ?? '').split('\n')
	assert.equal(head, 'created #12')
	assert.match(row ?? '', /^ {2}#12 {2}new {2}ask {2}Signals asks {2}Pick the row layout {2}0s$/)
})

test('add: an explicit --from wins (the terminal is still sent); no terminal → "agent"', async () => {
	const daemon = askDaemon()
	let lookedUp = false
	const named = capture(daemon.fetch, {
		env: { ...ENV, OKENA_TERMINAL_ID: TERMINAL },
		okenaTerminalName: async () => {
			lookedUp = true
			return 'never used'
		},
	})
	assert.equal(await runSignalCli(['add', '--title', 'Merge #314?', '--from', 'ci-bot'], named.deps), 0)
	assert.equal(lookedUp, false)
	assert.deepEqual(daemon.calls[0]?.body, { title: 'Merge #314?', from: 'ci-bot', terminal: TERMINAL })

	// No (or a malformed) terminal id: no lookup, no terminal, from "agent".
	for (const env of [ENV, { ...ENV, OKENA_TERMINAL_ID: 'not-a-terminal' }]) {
		const plain = capture(daemon.fetch, {
			env,
			okenaTerminalName: async () => {
				lookedUp = true
				return 'x'
			},
		})
		assert.equal(await runSignalCli(['add', '--title', 'Merge #314?'], plain.deps), 0)
		assert.deepEqual(daemon.calls.at(-1)?.body, { title: 'Merge #314?', from: 'agent' })
	}
	assert.equal(lookedUp, false)

	// A lookup that finds nothing (or fails) falls back to "agent" but keeps the terminal.
	for (const lookup of [async () => null, async () => Promise.reject(new Error('boom')), async () => ' ‮ ']) {
		const fallback = capture(daemon.fetch, { env: { ...ENV, OKENA_TERMINAL_ID: TERMINAL }, okenaTerminalName: lookup })
		assert.equal(await runSignalCli(['add', '--title', 'Merge #314?'], fallback.deps), 0)
		assert.deepEqual(daemon.calls.at(-1)?.body, { title: 'Merge #314?', from: 'agent', terminal: TERMINAL })
	}
})

test('okenaTerminalLabel: the name, or the project for an unnamed terminal', () => {
	const list = JSON.stringify([
		{ terminal_id: TERMINAL, name: TERMINAL, project_id: 'p', project_name: 'helm' },
		{ terminal_id: '00529b76-aa85-4007-8692-b836e6349f83', name: 'Signals\u001b asks', project_name: 'helm' },
	])
	assert.equal(okenaTerminalLabel(list, TERMINAL.toUpperCase()), 'helm')
	assert.equal(okenaTerminalLabel(list, '00529b76-aa85-4007-8692-b836e6349f83'), 'Signals asks')
	assert.equal(okenaTerminalLabel(list, 'ffffffff-aa85-4007-8692-b836e6349f83'), null)
	assert.equal(okenaTerminalLabel('not json', TERMINAL), null)
	assert.equal(okenaTerminalLabel('{"terminal_id":1}', TERMINAL), null)
})

test('add --terminal files the ask for another open Okena terminal, named after it', async () => {
	const OTHER = 'b2b3a76c-45fd-4d9e-b766-b7455b1723e0'
	const list = JSON.stringify([
		{ terminal_id: TERMINAL, name: 'dispatcher', project_name: 'vault' },
		{ terminal_id: OTHER, name: 'VOS sloty', project_name: 'psyon' },
	])
	const daemon = askDaemon()
	let lists = 0
	let named = 0
	const deps = (output: string | null | (() => Promise<string | null>)) =>
		capture(daemon.fetch, {
			// The dispatcher runs in its own terminal; --terminal wins over it.
			env: { ...ENV, OKENA_TERMINAL_ID: TERMINAL },
			okenaTerminalName: async () => {
				named += 1
				return 'dispatcher'
			},
			okenaTerminalList:
				typeof output === 'function'
					? output
					: async () => {
							lists += 1
							return output
						},
		})
	const ok = deps(list)
	assert.equal(
		await runSignalCli(['add', '--title', 'Approve the slots?', '--terminal', OTHER.toUpperCase(), '--json'], ok.deps),
		0,
	)
	assert.deepEqual(daemon.calls.at(-1)?.body, { title: 'Approve the slots?', from: 'VOS sloty', terminal: OTHER })
	assert.equal(JSON.parse(ok.out[0] ?? '{}').outcome, 'created')
	// An explicit --from still wins.
	const from = deps(list)
	assert.equal(await runSignalCli(['add', '--title', 'T', '--terminal', OTHER, '--from', 'dispatcher'], from.deps), 0)
	assert.deepEqual(daemon.calls.at(-1)?.body, { title: 'T', from: 'dispatcher', terminal: OTHER })
	assert.equal(named, 0, 'the env terminal is never looked up with --terminal')
	assert.equal(lists, 2)

	const calls = daemon.calls.length
	const refused = async (args: string[], output: Parameters<typeof deps>[0], message: RegExp) => {
		const run = deps(output)
		assert.equal(await runSignalCli(args, run.deps), 1, args.join(' '))
		assert.match(run.err.join('\n'), message)
	}
	await refused(['add', '--title', 'T', '--terminal', 'pane-1'], list, /--terminal must be an Okena terminal id/)
	await refused(
		['add', '--title', 'T', '--terminal', 'ffffffff-aa85-4007-8692-b836e6349f83'],
		list,
		/Okena has no open terminal ffffffff-aa85-4007-8692-b836e6349f83/,
	)
	await refused(['add', '--title', 'T', '--terminal', OTHER], null, /could not list Okena terminals/)
	await refused(['add', '--title', 'T', '--terminal', OTHER], 'not json', /could not list Okena terminals/)
	await refused(
		['add', '--title', 'T', '--terminal', OTHER],
		() => Promise.reject(new Error('boom')),
		/could not list Okena terminals/,
	)
	await refused(['done', '1', '--terminal', OTHER], list, /--terminal/)
	assert.equal(daemon.calls.length, calls, 'nothing was filed')
})

test('okenaTerminalLookup: listed or not, with its label; null for unreadable output', () => {
	const list = JSON.stringify([{ terminal_id: TERMINAL, name: TERMINAL, project_name: '' }])
	assert.deepEqual(okenaTerminalLookup(list, TERMINAL), { listed: true, label: null })
	assert.deepEqual(okenaTerminalLookup(list, 'ffffffff-aa85-4007-8692-b836e6349f83'), { listed: false })
	assert.equal(okenaTerminalLookup('{}', TERMINAL), null)
})

test('add: outcomes in words, --json prints the result on one line', async () => {
	for (const [outcome, head] of [
		['created', 'created #12'],
		['renewed', 'renewed #12 (new again)'],
		['updated', 'updated #12'],
		['unchanged', 'unchanged #12'],
	] as const) {
		const run = capture(askDaemon(outcome).fetch)
		assert.equal(await runSignalCli(['add', '--title', 'Merge #314?', '--key', 'merge-314'], run.deps), 0)
		assert.equal(run.out[0]?.split('\n')[0], head)
	}
	const run = capture(askDaemon('renewed').fetch)
	assert.equal(await runSignalCli(['add', '--title', 'Merge #314?', '--json'], run.deps), 0)
	assert.equal(run.out.length, 1)
	assert.equal(run.out[0]?.includes('\n'), false)
	const result = JSON.parse(run.out[0] ?? '') as SignalAskResult
	assert.equal(result.outcome, 'renewed')
	assert.equal(result.thread.id, 12)

	const old = capture(fakeDaemon(() => json(ask({ id: 12 }))).fetch)
	assert.equal(await runSignalCli(['add', '--title', 'x'], old.deps), 1)
	assert.match(old.err[0] ?? '', /sent no ask result/)
})

test('add refuses bad input before any request', async () => {
	const daemon = fakeDaemon(() => json({}))
	let lookups = 0
	const cases: string[][] = [
		['add'],
		['add', 'Merge #314?'],
		['add', '--title', '   '],
		['add', '--title', 'one\ntwo'],
		['add', '--title', 'x'.repeat(201)],
		['add', '--title', 'x', '--body', 'b'.repeat(1001)],
		['add', '--title', 'x', '--body', Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n')],
		['add', '--title', 'x', '--link', 'javascript:alert(1)'],
		['add', '--title', 'x', '--link', 'https://user:pw@example.com/'],
		['add', '--title', 'x', '--link', '/relative/path'],
		['add', '--title', 'x', '--link', 'https://evil.com\\.github.com/x'],
		['add', '--title', 'x', '--link', 'http:evil.com'],
		['add', '--title', 'x', '--link', 'https:/\\evil.com'],
		['add', '--title', 'x', '--link', 'https:///evil.com'],
		['add', '--title', 'x', '--body', Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\u2028')],
		['add', '--title', 'x', '--body', Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\u2029')],
		['add', '--title', 'x', ...Array.from({ length: 9 }, (_, i) => ['--link', `https://example.com/${i}`]).flat()],
		['add', '--title', 'x', '--key', 'has space'],
		['add', '--title', 'x', '--key', '-leading'],
		['add', '--title', 'x', '--body', 'b', '--body-file', '/tmp/x'],
		['add', '--title', 'x', '--title', 'y'],
		['add', '--title', 'x', '--from', ''],
		['add', '--title', 'x', '--from', 'a\nb'],
		['add', '--title', 'x', '--bogus'],
		['add', '--title', 'x', '--link'],
		['add', '--title', 'x', '--note', 'n'],
		['ls', '--link', 'https://example.com/'],
		['show', '12', '--link', 'https://example.com/'],
		['set', '12', '--title', 'x'],
		['done'],
		['done', '12', '--key', 'k'],
		['done', '12', '13'],
		['done', '--key', 'bad key'],
		['done', '12', '--note', ' '],
		['done', '12', '--note', 'n'.repeat(301)],
		['done', '12', '--link', 'https://example.com/'],
	]
	for (const args of cases) {
		const run = capture(daemon.fetch, {
			env: { ...ENV, OKENA_TERMINAL_ID: TERMINAL },
			okenaTerminalName: async () => {
				lookups++
				return 'name'
			},
		})
		assert.equal(await runSignalCli(args, run.deps), 1, args.join(' '))
		assert.match(run.err[0] ?? '', /Run helm signal help\.$/, args.join(' '))
	}
	assert.equal(daemon.calls.length, 0)
	assert.equal(lookups, 0, 'a bad call never runs Okena')
})

test('add counts body lines as the store keeps them', async () => {
	const daemon = askDaemon()
	// Twelve lines once blank runs collapse and leading/trailing blank lines drop: accepted.
	const lines = Array.from({ length: 11 }, (_, i) => `line ${i}`)
	const body = `\n\u2028 \u0007\n${lines.slice(0, 5).join('\u2028')}\n\n\u202e\n${lines.slice(5).join('\u2029')}\r\n\n`
	const run = capture(daemon.fetch)
	assert.equal(await runSignalCli(['add', '--title', 'x', '--body', body], run.deps), 0, run.err.join('\n'))
	assert.equal(daemon.calls.length, 1)
	// A thirteenth line separated by U+2028 is refused before any request.
	const over = capture(daemon.fetch)
	assert.equal(await runSignalCli(['add', '--title', 'x', '--body', `${body}\u2028line 12`], over.deps), 1)
	assert.match(over.err[0] ?? '', /Run helm signal help\.$/)
	assert.equal(daemon.calls.length, 1)
})

test('add: a refused ask (429, too many open) prints the daemon message', async () => {
	const message = 'Too many open agent asks and answers (50). Close some with helm signal done.'
	const daemon = fakeDaemon(() => json({ error: message }, 429))
	const run = capture(daemon.fetch)
	assert.equal(await runSignalCli(['add', '--title', 'One too many'], run.deps), 1)
	assert.equal(daemon.calls.length, 1)
	assert.equal(run.out.length, 0)
	assert.ok((run.err[0] ?? '').includes(message), run.err.join('\n'))
})

test('add --body-file reads a file or stdin, bounded and UTF-8 only', async t => {
	const dir = mkdtempSync(join(tmpdir(), 'hs-cli-'))
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const file = join(dir, 'body.md')
	writeFileSync(file, '﻿Both variants are in Storybook.\n\nReply 1 or 2.\n')
	const daemon = askDaemon()
	const fromFile = capture(daemon.fetch)
	assert.equal(await runSignalCli(['add', '--title', 'Pick one', '--body-file', file], fromFile.deps), 0)
	assert.deepEqual(daemon.calls[0]?.body, {
		title: 'Pick one',
		body: 'Both variants are in Storybook.\n\nReply 1 or 2.',
		from: 'agent',
	})

	const asked: number[] = []
	const fromStdin = capture(daemon.fetch, {
		readStdin: async (max: number) => {
			asked.push(max)
			return Buffer.from('Merge now?\nCI is green.\n')
		},
	})
	assert.equal(await runSignalCli(['add', '--title', 'Merge #314?', '--body-file', '-'], fromStdin.deps), 0)
	assert.deepEqual(asked, [BODY_FILE_MAX_BYTES])
	assert.deepEqual(daemon.calls[1]?.body, { title: 'Merge #314?', body: 'Merge now?\nCI is green.', from: 'agent' })

	// Too big, not UTF-8, a directory, a missing file: refused, nothing sent.
	const big = join(dir, 'big.md')
	writeFileSync(big, 'x'.repeat(BODY_FILE_MAX_BYTES + 1))
	const binary = join(dir, 'binary.bin')
	writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0x41]))
	for (const [path, message] of [
		[big, /larger than 64 KiB/],
		[binary, /not UTF-8 text/],
		[dir, /not a regular file/],
		[join(dir, 'missing.md'), /Could not read --body-file .*ENOENT/],
	] as const) {
		const run = capture(daemon.fetch)
		assert.equal(await runSignalCli(['add', '--title', 'x', '--body-file', path], run.deps), 1, path)
		assert.match(run.err[0] ?? '', message, path)
	}
	const huge = capture(daemon.fetch, { readStdin: async (max: number) => Buffer.alloc(max + 1, 0x61) })
	assert.equal(await runSignalCli(['add', '--title', 'x', '--body-file', '-'], huge.deps), 1)
	assert.match(huge.err[0] ?? '', /stdin is larger than 64 KiB/)
	assert.equal(daemon.calls.length, 2)
})

test('done by id, by --key, with --note, --json', async () => {
	const daemon = fakeDaemon(call =>
		json(
			ask({
				id: 12,
				state: 'done',
				closedReason: 'closed by the agent',
				note: (call.body as { note?: string }).note ?? null,
			}),
		),
	)
	const byId = capture(daemon.fetch)
	assert.equal(await runSignalCli(['done', '#12'], byId.deps), 0)
	assert.deepEqual(daemon.calls[0], { method: 'POST', url: `${BASE}/api/signals/12/done`, body: {} })
	assert.match(
		byId.out[0] ?? '',
		/^ {2}#12 {2}done {2}ask {2}dispatcher {2}Pick the row layout .*\(closed by the agent\)$/,
	)

	const noted = capture(daemon.fetch)
	assert.equal(await runSignalCli(['done', '12', '--note', ' Jakub picked 2; built it '], noted.deps), 0)
	assert.deepEqual(daemon.calls[1]?.body, { note: 'Jakub picked 2; built it' })

	const byKey = capture(daemon.fetch)
	assert.equal(
		await runSignalCli(['done', '--key', 'signals-row-layout', '--note', 'Built variant 2', '--json'], byKey.deps),
		0,
	)
	assert.deepEqual(daemon.calls[2], {
		method: 'POST',
		url: `${BASE}/api/signals/asks/done`,
		body: { key: 'signals-row-layout', note: 'Built variant 2' },
	})
	assert.equal(byKey.out.length, 1)
	assert.equal(JSON.parse(byKey.out[0] ?? '').state, 'done')

	const missing = capture(fakeDaemon(() => json({ error: 'Signal not found' }, 404)).fetch)
	assert.equal(await runSignalCli(['done', '--key', 'nope'], missing.deps), 1)
	assert.deepEqual(missing.err, ['Error: Signal not found'])
})

test('ls shows an ask row: from, title, and whether the reply reached the agent', async () => {
	const threads = [
		ask({ id: 21, lastActivityAt: '2026-11-05T09:58:00.000Z' }),
		ask({
			id: 22,
			state: 'seen',
			reply: 'Variant 2',
			replyAt: '2026-11-05T09:55:00.000Z',
			routedAgent: 'Signals asks',
			routedHow: 'replied',
			routedAt: '2026-11-05T09:55:01.000Z',
			lastActivityAt: '2026-11-05T09:50:00.000Z',
		}),
		ask({
			id: 23,
			state: 'seen',
			reply: 'No',
			replyAt: '2026-11-05T09:45:00.000Z',
			// A route left from an earlier reply does not deliver this one.
			routedAgent: 'Signals asks',
			routedHow: 'replied',
			routedAt: '2026-11-05T09:30:00.000Z',
			lastActivityAt: '2026-11-05T09:20:00.000Z',
		}),
	]
	const daemon = fakeDaemon(() => json(snapshot(threads, [])))
	const run = capture(daemon.fetch)
	assert.equal(await runSignalCli(['ls', '--source', 'agent'], run.deps), 0)
	assert.equal(daemon.calls[0]?.url, `${BASE}/api/signals?source=agent`)
	const lines = run.out.join('\n').split('\n')
	assert.equal(lines[0], 'NEEDS YOU', 'asks need no poller health')
	assert.match(lines[1] ?? '', /^ {2}#21 {2}new {3}ask {2}dispatcher {2}Pick the row layout {2}2m$/)
	assert.match(lines[2] ?? '', /#22 .*Pick the row layout {2}10m {2}→ replied Signals asks 5m ago$/)
	assert.match(lines[3] ?? '', /#23 .*Pick the row layout {2}40m {2}\(answered, not delivered\)$/)

	const empty = capture(fakeDaemon(() => json(snapshot([], []))).fetch)
	assert.equal(await runSignalCli(['ls', '--source', 'agent'], empty.deps), 0)
	assert.equal(empty.out[0], 'NEEDS YOU: nothing')
})

test('show prints an ask: body, links, terminal, reply and its delivery, all stripped', async () => {
	const delivered = ask({
		id: 22,
		state: 'seen',
		title: 'Pick‮ the row',
		body: 'Both are in Storybook.\n\u001b[31mReply 1 or 2.',
		reply: 'Variant 2,\nbut with the dim line.',
		replyAt: '2026-11-05T09:55:00.000Z',
		routedAgent: 'Signals asks',
		routedHow: 'replied',
		routedAt: '2026-11-05T09:55:01.000Z',
	})
	const run = capture(fakeDaemon(() => json(delivered)).fetch)
	assert.equal(await runSignalCli(['show', '22'], run.deps), 0)
	const out = run.out.join('\n')
	assert.equal(out.includes('\u001b') || out.includes('‮'), false)
	assert.match(out, /^title \(written by an agent, untrusted\): Pick the row$/m)
	assert.match(out, /^body \(written by an agent, untrusted\):\n {2}Both are in Storybook\.\n {2}\[31mReply 1 or 2\.$/m)
	assert.ok(out.includes(`links:\n  ${STORY_1}\n  ${STORY_2}\n`))
	assert.match(out, new RegExp(`^terminal: ${TERMINAL}$`, 'm'))
	assert.match(out, /^reply \(Jakub's answer\):\n {2}Variant 2,\n {2}but with the dim line\.\nreply at: .*\(5m ago\)$/m)
	assert.match(out, /^reply delivered: yes, typed into Signals asks 5m ago$/m)

	const saved = capture(
		fakeDaemon(() =>
			json(ask({ id: 23, body: null, links: [], askTerminal: null, reply: 'No', replyAt: NOW.toISOString() })),
		).fetch,
	)
	assert.equal(await runSignalCli(['show', '23'], saved.deps), 0)
	const savedOut = saved.out.join('\n')
	assert.match(savedOut, /^body \(written by an agent, untrusted\): -$/m)
	assert.match(savedOut, /^links: -$/m)
	assert.match(savedOut, /^terminal: -$/m)
	assert.match(savedOut, /^reply delivered: no: read it here$/m)

	const open = capture(fakeDaemon(() => json(ask({ id: 21 }))).fetch)
	assert.equal(await runSignalCli(['show', '21'], open.deps), 0)
	assert.match(open.out.join('\n'), /^reply: -$/m)
	// GitHub threads keep their third-party labels and print no ask fields.
	const gh = capture(fakeDaemon(() => json(thread({ id: 12 }))).fetch)
	assert.equal(await runSignalCli(['show', '12'], gh.deps), 0)
	assert.doesNotMatch(gh.out.join('\n'), /^(body|links|terminal|reply)/m)
})

// ---------------------------------------------------------------------------
// answers (`helm signal answer`, `add --kind answer`)
// ---------------------------------------------------------------------------

test('answer files an answer: kind answer, named after the terminal, but no terminal sent', async () => {
	const daemon = askDaemon()
	const lookups: string[] = []
	const run = capture(daemon.fetch, {
		env: { ...ENV, OKENA_TERMINAL_ID: TERMINAL },
		okenaTerminalName: async (id: string) => {
			lookups.push(id)
			return 'dispatcher'
		},
	})
	const args = [
		'answer',
		'--title',
		'Proxy blocks Remote',
		'--body',
		'It is the corporate proxy.',
		'--key',
		'remote-proxy',
	]
	assert.equal(await runSignalCli(args, run.deps), 0)
	assert.deepEqual(lookups, [TERMINAL], 'the terminal still names the answer')
	assert.deepEqual(daemon.calls[0]?.body, {
		kind: 'answer',
		key: 'remote-proxy',
		title: 'Proxy blocks Remote',
		body: 'It is the corporate proxy.',
		from: 'dispatcher',
	})
	const [head, row] = (run.out[0] ?? '').split('\n')
	assert.equal(head, 'created #12')
	assert.match(row ?? '', /^ {2}#12 {2}new {2}answer {2}dispatcher {2}Proxy blocks Remote {2}0s$/)

	// `add --kind answer` is the same request; `--kind ask` (and no --kind) is an ask.
	const viaAdd = capture(daemon.fetch)
	assert.equal(await runSignalCli(['add', '--kind', 'answer', '--title', 'Proxy blocks Remote'], viaAdd.deps), 0)
	assert.deepEqual(daemon.calls.at(-1)?.body, { kind: 'answer', title: 'Proxy blocks Remote', from: 'agent' })
	assert.equal(await runSignalCli(['add', '--kind', 'ask', '--title', 'Merge?'], viaAdd.deps), 0)
	assert.deepEqual(daemon.calls.at(-1)?.body, { title: 'Merge?', from: 'agent' })
})

test('answer refuses --terminal, a bad --kind, and allows a longer body than an ask', async () => {
	const daemon = askDaemon()
	const refuse = async (args: string[], pattern: RegExp) => {
		const run = capture(daemon.fetch)
		assert.equal(await runSignalCli(args, run.deps), 1, args.join(' '))
		assert.match(run.err.join('\n'), pattern)
	}
	await refuse(['answer', '--title', 'x', '--terminal', TERMINAL], /Unknown option --terminal|--terminal/)
	await refuse(['add', '--kind', 'answer', '--title', 'x', '--terminal', TERMINAL], /An answer takes no reply/)
	await refuse(['add', '--kind', 'reply', '--title', 'x'], /--kind/)
	await refuse(['answer', '--kind', 'ask', '--title', 'x'], /--kind/)
	await refuse(['answer'], /answer requires --title/)
	await refuse(['answer', 'stray', '--title', 'x'], /answer takes no arguments/)
	assert.equal(daemon.calls.length, 0, 'nothing reaches the daemon')

	// 2000 characters and 30 lines: too long for an ask, fine for an answer.
	const long = Array.from({ length: 30 }, (_, i) => `Line ${i}: ${'x'.repeat(58)}`).join('\n')
	await refuse(['add', '--title', 'x', '--body', long], /at most 1000 characters/)
	const ok = capture(daemon.fetch)
	assert.equal(await runSignalCli(['answer', '--title', 'x', '--body', long], ok.deps), 0)
	assert.equal((daemon.calls.at(-1)?.body as SignalAsk).body, long)
	await refuse(['answer', '--title', 'x', '--body', 'y'.repeat(4001)], /at most 4000 characters/)
	await refuse(
		['answer', '--title', 'x', '--body', Array.from({ length: 61 }, (_, i) => `l${i}`).join('\n')],
		/at most 60 lines/,
	)
})

test('ls tells asks from answers by kind; show says an answer takes no reply', async () => {
	const threads = [
		ask({ id: 21, lastActivityAt: '2026-11-05T09:58:00.000Z' }),
		ask({
			id: 24,
			kind: 'answer',
			reasons: ['answer'],
			title: 'Proxy blocks Remote',
			head: 'Proxy blocks Remote',
			askTerminal: null,
			links: [],
			lastActivityAt: '2026-11-05T09:56:00.000Z',
		}),
	]
	const run = capture(fakeDaemon(() => json(snapshot(threads, []))).fetch)
	assert.equal(await runSignalCli(['ls', '--source', 'agent'], run.deps), 0)
	const lines = run.out.join('\n').split('\n')
	assert.equal(lines[0], 'NEEDS YOU')
	assert.match(lines[1] ?? '', /^ {2}#21 {2}new {2}ask {5}dispatcher {2}Pick the row layout {2}2m$/)
	assert.match(lines[2] ?? '', /^ {2}#24 {2}new {2}answer {2}dispatcher {2}Proxy blocks Remote {2}4m$/)

	const shown = capture(
		fakeDaemon(() =>
			json(ask({ id: 24, kind: 'answer', reasons: ['answer'], askTerminal: null, body: 'Line one\nLine two' })),
		).fetch,
	)
	assert.equal(await runSignalCli(['show', '24'], shown.deps), 0)
	const out = shown.out.join('\n')
	assert.match(out, /^#24 answer · new · jakub$/m)
	assert.match(out, /^body \(written by an agent, untrusted\):\n {2}Line one\n {2}Line two$/m)
	assert.match(out, /^reply: none \(an answer takes no reply\)$/m)
	assert.doesNotMatch(out, /^terminal:/m)
})

test('add --choice sends quick answers; refused on answers and when malformed; show lists them', async () => {
	const daemon = askDaemon()
	const run = capture(daemon.fetch)
	assert.equal(await runSignalCli(['add', '--title', 'Zkrácení?', '--choice', ' Ano ', '--choice', 'Ne'], run.deps), 0)
	assert.deepEqual(daemon.calls.at(-1)?.body, { title: 'Zkrácení?', choices: ['Ano', 'Ne'], from: 'agent' })
	const before = daemon.calls.length
	for (const [args, pattern] of [
		[['answer', '--title', 'x', '--choice', 'Ok'], /--choice/],
		[['add', '--kind', 'answer', '--title', 'x', '--choice', 'Ok'], /An answer takes no reply, so no --choice/],
		[['add', '--title', 'x', '--choice', ''], /--choice must be 1 to 80/],
		[['add', '--title', 'x', '--choice', 'y'.repeat(81)], /--choice must be 1 to 80/],
		[['add', '--title', 'x', '--choice', 'a\nb'], /--choice is one line/],
		[
			['add', '--title', 'x', ...['1', '2', '3', '4', '5', '6', '7'].flatMap(c => ['--choice', c])],
			/At most 6 --choice/,
		],
	] as const) {
		const refused = capture(daemon.fetch)
		assert.equal(await runSignalCli([...args], refused.deps), 1, args.join(' '))
		assert.match(refused.err.join('\n'), pattern)
	}
	assert.equal(daemon.calls.length, before, 'nothing reaches the daemon')

	const shown = capture(fakeDaemon(() => json(ask({ id: 25, choices: ['Ano', 'Ne\u202e'] }))).fetch)
	assert.equal(await runSignalCli(['show', '25'], shown.deps), 0)
	assert.match(shown.out.join('\n'), /^choices:\n {2}1\. Ano\n {2}2\. Ne$/m)
	const none = capture(fakeDaemon(() => json(ask({ id: 26 }))).fetch)
	assert.equal(await runSignalCli(['show', '26'], none.deps), 0)
	assert.match(none.out.join('\n'), /^choices: -$/m)
})
