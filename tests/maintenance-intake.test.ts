import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { ItemStore } from '../src/items/store.js'
import { Poller } from '../src/poller/poller.js'
import type { ProfileRuntime } from '../src/profiles/store.js'
import { ContemberProvider } from '../src/providers/contember.js'
import type { DiscoveredTask, TaskProvider } from '../src/providers/provider.js'

const initial = '2025-01-01T00:00:00.000Z'
const boundary = '2025-01-02T00:00:00.000Z'
const later = '2025-01-03T00:00:00.000Z'
const providerConfig = {
	type: 'contember' as const,
	apiBaseUrl: 'https://provider.invalid',
	projectSlug: 'fixture',
	apiToken: 'fixture-only',
	statuses: ['new'],
}
const config = configSchema.parse({
	provider: providerConfig,
	projects: [{ slug: 'fixture', repoPath: '/fixture', baseBranch: 'main' }],
	polling: { intervalSeconds: 60, since: initial },
})
const task = (id: string, createdAt = boundary): DiscoveredTask => ({ externalId: id, title: id, createdAt })
const provider = (overrides: Partial<TaskProvider>): TaskProvider => ({
	name: 'Fixture',
	pollNewTasks: async () => [],
	getTaskContext: async () => null,
	resolveTaskSummary: async () => null,
	postComment: async () => null,
	...overrides,
})
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(yes => {
		resolve = yes
	})
	return { promise, resolve }
}
async function withDb(run: (db: DB) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), 'hi-'))
	const db = new DB(join(root, 'helm.db'))
	try {
		await run(db)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
}
function runtime(id: string): ProfileRuntime {
	return {
		profile: {
			id,
			name: id,
			createdAt: initial,
			enabledProjects: ['fixture'],
			knowledgeBindings: [],
			archivedAt: null,
		},
		generation: 1,
		rootDir: '/fixture',
		dbPath: '/fixture/helm.db',
		attachmentsDir: '/fixture/attachments',
		logsDir: '/fixture/logs',
	}
}

// This fixture interprets the exact approved keyset variables and checks the query
// predicates separately. It does not attest a deployed Contember schema/API.
test('Contember consumes >50 equal timestamps and a duplicate first page with one finite horizon', async t => {
	const rows = Array.from({ length: 125 }, (_, index) => ({
		id: String(index).padStart(4, '0'),
		title: `task ${index}`,
		createdAt: boundary,
	}))
	const requests: Array<{
		query: string
		variables: { createdAfter: string; createdThrough: string; afterId?: string }
	}> = []
	t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const request = JSON.parse(String(init?.body)) as (typeof requests)[number]
		requests.push(request)
		assert.match(request.query, /orderBy: \[\{ createdAt: asc \}, \{ id: asc \}\]/)
		assert.match(request.query, /createdAt: \{ lte: \$createdThrough \}/)
		assert.match(request.query, /limit: 50/)
		if (request.variables.afterId !== undefined) {
			assert.match(request.query, /createdAt: \{ gt: \$createdAfter \}/)
			assert.match(request.query, /createdAt: \{ eq: \$createdAfter \}/)
			assert.match(request.query, /id: \{ gt: \$afterId \}/)
		} else assert.match(request.query, /createdAt: \{ gte: \$createdAfter \}/)
		const v = request.variables
		const selected = rows
			.filter(
				row =>
					row.createdAt <= v.createdThrough &&
					(row.createdAt > v.createdAfter ||
						(row.createdAt === v.createdAfter && (v.afterId === undefined || row.id > v.afterId))),
			)
			.slice(0, 50)
		// New arrivals after the captured horizon cannot extend this traversal.
		rows.push({
			id: `future-${requests.length}`,
			title: 'future',
			createdAt: new Date(Date.parse(v.createdThrough) + 1).toISOString(),
		})
		return Response.json({ data: { listTask: selected } })
	})
	await withDb(async db => {
		const commands = new ItemCommands(db.items, config)
		for (const row of rows.slice(0, 50))
			commands.createSolveItem({
				projectSlug: 'fixture',
				title: row.title,
				source: { provider: 'Contember', externalId: row.id },
			})
		const poller = new Poller(config, db, new ContemberProvider(providerConfig))
		await poller.pollOnce()
		assert.equal(requests.length, 3)
		assert.equal(new Set(requests.map(r => r.variables.createdThrough)).size, 1)
		assert.deepEqual(
			requests.map(r => r.variables.afterId),
			[undefined, '0049', '0099'],
		)
		for (const row of rows.slice(0, 125)) assert.ok(db.items.findBySourceExternalId(row.id))
		assert.equal(db.items.findBySourceExternalId('future-1'), null)
		assert.equal(db.getPollState('fixture')?.lastTaskSeen, boundary)
	})
})

