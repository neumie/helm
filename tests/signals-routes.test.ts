import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type HelmConfig, configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ProfileStore } from '../src/profiles/store.js'
import { apiRoutes } from '../src/server/routes/api.js'
import type {
	SignalAskResult,
	SignalEventsPage,
	SignalFilteredPage,
	SignalIncludeResult,
	SignalObservation,
	SignalSourceHealth,
	SignalThread,
	SignalsSnapshot,
} from '../src/signals/contract.js'
import { type IncludeSender, IncludeSenderError } from '../src/signals/include-sender.js'
import { SIGNAL_OPEN_ASKS_MAX } from '../src/signals/store.js'

const NOW = new Date('2026-11-05T10:00:00.000Z')
/** The daemon's local control token, as only Helm's main process holds it. */
const CONTROL_TOKEN = 'C'.repeat(43)

const config: HelmConfig = configSchema.parse({
	provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
	projects: [{ slug: 'work', repoPath: '/work' }],
})

function observation(number: number): SignalObservation {
	return {
		threadKey: `github:acme/widgets#${number}`,
		source: 'github',
		kind: 'review',
		reasons: ['review'],
		ref: `widgets#${number}`,
		fullRef: `acme/widgets#${number}`,
		title: `Widget ${number}`,
		head: 'review requested · reviewer-a',
		actor: 'reviewer-a',
		url: `https://github.com/acme/widgets/pull/${number}`,
		repo: 'acme/widgets',
		number,
		branch: null,
		activityKey: 'k1',
		lastActivityAt: NOW.toISOString(),
	}
}

interface Harness {
	request: (path: string, init?: RequestInit) => Promise<Response>
	/** `jakub: true` sends the local control token, as Helm's main process does. */
	post: (path: string, body?: unknown, options?: { jakub?: boolean }) => Promise<Response>
	db: DB
	store: ProfileStore
	pollRequests: () => number
	clock: { now: Date }
}

async function withSignalsApi(
	run: (harness: Harness) => Promise<void>,
	options: { includeSender?: IncludeSender | null } = {},
) {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-routes-'))
	const store = new ProfileStore(root, ['work'])
	const db = new DB(store.activeRuntime().dbPath, () => store.activeProfile().id)
	let polls = 0
	const clock = { now: NOW }
	const api = apiRoutes({
		config,
		configPath: join(root, 'helm.config.json'),
		db,
		queue: {} as never,
		poller: {} as never,
		provider: { name: 'fake' } as never,
		spawner: { name: 'fake' } as never,
		enricher: {} as never,
		profileContext: {
			store,
			localControlToken: CONTROL_TOKEN,
			runtime: () => store.activeRuntime(),
			signals: {
				watcher: {
					requestPoll: () => {
						polls += 1
					},
					health: (stored: SignalSourceHealth[]) =>
						stored.map(entry =>
							entry.source === 'mail' ? { ...entry, status: 'disabled' as const, detail: null } : entry,
						),
				},
				includeSender:
					options.includeSender === null
						? undefined
						: (options.includeSender ?? (address => ({ address, added: true }))),
				now: () => clock.now,
				eventPollMs: 10,
			},
		},
	})
	const request = (path: string, init?: RequestInit) => Promise.resolve(api.request(path, init))
	const post = (path: string, body?: unknown, options: { jakub?: boolean } = {}) =>
		request(path, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(options.jakub ? { authorization: `Bearer ${CONTROL_TOKEN}` } : {}),
			},
			body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
		})
	try {
		await run({ request, post, db, store, pollRequests: () => polls, clock })
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
}

async function data<T>(response: Response): Promise<T> {
	const json = (await response.json()) as { data?: T; error?: string }
	assert.ok(json.data !== undefined, `expected data, got ${JSON.stringify(json)}`)
	return json.data
}

function seed(db: DB, numbers: number[]) {
	db.signals.applyPoll(
		{ source: 'github', observations: numbers.map(observation), complete: true, goneReason: 'gone' },
		NOW,
	)
}

