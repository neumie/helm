// `helm signal` (src/cli/signal.ts): a thin HTTP client of the daemon's /api/signals routes.
// Driven with injected deps and a fake fetch: no process, no daemon, no DB.

import assert from 'node:assert/strict'
import test from 'node:test'
import { getFromDaemon, postToDaemon, requestDaemon, resolveBaseUrl } from '../src/cli/daemon-http.js'
import { SIGNAL_HEARTBEAT_MS, buildSetBody, parseUntil, runSignalCli } from '../src/cli/signal.js'
import type {
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