test('Poller advances duplicate-only observed pages before requesting the next page', async () => {
	await withDb(async db => {
		new ItemCommands(db.items, config).createSolveItem({
			projectSlug: 'fixture',
			title: 'duplicate',
			source: { provider: 'Fixture', externalId: 'duplicate' },
		})
		const poller = new Poller(
			config,
			db,
			provider({
				pollNewTasks: async () => {
					throw new Error('paged capability must win')
				},
				async *pollNewTaskPages() {
					yield [task('duplicate')]
					assert.equal(db.getPollState('fixture')?.lastTaskSeen, boundary)
					yield [task('next', later)]
				},
			}),
		)
		await poller.pollOnce()
		assert.ok(db.items.findBySourceExternalId('next'))
		assert.equal(db.getPollState('fixture')?.lastTaskSeen, later)
	})
})

test('failed partial page retains its boundary; a restarted poller deduplicates admitted rows', async t => {
	await withDb(async db => {
		const create = ItemStore.prototype.create
		let fail = true
		t.mock.method(ItemStore.prototype, 'create', function (this: ItemStore, ...args: Parameters<ItemStore['create']>) {
			if (fail && args[0].source?.externalId === 'second') throw new Error('injected row failure')
			return create.apply(this, args)
		})
		const pages = provider({
			async *pollNewTaskPages() {
				yield [task('first'), task('second', later)]
			},
		})
		await new Poller(config, db, pages).pollOnce()
		assert.ok(db.items.findBySourceExternalId('first'))
		const firstId = db.items.findBySourceExternalId('first')?.id
		assert.equal(db.getPollState('fixture'), null)
		fail = false
		await new Poller(config, db, pages).pollOnce()
		assert.equal(db.items.findBySourceExternalId('first')?.id, firstId)
		assert.ok(db.items.findBySourceExternalId('second'))
		assert.equal(db.getPollState('fixture')?.lastTaskSeen, later)
	})
})

test('provider traversal failure preserves the last complete page and restart continues inclusively', async () => {
	await withDb(async db => {
		await new Poller(
			config,
			db,
			provider({
				async *pollNewTaskPages() {
					yield [task('first')]
					throw new Error('page unavailable')
				},
			}),
		).pollOnce()
		assert.equal(db.getPollState('fixture')?.lastTaskSeen, boundary)
		const id = db.items.findBySourceExternalId('first')?.id
		await new Poller(
			config,
			db,
			provider({
				async *pollNewTaskPages(_project, since) {
					assert.equal(since, boundary)
					yield [task('first'), task('same-time')]
				},
			}),
		).pollOnce()
		assert.equal(db.items.findBySourceExternalId('first')?.id, id)
		assert.ok(db.items.findBySourceExternalId('same-time'))
	})
})

test('Poller coalesces A → B → A while a poll is admitted and owns only one successor timer', async t => {
	const timers = new Map<number, () => void>()
	let nextTimer = 0
	t.mock.method(globalThis, 'setTimeout', (callback: () => void) => {
		const id = ++nextTimer
		timers.set(id, callback)
		return id as unknown as NodeJS.Timeout
	})
	t.mock.method(globalThis, 'clearTimeout', (id: NodeJS.Timeout) => {
		timers.delete(id as unknown as number)
	})
	await withDb(async db => {
		let active = runtime('work')
		const held = deferred<DiscoveredTask[]>()
		let calls = 0
		const poller = new Poller(
			config,
			db,
			provider({
				pollNewTasks: async () => {
					calls++
					return calls === 1 ? held.promise : [task(`call-${calls}`, initial)]
				},
			}),
			undefined,
			() => active,
		)
		try {
			poller.start()
			poller.setWatching(true)
			const first = poller.pollOnce()
			await turn()
			active = runtime('profile-000000000001')
			poller.profileChanged()
			active = runtime('work')
			poller.profileChanged()
			assert.equal(calls, 1)
			assert.equal(timers.size, 0)
			held.resolve([task('original')])
			await first
			await poller.pollOnce()
			assert.equal(calls, 2)
			assert.equal(db.forProfile('work').getPollState('fixture')?.lastTaskSeen, boundary)
			assert.equal(db.forProfile('profile-000000000001').getPollState('fixture'), null)
			assert.equal(timers.size, 1)
			const firstTimer = [...timers][0]
			assert.ok(firstTimer)
			const [id, callback] = firstTimer
			timers.delete(id)
			callback()
			await poller.pollOnce()
			assert.equal(calls, 3)
			assert.equal(timers.size, 1)
		} finally {
			held.resolve([])
			await poller.stop()
		}
		assert.equal(timers.size, 0)
	})
})

