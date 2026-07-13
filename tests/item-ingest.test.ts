import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
	attachmentsDir,
	isOpenableAttachment,
	sanitizeAttachmentName,
	saveAttachment,
} from '../src/attachments/store.js'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { localizeCapturedAttachments } from '../src/items/context.js'
import type { TaskContext } from '../src/providers/provider.js'
import { apiRoutes } from '../src/server/routes/api.js'

const config: HelmConfig = {
	provider: {
		type: 'contember',
		apiBaseUrl: 'https://example.test',
		projectSlug: 'helm',
		apiToken: 'token',
		statuses: ['new'],
	},
	projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
	polling: { intervalSeconds: 60 },
	solver: {
		type: 'default',
		agent: 'claude',
		concurrency: 2,
		timeoutMinutes: 30,
		branchNaming: { enabled: false },
		displayName: { enabled: false },
		triage: { enabled: false },
	},
	spawner: { name: 'default' },
	server: { port: 7474, host: 'localhost' },
	github: {
		createPrs: false,
		postComments: true,
		prPrefix: '[Helm]',
		trackDeployments: false,
		deployPollSeconds: 120,
	},
}

const queue = { wake: () => undefined } as never
const poller = { pollOnce: async () => undefined } as never
const spawner = { name: 'default', startPlanningSession: async () => ({}) } as never

// A provider whose getTaskContext THROWS — proves ingested Items resolve their
// frozen capturedContext and never round-trip the active provider.
const explodingProvider = {
	name: 'Contember',
	pollNewTasks: async () => [],
	getTaskContext: async () => {
		throw new Error('provider must not be called for captured (email) Items')
	},
	resolveTaskSummary: async () => null,
	postComment: async () => null,
} as never

function makeRecordingEnricher() {
	const enqueued: string[] = []
	return { enricher: { enqueue: (items: Array<{ id: string }>) => enqueued.push(...items.map(i => i.id)) }, enqueued }
}

function withTempDb(fn: (db: DB) => Promise<void> | void) {
	const dir = mkdtempSync(join(tmpdir(), 'helm-ingest-'))
	const db = new DB(join(dir, 'helm.db'))
	return Promise.resolve(fn(db)).finally(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})
}

const PNG_1x1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64',
)

test('POST /items/ingest creates a triage source solve Item with frozen captured context + served attachment', () =>
	withTempDb(async db => {
		const { enricher, enqueued } = makeRecordingEnricher()
		const api = apiRoutes(config, 'helm.config.json', db, queue, poller, explodingProvider, spawner, enricher as never)

		const createdIds: string[] = []
		try {
			const res = await api.request('/items/ingest', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectSlug: 'helm',
					title: 'Client emailed a bug report',
					body: 'The export button 500s. Screenshot attached.',
					metadata: { From: 'client@acme.test', Date: '2026-06-30' },
					source: { label: 'Email', externalId: 'email:msg-123', url: 'https://mail.example.test/msg-123' },
					attachments: [{ name: 'screen shot.png', contentType: 'image/png', dataBase64: PNG_1x1.toString('base64') }],
				}),
			})
			assert.equal(res.status, 201)
			const { data } = (await res.json()) as {
				data: { id: string; status: string; source: { provider: string }; allowedActions: Array<{ id: string }> }
			}
			createdIds.push(data.id)

			assert.equal(data.status, 'triage')
			assert.equal(data.source.provider, 'Email')
			assert.deepEqual(
				data.allowedActions.map(a => a.id),
				['approve', 'reject'],
			)
			assert.deepEqual(enqueued, [data.id]) // queued for AI enrichment (display name + security assessment)

			// Captured context is frozen on the row.
			const stored = db.items.get(data.id)
			assert.ok(stored?.capturedContext, 'capturedContext set')
			const ctx = stored.capturedContext as TaskContext
			assert.equal(ctx.title, 'Client emailed a bug report')
			assert.equal(ctx.description, 'The export button 500s. Screenshot attached.')
			assert.equal(ctx.metadata?.From, 'client@acme.test')
			assert.equal(ctx.attachments?.length, 1)
			// Served URL is relative + same-origin under /api.
			const attUrl = ctx.attachments?.[0].url ?? ''
			assert.match(attUrl, /^\/api\/items\/.+\/attachments\/screen_shot\.png$/)

			// Detail route returns the captured context as sourceTask WITHOUT calling the provider (it would throw).
			const detail = await api.request(`/items/${data.id}`)
			assert.equal(detail.status, 200)
			const detailBody = (await detail.json()) as { data: { sourceTask: TaskContext | null } }
			assert.equal(detailBody.data.sourceTask?.title, 'Client emailed a bug report')

			// Attachment bytes are served back. The stored URL is `/api/items/...`
			// (routes mount under /api in the real app); this test calls the raw
			// apiRoutes instance, so drop the /api prefix.
			const att = await api.request(attUrl.replace(/^\/api/, ''))
			assert.equal(att.status, 200)
			assert.equal(att.headers.get('content-type'), 'image/png')
			// XSS hardening: never sniff, render inline only as a known-safe type, sandbox CSP.
			assert.equal(att.headers.get('x-content-type-options'), 'nosniff')
			assert.match(att.headers.get('content-disposition') ?? '', /^inline; filename="screen_shot\.png"$/)
			assert.match(att.headers.get('content-security-policy') ?? '', /sandbox/)
			const bytes = Buffer.from(await att.arrayBuffer())
			assert.deepEqual(bytes, PNG_1x1)
		} finally {
			for (const id of createdIds) rmSync(attachmentsDir(id), { recursive: true, force: true })
		}
	}))