test('GET /signals returns the snapshot with filters, health and cursor', async () => {
	await withSignalsApi(async ({ request, post, db }) => {
		seed(db, [1, 2])
		db.signals.setSourceHealth('github', 'ok', null, NOW, true)
		db.signals.setSourceHealth('mail', 'error', 'stale', NOW, false)
		const response = await request('/signals')
		assert.equal(response.status, 200)
		const snapshot = await data<SignalsSnapshot>(response)
		assert.equal(snapshot.threads.length, 2)
		assert.equal(snapshot.seq, db.signals.latestSeq())
		assert.equal(snapshot.generatedAt, NOW.toISOString())
		assert.deepEqual(
			snapshot.sources.map(source => [source.source, source.status]),
			[
				['github', 'ok'],
				['mail', 'disabled'],
			],
		)

		const id = snapshot.threads[0]?.id ?? 0
		await post(`/signals/${id}`, { state: 'done' })
		assert.equal((await data<SignalsSnapshot>(await request('/signals?state=new'))).threads.length, 1)
		assert.equal((await data<SignalsSnapshot>(await request('/signals?state=new,done'))).threads.length, 2)
		assert.equal((await data<SignalsSnapshot>(await request('/signals?owner=managed'))).threads.length, 0)
		assert.equal((await data<SignalsSnapshot>(await request('/signals?source=mail&all=1'))).threads.length, 0)
		assert.equal((await request('/signals?state=bogus')).status, 400)
		assert.equal((await request('/signals?owner=someone')).status, 400)
	})
})

test('GET /signals wakes snoozed threads first', async () => {
	await withSignalsApi(async ({ request, post, db, clock }) => {
		seed(db, [1])
		const id = db.signals.list({}, NOW)[0]?.id ?? 0
		const snoozed = await post(`/signals/${id}`, { state: 'snoozed', snoozedUntil: '2026-11-05T11:00:00Z' })
		assert.equal((await data<SignalThread>(snoozed)).state, 'snoozed')
		clock.now = new Date('2026-11-05T11:00:01.000Z')
		const snapshot = await data<SignalsSnapshot>(await request('/signals'))
		assert.equal(snapshot.threads[0]?.state, 'new')
	})
})

test('single thread reads and writes validate ids and bodies', async () => {
	await withSignalsApi(async ({ request, post, db }) => {
		seed(db, [1])
		const id = db.signals.list({}, NOW)[0]?.id ?? 0
		assert.equal((await data<SignalThread>(await request(`/signals/${id}`))).threadKey, 'github:acme/widgets#1')
		assert.equal((await request('/signals/0')).status, 400)
		assert.equal((await request('/signals/abc')).status, 400)
		const missing = await request('/signals/9999')
		assert.equal(missing.status, 404)
		assert.deepEqual(await missing.json(), { error: 'Signal not found' })

		assert.equal((await post(`/signals/${id}`, {})).status, 400, 'nothing to change')
		assert.equal((await post(`/signals/${id}`, { state: 'seen', extra: 1 })).status, 400, 'strict body')
		assert.equal((await post(`/signals/${id}`, '{not json')).status, 400)
		assert.equal((await post(`/signals/${id}`, { state: 'snoozed' })).status, 400, 'snooze needs a time')
		assert.equal((await post('/signals/9999', { state: 'seen' })).status, 404)
		const big = await post(`/signals/${id}`, { managedBy: 'x'.repeat(20_000) })
		assert.equal(big.status, 413)

		const managed = await data<SignalThread>(await post(`/signals/${id}`, { owner: 'managed', managedBy: 'agent-a' }))
		assert.equal(managed.owner, 'managed')
		assert.equal(managed.managedBy, 'agent-a')

		const noted = await data<SignalThread>(await post(`/signals/${id}/note`, { note: 'Answered the reviewer' }))
		assert.equal(noted.note, 'Answered the reviewer')
		assert.equal((await post(`/signals/${id}/note`, { note: '' })).status, 400)

		const routed = await data<SignalThread>(
			await post(`/signals/${id}/routed`, { agent: 'widget-fix', how: 'started' }),
		)
		assert.equal(routed.routedAgent, 'widget-fix')
		assert.equal(routed.routedHow, 'started')
		assert.equal(routed.state, 'seen')
		assert.equal((await post(`/signals/${id}/routed`, { agent: 'a', how: 'teleported' })).status, 400)

		await post(`/signals/${id}`, { state: 'new' })
		assert.equal((await data<SignalThread>(await post(`/signals/${id}/seen`))).state, 'seen')
		assert.equal((await post('/signals/9999/seen')).status, 404)
	})
})

