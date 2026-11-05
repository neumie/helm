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
	SignalEventsPage,
	SignalObservation,
	SignalSourceHealth,
	SignalThread,
	SignalsSnapshot,
} from '../src/signals/contract.js'

const NOW = new Date('2026-11-05T10:00:00.000Z')

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
	post: (path: string, body?: unknown) => Promise<Response>
	db: DB
	store: ProfileStore
	pollRequests: () => number
	clock: { now: Date }
}

async function withSignalsApi(run: (harness: Harness) => Promise<void>) {
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
				now: () => clock.now,
				eventPollMs: 10,
			},
		},
	})
	const request = (path: string, init?: RequestInit) => Promise.resolve(api.request(path, init))
	const post = (path: string, body?: unknown) =>
		request(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
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
	db.forProfile(db.currentProfileId()).signals.applyPoll(
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

test('requests read and write the active profile only', async () => {
	await withSignalsApi(async ({ request, post, db, store }) => {
		seed(db, [1])
		const workId = db.signals.list({}, NOW)[0]?.id ?? 0
		const other = store.create('Personal')
		store.activate(other.id)
		assert.equal(db.currentProfileId(), other.id)
		assert.equal((await data<SignalsSnapshot>(await request('/signals'))).threads.length, 0)
		assert.equal((await request(`/signals/${workId}`)).status, 404)
		assert.equal((await post(`/signals/${workId}`, { state: 'done' })).status, 404)
	})
})
