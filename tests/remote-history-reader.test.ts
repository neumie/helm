import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { type HistoryEntry, historyBytes, projectHistoryEntry } from '../src/remote/history-projection.js'
import {
	HISTORY_PAGE_BYTES,
	HISTORY_RECORD_BYTES,
	HISTORY_RESULT_BYTES,
	type HistoryDescriptor,
	type HistoryRequest,
	type HistoryResult,
	historyRequestSchema,
} from '../src/remote/history-protocol.js'
import { RemoteHistoryReader } from '../src/remote/history-reader.js'

const id = (n: number) => n.toString(16).padStart(8, '0')
function fixture(count = 600) {
	let now = 1000
	let active = true
	let calls = 0
	let leaf: string | null = null
	const entries = new Map<string, HistoryEntry>()
	for (let n = 1; n <= count; n++) {
		entries.set(id(n), {
			id: id(n),
			parentId: leaf,
			type: 'message',
			message: { role: n % 2 ? 'user' : 'assistant', content: `Message ${n}` },
		})
		leaf = id(n)
	}
	const target = { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 }
	const epoch = randomUUID()
	const reader = new RemoteHistoryReader(
		target,
		epoch,
		() =>
			active
				? {
						getLeafId: () => leaf,
						getEntry: key => {
							calls++
							return entries.get(key)
						},
					}
				: null,
		() => now,
	)
	const viewId = randomUUID()
	let sequence = 0
	let last: HistoryDescriptor
	function read(action: HistoryRequest['action'], principalKey = 'device-a', view = viewId): HistoryResult {
		const before = calls
		last = {
			requestId: randomUUID(),
			principalKey,
			expiresAt: now + 4000,
			request: { version: 1, hostEpoch: epoch, target, viewId: view, sequence: sequence++, action },
		}
		const result = reader.execute(last)
		assert.ok(calls - before <= 128)
		assert.equal(result.attempts, calls - before)
		assert.ok(historyBytes(result) <= HISTORY_RESULT_BYTES)
		if (result.page) {
			assert.ok(result.page.records.length <= 40)
			assert.ok(historyBytes(result.page.records) <= HISTORY_PAGE_BYTES)
		}
		return result
	}
	function finish(initial: HistoryResult): HistoryResult {
		let result = initial
		for (let attempts = 0; result.state === 'progress' && attempts < 100; attempts++)
			result = read({ kind: 'continue', cursor: required(result.continuation) })
		assert.notEqual(result.state, 'progress')
		return result
	}
	return {
		reader,
		read,
		finish,
		entries,
		target,
		epoch,
		viewId,
		last: () => last,
		calls: () => calls,
		advance: (ms: number) => {
			now += ms
		},
		deactivate: () => {
			active = false
		},
		append: () => {
			const n = entries.size + 1
			entries.set(id(n), { id: id(n), parentId: leaf, type: 'message', message: { role: 'user', content: 'Appended' } })
			leaf = id(n)
		},
	}
}

test('history pages reach the entire branch with real IDs, repeats and compaction continuity', () => {
	const f = fixture(350)
	required(f.entries.get(id(280))).type = 'compaction'
	required(f.entries.get(id(279))).message = { role: 'user', content: 'duplicate' }
	required(f.entries.get(id(278))).message = { role: 'user', content: 'duplicate' }
	let result = f.read({ kind: 'open' })
	const ids: string[] = []
	while (result.page) {
		ids.push(...result.page.records.map(row => (row.kind === 'message' ? row.message.id : row.id)))
		if (!result.page.older) break
		result = f.read({ kind: 'page', cursor: result.page.older })
	}
	assert.equal(ids.length, 350)
	assert.equal(new Set(ids).size, 350)
	assert.ok(ids.includes(id(278)) && ids.includes(id(279)))
	assert.equal(result.page?.stopped, 'root')
})