test('a hidden task sidebar does not poll the provider', async () => {
	await withDb(async db => {
		let calls = 0
		const poller = new Poller(
			config,
			db,
			provider({
				pollNewTasks: async () => {
					calls += 1
					return [task('seen')]
				},
			}),
		)
		try {
			poller.start()
			await turn()
			assert.equal(calls, 0)
			poller.profileChanged()
			await turn()
			assert.equal(calls, 0)
			poller.setWatching(true)
			await poller.pollOnce()
			assert.equal(calls, 1)
			poller.setWatching(false)
			await turn()
			assert.equal(calls, 1)
		} finally {
			await poller.stop()
		}
	})
})

test('profile changes retain the original tenant and the coalesced wake captures the latest tenant', async () => {
	await withDb(async db => {
		let active = runtime('work')
		const held = deferred<DiscoveredTask[]>()
		let calls = 0
		const poller = new Poller(
			config,
			db,
			provider({ pollNewTasks: async () => (++calls === 1 ? held.promise : [task('new-profile', later)]) }),
			undefined,
			() => active,
		)
		try {
			poller.start()
			poller.setWatching(true)
			const first = poller.pollOnce()
			await turn()
			active = runtime('profile-000000000001')
			poller.profileChanged()
			held.resolve([task('original')])
			await first
			await poller.pollOnce()
			assert.ok(db.forProfile('work').items.findBySourceExternalId('original'))
			assert.equal(db.forProfile('work').items.findBySourceExternalId('new-profile'), null)
			assert.ok(db.forProfile(active.profile.id).items.findBySourceExternalId('new-profile'))
		} finally {
			held.resolve([])
			await poller.stop()
		}
	})
})

test('stop aborts paged traversal and fences late generic provider results until restart', async () => {
	await withDb(async db => {
		const held = deferred<DiscoveredTask[]>()
		let observedSignal: AbortSignal | undefined
		const poller = new Poller(
			config,
			db,
			provider({
				async *pollNewTaskPages(_project, _since, signal) {
					observedSignal = signal
					yield [task('committed')]
					yield await held.promise
				},
			}),
		)
		const flight = poller.pollOnce()
		await turn()
		const stopped = poller.stop()
		assert.equal(observedSignal?.aborted, true)
		held.resolve([task('late', later)])
		await stopped
		await flight
		assert.equal(db.items.findBySourceExternalId('late'), null)
		assert.equal(db.getPollState('fixture')?.lastTaskSeen, boundary)
		await poller.pollOnce()
		assert.equal(db.items.findBySourceExternalId('late'), null)

		const legacyHeld = deferred<DiscoveredTask[]>()
		const legacy = new Poller(config, db, provider({ pollNewTasks: () => legacyHeld.promise }))
		void legacy.pollOnce()
		await turn()
		const drain = legacy.stop()
		legacyHeld.resolve([task('legacy-late', later)])
		await drain
		assert.equal(db.items.findBySourceExternalId('legacy-late'), null)
		try {
			legacy.start()
			await legacy.pollOnce()
			assert.ok(db.items.findBySourceExternalId('legacy-late'))
		} finally {
			await legacy.stop()
		}
	})
})

test('Contember threads cancellation into fetch and admits no further page after abort', async t => {
	const controller = new AbortController()
	let calls = 0
	t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		calls++
		assert.equal(init?.signal, controller.signal)
		return Response.json({
			data: {
				listTask: Array.from({ length: 50 }, (_, n) => ({
					id: String(n).padStart(4, '0'),
					title: 'task',
					createdAt: boundary,
				})),
			},
		})
	})
	const pages = new ContemberProvider(providerConfig)
		.pollNewTaskPages('fixture', initial, controller.signal)
		[Symbol.asyncIterator]()
	assert.equal((await pages.next()).value?.length, 50)
	controller.abort()
	await assert.rejects(pages.next(), { name: 'AbortError' })
	assert.equal(calls, 1)
	await assert.rejects(
		new ContemberProvider(providerConfig)
			.pollNewTaskPages('fixture', initial, controller.signal)
			[Symbol.asyncIterator]()
			.next(),
		{ name: 'AbortError' },
	)
	assert.equal(calls, 1)
})