test('events long-poll returns at once when events exist and waits otherwise', async () => {
	await withSignalsApi(async ({ request, db }) => {
		seed(db, [1, 2])
		const page = await data<SignalEventsPage>(await request('/signals/events?after=0'))
		assert.equal(page.events.length, 2)
		assert.equal(page.seq, page.events[1]?.seq)
		assert.equal(page.events[0]?.type, 'created')
		assert.equal(page.events[0]?.detail.owner, 'jakub')

		const empty = await data<SignalEventsPage>(await request(`/signals/events?after=${page.seq}`))
		assert.deepEqual(empty, { events: [], seq: page.seq })

		const started = Date.now()
		const waiting = request(`/signals/events?after=${page.seq}&wait=5`)
		await new Promise(resolve => setTimeout(resolve, 40))
		seed(db, [3])
		const woke = await data<SignalEventsPage>(await waiting)
		assert.equal(woke.events.length, 1)
		assert.ok(Date.now() - started < 4_000, 'returns as soon as an event lands')

		const controller = new AbortController()
		const aborted = request(`/signals/events?after=${woke.seq}&wait=25`, { signal: controller.signal })
		setTimeout(() => controller.abort(), 30)
		const abortedStart = Date.now()
		const abortedPage = await data<SignalEventsPage>(await aborted)
		assert.deepEqual(abortedPage.events, [])
		assert.ok(Date.now() - abortedStart < 4_000, 'an aborted request stops waiting')

		assert.equal((await request('/signals/events?wait=26')).status, 400)
		assert.equal((await request('/signals/events?after=-1')).status, 400)
	})
})

test('POST /signals/poll asks the watcher', async () => {
	await withSignalsApi(async ({ post, pollRequests }) => {
		assert.deepEqual(await data<{ requested: boolean }>(await post('/signals/poll')), { requested: true })
		assert.equal(pollRequests(), 1)
	})
})

test('signals are global: switching the Helm profile shows and edits the same inbox', async () => {
	await withSignalsApi(async ({ request, post, db, store }) => {
		seed(db, [1])
		const workId = db.signals.list({}, NOW)[0]?.id ?? 0
		const other = store.create('Personal')
		store.activate(other.id)
		assert.equal(db.currentProfileId(), other.id)
		assert.equal((await data<SignalsSnapshot>(await request('/signals'))).threads.length, 1)
		assert.equal((await request(`/signals/${workId}`)).status, 200)
		assert.equal((await post(`/signals/${workId}`, { state: 'done' })).status, 200)
		assert.equal(db.forProfile('work').signals.get(workId)?.state, 'done')
	})
})

function seedFiltered(db: DB) {
	db.signals.applyPoll(
		{
			source: 'mail',
			observations: [],
			complete: true,
			goneReason: 'no longer unread in the inbox',
			filtered: {
				keptKeys: [],
				entries: [
					{
						messageKey: 'ooo@psyon.example',
						senderName: 'Petra',
						senderAddress: 'petra_at_psyon_example_aa_bb@privaterelay.appleid.com',
						senderIdentity: 'petra@psyon.example',
						subject: 'Out of office',
						reason: 'auto-reply',
						mailbox: null,
						url: 'message://%3Cooo%40psyon.example%3E',
						receivedAt: new Date(NOW.getTime() - 60_000).toISOString(),
					},
					{
						messageKey: 'news@news.example',
						senderName: 'News',
						senderAddress: 'digest@news.example',
						senderIdentity: 'digest@news.example',
						subject: 'Weekly',
						reason: 'newsletter',
						mailbox: 'Clientcare',
						url: null,
						receivedAt: new Date(NOW.getTime() - 120_000).toISOString(),
					},
				],
			},
		},
		NOW,
	)
}