test('initial anchor search is head-authorized, cancellable and reaches genuinely older content', () => {
	const f = fixture(1000)
	const first = f.read({ kind: 'open', anchor: id(500) })
	assert.equal(first.state, 'progress')
	assert.equal(first.attempts, 128)
	f.append()
	const result = f.finish(first)
	// Search and page share this slice's128 lookup budget:11 records remain.
	assert.equal(result.page?.newest, id(499))
	assert.equal(result.page?.oldest, id(489))
	const page = required(result.page)
	const reread = required(f.read({ kind: 'page', cursor: page.reread }).page)
	assert.deepEqual(reread.records, page.records)
	assert.equal(reread.newest, page.newest)
	assert.equal(reread.oldest, page.oldest)
	assert.equal(reread.reread, page.reread)
	assert.equal(reread.older, page.older)
	const older = required(f.read({ kind: 'page', cursor: required(reread.older) }).page)
	assert.equal(older.newest, id(488))
	assert.equal(older.oldest, id(449))
	assert.equal(
		new Set([...page.records, ...older.records].map(row => (row.kind === 'message' ? row.message.id : row.id))).size,
		51,
	)
	assert.equal(f.read({ kind: 'close' }).state, 'closed')
	assert.equal(f.read({ kind: 'continue', cursor: required(first.continuation) }).state, 'expired')
})

test('forged, absent and provisional anchors never become arbitrary getEntry starts', () => {
	const f = fixture(200)
	const result = f.finish(f.read({ kind: 'open', anchor: 'deadbeef' }))
	assert.equal(result.state, 'gap')
	assert.equal(f.calls(), 200)
	assert.equal(
		historyRequestSchema.safeParse({
			version: 1,
			hostEpoch: f.epoch,
			target: f.target,
			viewId: randomUUID(),
			sequence: 0,
			action: { kind: 'open', anchor: 'current' },
		}).success,
		false,
	)
})

test('Newer remains available after many older pages and re-walks the fixed head in bounded slices', () => {
	const f = fixture(1000)
	let result = f.read({ kind: 'open' })
	for (let n = 0; n < 16; n++) result = f.read({ kind: 'page', cursor: required(required(result.page).older) })
	assert.equal(result.page?.newest, id(360))
	const exact = required(result.page).reread
	f.append()
	result = f.read({ kind: 'newer', cursor: required(required(result.page).newer) })
	assert.equal(result.state, 'progress')
	result = f.finish(result)
	assert.equal(result.page?.newest, id(400))
	assert.equal(result.page?.oldest, id(361))
	assert.equal(f.read({ kind: 'page', cursor: exact }).page?.newest, id(360))
	assert.ok(f.reader.storage.searchRows <= 128)
})

test('metadata-only and hidden activity intervals advance without false root; Newer recovers sparse intervals', () => {
	const f = fixture(500)
	for (let n = 300; n <= 500; n++) required(f.entries.get(id(n))).type = 'session_info'
	let result = f.read({ kind: 'open' })
	assert.equal(result.page?.records.length, 0)
	assert.ok(result.page?.older)
	assert.equal(result.page?.stopped, 'entries')
	result = f.read({ kind: 'page', cursor: required(required(result.page).older) })
	assert.ok(required(result.page).records.length > 0)
	const newer = f.finish(f.read({ kind: 'newer', cursor: required(required(result.page).newer) }))
	assert.equal(newer.page?.records.length, 0)
	assert.ok(newer.page?.older)
})

test('an empty post-seek root range retains sealed Newer access, including metadata and activity roots', () => {
	for (const rootType of ['message', 'session_info', 'activity']) {
		const f = fixture(300)
		const root = required(f.entries.get(id(1)))
		if (rootType === 'session_info') root.type = 'session_info'
		if (rootType === 'activity') root.message = { role: 'toolResult', content: 'hidden activity' }
		const result = f.finish(f.read({ kind: 'open', anchor: id(1) }))
		assert.equal(result.page?.stopped, 'root')
		assert.deepEqual(result.page?.records, [])
		assert.equal(result.page?.older, null)
		assert.ok(result.page?.newer, rootType)
		const reread = f.read({ kind: 'page', cursor: required(result.page).reread })
		assert.deepEqual(reread.page, result.page)
		let newer = f.finish(f.read({ kind: 'newer', cursor: required(required(reread.page).newer) }))
		assert.equal(newer.page?.oldest, id(1))
		const ranges = [required(newer.page).oldest]
		while (newer.page?.newer) {
			newer = f.finish(f.read({ kind: 'newer', cursor: newer.page.newer }))
			ranges.push(required(newer.page).oldest)
		}
		assert.equal(newer.page?.newest, id(300))
		assert.equal(new Set(ranges).size, ranges.length)
	}
	const empty = fixture(0).read({ kind: 'open' })
	assert.equal(empty.page?.newer, null)
})