test('ingested attachments are served with XSS-safe headers (declared content-type ignored)', () =>
	withTempDb(async db => {
		const { enricher } = makeRecordingEnricher()
		const api = apiRoutes(config, 'helm.config.json', db, queue, poller, explodingProvider, spawner, enricher as never)
		const createdIds: string[] = []
		try {
			const res = await api.request('/items/ingest', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectSlug: 'helm',
					title: 'Malicious attachment',
					// Attacker declares an active content-type for a script-bearing SVG.
					attachments: [
						{
							name: 'x.svg',
							contentType: 'image/svg+xml',
							dataBase64: Buffer.from(
								'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
							).toString('base64'),
						},
					],
				}),
			})
			assert.equal(res.status, 201)
			const { data } = (await res.json()) as { data: { id: string } }
			createdIds.push(data.id)
			const attUrl = (db.items.get(data.id)?.capturedContext as TaskContext).attachments?.[0].url ?? ''

			const att = await api.request(attUrl.replace(/^\/api/, ''))
			assert.equal(att.status, 200)
			// The declared image/svg+xml is IGNORED — served as a download, not active.
			assert.equal(att.headers.get('content-type'), 'application/octet-stream')
			assert.match(att.headers.get('content-disposition') ?? '', /^attachment; filename="x\.svg"$/)
			assert.equal(att.headers.get('x-content-type-options'), 'nosniff')
		} finally {
			for (const id of createdIds) rmSync(attachmentsDir(id), { recursive: true, force: true })
		}
	}))

test('POST /items/ingest is idempotent by source.externalId', () =>
	withTempDb(async db => {
		const { enricher } = makeRecordingEnricher()
		const api = apiRoutes(config, 'helm.config.json', db, queue, poller, explodingProvider, spawner, enricher as never)
		const payload = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectSlug: 'helm', title: 'Dup email', source: { externalId: 'email:dup-1' } }),
		}
		const createdIds: string[] = []
		try {
			const first = await api.request('/items/ingest', payload)
			assert.equal(first.status, 201)
			const firstId = ((await first.json()) as { data: { id: string } }).data.id
			createdIds.push(firstId)

			const second = await api.request('/items/ingest', payload)
			// Existing Item returned (200, not a new 201) and no duplicate row.
			assert.equal(second.status, 200)
			const secondId = ((await second.json()) as { data: { id: string } }).data.id
			assert.equal(secondId, firstId)
			assert.equal(db.items.list({ limit: 100 }).length, 1)
		} finally {
			for (const id of createdIds) rmSync(attachmentsDir(id), { recursive: true, force: true })
		}
	}))

test('POST /items/ingest rejects an unconfigured project', () =>
	withTempDb(async db => {
		const { enricher } = makeRecordingEnricher()
		const api = apiRoutes(config, 'helm.config.json', db, queue, poller, explodingProvider, spawner, enricher as never)
		const res = await api.request('/items/ingest', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectSlug: 'nope', title: 'Wrong project' }),
		})
		assert.equal(res.status, 400)
		assert.equal(db.items.list({ limit: 100 }).length, 0)
	}))

test('isOpenableAttachment allows documents/media but refuses executables/scripts/markup', () => {
	for (const ok of ['a.xlsx', 'b.pdf', 'c.png', 'd.csv', 'e.docx', 'f.mp4']) {
		assert.equal(isOpenableAttachment(ok), true, ok)
	}
	for (const bad of ['x.command', 'y.sh', 'z.app', 'w.scpt', 'v.html', 'u.svg', 'q', 'r.dmg']) {
		assert.equal(isOpenableAttachment(bad), false, bad)
	}
})

test('open-attachment route guards: 404 unknown item, 400 non-openable type, 404 missing file (no native open)', () =>
	withTempDb(async db => {
		const { enricher } = makeRecordingEnricher()
		const api = apiRoutes(config, 'helm.config.json', db, queue, poller, explodingProvider, spawner, enricher as never)
		const post = (path: string) => api.request(path, { method: 'POST' })

		// Unknown item → 404 (never reaches the opener).
		assert.equal((await post('/items/nope/attachments/x.pdf/open')).status, 404)

		// Real item, but a non-openable extension is rejected BEFORE any open.
		const item = new ItemCommands(db.items, config).createSolveItem({
			projectSlug: 'helm',
			title: 'Has a risky attachment name',
			prompt: 'body',
			source: { provider: 'Email', externalId: 'email:open-guard' },
			capturedContext: { title: 'x' },
		})
		assert.equal((await post(`/items/${item.id}/attachments/evil.command/open`)).status, 400)
		// Openable extension but the file isn't on disk → 404 (still no open).
		assert.equal((await post(`/items/${item.id}/attachments/missing.pdf/open`)).status, 404)
	}))

