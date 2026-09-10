import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
	appendFileSync,
	chmodSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PiSessionCatalog } from '../src/remote/catalog.js'

const epoch = '10000000-0000-4000-8000-000000000000'
const view = { viewId: 'catalog-proof', principalId: 'proof-device', sequence: 1, overlayStamp: 'proof-overlay' }

function rootFixture(prefix: string) {
	const root = mkdtempSync(join(tmpdir(), prefix))
	chmodSync(root, 0o700)
	const project = join(root, 'project')
	writeFileSync(project, '', { flag: 'a' })
	rmSync(project)
	return { root, project }
}
function session(path: string, label: string, timestamp: string, extra = '') {
	const id = randomUUID()
	writeFileSync(
		path,
		`${JSON.stringify({ type: 'session', id, timestamp })}\n${extra}${JSON.stringify({ type: 'session_info', name: label })}\n`,
		{ mode: 0o600 },
	)
	return id
}
async function page(catalog: PiSessionCatalog, cursor?: string, query = '', overlay = new Set<string>()) {
	const request = { ...view, sequence: ++view.sequence }
	for (let attempt = 0; attempt < 200_000; attempt++) {
		const result = catalog.page(epoch, cursor, query, overlay, request)
		if (result.state !== 'pending') return result
		await new Promise(resolve => setTimeout(resolve, 0))
	}
	throw new Error('catalog page did not settle')
}