test('cycles crossing page boundaries and missing parents are gaps, never roots', () => {
	const f = fixture(300)
	required(f.entries.get(id(10))).parentId = id(250)
	let result = f.read({ kind: 'open' })
	for (let n = 0; n < 40 && result.page?.older; n++) result = f.read({ kind: 'page', cursor: result.page.older })
	assert.equal(result.state, 'gap')
	const g = fixture(50)
	g.entries.delete(id(20))
	const first = g.read({ kind: 'open' })
	assert.equal(first.state, 'gap')
})

test('sealed cursors bind principal, view, target, epoch and lifecycle; retry retains only latest sequence', () => {
	const f = fixture()
	const page = f.read({ kind: 'open' })
	const last = f.last()
	assert.deepEqual(f.reader.execute(last), page)
	assert.equal(f.read({ kind: 'page', cursor: required(required(page.page).older) }, 'device-b').state, 'stale')
	assert.equal(f.read({ kind: 'page', cursor: `${required(required(page.page).older).slice(0, -1)}!` }).state, 'gap')
	assert.deepEqual(f.reader.execute(last), page) // invalid requests retain the latest valid retry
	f.read({ kind: 'page', cursor: required(required(page.page).older) })
	assert.equal(f.reader.execute(last).state, 'stale')
	f.advance(60_001)
	assert.equal(f.read({ kind: 'page', cursor: required(required(page.page).older) }).state, 'expired')
	assert.equal(f.reader.storage.views, 0)
	const g = fixture()
	const initial = g.read({ kind: 'open' })
	g.deactivate()
	assert.equal(g.read({ kind: 'page', cursor: required(required(initial.page).older) }).state, 'stale')
	g.reader.dispose()
	assert.equal(g.reader.storage.views, 0)
})

test('bounded views refuse excess and progress continuation cannot be reused after search supersession', () => {
	const f = fixture(900)
	for (let n = 0; n < 8; n++) assert.equal(f.read({ kind: 'open' }, 'device-a', randomUUID()).state, 'page')
	assert.equal(f.read({ kind: 'open' }).state, 'busy')
	assert.equal(f.reader.storage.views, 8)
	const g = fixture(900)
	const first = g.read({ kind: 'open', anchor: id(100) })
	assert.equal(g.read({ kind: 'open', anchor: id(200) }).state, 'stale')
	assert.equal(g.finish(first).page?.newest, id(99))
})

test('projection clips escaped bytes and Unicode deterministically without serializing raw payloads', () => {
	const raw = {
		role: 'assistant',
		content: [
			{ type: 'text', text: `${'\0'.repeat(8191)}😀` },
			{ type: 'thinking', thinking: '\0'.repeat(8192) },
			{ type: 'image', data: 'private-image' },
			{ type: 'toolCall', name: 'read', arguments: { secret: 'never' } },
		],
		toJSON() {
			throw new Error('raw serialized')
		},
	}
	const value = projectHistoryEntry({ id: id(1), parentId: null, type: 'message', message: raw })
	assert.ok(value.record)
	assert.ok(historyBytes(value.record) <= HISTORY_RECORD_BYTES)
	assert.equal(value.omissions.images, 1)
	assert.equal(value.omissions.clipped, 1)
	assert.doesNotMatch(JSON.stringify(value.record), /private-image|never|\\ud83d/)
	assert.equal(
		projectHistoryEntry({ id: id(2), parentId: id(1), type: 'custom_message', message: raw }).omissions.unsupported,
		1,
	)
	const f = fixture(50)
	for (const entry of f.entries.values()) entry.message = { role: 'user', content: '\0'.repeat(8192) }
	let result = f.read({ kind: 'open' })
	let seen = 0
	while (result.page) {
		seen += result.page.records.length
		if (!result.page.older) break
		result = f.read({ kind: 'page', cursor: result.page.older })
	}
	assert.equal(seen, 50)
})