test('GET /signals carries the filtered count; GET /signals/filtered lists heads newest first', async () => {
	await withSignalsApi(async ({ request, db }) => {
		assert.equal((await data<SignalsSnapshot>(await request('/signals'))).filteredCount, 0)
		seedFiltered(db)
		assert.equal((await data<SignalsSnapshot>(await request('/signals'))).filteredCount, 2)
		const page = await data<SignalFilteredPage>(await request('/signals/filtered'))
		assert.equal(page.total, 2)
		assert.equal(page.retentionDays, 7)
		assert.deepEqual(
			page.entries.map(entry => [entry.subject, entry.reason, entry.mailbox]),
			[
				['Out of office', 'auto-reply', null],
				['Weekly', 'newsletter', 'Clientcare'],
			],
		)
		// `filtered` is a static path, never parsed as a thread id.
		assert.equal((await request('/signals/filtered')).status, 200)
	})
})

test('POST /signals/filtered/:id/include adds the decoded sender, forgets its rows and asks for a poll', async () => {
	const included: string[] = []
	await withSignalsApi(
		async ({ request, post, db, pollRequests }) => {
			seedFiltered(db)
			const page = await data<SignalFilteredPage>(await request('/signals/filtered'))
			const ooo = page.entries[0]
			assert.ok(ooo)
			const response = await post(`/signals/filtered/${ooo.id}/include`, {})
			assert.equal(response.status, 200)
			assert.deepEqual(await data<SignalIncludeResult>(response), { address: 'petra@psyon.example', added: true })
			assert.deepEqual(included, ['petra@psyon.example'])
			assert.equal(pollRequests(), 1)
			assert.equal((await data<SignalsSnapshot>(await request('/signals'))).filteredCount, 1)
			// Gone from the log now: 404, and nothing written.
			assert.equal((await post(`/signals/filtered/${ooo.id}/include`, {})).status, 404)
			assert.equal((await post('/signals/filtered/abc/include', {})).status, 400)
			assert.equal((await post('/signals/filtered/0/include', {})).status, 400)
			assert.equal(included.length, 1)
		},
		{
			includeSender: address => {
				included.push(address)
				return { address, added: true }
			},
		},
	)
})

test('include errors: a refused address is 400, a failed write 500, no writer 503; the row stays', async () => {
	await withSignalsApi(
		async ({ request, post, db, pollRequests }) => {
			seedFiltered(db)
			const id = (await data<SignalFilteredPage>(await request('/signals/filtered'))).entries[0]?.id ?? 0
			const response = await post(`/signals/filtered/${id}/include`, {})
			assert.equal(response.status, 400)
			assert.match(((await response.json()) as { error: string }).error, /include list is full/)
			assert.equal(pollRequests(), 0)
			assert.equal((await data<SignalsSnapshot>(await request('/signals'))).filteredCount, 2)
		},
		{
			includeSender: () => {
				throw new IncludeSenderError('The include list is full. Remove senders in Settings › Signals first')
			},
		},
	)
	await withSignalsApi(
		async ({ request, post, db }) => {
			seedFiltered(db)
			const id = (await data<SignalFilteredPage>(await request('/signals/filtered'))).entries[0]?.id ?? 0
			assert.equal((await post(`/signals/filtered/${id}/include`, {})).status, 500)
		},
		{
			includeSender: () => {
				throw new Error('EACCES')
			},
		},
	)
	await withSignalsApi(
		async ({ request, post, db }) => {
			seedFiltered(db)
			const id = (await data<SignalFilteredPage>(await request('/signals/filtered'))).entries[0]?.id ?? 0
			assert.equal((await post(`/signals/filtered/${id}/include`, {})).status, 503)
		},
		{ includeSender: null },
	)
})