// This is intentionally a real on-disk proof: a small cache cannot hide older
// records because every opaque More cursor performs bounded selection across roots.
test('catalog reaches every record beyond 2048, supports inverse Previous and searches older metadata', async () => {
	const { root, project } = rootFixture('hr-catalog-pages-')
	const count = 2305
	try {
		await import('node:fs/promises').then(({ mkdir }) => mkdir(project, { mode: 0o700 }))
		const expected = new Set<string>()
		const expectedIds = new Set<string>()
		for (let index = 0; index < count; index++) {
			const label = `older conversation ${String(index).padStart(4, '0')}`
			expected.add(label)
			const path = join(project, `${String(index).padStart(4, '0')}.jsonl`)
			session(path, label, new Date(1_700_000_000_000 + index * 1000).toISOString())
			utimesSync(path, 1_700_000_000 + index, 1_700_000_000 + index)
			const stat = statSync(path)
			expectedIds.add(`catalog_${createHash('sha256').update(`${stat.dev}:${stat.ino}`).digest('hex').slice(0, 32)}`)
		}
		const catalog = new PiSessionCatalog([root])
		try {
			let cursor: string | undefined
			let second: string | undefined
			const found = new Set<string>()
			const foundIds = new Set<string>()
			for (;;) {
				const result = await page(catalog, cursor)
				assert.equal(result.state, 'ready')
				for (const row of result.rows) {
					assert.ok(!foundIds.has(row.id), 'More returned a duplicate ID')
					foundIds.add(row.id)
					found.add(row.label)
				}
				if (!second) second = result.nextCursor ?? undefined
				if (!result.nextCursor) break
				cursor = result.nextCursor
			}
			assert.deepEqual(found, expected)
			assert.deepEqual(foundIds, expectedIds)
			assert.ok(second)
			const pageTwo = await page(catalog, second)
			assert.equal(pageTwo.state, 'ready')
			assert.ok(pageTwo.previousCursor)
			const previous = await page(catalog, pageTwo.previousCursor ?? undefined)
			assert.equal(previous.state, 'ready')
			assert.deepEqual(
				previous.rows.map(row => row.label),
				[...found].sort().slice(-50).reverse(),
			)
			const older = await page(catalog, undefined, 'older conversation 0000')
			assert.equal(older.state, 'ready')
			assert.deepEqual(
				older.rows.map(row => row.label),
				['older conversation 0000'],
			)
		} finally {
			await catalog.stop()
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('tiny budgets retain bounded state, latest session_info clears correctly, and a large valid line progresses', async () => {
	const { root, project } = rootFixture('hr-catalog-tiny-')
	try {
		await import('node:fs/promises').then(({ mkdir }) => mkdir(project, { mode: 0o700 }))
		for (let index = 0; index < 9; index++)
			session(join(project, `${index}.jsonl`), `name ${index}`, new Date(1_700_000_000_000 + index).toISOString())
		const renamed = join(project, 'renamed.jsonl')
		const renamedId = randomUUID()
		writeFileSync(
			renamed,
			`${JSON.stringify({ type: 'session', id: renamedId, timestamp: '2024-01-01T00:00:00.000Z' })}\n${JSON.stringify({ type: 'message', text: 'x'.repeat(300_000) })}\n${JSON.stringify({ type: 'session_info', name: 'first title' })}\n${JSON.stringify({ type: 'session_info', name: '' })}\n`,
			{ mode: 0o600 },
		)
		const catalog = new PiSessionCatalog([root], {
			pageSize: 3,
			cacheSize: 2,
			entryAttemptsPerSlice: 1,
			fileAttemptsPerSlice: 1,
			metadataOpsPerSlice: 1,
			bytesPerSlice: 1024,
		})
		try {
			const result = await page(catalog)
			assert.equal(result.state, 'ready')
			assert.ok(result.rows.some(row => row.id && row.label === 'Pi conversation'))
			const diagnostic = catalog.diagnostics()
			assert.ok(diagnostic.cache <= 2)
			assert.ok(diagnostic.maxRetainedRecords <= 2 + 2 * 3 + 3)
			assert.ok(diagnostic.maxOpenHandles <= 5)
			assert.equal(diagnostic.bufferBytes, 64 * 1024)
		} finally {
			await catalog.stop()
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('stop closes admission and drains a paused read, while a persistent post-open project replacement is never published', async () => {
	const { root, project } = rootFixture('hr-catalog-drain-')
	try {
		mkdirSync(project, { mode: 0o700 })
		session(join(project, 'inside.jsonl'), 'inside metadata', '2024-01-01T00:00:00.000Z')
		let release!: () => void
		let reached!: () => void
		const reachedRead = new Promise<void>(resolve => {
			reached = resolve
		})
		const barrier = new Promise<void>(resolve => {
			release = resolve
		})
		const catalog = new PiSessionCatalog([root], {
			onBarrier: async point => {
				if (point === 'before_file_read') {
					reached()
					await barrier
				}
			},
		})
		const pending = catalog.page(epoch, undefined, '', new Set(), view)
		assert.equal(pending.state, 'pending')
		await reachedRead
		const oldProject = `${project}-old`
		renameSync(project, oldProject)
		mkdirSync(project, { mode: 0o700 })
		session(join(project, 'outside.jsonl'), 'outside metadata', '2025-01-01T00:00:00.000Z')
		const stopping = catalog.stop()
		let settled = false
		void stopping.then(() => {
			settled = true
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		assert.equal(settled, false)
		release()
		await stopping
		const diagnostic = catalog.diagnostics()
		assert.equal(diagnostic.views, 0)
		assert.equal(diagnostic.cache, 0)
		assert.equal(diagnostic.queued, 0)
		assert.equal(diagnostic.active, false)
		assert.equal(diagnostic.openHandles, 0)
		assert.equal(diagnostic.maxOpenHandles, 5)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('persistent project replacement after file open fails closed without publishing outside metadata', async () => {
	const { root, project } = rootFixture('hr-catalog-substitute-')
	try {
		mkdirSync(project, { mode: 0o700 })
		session(join(project, 'inside.jsonl'), 'inside metadata', '2024-01-01T00:00:00.000Z')
		let release!: () => void
		let reached!: () => void
		const reachedRead = new Promise<void>(resolve => {
			reached = resolve
		})
		const barrier = new Promise<void>(resolve => {
			release = resolve
		})
		const catalog = new PiSessionCatalog([root], {
			onBarrier: async point => {
				if (point === 'before_file_read') {
					reached()
					await barrier
				}
			},
		})
		catalog.page(epoch, undefined, '', new Set(), view)
		await reachedRead
		renameSync(project, `${project}-old`)
		mkdirSync(project, { mode: 0o700 })
		session(join(project, 'outside.jsonl'), 'outside metadata', '2025-01-01T00:00:00.000Z')
		release()
		const result = await page(catalog)
		assert.equal(result.state, 'unavailable')
		assert.deepEqual(result.rows, [])
		await catalog.stop()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('unchanged cursor stays ready, mutation invalidates explicitly, and exact live UUID suppression backfills', async () => {
	const { root, project } = rootFixture('hr-catalog-mutation-')
	try {
		await import('node:fs/promises').then(({ mkdir }) => mkdir(project, { mode: 0o700 }))
		const firstPath = join(project, 'first.jsonl')
		const firstId = session(firstPath, 'same label', '2024-01-01T00:00:00.000Z')
		session(join(project, 'second.jsonl'), 'same label', '2024-01-02T00:00:00.000Z')
		session(join(project, 'third.jsonl'), 'neighbor', '2024-01-03T00:00:00.000Z')
		const catalog = new PiSessionCatalog([root], { pageSize: 2 })
		try {
			const initial = await page(catalog)
			assert.equal(initial.state, 'ready')
			assert.ok(initial.pageCursor)
			const unchanged = await page(catalog, initial.pageCursor ?? undefined)
			assert.equal(unchanged.state, 'ready')
			writeFileSync(
				join(project, 'new.jsonl'),
				`${JSON.stringify({ type: 'session', id: randomUUID(), timestamp: '2025-01-01T00:00:00.000Z' })}\n`,
				{ mode: 0o600 },
			)
			await catalog.refresh()
			const changed = await page(catalog, initial.pageCursor ?? undefined)
			assert.equal(changed.state, 'invalidated')
			const suppressed = await page(catalog, undefined, '', new Set([firstId]))
			assert.equal(suppressed.state, 'ready')
			assert.ok(
				!suppressed.rows.some(
					row => row.label === 'same label' && row.createdAt === Date.parse('2024-01-01T00:00:00.000Z'),
				),
			)
			assert.ok(suppressed.rows.length === 2)
		} finally {
			await catalog.stop()
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test(
	'a valid file and single message beyond 64MiB completes with bounded parser state and no transcript projection',
	{ timeout: 240_000 },
	async () => {
		const { root, project } = rootFixture('hr-catalog-large-')
		mkdirSync(project, { mode: 0o700 })
		const path = join(project, 'large.jsonl')
		const fd = openSync(path, 'wx', 0o600)
		try {
			writeSync(
				fd,
				`${JSON.stringify({ type: 'session', id: randomUUID(), timestamp: '2024-01-01' })}\n{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"`,
			)
			const block = 'PRIVATE_TRANSCRIPT_'.repeat(60_000)
			for (let index = 0; index < 64; index++) writeSync(fd, block)
			writeSync(fd, '"}]}}\n')
			for (let index = 0; index < 80; index++)
				writeSync(fd, '{"type":"message","message":{"role":"user","content":[]}}\n')
			writeSync(fd, '{"type":"session_info","name":"old name"}\n{"type":"session_info","name":"')
			for (let index = 0; index < 2; index++) writeSync(fd, ' '.repeat(1024 * 1024))
			writeSync(fd, 'latest café 😀 name"}\n')
		} finally {
			closeSync(fd)
		}
		assert.ok(statSync(path).size > 64 * 1024 * 1024)
		const catalog = new PiSessionCatalog([root], { bytesPerSlice: 65536, metadataOpsPerSlice: 16 })
		try {
			const result = await page(catalog)
			assert.equal(result.state, 'ready')
			assert.deepEqual(
				result.rows.map(row => row.label),
				['latest café 😀 name'],
			)
			assert.ok(!JSON.stringify(result).includes('PRIVATE_TRANSCRIPT'))
			const d = catalog.diagnostics()
			assert.ok(d.totalBytes > 64 * 1024 * 1024)
			assert.ok(d.maxParserCharacters < 1600)
			assert.ok(d.maxParserDepth <= 64)
			assert.ok(d.maxSliceBytes <= 65536)
			assert.ok(d.maxSliceOperations <= 16)
			console.log('Large valid catalog proof:', JSON.stringify({ fileBytes: statSync(path).size, ...d }))
		} finally {
			await catalog.stop()
			rmSync(root, { recursive: true, force: true })
		}
	},
)

test('an authorized live file keeps appending while history becomes ready without traversing its name/message bytes', async () => {
	const { root, project } = rootFixture('hr-catalog-append-')
	mkdirSync(project, { mode: 0o700 })
	const livePath = join(project, 'live.jsonl')
	const id = session(livePath, 'same label', '2024-01-01')
	appendFileSync(livePath, `${JSON.stringify({ type: 'message', text: 'x'.repeat(2 * 1024 * 1024) })}\n`)
	session(join(project, 'history.jsonl'), 'same label', '2024-01-02')
	session(join(project, 'neighbor.jsonl'), 'neighbor', '2024-01-03')
	let appends = 0
	const catalog = new PiSessionCatalog([root], {
		pageSize: 2,
		bytesPerSlice: 128,
		metadataOpsPerSlice: 1,
		onBarrier(point) {
			if (point === 'before_file_read' || point === 'before_publication') {
				appendFileSync(livePath, '{"type":"message","text":"growing"}\n')
				appends++
			}
		},
	})
	try {
		const first = await page(catalog, undefined, '', new Set([id]))
		assert.equal(first.state, 'ready')
		assert.equal(first.rows.length, 2)
		assert.equal(first.rows.filter(row => row.label === 'same label').length, 1)
		assert.ok(first.rows.some(row => row.label === 'neighbor'))
		assert.ok(first.pageCursor)
		const unchanged = await page(catalog, first.pageCursor, '', new Set([id]))
		assert.equal(unchanged.state, 'ready')
		assert.equal(unchanged.pageCursor, first.pageCursor)
		assert.ok(appends >= 4)
		assert.ok(catalog.diagnostics().totalBytes < 4096)
		console.log(
			'Appending live-file proof:',
			JSON.stringify({ appends, fileBytes: statSync(livePath).size, readBytes: catalog.diagnostics().totalBytes }),
		)
	} finally {
		await catalog.stop()
		rmSync(root, { recursive: true, force: true })
	}
})