function required<T>(value: T | null | undefined): T {
	assert.ok(value !== null && value !== undefined, 'Expected fixture value')
	return value
}

test('invalid cursors do not renew idle leases or destroy a valid continuation', () => {
	const f = fixture(900)
	const first = f.read({ kind: 'open', anchor: id(1) })
	const cursor = required(first.continuation)
	f.advance(59_000)
	assert.equal(f.read({ kind: 'continue', cursor: 'forged' }).state, 'gap')
	assert.equal(f.finish(f.read({ kind: 'continue', cursor })).state, 'page')
	const g = fixture()
	const page = required(g.read({ kind: 'open' }).page)
	g.advance(59_000)
	assert.equal(g.read({ kind: 'page', cursor: 'forged' }).state, 'gap')
	const invalid = g.last()
	g.advance(1_001)
	assert.equal(g.reader.execute({ ...invalid, expiresAt: 99_000 }).state, 'expired')
	assert.equal(g.read({ kind: 'page', cursor: required(page.older) }).state, 'expired')
})

test('cursors cannot cross views, principals, owner fields or a fresh lifecycle secret', () => {
	const f = fixture()
	const page = required(f.read({ kind: 'open' }).page)
	const last = f.last()
	const otherView = randomUUID()
	f.read({ kind: 'open' }, 'device-a', otherView)
	assert.equal(f.read({ kind: 'page', cursor: required(page.older) }, 'device-a', otherView).state, 'gap')
	const principalView = randomUUID()
	f.read({ kind: 'open' }, 'device-b', principalView)
	assert.equal(f.read({ kind: 'page', cursor: required(page.older) }, 'device-b', principalView).state, 'gap')
	for (const changed of [
		{ sessionId: randomUUID() },
		{ incarnation: randomUUID() },
		{ scopeId: randomUUID() },
		{ generation: 2 },
	]) {
		assert.equal(
			f.reader.execute({ ...last, request: { ...last.request, target: { ...f.target, ...changed } } }).state,
			'stale',
		)
	}
	assert.equal(f.reader.execute({ ...last, request: { ...last.request, hostEpoch: randomUUID() } }).state, 'stale')
	const replacement = new RemoteHistoryReader(
		f.target,
		f.epoch,
		() => ({ getLeafId: () => id(600), getEntry: key => f.entries.get(key) }),
		() => 1000,
	)
	replacement.execute(last)
	assert.equal(
		replacement.execute({
			...last,
			request: { ...last.request, sequence: 1, action: { kind: 'page', cursor: required(page.older) } },
		}).state,
		'gap',
	)
	replacement.dispose()
	assert.equal(replacement.execute(last).state, 'stale')
})

test('malformed parent identities and private branch metadata never become traversal authority', () => {
	const f = fixture(50)
	required(f.entries.get(id(50))).parentId = '../private'
	assert.equal(f.read({ kind: 'open' }).state, 'gap')
	assert.equal(f.calls(), 1)
	const g = fixture(10)
	const marker = {
		id: id(9),
		parentId: id(8),
		type: 'branch_summary',
		fromId: 'deadbeef',
		summary: 'private summary',
		details: { secret: 'private' },
	}
	g.entries.set(id(9), marker)
	g.entries.set(id(8), {
		id: id(8),
		parentId: id(7),
		type: 'custom_message',
		message: { role: 'user', content: 'private' },
	})
	g.entries.set(id(7), { id: id(7), parentId: id(6), type: 'custom', message: { role: 'user', content: 'private' } })
	const page = required(g.read({ kind: 'open' }).page)
	assert.equal(page.oldest, id(1))
	assert.equal(page.omissions.unsupported, 2)
	assert.deepEqual(
		page.records.find(row => row.kind === 'marker'),
		{ kind: 'marker', id: id(9), marker: 'branch-summary' },
	)
	assert.doesNotMatch(JSON.stringify(page), /private|deadbeef/)
})