test('attachment store sanitizes names and de-dups collisions', () => {
	assert.equal(sanitizeAttachmentName('../../etc/passwd'), 'passwd')
	assert.equal(sanitizeAttachmentName('a b/c?.png'), 'c_.png')
	assert.equal(sanitizeAttachmentName(''), 'file')

	const id = `test-${Date.now()}`
	try {
		const first = saveAttachment(id, 'note.txt', Buffer.from('one'))
		const second = saveAttachment(id, 'note.txt', Buffer.from('two'))
		assert.equal(first, 'note.txt')
		assert.equal(second, 'note-1.txt')
	} finally {
		if (existsSync(attachmentsDir(id))) rmSync(attachmentsDir(id), { recursive: true, force: true })
	}
})

test('localizeCapturedAttachments rewrites served URLs to worktree-relative paths', () => {
	const ctx: TaskContext = {
		title: 't',
		attachments: [
			{ name: 'shot.png', url: '/api/items/abc/attachments/shot.png', contentType: 'image/png' },
			{ name: 'doc.pdf', url: '/api/items/abc/attachments/doc.pdf' },
		],
	}
	const out = localizeCapturedAttachments(ctx)
	assert.deepEqual(
		out.attachments?.map(a => a.url),
		['.helm-attachments/shot.png', '.helm-attachments/doc.pdf'],
	)
	// Name/contentType preserved; no attachments → unchanged object.
	assert.equal(out.attachments?.[0].contentType, 'image/png')
	assert.deepEqual(localizeCapturedAttachments({ title: 't' }), { title: 't' })
})

test('source-task route promotes a captured Item into a provider task and links it', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			projectSlug: 'helm',
			title: 'Customer email: invoice recipient wrong',
			prompt: 'Customer email: invoice recipient wrong',
			source: { provider: 'Email', externalId: 'email:abc' },
			capturedContext: { title: 'Customer email: invoice recipient wrong', description: 'Body of the email.' },
		})

		const createCalls: Array<{ projectSlug: string; title: string; description?: string }> = []
		const creatingProvider = {
			name: 'Contember',
			pollNewTasks: async () => [],
			getTaskContext: async () => null,
			resolveTaskSummary: async () => null,
			postComment: async () => null,
			createTask: async (input: { projectSlug: string; title: string; description?: string }) => {
				createCalls.push(input)
				return { externalId: 'task-123', url: 'https://clientcare.test/task?id=task-123' }
			},
		} as never
		const { enricher } = makeRecordingEnricher()
		const api = apiRoutes(config, 'helm.config.json', db, queue, poller, creatingProvider, spawner, enricher as never)

		const res = await api.request(`/items/${item.id}/source-task`, { method: 'POST' })
		assert.equal(res.status, 200)
		const body = (await res.json()) as { data: Record<string, unknown> }
		assert.deepEqual(createCalls, [
			{ projectSlug: 'helm', title: 'Customer email: invoice recipient wrong', description: 'Body of the email.' },
		])
		assert.deepEqual(body.data.source, {
			provider: 'Contember',
			externalId: 'task-123',
			url: 'https://clientcare.test/task?id=task-123',
		})
		assert.equal(body.data.captured, true)
		assert.equal(body.data.canCreateSourceTask, false) // linked now — action gone

		// The frozen email context survives the promotion (attachments/body still local).
		const stored = db.items.get(item.id)
		assert.equal(stored?.capturedContext?.description, 'Body of the email.')
		assert.equal(db.items.countEvents(item.id, 'source_task_created'), 1)
		// Poller dedup now keys on the new task id — no duplicate Item on next poll.
		assert.equal(db.items.findBySourceExternalId('task-123')?.id, item.id)

		// Second promotion refuses — already linked.
		const again = await api.request(`/items/${item.id}/source-task`, { method: 'POST' })
		assert.equal(again.status, 400)
	}))

test('source-task route refuses non-captured Items and providers without createTask', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const plain = commands.createSolveItem({ projectSlug: 'helm', title: 'plain', prompt: 'plain' })
		const captured = commands.createSolveItem({
			projectSlug: 'helm',
			title: 'email',
			prompt: 'email',
			source: { provider: 'Email', externalId: 'email:x' },
			capturedContext: { title: 'email' },
		})
		const { enricher } = makeRecordingEnricher()
		// explodingProvider has no createTask
		const api = apiRoutes(config, 'helm.config.json', db, queue, poller, explodingProvider, spawner, enricher as never)

		const nonCaptured = await api.request(`/items/${plain.id}/source-task`, { method: 'POST' })
		assert.equal(nonCaptured.status, 400)

		const noCapability = await api.request(`/items/${captured.id}/source-task`, { method: 'POST' })
		assert.equal(noCapability.status, 400)
		assert.match(((await noCapability.json()) as { error: string }).error, /does not support task creation/)

		const missing = await api.request('/items/nope/source-task', { method: 'POST' })
		assert.equal(missing.status, 404)
	}))
