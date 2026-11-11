// Signals column, Electron main side (app/src/signals-main.ts): the daemon is polled only
// while a window shows the column, pushes are deduplicated, only github.com / Mail links
// open, Okena parent projects map to GitHub repos, `n` starts a worktree + Claude
// through the Okena CLI with a private, short-lived prompt file, an answer to an agent ask
// is passed to the daemon and an ask's link opens only as main re-reads it. Every exec is a fake:
// these tests never run gh, git, Okena or Mail.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import signalsMainModule from '../app/src/signals-main.ts'

type SignalsMainModule = typeof import('../app/src/signals-main.ts')
type SignalsBridgeState = import('../app/src/shared.ts').SignalsBridgeState
type SignalsSnapshot = import('../app/src/shared-helm.ts').SignalsSnapshot
type SignalThread = import('../app/src/shared-helm.ts').SignalThread
type SignalsExec = import('../app/src/signals-main.ts').SignalsExec
type SignalsRequest = import('../app/src/signals-main.ts').SignalsRequest
const {
	SignalsMain,
	createSignalsDaemonRequest,
	githubRepoFromRemote,
	signalOpenableUrl,
	resolveOkenaBinary,
	SIGNALS_POLL_MS,
} = signalsMainModule as SignalsMainModule

const TOKEN = 'work:1'
const WINDOW = { id: 1 }
const PARENT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NEW_TERMINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function snapshot(head: string, generatedAt = '2026-11-05T09:00:00.000Z'): SignalsSnapshot {
	return {
		threads: [
			{
				id: 1,
				threadKey: 'github:acme/widgets#7',
				source: 'github',
				kind: 'review',
				reasons: ['review'],
				ref: 'widgets#7',
				fullRef: 'acme/widgets#7',
				title: 'Example change',
				head,
				actor: 'reviewer-a',
				url: 'https://github.com/acme/widgets/pull/7',
				repo: 'acme/widgets',
				number: 7,
				branch: 'feat/example',
				state: 'new',
				owner: 'jakub',
				snoozedUntil: null,
				lastActivityAt: '2026-11-05T08:00:00.000Z',
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
				createdAt: '2026-11-05T08:00:00.000Z',
				updatedAt: '2026-11-05T08:00:00.000Z',
			},
		],
		sources: [{ source: 'github', status: 'ok', detail: null, lastPollAt: null, lastOkAt: null }],
		seq: 3,
		generatedAt,
	}
}

