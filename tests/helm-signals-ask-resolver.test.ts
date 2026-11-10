// Signals asks that follow their Okena terminal (app/src/signals-ask-resolver.ts): which transcript
// prompts count as Jakub prompting the terminal, and how an open ask closes from them.

import assert from 'node:assert/strict'
import test from 'node:test'
import modelModule from '../app/src/renderer/signals/model.ts'
import resolverModule from '../app/src/signals-ask-resolver.ts'

type SignalThread = import('../app/src/shared-helm.ts').SignalThread
type HelmResult<T> = import('../app/src/shared-helm.ts').HelmResult<T>
type SentPrompt = import('../app/src/signals-ask-resolver.ts').SentPrompt
type TerminalPromptEntry = import('../app/src/signals-ask-resolver.ts').TerminalPromptEntry

const { replyPrompt } = modelModule as typeof import('../app/src/renderer/signals/model.ts')
const {
	ASK_REFRESH_MS,
	SignalsAskResolver,
	askReplyMarker,
	askReplyMarkerId,
	classifyTerminalPrompt,
	openTerminalAsks,
} = resolverModule as typeof import('../app/src/signals-ask-resolver.ts')

const T0 = Date.parse('2026-11-10T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const TERMINAL = 'b2b3a76c-45fd-4d9e-b766-b7455b1723e0'
const OTHER = '5d3f8a2e-1b4c-4e8a-9f21-6c0d7e9b3a14'

function ask(patch: Partial<SignalThread> & { id: number }): SignalThread {
	return {
		threadKey: `agent:ask-${patch.id}`,
		source: 'agent',
		kind: 'ask',
		reasons: ['ask'],
		ref: 'VOS sloty',
		fullRef: 'VOS sloty · Okena terminal',
		title: 'Briefing ready',
		head: 'Briefing ready',
		actor: 'VOS sloty',
		url: null,
		repo: null,
		number: null,
		branch: null,
		state: 'new',
		owner: 'jakub',
		snoozedUntil: null,
		lastActivityAt: iso(T0),
		active: true,
		closedReason: null,
		closedBy: null,
		note: null,
		noteAt: null,
		managedBy: null,
		routedAgent: null,
		routedHow: null,
		routedAt: null,
		body: null,
		links: [],
		askTerminal: TERMINAL,
		reply: null,
		replyAt: null,
		createdAt: iso(T0),
		updatedAt: iso(T0),
		...patch,
	}
}

const typed = (uuid: string, at: number, text: string, origin: 'terminal' | 'channel' = 'terminal') =>
	({ uuid, timestamp: iso(at), text, origin }) satisfies TerminalPromptEntry

test('classify: typed prompts count; channel, untimed, old, commands, interrupts and bare pastes do not', () => {
	const start = T0
	const classify = (entry: TerminalPromptEntry, sent: SentPrompt[] = []) => classifyTerminalPrompt(entry, sent, start)
	assert.deepEqual(classify(typed('a', T0 + 1_000, 'Ano, schvaluju.')), { kind: 'jakub', at: T0 + 1_000 })
	assert.deepEqual(classify(typed('b', T0 + 1_000, 'yes', 'channel')), { kind: 'ignored', why: 'channel' })
	assert.deepEqual(classify({ uuid: 'c', text: 'yes', origin: 'terminal' }), { kind: 'ignored', why: 'no-time' })
	assert.deepEqual(classify({ uuid: 'c', timestamp: 'later', text: 'yes', origin: 'terminal' }), {
		kind: 'ignored',
		why: 'no-time',
	})
	assert.deepEqual(classify(typed('d', T0 - 1, 'yes')), { kind: 'ignored', why: 'before-start' })
	assert.deepEqual(classify(typed('e', T0 + 1, '  ')), { kind: 'ignored', why: 'empty' })
	assert.deepEqual(classify(typed('f', T0 + 1, '/compact keep it short')), { kind: 'ignored', why: 'command' })
	assert.deepEqual(classify(typed('g', T0 + 1, '[Request interrupted by user for tool use]')), {
		kind: 'ignored',
		why: 'interrupt',
	})
	const paste = '<pasted_content id="p1">A long brief from another agent.\nLine two.</pasted_content id="p1">'
	assert.deepEqual(classify(typed('h', T0 + 1, paste)), { kind: 'ignored', why: 'paste' })
	assert.deepEqual(classify(typed('i', T0 + 1, `${paste}\n\nTohle udělej.`)), { kind: 'jakub', at: T0 + 1 })
})

test('classify: a prompt Helm typed is not Jakub’s, unless it is his Signals reply to that ask', () => {
	const sent = (text: string, askId: number | null = null, at = T0): SentPrompt => ({
		match: text.replace(/\s+/g, ' ').trim(),
		at,
		askId,
	})
	const handoff = sent('Look at crane-rental#970 and fix the failing build, then open a PR.')
	assert.deepEqual(
		classifyTerminalPrompt(
			typed('a', T0 + 500, 'Look at crane-rental#970 and fix the failing build, then open a PR.'),
			[handoff],
			T0,
		),
		{ kind: 'ignored', why: 'helm' },
	)
	// Long Helm prompts land as a paste; still Helm's.
	const pasted = `<pasted_content id="x">Look at crane-rental#970 and fix the failing build,\nthen open a PR.</pasted_content id="x">`
	assert.deepEqual(classifyTerminalPrompt(typed('b', T0 + 500, pasted), [handoff], T0), {
		kind: 'ignored',
		why: 'helm',
	})
	// A short Helm prompt matches only when equal: Jakub's own longer words are his.
	const short = sent('ok')
	assert.deepEqual(classifyTerminalPrompt(typed('c', T0 + 500, 'ok'), [short], T0), { kind: 'ignored', why: 'helm' })
	assert.deepEqual(classifyTerminalPrompt(typed('d', T0 + 500, 'ok, ale nejdřív testy'), [short], T0), {
		kind: 'jakub',
		at: T0 + 500,
	})
	// A Helm prompt recorded well after the entry was written cannot be it.
	assert.deepEqual(classifyTerminalPrompt(typed('e', T0 + 500, 'ok'), [sent('ok', null, T0 + 60_000)], T0), {
		kind: 'jakub',
		at: T0 + 500,
	})

	// Jakub's Signals reply (r) counts for its own ask only.
	const reply = replyPrompt(ask({ id: 28 }), 'Ano, pošli to klientovi.')
	assert.equal(askReplyMarkerId(reply), 28)
	assert.ok(reply.startsWith(askReplyMarker(28)))
	const replySent = sent(reply, askReplyMarkerId(reply))
	assert.deepEqual(classifyTerminalPrompt(typed('f', T0 + 500, reply), [replySent], T0), {
		kind: 'reply',
		at: T0 + 500,
		askId: 28,
	})
	const replyPasted = `<pasted_content id="r">${reply}</pasted_content id="r">`
	assert.equal(askReplyMarkerId(replyPasted), 28)
	assert.deepEqual(classifyTerminalPrompt(typed('g', T0 + 500, replyPasted), [replySent], T0), {
		kind: 'reply',
		at: T0 + 500,
		askId: 28,
	})
	// The same words typed by someone else (no Helm send on record) are a paste, nothing more.
	assert.deepEqual(classifyTerminalPrompt(typed('h', T0 + 500, replyPasted), [], T0), { kind: 'ignored', why: 'paste' })
	assert.equal(askReplyMarkerId('Please: Jakub answered your Signals ask #28.'), null)
})

test('openTerminalAsks: open agent asks bound to a terminal only', () => {
	assert.deepEqual(
		openTerminalAsks([
			ask({ id: 1, askTerminal: TERMINAL.toUpperCase() }),
			ask({ id: 2, askTerminal: null }),
			ask({ id: 3, state: 'done' }),
			ask({ id: 4, state: 'snoozed' }),
			ask({ id: 5, source: 'github' }),
			ask({ id: 6, lastActivityAt: 'never' }),
		]),
		[
			{ id: 1, terminal: TERMINAL, activityAt: iso(T0) },
			{ id: 4, terminal: TERMINAL, activityAt: iso(T0) },
		],
	)
})

function fakeDaemon(threads: () => SignalThread[]) {
	const posts: Array<{ path: string; body: unknown }> = []
	let answer: (path: string) => HelmResult<unknown> = () => ({ data: {} })
	const request = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HelmResult<T>> => {
		if (method === 'GET') {
			assert.equal(path, '/signals?source=agent&state=new,seen,snoozed')
			return { data: { threads: threads() } as T }
		}
		posts.push({ path, body })
		return answer(path) as HelmResult<T>
	}
	return {
		request,
		posts,
		answerWith(next: (path: string) => HelmResult<unknown>) {
			answer = next
		},
	}
}

function fakeTimers() {
	const pending: Array<{ callback: () => void; ms: number; handle: number }> = []
	let next = 1
	return {
		pending,
		setTimeout(callback: () => void, ms: number) {
			const handle = next++
			pending.push({ callback, ms, handle })
			return handle
		},
		clearTimeout(handle: unknown) {
			const index = pending.findIndex(timer => timer.handle === handle)
			if (index >= 0) pending.splice(index, 1)
		},
	}
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('resolver: a prompt typed after the ask closes it (once); before it, or in another terminal, nothing', async () => {
	let threads = [ask({ id: 28 }), ask({ id: 29, askTerminal: OTHER }), ask({ id: 30, askTerminal: null })]
	const daemon = fakeDaemon(() => threads)
	const watched: string[][] = []
	const clock = { now: T0 - 60_000 }
	const timers = fakeTimers()
	const resolver = new SignalsAskResolver({
		request: daemon.request,
		watch: ids => watched.push([...ids].sort()),
		now: () => clock.now,
		timers,
	})
	resolver.start()
	await resolver.refresh()
	assert.deepEqual(watched.at(-1), [OTHER, TERMINAL].sort())
	assert.deepEqual(
		timers.pending.map(timer => timer.ms),
		[ASK_REFRESH_MS],
	)

	// Before the ask: no close (Jakub typed it while the agent was still working on the ask).
	resolver.observePrompts(TERMINAL, [typed('u-old', T0 - 1_000, 'Udělej briefing.')])
	await settle()
	assert.equal(daemon.posts.length, 0)

	// After the ask, in its terminal (any case): closes that ask only.
	resolver.observePrompts(TERMINAL.toUpperCase(), [typed('u-new', T0 + 5_000, 'Ano, pošli to.')])
	await settle()
	assert.deepEqual(daemon.posts, [
		{ path: '/signals/28/answered', body: { activityAt: iso(T0), promptAt: iso(T0 + 5_000) } },
	])
	assert.deepEqual(watched.at(-1), [OTHER])
	// The same entry again (a reset page) changes nothing.
	resolver.observePrompts(TERMINAL, [typed('u-new', T0 + 5_000, 'Ano, pošli to.')])
	await settle()
	assert.equal(daemon.posts.length, 1)

	// A refresh while the daemon still lists it (renewed meanwhile: newer activity) waits for a newer prompt.
	threads = [ask({ id: 28, lastActivityAt: iso(T0 + 10_000) }), ask({ id: 29, askTerminal: OTHER })]
	await resolver.refresh()
	assert.equal(daemon.posts.length, 1)
	resolver.observePrompts(TERMINAL, [typed('u-3', T0 + 11_000, 'A teď?')])
	await settle()
	assert.deepEqual(daemon.posts.at(-1), {
		path: '/signals/28/answered',
		body: { activityAt: iso(T0 + 10_000), promptAt: iso(T0 + 11_000) },
	})

	resolver.stop()
	assert.deepEqual(watched.at(-1), [])
	assert.deepEqual(timers.pending, [])
	resolver.observePrompts(OTHER, [typed('u-4', T0 + 12_000, 'yes')])
	await settle()
	assert.equal(daemon.posts.length, 2, 'stopped: nothing more')
})

test('resolver: a prompt seen before the ask was loaded closes it on the next refresh; a conflict waits', async () => {
	let threads: SignalThread[] = []
	const daemon = fakeDaemon(() => threads)
	const clock = { now: T0 - 60_000 }
	const resolver = new SignalsAskResolver({ request: daemon.request, now: () => clock.now, timers: fakeTimers() })
	resolver.start()
	await resolver.refresh()
	resolver.observePrompts(TERMINAL, [typed('u-1', T0 + 5_000, 'Hotovo, díky.')])
	await settle()
	assert.equal(daemon.posts.length, 0)

	threads = [ask({ id: 31 })]
	daemon.answerWith(() => ({ error: 'The ask changed since that prompt was matched', status: 409 }))
	await resolver.refresh()
	assert.deepEqual(
		daemon.posts.map(post => post.path),
		['/signals/31/answered'],
	)
	// Dropped until the next refresh reads it again.
	resolver.observePrompts(TERMINAL, [typed('u-2', T0 + 6_000, 'A ještě tohle.')])
	await settle()
	assert.equal(daemon.posts.length, 1)
	daemon.answerWith(() => ({ data: {} }))
	await resolver.refresh()
	assert.deepEqual(daemon.posts.at(-1)?.body, { activityAt: iso(T0), promptAt: iso(T0 + 6_000) })
	resolver.stop()
})

test('resolver: Helm’s own prompts are ignored, Jakub’s Signals reply closes only its ask', async () => {
	const threads = [ask({ id: 40 }), ask({ id: 41 })]
	const daemon = fakeDaemon(() => threads)
	const clock = { now: T0 - 60_000 }
	const resolver = new SignalsAskResolver({ request: daemon.request, now: () => clock.now, timers: fakeTimers() })
	resolver.start()
	await resolver.refresh()

	clock.now = T0 + 1_000
	const handoff = 'Look at crane-rental#970: the build fails on main. Fix it and open a PR.'
	resolver.promptSending({ source: 'okena', terminalId: TERMINAL }, handoff)
	resolver.promptSending({ source: 'helm', terminalId: TERMINAL }, 'ignored: not an Okena terminal')
	resolver.observePrompts(TERMINAL, [typed('h-1', T0 + 2_000, handoff)])
	await settle()
	assert.equal(daemon.posts.length, 0)

	const reply = replyPrompt(ask({ id: 41 }), 'Varianta B.')
	resolver.promptSending({ source: 'okena', terminalId: TERMINAL }, reply)
	resolver.observePrompts(TERMINAL, [
		typed('h-2', T0 + 3_000, `<pasted_content id="r">${reply}</pasted_content id="r">`),
	])
	await settle()
	assert.deepEqual(daemon.posts, [
		{ path: '/signals/41/answered', body: { activityAt: iso(T0), promptAt: iso(T0 + 3_000) } },
	])
	// Each Helm send lands once: the same words typed again later are Jakub's.
	resolver.observePrompts(TERMINAL, [typed('h-3', T0 + 4_000, handoff)])
	await settle()
	assert.deepEqual(daemon.posts.at(-1), {
		path: '/signals/40/answered',
		body: { activityAt: iso(T0), promptAt: iso(T0 + 4_000) },
	})
	resolver.stop()
})

test('resolver.polled reads user entries from Okena transcript pages only', async () => {
	const daemon = fakeDaemon(() => [ask({ id: 50 })])
	const resolver = new SignalsAskResolver({ request: daemon.request, now: () => T0 - 1, timers: fakeTimers() })
	resolver.start()
	await resolver.refresh()
	const page = (entries: unknown[]) => ({
		ok: true as const,
		body: { session_id: 's', entries, cursor: 10, reset: false },
	})
	const entry = { kind: 'user', uuid: 'p-1', timestamp: iso(T0 + 1_000), text: 'Jo.', origin: 'terminal' }
	resolver.polled({
		type: 'poll',
		source: 'helm',
		profile: 'p',
		state: { ok: true, body: {} },
		terminals: [{ terminalId: TERMINAL, detail: { ok: true, body: {} }, transcript: page([entry]) }],
	})
	resolver.polled({
		type: 'poll',
		source: 'okena',
		profile: 'p',
		state: { ok: true, body: {} },
		terminals: [
			{ terminalId: TERMINAL, detail: { ok: true, body: {} } },
			{ terminalId: TERMINAL, detail: { ok: true, body: {} }, transcript: { ok: false, error: 'down' } },
			{ terminalId: TERMINAL, detail: { ok: true, body: {} }, transcript: { ok: true, body: { nope: 1 } } },
			{
				terminalId: TERMINAL,
				detail: { ok: true, body: {} },
				transcript: page([{ kind: 'assistant', uuid: 'x', text: 'Hotovo?' }]),
			},
		],
	})
	await settle()
	assert.equal(daemon.posts.length, 0)
	resolver.polled({
		type: 'poll',
		source: 'okena',
		profile: 'p',
		state: { ok: true, body: {} },
		terminals: [{ terminalId: TERMINAL, detail: { ok: true, body: {} }, transcript: page([entry]) }],
	})
	await settle()
	assert.deepEqual(
		daemon.posts.map(post => post.path),
		['/signals/50/answered'],
	)
	resolver.stop()
})