test('projection accounts unsupported roles and malformed blocks and preserves Unicode field boundaries', () => {
	for (const role of ['custom', 'bashExecution', 'branchSummary', 'compactionSummary', 'futureRole']) {
		const value = projectHistoryEntry({
			id: id(1),
			parentId: null,
			type: 'message',
			message: { role, content: 'private' },
		})
		assert.equal(value.record, null)
		assert.equal(value.omissions.unsupported, 1)
	}
	const malformed = projectHistoryEntry({
		id: id(1),
		parentId: null,
		type: 'message',
		message: {
			role: 'user',
			content: [
				null,
				{ type: 'text', text: 4 },
				{ type: 'future', data: 'private' },
				{ type: 'thinking', thinking: [] },
				{ type: 'toolCall', name: null },
			],
		},
	})
	assert.equal(malformed.omissions.unsupported, 5)
	for (const field of ['text', 'thinking', 'toolCall']) {
		const value = `${'x'.repeat(field === 'toolCall' ? 99 : 8191)}😀`
		const block = field === 'toolCall' ? { type: field, name: value } : { type: field, [field]: value }
		const entry = { id: id(1), parentId: null, type: 'message', message: { role: 'assistant', content: [block] } }
		const projected = projectHistoryEntry(entry)
		assert.deepEqual(projectHistoryEntry(entry), projected)
		assert.equal(projected.omissions.clipped, 1)
		assert.doesNotMatch(JSON.stringify(projected.record), /\\ud83d/)
	}
	const blocks = Array.from({ length: 101 }, () => ({ type: 'text', text: 'x' }))
	const bounded = projectHistoryEntry({
		id: id(1),
		parentId: null,
		type: 'message',
		message: { role: 'assistant', content: blocks },
	})
	assert.equal(bounded.record?.kind === 'message' && bounded.record.message.text.length, 100)
	assert.equal(bounded.omissions.clipped, 1)
})

test('retrying a genuine ancestry gap does not extend the view lease', () => {
	const f = fixture(5)
	required(f.entries.get(id(5))).parentId = 'deadbeef'
	const gap = f.read({ kind: 'open' })
	assert.equal(gap.state, 'gap')
	const descriptor = f.last()
	f.advance(59_000)
	assert.deepEqual(f.reader.execute({ ...descriptor, expiresAt: 64_000 }), gap)
	f.advance(1_001)
	assert.equal(f.read({ kind: 'continue', cursor: 'unavailable' }).state, 'expired')
})

for (const boundary of ['close', 'expire'] as const) {
	test(`${boundary} then reopen at the same head cannot revive retired-view tokens; current retries and rereads remain valid`, () => {
		const f = fixture(50)
		const original = required(f.read({ kind: 'open' }).page)
		const older = required(f.read({ kind: 'page', cursor: required(original.older) }).page)
		if (boundary === 'close') assert.equal(f.read({ kind: 'close' }).state, 'closed')
		else f.advance(60_001)
		const reopened = f.read({ kind: 'open' })
		const reopenedDescriptor = f.last()
		const page = required(reopened.page)
		assert.deepEqual(page.records, original.records) // same browser view, owner, principal and captured head
		assert.notEqual(page.reread, original.reread)
		for (const action of [
			{ kind: 'page', cursor: original.reread },
			{ kind: 'page', cursor: required(original.older) },
			{ kind: 'newer', cursor: required(older.newer) },
		] as const) {
			const before = f.calls()
			assert.equal(f.read(action).state, 'gap')
			assert.equal(f.calls(), before) // reject before any retired traversal authority is consumed
		}
		const retry = f.reader.execute({ ...reopenedDescriptor, requestId: randomUUID() })
		assert.equal(retry.state, 'page')
		assert.deepEqual(retry.page, page) // invalid old tokens do not replace latest valid retry evidence
		const reread = required(f.read({ kind: 'page', cursor: page.reread }).page)
		assert.deepEqual(reread.records, page.records)
		assert.equal(reread.reread, page.reread)
		assert.equal(reread.older, page.older)
		f.reader.dispose()
	})
}