test('agent asks: add, upsert by key, read by key, reply and done by id or key', async () => {
	await withSignalsApi(async ({ request, post, db, clock }) => {
		const ask = {
			key: 'dispatcher:pick',
			title: 'Pick a variant',
			body: 'A or B?',
			links: ['https://storybook.test/?path=/story/a'],
			from: 'dispatcher',
			terminal: '01234567-89ab-4def-8123-456789abcdef',
		}
		const created = await data<SignalAskResult>(await post('/signals/asks', ask))
		assert.equal(created.outcome, 'created')
		assert.equal(created.thread.source, 'agent')
		assert.equal(created.thread.askTerminal, ask.terminal)
		const id = created.thread.id
		assert.equal((await data<SignalAskResult>(await post('/signals/asks', ask))).outcome, 'unchanged')
		clock.now = new Date('2026-11-05T10:05:00.000Z')
		const renewed = await data<SignalAskResult>(await post('/signals/asks', { ...ask, body: 'A, B or C?' }))
		assert.equal(renewed.outcome, 'renewed')
		assert.equal(renewed.thread.id, id)
		const unkeyed = await data<SignalAskResult>(await post('/signals/asks', { title: 'Approve?' }))
		assert.equal(unkeyed.outcome, 'created')
		assert.notEqual(unkeyed.thread.id, id)

		assert.equal((await data<SignalThread>(await request('/signals/asks?key=dispatcher:pick'))).id, id)
		const missing = await request('/signals/asks?key=nope')
		assert.equal(missing.status, 404)
		assert.deepEqual(await missing.json(), { error: 'Signal not found' })
		assert.equal((await request('/signals/asks?key=bad%20key')).status, 400)
		assert.equal((await request('/signals/asks')).status, 400)

		// The snapshot lists asks; health stays poll sources only.
		const snapshot = await data<SignalsSnapshot>(await request('/signals?source=agent'))
		assert.equal(snapshot.threads.length, 2)
		assert.deepEqual(
			snapshot.sources.map(source => source.source),
			['github', 'mail'],
		)

		// Only Helm (the local control token) records Jakub's reply and its replied receipt: no agent
		// can answer another agent's ask in his name.
		for (const [path, body] of [
			[`/signals/${id}/reply`, { text: 'Forged' }],
			[`/signals/${id}/routed`, { agent: 'dispatcher', how: 'replied' }],
		] as const) {
			const forged = await post(path, body)
			assert.equal(forged.status, 401, path)
			assert.deepEqual(await forged.json(), { error: 'Only Helm can record Jakub’s reply' })
		}
		assert.equal(db.signals.get(id)?.reply ?? null, null, 'nothing was recorded')
		const wrongToken = await request(`/signals/${id}/reply`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${'D'.repeat(43)}` },
			body: JSON.stringify({ text: 'Forged' }),
		})
		assert.equal(wrongToken.status, 401)

		const replied = await data<SignalThread>(await post(`/signals/${id}/reply`, { text: 'Variant B' }, { jakub: true }))
		assert.equal(replied.reply, 'Variant B')
		assert.equal(replied.state, 'seen')
		const routed = await data<SignalThread>(
			await post(`/signals/${id}/routed`, { agent: 'dispatcher', how: 'replied' }, { jakub: true }),
		)
		assert.equal(routed.routedHow, 'replied')

		const done = await data<SignalThread>(await post(`/signals/${id}/done`, {}))
		assert.equal(done.state, 'done')
		assert.equal(done.closedReason, 'closed by the agent')
		const byKey = await data<SignalThread>(
			await post('/signals/asks/done', { key: 'dispatcher:pick', note: 'Went with B' }),
		)
		assert.equal(byKey.id, id)
		assert.equal(byKey.note, 'Went with B')
		const noted = await data<SignalThread>(await post(`/signals/${unkeyed.thread.id}/done`, { note: 'Approved' }))
		assert.equal(noted.state, 'done')
		assert.equal(noted.note, 'Approved')
		assert.equal(db.signals.get(unkeyed.thread.id)?.state, 'done')
	})
})

test('a close through Helm (control token) is recorded as Jakub, any other as an agent', async () => {
	await withSignalsApi(async ({ post, db }) => {
		seed(db, [1, 2, 3])
		const [one, two, three] = [1, 2, 3].map(n => db.signals.getByThreadKey(`github:acme/widgets#${n}`)?.id ?? 0)
		const byJakub = await data<SignalThread>(await post(`/signals/${one}`, { state: 'done' }, { jakub: true }))
		assert.equal(byJakub.closedBy, 'jakub')
		const byAgent = await data<SignalThread>(await post(`/signals/${two}`, { state: 'done' }))
		assert.equal(byAgent.closedBy, 'agent')
		const doneByAgent = await data<SignalThread>(await post(`/signals/${three}/done`, { note: 'Merged' }))
		assert.equal(doneByAgent.closedBy, 'agent')
		assert.equal(doneByAgent.note, 'Merged')
		const reopened = await data<SignalThread>(await post(`/signals/${one}`, { state: 'seen' }, { jakub: true }))
		assert.equal(reopened.closedBy, null)
	})
})

test('a new agent ask beyond the open cap is refused with 429; its key can still be renewed', async () => {
	await withSignalsApi(async ({ post, db }) => {
		for (let n = 0; n < SIGNAL_OPEN_ASKS_MAX; n++) db.signals.upsertAsk({ key: `ask-${n}`, title: `Ask ${n}` }, NOW)
		const refused = await post('/signals/asks', { title: 'One too many' })
		assert.equal(refused.status, 429)
		assert.deepEqual(await refused.json(), {
			error: 'Too many open agent asks (50). Close some with helm signal done.',
		})
		assert.equal(db.signals.list({ source: 'agent' }, NOW).length, SIGNAL_OPEN_ASKS_MAX, 'nothing was stored')
		const renewed = await data<SignalAskResult>(await post('/signals/asks', { key: 'ask-0', title: 'Ask 0, again' }))
		assert.equal(renewed.outcome, 'renewed')
		await data<SignalThread>(await post('/signals/asks/done', { key: 'ask-1' }))
		assert.equal((await data<SignalAskResult>(await post('/signals/asks', { title: 'Fits' }))).outcome, 'created')
	})
})

test('agent ask routes validate their bodies and map errors', async () => {
	await withSignalsApi(async ({ post, db }) => {
		seed(db, [1])
		const prId = db.signals.list({}, NOW)[0]?.id ?? 0
		const bad = async (path: string, body: unknown, status = 400) =>
			assert.equal(
				(await post(path, body, { jakub: path.endsWith('/reply') })).status,
				status,
				`${path} ${JSON.stringify(body)}`,
			)

		await bad('/signals/asks', {})
		await bad('/signals/asks', { title: '' })
		await bad('/signals/asks', { title: 'two\nlines' })
		await bad('/signals/asks', { title: 'x'.repeat(201) })
		await bad('/signals/asks', { title: 'T', body: 'b'.repeat(1001) })
		await bad('/signals/asks', { title: 'T', links: ['javascript:alert(1)'] })
		for (const link of ['https://evil.com\\.github.com/x', 'http:evil.com', 'https:/\\evil.com'])
			await bad('/signals/asks', { title: 'T', links: [link] })
		await bad('/signals/asks', { title: 'T', links: Array.from({ length: 9 }, (_, n) => `https://ok.test/${n}`) })
		await bad('/signals/asks', { title: 'T', key: 'has space' })
		await bad('/signals/asks', { title: 'T', terminal: 'pane-1' })
		await bad('/signals/asks', { title: 'T', extra: true })
		await bad('/signals/asks', '{not json')
		await bad('/signals/asks', { title: 'T', body: 'x'.repeat(20_000) }, 413)
		assert.equal(db.signals.list({ source: 'agent' }, NOW).length, 0, 'nothing was stored')

		await bad('/signals/asks/done', {})
		await bad('/signals/asks/done', { key: 'nope' }, 404)
		await bad('/signals/asks/done', { key: 'k', note: '' })
		await bad('/signals/abc/done', {})
		await bad('/signals/9999/done', {}, 404)
		await bad(`/signals/${prId}/done`, { note: 'x'.repeat(301) })
		await bad(`/signals/${prId}/done`, { reason: 'x' })

		const ask = db.signals.upsertAsk({ title: 'Q' }, NOW).thread
		await bad(`/signals/${ask.id}/reply`, {})
		await bad(`/signals/${ask.id}/reply`, { text: '   ' })
		await bad(`/signals/${ask.id}/reply`, { text: 'x'.repeat(2001) })
		await bad(`/signals/${ask.id}/reply`, { text: '\u0007' })
		await bad('/signals/9999/reply', { text: 'hi' }, 404)
		await bad('/signals/0/reply', { text: 'hi' })
		const notAsk = await post(`/signals/${prId}/reply`, { text: 'hi' }, { jakub: true })
		assert.equal(notAsk.status, 400)
		assert.deepEqual(await notAsk.json(), { error: 'Only agent asks take a reply' })
		// A GitHub thread can still be closed with done.
		assert.equal((await data<SignalThread>(await post(`/signals/${prId}/done`, {}))).closedReason, null)
	})
})