class ManualTimers {
	next = 1
	pending = new Map<number, { callback: () => void; ms: number }>()
	setTimeout = (callback: () => void, ms: number) => {
		const id = this.next++
		this.pending.set(id, { callback, ms })
		return id
	}
	clearTimeout = (handle: unknown) => {
		this.pending.delete(handle as number)
	}
	fire(): number {
		const entries = [...this.pending.entries()]
		this.pending.clear()
		for (const [, entry] of entries) entry.callback()
		return entries.length
	}
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

interface Harness {
	main: InstanceType<typeof SignalsMain>
	calls: Array<{ method: string; path: string; body?: unknown }>
	published: SignalsBridgeState[]
	timers: ManualTimers
	clock: { now: number }
	respond: { result: () => unknown }
	token: { value: string }
}

function harness(options: { readOnly?: boolean; exec?: SignalsExec; userDataDir?: string } = {}): Harness {
	const calls: Harness['calls'] = []
	const published: SignalsBridgeState[] = []
	const timers = new ManualTimers()
	const clock = { now: 1_000_000 }
	const respond: Harness['respond'] = { result: () => ({ data: snapshot('review requested · reviewer-a') }) }
	const token = { value: TOKEN }
	const request = (async (method: 'GET' | 'POST', path: string, body?: unknown) => {
		calls.push({ method, path, ...(body === undefined ? {} : { body }) })
		if (method === 'POST' && path === '/signals/poll') return { data: { requested: true } }
		if (method === 'POST') return { data: { id: 1 } }
		return respond.result()
	}) as SignalsRequest
	const main = new SignalsMain({
		request,
		acceptsIpc: (sender, profileToken) => sender === WINDOW && profileToken === token.value,
		publish: state => published.push(state),
		exec:
			options.exec ??
			(async () => {
				throw new Error('no exec expected')
			}),
		openExternal: async () => undefined,
		userDataDir: options.userDataDir ?? join(tmpdir(), 'helm-signals-unused'),
		okenaBin: '/fake/okena',
		readOnly: options.readOnly ?? false,
		readOnlyError: 'read-only run',
		now: () => clock.now,
		timers,
		env: { PATH: '/usr/bin', GIT_DIR: '/elsewhere' },
	})
	return { main, calls, published, timers, clock, respond, token }
}

test('polls only while visible, asks sources once per 20 s and pushes only changes', async () => {
	const h = harness()
	assert.equal(h.timers.pending.size, 0)
	assert.equal(h.calls.length, 0, 'nothing is read before the column is shown')

	h.main.setVisible(WINDOW, true)
	await flush()
	assert.deepEqual(
		h.calls.map(call => `${call.method} ${call.path}`),
		['POST /signals/poll', 'GET /signals'],
	)
	assert.equal(h.published.length, 1)
	assert.equal(h.published[0]?.error, null)
	assert.equal(h.published[0]?.snapshot?.threads[0]?.head, 'review requested · reviewer-a')
	assert.equal([...h.timers.pending.values()][0]?.ms, SIGNALS_POLL_MS)

	// Same data, new generatedAt: read again, no push.
	h.respond.result = () => ({ data: snapshot('review requested · reviewer-a', '2026-11-05T09:00:03.000Z') })
	h.timers.fire()
	await flush()
	assert.equal(h.calls.filter(call => call.path === '/signals').length, 2)
	assert.equal(h.published.length, 1)

	// Changed head → one push.
	h.respond.result = () => ({ data: snapshot('approved · reviewer-a') })
	h.timers.fire()
	await flush()
	assert.equal(h.published.length, 2)
	assert.equal(h.main.getState().snapshot?.threads[0]?.head, 'approved · reviewer-a')

	// Daemon down: the last snapshot stays, with the reason.
	h.respond.result = () => ({ error: 'fetch failed' })
	h.timers.fire()
	await flush()
	assert.equal(h.published.length, 3)
	assert.equal(h.published[2]?.error, 'Helm daemon is not reachable')
	assert.equal(h.published[2]?.snapshot?.threads[0]?.head, 'approved · reviewer-a')

	// Hidden: the timer is gone and nothing more is read.
	h.main.setVisible(WINDOW, false)
	assert.equal(h.timers.pending.size, 0)
	const reads = h.calls.length
	await flush()
	assert.equal(h.calls.length, reads)

	// Shown again within 20 s: read, but no source poll.
	h.clock.now += 5_000
	h.respond.result = () => ({ data: snapshot('approved · reviewer-a') })
	h.main.setVisible(WINDOW, true)
	await flush()
	assert.deepEqual(
		h.calls.slice(reads).map(call => `${call.method} ${call.path}`),
		['GET /signals'],
	)
	// After 20 s: the sources are asked again.
	h.main.setVisible(WINDOW, false)
	h.clock.now += 20_000
	h.main.setVisible(WINDOW, true)
	await flush()
	assert.ok(h.calls.slice(reads + 1).some(call => call.path === '/signals/poll'))
	h.main.stop()
	assert.equal(h.timers.pending.size, 0)
})

test('a destroyed or reloaded renderer stops the polling; signals are global, so a profile switch keeps the cached state', async () => {
	const h = harness()
	let destroyed: (() => void) | null = null
	const contents = {
		once: (_event: string, listener: () => void) => {
			destroyed = listener
		},
	}
	h.main.setVisible(contents, true)
	await flush()
	assert.equal(h.main.isPolling(), true)
	assert.ok(destroyed, 'watches its destroyed event')
	;(destroyed as () => void)()
	assert.equal(h.main.isPolling(), false)
	assert.equal(h.timers.pending.size, 0)

	h.main.setVisible(WINDOW, true)
	await flush()
	h.main.forget(WINDOW)
	assert.equal(h.main.isPolling(), false)

	assert.notEqual(h.main.getState().snapshot, null)
	const before = h.main.getState()
	h.token.value = 'other:2'
	assert.deepEqual(h.main.getState(), before)
})

test('update and routed POST, then re-read at once; the IPC gate refuses other windows and profiles', async () => {
	const h = harness()
	const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
	const listeners = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>()
	h.main.registerIpc({
		on: (channel, listener) => listeners.set(channel, listener),
		handle: (channel, listener) => handlers.set(channel, listener),
	})
	assert.deepEqual(
		[...handlers.keys()].sort(),
		[
			'signals:filtered',
			'signals:include',
			'signals:mute',
			'signals:new-agent',
			'signals:okena-projects',
			'signals:open',
			'signals:open-link',
			'signals:reply',
			'signals:routed',
			'signals:slack-include',
			'signals:slack-mute',
			'signals:slack-reply',
			'signals:subscribe',
			'signals:update',
		].sort(),
	)
	assert.deepEqual([...listeners.keys()], ['signals:set-visible'])

	const update = handlers.get('signals:update')
	assert.ok(update)
	const refusedWindow = (await update({ sender: { id: 9 } }, 1, { state: 'seen' }, TOKEN)) as { error?: string }
	assert.match(refusedWindow.error ?? '', /cannot change signals/)
	const refusedToken = (await update({ sender: WINDOW }, 1, { state: 'seen' }, 'old:0')) as { error?: string }
	assert.match(refusedToken.error ?? '', /cannot change signals/)
	assert.equal(h.calls.length, 0)

	const result = await update({ sender: WINDOW }, 4, { state: 'done' }, TOKEN)
	assert.deepEqual(result, { data: { id: 1 } })
	await flush()
	assert.deepEqual(h.calls.slice(0, 2), [
		{ method: 'POST', path: '/signals/4', body: { state: 'done' } },
		{ method: 'GET', path: '/signals' },
	])
	const routed = handlers.get('signals:routed')
	assert.ok(routed)
	await routed({ sender: WINDOW }, 4, { agent: 'feat/example', how: 'sent' }, TOKEN)
	await flush()
	assert.deepEqual(h.calls.slice(-2), [
		{ method: 'POST', path: '/signals/4/routed', body: { agent: 'feat/example', how: 'sent' } },
		{ method: 'GET', path: '/signals' },
	])
	assert.deepEqual(await update({ sender: WINDOW }, -1, { state: 'done' }, TOKEN), {
		error: 'That signal does not exist.',
		status: 400,
	})

	// setVisible through IPC is gated too.
	const setVisible = listeners.get('signals:set-visible')
	setVisible?.({ sender: { id: 9 } }, true, TOKEN)
	assert.equal(h.main.isPolling(), false)
	setVisible?.({ sender: WINDOW }, true, TOKEN)
	assert.equal(h.main.isPolling(), true)
	const subscribe = handlers.get('signals:subscribe')
	const refusedState = (await subscribe?.({ sender: { id: 9 } }, TOKEN)) as SignalsBridgeState
	assert.equal(refusedState.snapshot, null)
	assert.match(refusedState.error ?? '', /cannot read Signals/)
	h.main.stop()
})

test('filtered reads the log; include POSTs one id and re-reads; both gated; read-only runs cannot include', async () => {
	const h = harness()
	const page = { entries: [], total: 0, retentionDays: 7 }
	h.respond.result = () => ({ data: page })
	const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
	h.main.registerIpc({ on: () => undefined, handle: (channel, listener) => handlers.set(channel, listener) })
	const filtered = handlers.get('signals:filtered')
	const include = handlers.get('signals:include')
	assert.ok(filtered && include)
	assert.match(((await filtered({ sender: { id: 9 } }, TOKEN)) as { error: string }).error, /cannot read filtered mail/)
	assert.match(((await include({ sender: WINDOW }, 3, 'old:0')) as { error: string }).error, /include list/)
	assert.equal(h.calls.length, 0)

	assert.deepEqual(await filtered({ sender: WINDOW }, TOKEN), { data: page })
	assert.deepEqual(h.calls, [{ method: 'GET', path: '/signals/filtered' }])
	h.respond.result = () => ({ data: { entries: 'nope' } })
	assert.match(((await filtered({ sender: WINDOW }, TOKEN)) as { error: string }).error, /unreadable filtered list/)

	h.calls.length = 0
	assert.deepEqual(await include({ sender: WINDOW }, 3, TOKEN), { data: { id: 1 } })
	await flush()
	assert.deepEqual(h.calls.slice(0, 2), [
		{ method: 'POST', path: '/signals/filtered/3/include', body: {} },
		{ method: 'GET', path: '/signals' },
	])
	assert.deepEqual(await include({ sender: WINDOW }, '3; rm', TOKEN), {
		error: 'That filtered mail does not exist.',
		status: 400,
	})
	h.main.stop()

	const readOnly = harness({ readOnly: true })
	assert.deepEqual(await readOnly.main.include(3), { error: 'read-only run', status: 403 })
	assert.equal(readOnly.calls.length, 0)
	readOnly.main.stop()
})

test('mute POSTs one thread id and re-reads; gated like include; read-only runs cannot mute', async () => {
	const h = harness()
	const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
	h.main.registerIpc({ on: () => undefined, handle: (channel, listener) => handlers.set(channel, listener) })
	const mute = handlers.get('signals:mute')
	assert.ok(mute)
	assert.match(((await mute({ sender: { id: 9 } }, 43, TOKEN)) as { error: string }).error, /exclude list/)
	assert.match(((await mute({ sender: WINDOW }, 43, 'old:0')) as { error: string }).error, /exclude list/)
	assert.equal(h.calls.length, 0)
	assert.deepEqual(await mute({ sender: WINDOW }, 43, TOKEN), { data: { id: 1 } })
	await flush()
	assert.deepEqual(h.calls.slice(0, 2), [
		{ method: 'POST', path: '/signals/43/mute', body: {} },
		{ method: 'GET', path: '/signals' },
	])
	assert.deepEqual(await mute({ sender: WINDOW }, '43/../1', TOKEN), {
		error: 'That signal does not exist.',
		status: 400,
	})
	h.main.stop()

	const readOnly = harness({ readOnly: true })
	assert.deepEqual(await readOnly.main.mute(43), { error: 'read-only run', status: 403 })
	assert.equal(readOnly.calls.length, 0)
	readOnly.main.stop()
})

test('open allows only github.com https links and Mail message ids', async () => {
	assert.equal(signalOpenableUrl('https://github.com/acme/widgets/pull/7'), 'https://github.com/acme/widgets/pull/7')
	assert.equal(
		signalOpenableUrl('message://%3Cabc.123%40mail.example.com%3E'),
		'message://%3Cabc.123%40mail.example.com%3E',
	)
	for (const bad of [
		'http://github.com/acme/widgets',
		'https://github.com.evil.example/acme',
		'https://user:pass@github.com/acme',
		'https://github.com:8443/acme',
		'https://gist.github.com/x',
		'file:///etc/passwd',
		'message://<abc@x>',
		'message://%3Cabc%40x%3E/../x',
		'message:%3Cabc%40x%3E',
		'javascript:alert(1)',
		`https://github.com/${'a'.repeat(2050)}`,
		// Slack: only the /archives/ path on a slack.com subdomain.
		'https://cntmbr.slack.com/team/U1',
		'http://cntmbr.slack.com/archives/C1/p1',
		'https://cntmbr.slack.com.evil.example/archives/C1',
		42,
		null,
	])
		assert.equal(signalOpenableUrl(bad), null, String(bad))

	for (const good of [
		'https://cntmbr.slack.com/archives/C1/p1700000000000000',
		'https://cntmbr.slack.com/archives/D1/p1?thread_ts=1.0&cid=C1',
	])
		assert.equal(signalOpenableUrl(good), good, good)

	const opened: string[] = []
	const h = harness()
	;(h.main as unknown as { options: { openExternal: (url: string) => Promise<void> } }).options.openExternal =
		async url => {
			opened.push(url)
		}
	assert.deepEqual(await h.main.open('https://github.com/acme/widgets/pull/7'), { data: true })
	assert.deepEqual(await h.main.open('https://example.com/'), {
		error: 'Only GitHub, Slack and Mail links can be opened.',
		status: 400,
	})
	assert.deepEqual(opened, ['https://github.com/acme/widgets/pull/7'])
})

/** An agent ask as `GET /api/signals/:id` serves it, links included. */
function askThread(patch: Partial<SignalThread> = {}): SignalThread {
	const base = snapshot('x').threads[0] as SignalThread
	return {
		...base,
		id: 5,
		threadKey: 'agent:design-pick',
		source: 'agent',
		kind: 'ask',
		reasons: ['ask'],
		ref: 'Signals asks',
		fullRef: 'Signals asks · Okena terminal',
		title: 'Pick a row layout',
		head: 'Pick a row layout',
		url: null,
		repo: null,
		number: null,
		branch: null,
		links: ['http://127.0.0.1:6006/?path=/story/a', 'https://github.com/neumie/helm/pull/412'],
		...patch,
	}
}

test('reply passes Jakub’s answer to the daemon and re-reads; the IPC channel is gated', async () => {
	const h = harness()
	const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
	h.main.registerIpc({ on: () => undefined, handle: (channel, listener) => handlers.set(channel, listener) })
	const reply = handlers.get('signals:reply')
	assert.ok(reply)
	const refused = (await reply({ sender: { id: 9 } }, 5, { text: 'B' }, TOKEN)) as { error?: string }
	assert.match(refused.error ?? '', /cannot change signals/)
	assert.equal(h.calls.length, 0)

	// Only `text` crosses to the daemon (its schema is strict); the text itself is the daemon's to clean.
	assert.deepEqual(await reply({ sender: WINDOW }, 5, { text: 'Variant B\nship it', extra: true }, TOKEN), {
		data: { id: 1 },
	})
	await flush()
	assert.deepEqual(h.calls.slice(0, 2), [
		{ method: 'POST', path: '/signals/5/reply', body: { text: 'Variant B\nship it' } },
		{ method: 'GET', path: '/signals' },
	])
	const before = h.calls.length
	assert.deepEqual(await h.main.reply(0, { text: 'B' }), { error: 'That signal does not exist.', status: 400 })
	assert.deepEqual(await h.main.reply(5, { text: '   ' }), { error: 'The answer is empty.', status: 400 })
	assert.deepEqual(await h.main.reply(5, 'B'), { error: 'The answer is empty.', status: 400 })
	assert.deepEqual(await h.main.reply(5, { text: 'x'.repeat(2_001) }), {
		error: 'The answer is too long.',
		status: 400,
	})
	assert.equal(h.calls.length, before)
	h.main.stop()
})

test('openLink opens only an agent ask’s stored http(s) link, read fresh from the daemon, while it is the one shown', async () => {
	const h = harness()
	const opened: string[] = []
	;(h.main as unknown as { options: { openExternal: (url: string) => Promise<void> } }).options.openExternal =
		async url => {
			opened.push(url)
		}
	let served: SignalThread = askThread()
	h.respond.result = () => ({ data: served })

	assert.deepEqual(await h.main.openLink(5, 1, 'https://github.com/neumie/helm/pull/412'), { data: true })
	assert.deepEqual(opened, ['https://github.com/neumie/helm/pull/412'])
	// A fresh GET of that one thread decides what opens, never a value the renderer sent.
	assert.deepEqual(h.calls, [{ method: 'GET', path: '/signals/5' }])

	// The link changed in place since the column rendered it: nothing opens, Jakub looks again.
	served = askThread({ links: ['http://127.0.0.1:6006/?path=/story/a', 'https://example.com/elsewhere'] })
	assert.deepEqual(await h.main.openLink(5, 1, 'https://github.com/neumie/helm/pull/412'), {
		error: 'The links changed; look at the ask again.',
		status: 409,
	})
	// Shown at another position, or a near match: refused as well.
	assert.equal(((await h.main.openLink(5, 0, 'https://example.com/elsewhere')) as { status?: number }).status, 409)
	assert.equal(((await h.main.openLink(5, 1, 'https://example.com/elsewhere/')) as { status?: number }).status, 409)
	assert.deepEqual(opened, ['https://github.com/neumie/helm/pull/412'])
	served = askThread()

	// Bad ids and indexes are refused before any read.
	h.calls.length = 0
	for (const [id, index, shown] of [
		[0, 0, 'https://github.com/neumie/helm/pull/412'],
		['5', 0, 'https://github.com/neumie/helm/pull/412'],
		[5, -1, 'https://github.com/neumie/helm/pull/412'],
		[5, 1.5, 'https://github.com/neumie/helm/pull/412'],
		[5, 8, 'https://github.com/neumie/helm/pull/412'],
		[5, '0', 'https://github.com/neumie/helm/pull/412'],
		[5, Number.NaN, 'https://github.com/neumie/helm/pull/412'],
		[5, null, 'https://github.com/neumie/helm/pull/412'],
		[5, 1, undefined],
		[5, 1, null],
		[5, 1, ''],
		[5, 1, 42],
		[5, 1, `https://example.com/${'a'.repeat(2048)}`],
	] as const)
		assert.equal(
			((await h.main.openLink(id, index, shown)) as { status?: number }).status,
			400,
			`${id}/${String(index)}/${String(shown).slice(0, 40)}`,
		)
	assert.equal(h.calls.length, 0)

	// An index past the stored links, and a GitHub thread (no ask links), open nothing.
	assert.deepEqual(await h.main.openLink(5, 2, 'https://github.com/neumie/helm/pull/412'), {
		error: 'That link does not exist.',
		status: 404,
	})
	served = { ...(snapshot('x').threads[0] as SignalThread), links: ['https://github.com/acme/widgets/pull/7'] }
	assert.deepEqual(await h.main.openLink(1, 0, 'https://github.com/acme/widgets/pull/7'), {
		error: 'Only agent asks have links to open.',
		status: 400,
	})

	// Links the store would never keep are refused again here, even if a thread carried them.
	for (const bad of [
		'javascript:alert(1)',
		'file:///etc/passwd',
		'https://user:pass@example.com/',
		'https://example.com/\u202eexe',
		'https://example.com/a b',
		'message://%3Cabc%40x%3E',
	]) {
		served = askThread({ links: [bad] })
		assert.deepEqual(await h.main.openLink(5, 0, bad), { error: 'That link does not exist.', status: 404 }, bad)
	}
	assert.deepEqual(opened, ['https://github.com/neumie/helm/pull/412'])

	// The daemon down: says so, opens nothing.
	h.respond.result = () => ({ error: 'fetch failed' })
	assert.deepEqual(await h.main.openLink(5, 0, 'http://127.0.0.1:6006/?path=/story/a'), {
		error: 'Helm daemon is not reachable',
		status: 503,
	})
	h.respond.result = () => ({ error: 'Signal not found', status: 404 })
	assert.deepEqual(await h.main.openLink(5, 0, 'http://127.0.0.1:6006/?path=/story/a'), {
		error: 'Signal not found',
		status: 404,
	})
	assert.equal(opened.length, 1)

	// Through IPC: the same gate as `open`.
	const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
	h.main.registerIpc({ on: () => undefined, handle: (channel, listener) => handlers.set(channel, listener) })
	served = askThread()
	h.respond.result = () => ({ data: served })
	const openLink = handlers.get('signals:open-link')
	assert.match(
		(
			(await openLink?.({ sender: WINDOW }, 5, 0, 'http://127.0.0.1:6006/?path=/story/a', 'old:0')) as {
				error?: string
			}
		).error ?? '',
		/open links/,
	)
	assert.deepEqual(await openLink?.({ sender: WINDOW }, 5, 0, 'http://127.0.0.1:6006/?path=/story/a', TOKEN), {
		data: true,
	})
	assert.deepEqual(opened, ['https://github.com/neumie/helm/pull/412', 'http://127.0.0.1:6006/?path=/story/a'])
	h.main.stop()
})

test('git remotes normalize to lowercase github owner/repo', () => {
	assert.equal(githubRepoFromRemote('git@github.com:Acme/Widgets.git\n'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('https://github.com/acme/widgets'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('https://github.com/acme/widgets.git/'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('ssh://git@github.com/acme/widgets.git'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('ssh://git@ssh.github.com:443/acme/widgets.git'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('git@gitlab.com:acme/widgets.git'), null)
	assert.equal(githubRepoFromRemote('/Users/someone/repo'), null)
	assert.equal(githubRepoFromRemote('https://github.com/acme'), null)
})

test('the Okena binary: env, then ~/.local/bin, then PATH', () => {
	assert.equal(
		resolveOkenaBinary({ HELM_OKENA_BIN: '/opt/okena' }, '/h', () => true),
		'/opt/okena',
	)
	assert.equal(
		resolveOkenaBinary({}, '/h', path => path === '/h/.local/bin/okena'),
		'/h/.local/bin/okena',
	)
	assert.equal(
		resolveOkenaBinary({}, '/h', () => false),
		'okena',
	)
})

function okenaState(extra: unknown[] = []) {
	return JSON.stringify({
		state_version: 1,
		projects: [
			{ id: 'default', name: 'Default', path: '/home/someone', layout: null },
			{ id: PARENT, name: 'widgets', path: '/code/widgets', layout: null, git_status: { branch: 'main' } },
			{ id: OTHER, name: 'gadgets', path: '/code/gadgets', layout: null },
			{ id: 'twin', name: 'widgets copy', path: '/code/widgets-copy', layout: null, is_closing: true },
			{
				id: 'wt-old',
				name: 'widgets (old)',
				path: '/code/widgets-wt/old',
				worktree_info: { parent_project_id: PARENT },
				git_status: { branch: 'old' },
				layout: { type: 'terminal', terminal_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
			},
			...extra,
		],
	})
}

test('okenaProjects lists parent projects with their origin repo and suggests the single match', async () => {
	const execs: string[][] = []
	const remotes: Record<string, string> = {
		'/code/widgets': 'git@github.com:Acme/widgets.git\n',
		'/code/gadgets': 'https://github.com/acme/gadgets\n',
	}
	const exec: SignalsExec = async (file, args, options) => {
		execs.push([file, ...args])
		if (file === '/fake/okena') {
			assert.deepEqual(args, ['state'])
			return { stdout: okenaState(), stderr: '' }
		}
		assert.equal(file, 'git')
		assert.equal(options.env?.GIT_DIR, undefined, 'inherited GIT_* never reaches git')
		assert.equal(options.env?.GIT_OPTIONAL_LOCKS, '0')
		const remote = remotes[args[1] ?? '']
		if (remote === undefined) throw Object.assign(new Error('not a git repository'), { code: 128 })
		return { stdout: remote, stderr: '' }
	}
	const h = harness({ exec })
	const result = await h.main.okenaProjects('acme/Widgets')
	assert.deepEqual(result, {
		data: {
			projects: [
				{ id: 'default', name: 'Default', repo: null },
				{ id: PARENT, name: 'widgets', repo: 'acme/widgets' },
				{ id: OTHER, name: 'gadgets', repo: 'acme/gadgets' },
			],
			suggested: PARENT,
		},
	})
	// No worktree child, no closing project; every git read is read-only.
	assert.ok(execs.every(call => call[0] === '/fake/okena' || call.slice(3).join(' ') === 'remote get-url origin'))
	const gitReads = execs.filter(call => call[0] === 'git').length
	assert.equal(gitReads, 3)

	// Cached for 5 minutes per path.
	const again = await h.main.okenaProjects(null)
	assert.equal(again.data?.suggested, null)
	assert.equal(execs.filter(call => call[0] === 'git').length, gitReads)

	// Two checkouts of the same repo → no suggestion.
	remotes['/code/gadgets'] = 'git@github.com:acme/widgets.git'
	h.clock.now += 6 * 60_000
	assert.equal((await h.main.okenaProjects('acme/widgets')).data?.suggested, null)

	assert.equal((await h.main.okenaProjects('not a repo')).status, 400)
})

test('okenaProjects says when Okena is missing', async () => {
	const h = harness({
		exec: async () => {
			throw Object.assign(new Error('spawn okena ENOENT'), { code: 'ENOENT' })
		},
	})
	assert.deepEqual(await h.main.okenaProjects(null), { error: 'Okena is not installed.' })
})

function newAgentRequest(overrides: Record<string, unknown> = {}) {
	return {
		signalId: 1,
		projectId: PARENT,
		branch: 'fix/widgets-7',
		agent: 'claude',
		prompt: 'Look at <external>…</external>',
		...overrides,
	}
}

/** git for a branch that exists neither locally nor on origin (ls-remote --exit-code → 2). */
function newBranchGit(args: readonly string[]) {
	if (args[2] === 'check-ref-format') return { stdout: `${args[4]}\n`, stderr: '' }
	if (args[2] === 'show-ref') throw Object.assign(new Error('exit 1'), { code: 1 })
	if (args[2] === 'ls-remote') throw Object.assign(new Error('exit 2'), { code: 2 })
	throw new Error(`unexpected git ${args.join(' ')}`)
}

test('newAgent: worktree add, then claude start with a private prompt file that is deleted afterwards', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-main-'))
	try {
		const execs: string[][] = []
		let promptSeen: { content: string; mode: number; dirMode: number } | null = null
		let created = false
		const exec: SignalsExec = async (file, args) => {
			execs.push([file, ...args])
			if (file === 'git') return newBranchGit(args)
			if (args[0] === 'state')
				return {
					stdout: created
						? okenaState([
								{
									id: 'wt-new',
									name: 'widgets (fix/widgets-7)',
									path: '/code/widgets-wt/fix-widgets-7',
									worktree_info: { parent_project_id: PARENT },
									git_status: { branch: 'fix/widgets-7' },
									layout: {
										type: 'split',
										children: [
											{ type: 'terminal', terminal_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
											{ type: 'terminal', terminal_id: NEW_TERMINAL },
										],
									},
								},
							])
						: okenaState(),
					stderr: '',
				}
			if (args[0] === 'worktree') {
				assert.deepEqual(args, ['worktree', 'add', PARENT, 'fix/widgets-7', '--new-branch', '--wait'])
				created = true
				return { stdout: `wt-new\t/code/widgets-wt/fix-widgets-7\t${NEW_TERMINAL}\n`, stderr: '' }
			}
			if (args[0] === 'claude') {
				const file = args[args.indexOf('--prompt-file') + 1] ?? ''
				assert.deepEqual(args, ['claude', 'start', NEW_TERMINAL, '--trust', '--prompt-file', file, '--json'])
				assert.ok(file.startsWith(join(root, 'signals', 'prompt-')))
				promptSeen = {
					content: readFileSync(file, 'utf8'),
					mode: statSync(file).mode & 0o777,
					dirMode: statSync(join(root, 'signals')).mode & 0o777,
				}
				return {
					stdout: JSON.stringify({ terminal: NEW_TERMINAL, session_id: 'sess-1', delivery: 'typed' }),
					stderr: '',
				}
			}
			throw new Error(`unexpected exec ${file} ${args.join(' ')}`)
		}
		const h = harness({ exec, userDataDir: root })
		const result = await h.main.newAgent(newAgentRequest())
		assert.deepEqual(result, {
			data: { terminalId: NEW_TERMINAL, sessionId: 'sess-1', agentName: 'fix/widgets-7' },
		})
		assert.deepEqual(promptSeen, { content: 'Look at <external>…</external>', mode: 0o600, dirMode: 0o700 })
		assert.deepEqual(readdirSync(join(root, 'signals')), [], 'the prompt file is gone')
		assert.deepEqual(
			execs.map(call => call.slice(0, 3).join(' ')),
			[
				'/fake/okena state',
				'git -C /code/widgets',
				'git -C /code/widgets',
				'git -C /code/widgets',
				'git -C /code/widgets',
				'/fake/okena worktree add',
				'/fake/okena state',
				'/fake/okena claude start',
			],
		)
		assert.deepEqual(
			execs.filter(call => call[0] === 'git').map(call => call.slice(1)),
			[
				['-C', '/code/widgets', 'check-ref-format', '--branch', 'fix/widgets-7'],
				['-C', '/code/widgets', 'show-ref', '--verify', '--quiet', 'refs/heads/fix/widgets-7'],
				['-C', '/code/widgets', 'show-ref', '--verify', '--quiet', 'refs/remotes/origin/fix/widgets-7'],
				['-C', '/code/widgets', 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/fix/widgets-7'],
			],
			'a brand-new branch: absent locally and on origin, nothing is fetched or created by git',
		)
		assert.equal(h.calls.length, 0, 'routing is the renderer’s POST, not main’s')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('newAgent falls back to the worktree’s first terminal and still deletes the prompt when Claude fails', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-main-'))
	try {
		let created = false
		let promptPath = ''
		const exec: SignalsExec = async (file, args) => {
			if (file === 'git') return { stdout: '', stderr: '' }
			if (args[0] === 'state')
				return {
					stdout: okenaState(
						created
							? [
									{
										id: 'wt-new',
										name: 'widgets (fix/widgets-7)',
										path: '/code/widgets-wt/fix-widgets-7',
										worktree_info: { parent_project_id: PARENT },
										git_status: { branch: 'fix/widgets-7' },
										layout: { type: 'terminal', terminal_id: NEW_TERMINAL },
									},
								]
							: [],
					),
					stderr: '',
				}
			if (args[0] === 'worktree') {
				created = true
				return { stdout: 'created\n', stderr: '' }
			}
			promptPath = args[args.indexOf('--prompt-file') + 1] ?? ''
			assert.equal(args[2], NEW_TERMINAL)
			throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'claude did not connect\u001b[0m' })
		}
		const h = harness({ exec, userDataDir: root })
		const result = await h.main.newAgent(newAgentRequest())
		assert.match(
			String((result as { error?: string }).error),
			/^Okena could not start Claude: claude did not connect \[0m\. The branch already existed/,
		)
		assert.ok(promptPath !== '')
		assert.equal(existsSync(promptPath), false)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

/** A newAgent run where git answers from `refs`/`origin`; returns every exec argv. */
async function runNewAgentWithGit(git: {
	refs: Set<string>
	origin: Set<string>
	failLsRemote?: boolean
	/** `okena claude start` fails (e.g. the trust dialog is shown without --trust). */
	failClaude?: boolean
}): Promise<{ execs: string[][]; result: unknown }> {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-main-'))
	try {
		const execs: string[][] = []
		let created = false
		const exec: SignalsExec = async (file, args) => {
			execs.push([file, ...args])
			if (file === 'git') {
				assert.equal(args[1], '/code/widgets')
				const verb = args[2]
				if (verb === 'check-ref-format') return { stdout: '', stderr: '' }
				if (verb === 'show-ref') {
					if (git.refs.has(args[5] ?? '')) return { stdout: '', stderr: '' }
					throw Object.assign(new Error('exit 1'), { code: 1 })
				}
				if (verb === 'ls-remote') {
					if (git.failLsRemote)
						throw Object.assign(new Error('exit 128'), { code: 128, stderr: 'fatal: could not read from remote' })
					if (git.origin.has(args[6] ?? '')) return { stdout: 'abc\trefs/heads/x\n', stderr: '' }
					throw Object.assign(new Error('exit 2'), { code: 2 })
				}
				if (verb === 'fetch') {
					const [, dst] = (args[5] ?? '').split(':')
					git.refs.add(dst ?? '')
					return { stdout: '', stderr: '' }
				}
				if (verb === 'branch') {
					assert.ok(git.refs.has(args[5] ?? ''), 'tracks a fetched remote ref')
					git.refs.add(`refs/heads/${args[4]}`)
					return { stdout: '', stderr: '' }
				}
				throw new Error(`unexpected git ${args.join(' ')}`)
			}
			if (args[0] === 'state')
				return {
					stdout: okenaState(
						created
							? [
									{
										id: 'wt-new',
										name: 'widgets (fix/widgets-7)',
										path: '/code/widgets-wt/fix-widgets-7',
										worktree_info: { parent_project_id: PARENT },
										git_status: { branch: 'fix/widgets-7' },
										layout: { type: 'terminal', terminal_id: NEW_TERMINAL },
									},
								]
							: [],
					),
					stderr: '',
				}
			if (args[0] === 'worktree') {
				created = true
				return { stdout: `wt-new\t/code/widgets-wt/fix-widgets-7\t${NEW_TERMINAL}\n`, stderr: '' }
			}
			if (args[0] === 'claude') {
				if (git.failClaude) throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'trust dialog is shown' })
				return { stdout: JSON.stringify({ session_id: 'sess-1' }), stderr: '' }
			}
			throw new Error(`unexpected exec ${file} ${args.join(' ')}`)
		}
		const h = harness({ exec, userDataDir: root })
		const result = await h.main.newAgent(newAgentRequest())
		return { execs, result }
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

const LOCAL_REF = 'refs/heads/fix/widgets-7'
const REMOTE_REF = 'refs/remotes/origin/fix/widgets-7'
const OK_RESULT = { data: { terminalId: NEW_TERMINAL, sessionId: 'sess-1', agentName: 'fix/widgets-7' } }
const gitArgs = (execs: string[][]) => execs.filter(call => call[0] === 'git').map(call => call.slice(3))
const worktreeArgs = (execs: string[][]) => execs.find(call => call[1] === 'worktree')?.slice(1)
const claudeArgs = (execs: string[][]) => execs.find(call => call[1] === 'claude')?.slice(1)

test('newAgent trusts the folder only for a brand-new branch, never for an existing local or origin branch', async () => {
	// A local branch may be one an earlier `n` made from a teammate's origin branch: no provenance.
	const local = await runNewAgentWithGit({ refs: new Set([LOCAL_REF, REMOTE_REF]), origin: new Set([LOCAL_REF]) })
	assert.deepEqual(local.result, OK_RESULT)
	assert.ok(!claudeArgs(local.execs)?.includes('--trust'))
	const fresh = await runNewAgentWithGit({ refs: new Set(), origin: new Set() })
	assert.ok(claudeArgs(fresh.execs)?.includes('--trust'))

	const remote = await runNewAgentWithGit({ refs: new Set(), origin: new Set([LOCAL_REF]) })
	assert.deepEqual(remote.result, OK_RESULT)
	assert.ok(!claudeArgs(remote.execs)?.includes('--trust'), 'origin code may carry someone else’s .claude hooks')

	const dialog = await runNewAgentWithGit({ refs: new Set(), origin: new Set([LOCAL_REF]), failClaude: true })
	assert.match(String((dialog.result as { error?: string }).error), /answer Claude's trust dialog in Okena/)
})

test('newAgent hands an existing local branch to Okena as is, without --new-branch', async () => {
	const { execs, result } = await runNewAgentWithGit({ refs: new Set([LOCAL_REF]), origin: new Set() })
	assert.deepEqual(result, OK_RESULT)
	assert.deepEqual(worktreeArgs(execs), ['worktree', 'add', PARENT, 'fix/widgets-7', '--wait'])
	assert.deepEqual(gitArgs(execs), [
		['check-ref-format', '--branch', 'fix/widgets-7'],
		['show-ref', '--verify', '--quiet', LOCAL_REF],
	])
})

test('newAgent makes an origin-only branch (a teammate’s PR head) a local tracking branch first', async () => {
	// Already fetched once: refs/remotes/origin/<branch> exists, no local branch.
	const fetched = await runNewAgentWithGit({ refs: new Set([REMOTE_REF]), origin: new Set([LOCAL_REF]) })
	assert.deepEqual(fetched.result, OK_RESULT)
	assert.deepEqual(gitArgs(fetched.execs), [
		['check-ref-format', '--branch', 'fix/widgets-7'],
		['show-ref', '--verify', '--quiet', LOCAL_REF],
		['show-ref', '--verify', '--quiet', REMOTE_REF],
		['fetch', '--no-tags', 'origin', `+${LOCAL_REF}:${REMOTE_REF}`],
		['branch', '--track', 'fix/widgets-7', REMOTE_REF],
	])
	assert.deepEqual(worktreeArgs(fetched.execs), ['worktree', 'add', PARENT, 'fix/widgets-7', '--wait'])

	// Never fetched here: origin itself is asked before anything is created.
	const fresh = await runNewAgentWithGit({ refs: new Set(), origin: new Set([LOCAL_REF]) })
	assert.deepEqual(fresh.result, OK_RESULT)
	assert.deepEqual(gitArgs(fresh.execs), [
		['check-ref-format', '--branch', 'fix/widgets-7'],
		['show-ref', '--verify', '--quiet', LOCAL_REF],
		['show-ref', '--verify', '--quiet', REMOTE_REF],
		['ls-remote', '--exit-code', '--heads', 'origin', LOCAL_REF],
		['fetch', '--no-tags', 'origin', `+${LOCAL_REF}:${REMOTE_REF}`],
		['branch', '--track', 'fix/widgets-7', REMOTE_REF],
	])
	assert.deepEqual(worktreeArgs(fresh.execs), ['worktree', 'add', PARENT, 'fix/widgets-7', '--wait'])
	assert.ok(
		fresh.execs.every(call => !call.includes('--new-branch')),
		'never a same-named branch from main',
	)
})

test('newAgent passes --new-branch only when the branch is on neither side, and stops when origin cannot be asked', async () => {
	const fresh = await runNewAgentWithGit({ refs: new Set(), origin: new Set() })
	assert.deepEqual(fresh.result, OK_RESULT)
	assert.deepEqual(worktreeArgs(fresh.execs), ['worktree', 'add', PARENT, 'fix/widgets-7', '--new-branch', '--wait'])
	assert.ok(fresh.execs.every(call => call[3] !== 'fetch' && call[3] !== 'branch'))

	const offline = await runNewAgentWithGit({ refs: new Set(), origin: new Set(), failLsRemote: true })
	assert.deepEqual(offline.result, {
		error: 'Could not check the branch on origin: fatal: could not read from remote',
	})
	assert.equal(worktreeArgs(offline.execs), undefined, 'no Okena write when origin is unknown')
})

test('newAgent refuses bad branches, unknown projects and other agents before any Okena write', async () => {
	const execs: string[][] = []
	const exec: SignalsExec = async (file, args) => {
		execs.push([file, ...args])
		if (file === 'git') throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'fatal: not a valid branch name' })
		if (args[0] === 'state') return { stdout: okenaState(), stderr: '' }
		throw new Error('no Okena write expected')
	}
	const h = harness({ exec })
	assert.deepEqual(await h.main.newAgent(newAgentRequest({ branch: 'fix..bad' })), {
		error: 'That is not a valid branch name.',
		status: 400,
	})
	for (const branch of ['', '--force', 'has space', 'x'.repeat(256)])
		assert.equal((await h.main.newAgent(newAgentRequest({ branch }))).status, 400, branch)
	assert.equal((await h.main.newAgent(newAgentRequest({ agent: 'codex' }))).status, 400)
	assert.equal((await h.main.newAgent(newAgentRequest({ prompt: '  ' }))).status, 400)
	assert.equal((await h.main.newAgent(newAgentRequest({ prompt: 'x'.repeat(16_385) }))).status, 400)
	assert.deepEqual(await h.main.newAgent(newAgentRequest({ projectId: 'wt-old' })), {
		error: 'That Okena project is no longer open.',
		status: 404,
	})
	assert.ok(execs.every(call => call[1] === 'state' || call[0] === 'git'))
})

test('newAgent is single-flight', async () => {
	let release: () => void = () => undefined
	const gate = new Promise<void>(resolve => {
		release = resolve
	})
	const exec: SignalsExec = async () => {
		await gate
		throw Object.assign(new Error('spawn okena ENOENT'), { code: 'ENOENT' })
	}
	const h = harness({ exec })
	const first = h.main.newAgent(newAgentRequest())
	assert.deepEqual(await h.main.newAgent(newAgentRequest()), {
		error: 'A new agent is already starting.',
		status: 409,
	})
	release()
	assert.deepEqual(await first, { error: 'Okena is not installed.' })
	// Released afterwards.
	const third = await h.main.newAgent(newAgentRequest())
	assert.deepEqual(third, { error: 'Okena is not installed.' })
})

test('a read-only (side-by-side) run never writes: no source poll, no thread changes, no new agents', async () => {
	const h = harness({
		readOnly: true,
		exec: async () => {
			throw new Error('no exec expected')
		},
	})
	h.main.setVisible(WINDOW, true)
	await flush()
	assert.deepEqual(
		h.calls.map(call => `${call.method} ${call.path}`),
		['GET /signals'],
	)
	assert.deepEqual(await h.main.update(1, { state: 'seen' }), { error: 'read-only run', status: 403 })
	assert.deepEqual(await h.main.routed(1, { agent: 'a', how: 'sent' }), { error: 'read-only run', status: 403 })
	assert.deepEqual(await h.main.newAgent(newAgentRequest()), { error: 'read-only run', status: 403 })
	assert.deepEqual(await h.main.reply(1, { text: 'yes' }), { error: 'read-only run', status: 403 })
	assert.ok(h.calls.every(call => call.method === 'GET'))
	h.main.stop()
})

test('main.ts and preload wire the Signals channels through the gated main-window path', () => {
	const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
	const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
	assert.match(main, /signalsMain\.registerIpc\(ipcMain\)/)
	const block = main.slice(main.indexOf('new SignalsMain({'), main.indexOf('readOnly: signalsReadOnly'))
	assert.match(
		block,
		/acceptsIpc: \(sender, profileToken\) => sessionIpcGate\.allows\(profileToken\) && sender === mainWindow\?\.webContents,/,
	)
	assert.match(
		block,
		/sendToLiveRenderer\(mainWindow\?\.webContents, SIGNALS_IPC\.snapshot, state, sessionProfileToken\(\)\)/,
	)
	assert.match(main, /readOnly: signalsReadOnly/)
	assert.match(main, /signalsMain\.stop\(\)/)
	assert.match(preload, /const SIGNALS_CHANNELS: typeof SIGNALS_IPC = \{/)
	assert.match(preload, /\} satisfies SignalsApi,/)
})

test('daemon requests: writes carry the local control token, reads and read-only runs never do', async () => {
	const seen: { method: string; url: string; headers: Record<string, string> }[] = []
	const fakeFetch = (async (url: string, init: RequestInit) => {
		seen.push({ method: init.method ?? 'GET', url, headers: { ...((init.headers as Record<string, string>) ?? {}) } })
		return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
	}) as unknown as typeof fetch
	let reads = 0
	const request = createSignalsDaemonRequest('http://127.0.0.1:7474/', {
		fetch: fakeFetch,
		controlToken: async () => {
			reads += 1
			return 'T'.repeat(43)
		},
	})
	assert.deepEqual(await request('GET', '/signals'), { data: { ok: true } })
	assert.deepEqual(await request('POST', '/signals/3/reply', { text: 'B' }), { data: { ok: true } })
	assert.equal(seen[0]?.headers.Authorization, undefined)
	assert.equal(seen[1]?.url, 'http://127.0.0.1:7474/api/signals/3/reply')
	assert.equal(seen[1]?.headers.Authorization, `Bearer ${'T'.repeat(43)}`)
	assert.equal(seen[1]?.headers['Content-Type'], 'application/json')
	assert.equal(reads, 1, 'the token is read for writes only')

	const readOnly = createSignalsDaemonRequest('http://127.0.0.1:7474', {
		fetch: fakeFetch,
		readOnlyError: 'read only',
		controlToken: async () => 'T'.repeat(43),
	})
	assert.deepEqual(await readOnly('POST', '/signals/3/reply', { text: 'B' }), { error: 'read only', status: 403 })
	assert.equal(seen.length, 2, 'a read-only run sends nothing')

	const noToken = createSignalsDaemonRequest('http://127.0.0.1:7474', {
		fetch: fakeFetch,
		controlToken: async () => {
			throw new Error('no token file')
		},
	})
	assert.deepEqual(await noToken('POST', '/signals/3', { state: 'done' }), { data: { ok: true } })
	assert.equal(seen.length, 3, 'without the token a write still goes out')
	assert.equal(seen[2]?.headers.Authorization, undefined, 'unauthenticated: the daemon refuses only a reply')
})
