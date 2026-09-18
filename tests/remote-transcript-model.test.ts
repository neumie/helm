import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import transcriptModelModule from '../app/src/renderer/remote/transcript-model.js'
import type {
	RemoteTranscriptModel as Model,
	TranscriptAssociation,
	TranscriptReconciliation,
} from '../app/src/renderer/remote/transcript-model.js'
import presentationModule from '../app/src/renderer/remote/transcript-presentation.js'
import type { HistoryEntry } from '../src/remote/history-projection.js'
import {
	type HistoryPage,
	type HistoryRecord,
	type HistoryRequest,
	type HistoryResult,
	emptyHistoryOmissions,
	historyPageSchema,
} from '../src/remote/history-protocol.js'
import { RemoteHistoryReader } from '../src/remote/history-reader.js'
import { projectRemoteMessage } from '../src/remote/message-projection.js'
import { remoteSnapshotSchema } from '../src/remote/protocol.js'
const { classifyTranscriptRecord, isMessageVisible, isLegacyWholeToolActivity } = presentationModule
const { RemoteTranscriptModel } = transcriptModelModule
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))
// Deliberately not lexically ordered: positions must follow source order.
const id = (n: number) => ((n ^ 0xabcdef) >>> 0).toString(16).padStart(8, '0')
const rec = (n: number, text = `message ${n}`): HistoryRecord => ({
	kind: 'message',
	message: { id: id(n), role: 'user', text, thinking: '', truncated: false },
})
const rid = (r: HistoryRecord) => (r.kind === 'message' ? r.message.id : r.id)
function page(ns: number[], token = `r-${ns.join('-')}`, root = false): HistoryPage {
	return {
		newest: ns.length ? id(ns.at(-1) as number) : null,
		oldest: ns.length ? id(ns[0] as number) : null,
		records: ns.map(n => rec(n)),
		omissions: emptyHistoryOmissions(),
		reread: token,
		older: root ? null : `older-${token}`,
		newer: `newer-${token}`,
		stopped: root ? 'root' : 'records',
	}
}
function admit(m: Model, p: HistoryPage): TranscriptAssociation {
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	const result = m.admitPrefix(ticket, p)
	assert.equal(result.status, 'accepted')
	assert.ok(result.association)
	return result.association
}
const observe = (m: Model, ns: number[], revision = 1, truncated = false) =>
	m.observeLive({ records: ns.map(n => rec(n)), revision, historyTruncated: truncated })
const owned = (m: Model) => [...m.snapshot().chunks.flatMap(c => c.page.records), ...m.snapshot().live].map(rid)
function honest(m: Model) {
	const s = m.snapshot()
	const d = m.debug()
	assert.equal(d.residentBytes, bytes(s.chunks))
	assert.equal(d.currentLiveBytes, bytes(s.live))
	assert.equal(d.metadataSpans, s.spans.length)
	assert.equal(d.checkpoints, s.checkpoints.length)
	assert.equal(d.retainedPayloadOwners, s.chunks.length + (s.live.length ? 1 : 0))
	assert.ok(d.residentChunks <= 128)
	assert.ok(d.residentBytes <= 8 * 1024 * 1024)
	assert.ok(d.currentLiveBytes <= 164 * 1024)
	assert.ok(d.currentNativeMessageBytes <= 160 * 1024)
	assert.ok(d.metadataSpans <= 64)
	assert.ok(d.checkpoints <= 256)
	assert.ok(d.metadataBytes <= 256 * 1024)
	assert.ok(d.metadataBytes >= bytes({ spans: s.spans, checkpoints: s.checkpoints }))
	assert.ok(s.spans.filter(span => span.recovery).length <= 64)
	assert.equal(new Set(owned(m)).size, owned(m).length)
}

const geometryLayout = (overrides = {}) => ({
	enabled: true,
	width: 800,
	viewportHeight: 320,
	activity: false,
	presentationEpoch: 7,
	readingVisible: true,
	inFlowTail: { epoch: 1, height: 0 },
	...overrides,
})
const geometryWindow = (m: Model) => {
	const window = m.snapshot().window
	assert.ok(window)
	return window
}
const windowRows = (m: Model) => geometryWindow(m).items.filter(item => item.kind === 'row')
const geometryReading = (m: Model, top: number) => {
	const w = geometryWindow(m)
	return {
		instance: w.instance,
		epoch: w.epoch,
		windowSerial: w.serial,
		logicalViewportTop: top,
		physicalScrollTop: -12,
		viewportHeight: 320,
		direction: 'newer' as const,
		following: false,
		anchor: null,
	}
}
const geometryBatch = (m: Model, heights: number[]) => {
	const w = geometryWindow(m)
	let top = 0
	return {
		instance: w.instance,
		epoch: w.epoch,
		windowSerial: w.serial,
		layoutEpoch: w.layoutEpoch,
		rows: windowRows(m)
			.slice(0, heights.length)
			.map((row, index) => {
				const value = { key: row.key, measurementKey: row.measurementKey, top, height: heights[index] }
				top += heights[index]
				return value
			}),
	}
}

test('M2 geometry interleaves native islands with history and fences stamped measurement', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 2, 3]))
	observe(m, [1, 3, 4], 2)
	assert.equal(m.configureLayout(geometryLayout()).status, 'accepted')
	assert.deepEqual(
		windowRows(m).map(row => rid(row.record)),
		[1, 2, 3, 4].map(id),
	)
	assert.deepEqual(
		windowRows(m).map(row => row.position),
		[-3, -2, -1, 0],
	)
	const batch = geometryBatch(m, [20, 30, 40, 50])
	assert.equal(m.measureWindow(batch).status, 'accepted')
	assert.equal(geometryWindow(m).logicalExtent, 140)
	assert.equal(m.measureWindow(batch).status, 'stale')
	m.clear()
	assert.equal(m.snapshot().window, null)
})

test('M2 reading chooses later prefixes and partitions both omitted edges', () => {
	const m = new RemoteTranscriptModel()
	for (let end = 240; end > 0; end -= 40) admit(m, page(Array.from({ length: 40 }, (_, i) => end - 39 + i)))
	m.configureLayout(geometryLayout())
	assert.equal(geometryWindow(m).logicalExtent, 240 * 80)
	m.setReading(geometryReading(m, 175 * 80))
	assert.ok(windowRows(m).some(row => rid(row.record) === id(176)))
	assert.ok(!windowRows(m).some(row => rid(row.record) === id(1)))
	const w = geometryWindow(m)
	assert.equal(w.items[0].kind, 'spacer')
	assert.equal(w.items.at(-1)?.kind, 'spacer')
	assert.equal(
		w.items.reduce((sum, item) => sum + item.height, 0),
		w.logicalExtent,
	)
	assert.ok(w.historicalVisibleCount <= 120)
	assert.ok(w.historicalOverscanCount <= 20)
	honest(m)
})

test('M2 aged-native rows count as historical while current native has a separate quota', () => {
	const m = new RemoteTranscriptModel()
	observe(
		m,
		Array.from({ length: 40 }, (_, i) => i + 1),
	)
	admit(m, page([0]))
	for (let batch = 1; batch <= 6; batch++)
		observe(
			m,
			Array.from({ length: 40 }, (_, i) => batch * 40 + i + 1),
			batch + 1,
		)
	m.configureLayout(geometryLayout())
	const rows = windowRows(m)
	assert.equal(rows.filter(row => row.origin === 'native').length, 40)
	assert.equal(rows.filter(row => row.origin === 'history').length, geometryWindow(m).historicalVisibleCount)
	assert.ok(rows.length <= 160)
	honest(m)
})

test('M2 batch measurements validate every row before mutation, including forged issued-key replacements', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 2]))
	m.configureLayout(geometryLayout())
	const batch = geometryBatch(m, [111, 222])
	const before = m.snapshot()
	for (const rows of [
		[batch.rows[0], { ...batch.rows[1], height: Number.NaN }],
		[batch.rows[0], batch.rows[0]],
		[batch.rows[0], { ...batch.rows[1], top: 0 }],
		[{ ...batch.rows[0], measurementKey: 'never-issued' }, batch.rows[1]],
	]) {
		assert.equal(m.measureWindow({ ...batch, rows }).status, 'invalid')
		assert.equal(m.snapshot(), before)
	}
	assert.equal(m.measureWindow(batch).status, 'accepted')
	assert.equal(geometryWindow(m).logicalExtent, 333)
	const measured = m.snapshot()
	assert.equal(m.measureWindow(geometryBatch(m, [111, 222])).status, 'unchanged')
	assert.equal(m.snapshot(), measured)
})

test('M2 partial batch replaces only measured rows and width uses the actual layout epoch', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 2, 3]))
	m.configureLayout(geometryLayout())
	const old = geometryBatch(m, [0, 180])
	assert.equal(m.measureWindow(old).status, 'accepted')
	assert.deepEqual(
		windowRows(m).map(row => row.height),
		[0, 180, 80],
	)
	assert.equal(geometryWindow(m).historicalVisibleCount, 3)
	m.configureLayout(geometryLayout({ width: 400 }))
	assert.equal(m.measureWindow(old).status, 'stale')
	assert.deepEqual(
		windowRows(m).map(row => row.height),
		[80, 80, 80],
	)
	assert.equal(m.measureWindow(geometryBatch(m, [91, 92, 93])).status, 'accepted')
	assert.equal(geometryWindow(m).logicalExtent, 276)
})

test('M2 descriptor accounting does not serialize borrowed message bodies', () => {
	const m = new RemoteTranscriptModel()
	for (let end = 24; end > 0; end -= 4) {
		const p = page(Array.from({ length: 4 }, (_, i) => end - 3 + i))
		p.records = p.records.map(r =>
			r.kind === 'message' ? { ...r, message: { ...r.message, text: '界'.repeat(4000) } } : r,
		)
		admit(m, p)
	}
	m.configureLayout(geometryLayout())
	assert.ok(m.debug().geometryMetadataBytes < 20000)
	honest(m)
})

test('M2 invalid reading keys and oversized extent leave the issued snapshot intact', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1]))
	m.configureLayout(geometryLayout())
	const before = m.snapshot()
	assert.equal(
		m.setReading({
			...geometryReading(m, 0),
			anchor: {
				key: '999:99:message:deadbeef',
				inRowOffset: Number.NaN,
				viewportOffset: Number.NaN,
			},
		}).status,
		'invalid',
	)
	assert.equal(m.snapshot(), before)
	assert.equal(m.configureLayout(geometryLayout({ inFlowTail: { epoch: 2, height: 1e12 } })).status, 'capacity')
	assert.equal(m.snapshot(), before)
	assert.equal(m.measure(m.snapshot().spans[0].id, 1), false)
	assert.equal(
		m.beginHydration({
			instance: geometryWindow(m).instance,
			epoch: geometryWindow(m).epoch,
			demandId: 'forged',
			rangeKey: 'forged',
			purpose: 'viewport',
		}),
		null,
	)
	m.configureLayout(geometryLayout({ enabled: false }))
	assert.equal(m.snapshot().window, null)
})

test('ordinary polling replaces; admission captures before pending response and retains non-FIFO aged B', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [1, 2, 3])
	observe(m, [4, 5, 6])
	assert.equal(m.snapshot().spans.length, 0)
	assert.equal(m.snapshot().chunks.length, 0)
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	observe(m, [4, 6, 7], 2)
	assert.deepEqual(new Set(owned(m)), new Set([4, 5, 6, 7].map(id)))
	assert.ok(m.inspectCheckpoints().some(c => c.id === id(5)))
	assert.equal(m.admitPrefix(ticket, page([2, 3, 4])).status, 'accepted')
	assert.deepEqual(new Set(owned(m)), new Set([2, 3, 4, 5, 6, 7].map(id)))
	assert.equal(m.snapshot().liveContinuity, 'observed')
	assert.equal(m.snapshot().pendingSeam?.unverified, true)
	honest(m)
})

test('no overlap, overlap with truncation, history overlap, and preview never discard known canonical rows', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [10, 11, 12])
	admit(m, page([8, 9, 10]))
	observe(m, [10, 12, 13], 2, true)
	observe(m, [20, 21], 3, true)
	const preview = rec(22)
	if (preview.kind === 'message') preview.message.id = 'current'
	m.observeLive({ records: [rec(20, 'current wins'), rec(21), preview], revision: 3, historyTruncated: true })
	assert.deepEqual(new Set(owned(m)), new Set([8, 9, 10, 11, 12, 13, 20, 21].map(id)))
	assert.ok(!m.inspectCheckpoints().some(c => c.id === 'current'))
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		8,
	)
	assert.equal(m.inspectRange().at(-1)?.gap, true)
	assert.equal(m.inspectRange().at(-1)?.omitted, true)
	const first = m.snapshot().live[0]
	assert.equal(first?.kind === 'message' && first.message.text, 'current wins')
	honest(m)
})

test('300 genuine pages retain logical endpoints, counts, source order and reconstruct evicted newer interval', () => {
	const m = new RemoteTranscriptModel()
	for (let n = 900; n > 0; n -= 3) admit(m, page([n - 2, n - 1, n]))
	const spans = m.inspectRange()
	assert.equal(spans.length, 63)
	assert.equal(spans[0]?.first, id(1))
	assert.equal(spans.at(-1)?.last, id(900))
	assert.equal(
		spans.reduce((sum, s) => sum + s.recordCount, 0),
		900,
	)
	assert.equal(
		spans.reduce((sum, s) => sum + s.height, 0),
		900 * 80,
	)
	assert.equal(m.debug().residentChunks, 128)
	assert.ok(!owned(m).includes(id(900)))
	assert.ok(spans.every((s, i) => i === 0 || s.start === spans[i - 1]?.end))
	const latest = spans.at(-1)
	assert.ok(latest)
	const handle = m.associate(latest.id)
	assert.ok(handle)
	assert.equal(handle.last, id(900))
	assert.equal(m.restore(handle, page([898, 899, 900])).status, 'accepted')
	assert.ok(owned(m).includes(id(900)))
	assert.equal(
		m.inspectRange().reduce((sum, s) => sum + s.recordCount, 0),
		900,
	)
	assert.equal(m.inspectRange()[0]?.first, id(1))
	honest(m)
})

test('coalesced partial restore requires surviving ordered checkpoints; does not enlarge oldest', () => {
	const m = new RemoteTranscriptModel()
	for (let n = 600; n > 0; n -= 3) admit(m, page([n - 2, n - 1, n]))
	const aggregate = m.inspectRange().find(s => s.source === 'aggregate')
	assert.ok(aggregate)
	assert.equal(aggregate.gap, true)
	assert.equal(aggregate.coverage, 'unverified', 'coalescing must not certify the unverified joins')
	const points = m.inspectCheckpoints().filter(c => c.spanId === aggregate.id)
	assert.ok(points.length >= 2)
	const first = points[0]
	const last = points[1]
	assert.ok(first && last)
	const association = m.associate(aggregate.id, first.position, last.position + 1)
	assert.ok(association)
	const numeric = (value: string) => (Number.parseInt(value, 16) ^ 0xabcdef) >>> 0
	const values = Array.from({ length: last.position - first.position + 1 }, (_, i) => numeric(first.id) + i)
	const oldStart = m.inspectRange()[0]?.start
	const oldCount = m.inspectRange().reduce((n, s) => n + s.recordCount, 0)
	assert.equal(m.restore(association, page(values)).status, 'accepted')
	assert.equal(m.restore(association, page(values)).status, 'unchanged')
	assert.equal(m.settle(association), true)
	assert.equal(m.settle(association), false)
	assert.equal(m.restore(association, page(values)).status, 'unchanged')
	assert.equal(m.restore({ ...association, start: association.start - 1 }, page(values)).status, 'stale')
	assert.equal(
		m.restore(
			association,
			page(values),
			values.map((_, i) => association.start + i - 1),
		).status,
		'unverified',
	)
	assert.equal(m.inspectRange()[0]?.start, oldStart)
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		oldCount,
	)
	m.settle(association)
	assert.equal(m.associate(aggregate.id, aggregate.start - 1, aggregate.end), null)
	honest(m)
})

function dense(n: number): HistoryPage {
	const p = page([n, n + 1], `dense-${n}`)
	const first = p.records[0]
	const second = p.records[1]
	assert.ok(first?.kind === 'message' && second?.kind === 'message')
	first.message.text = '界'.repeat(8190)
	first.message.thinking = '界'.repeat(8100)
	const remaining = 65530 - bytes(p)
	second.message.thinking = '界'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3)
	assert.ok(bytes(first) > 47 * 1024 && bytes(first) <= 48 * 1024)
	assert.equal(bytes(p), 65530)
	historyPageSchema.parse(p)
	return p
}

test('real <=64KiB pages with near48KiB hidden-thinking records hit byte ceiling before chunk ceiling', () => {
	const m = new RemoteTranscriptModel()
	for (let n = 1000; n > 740; n -= 2) admit(m, dense(n))
	assert.equal(m.debug().residentChunks, 127)
	assert.ok(m.debug().residentBytes > 7.9 * 1024 * 1024)
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		260,
	)
	const anchor = m.snapshot().chunks.at(-1)
	assert.ok(anchor)
	assert.ok(
		m.protect({
			anchorIds: [rid(anchor.page.records[0] as HistoryRecord)],
			overscanChunkIds: m.snapshot().chunks.map(c => c.id),
		}),
	)
	admit(m, dense(738))
	assert.ok(m.snapshot().chunks.some(c => c.id === anchor.id))
	assert.equal(m.debug().residentChunks, 127)
	honest(m)
})

test('protected residency refuses expansion atomically; releasing protection admits same pending ticket', () => {
	const m = new RemoteTranscriptModel()
	for (let n = 1000; n > 746; n -= 2) admit(m, dense(n))
	assert.equal(m.snapshot().chunks.length, 127)
	assert.ok(m.protect({ chunkIds: m.snapshot().chunks.map(c => c.id) }))
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	const before = m.snapshot()
	assert.equal(m.admitPrefix(ticket, dense(744)).status, 'capacity')
	assert.equal(m.snapshot(), before)
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		254,
	)
	m.release()
	assert.equal(m.admitPrefix(ticket, dense(744)).status, 'accepted')
	honest(m)
})

test('replace enforces full byte accounting and preserves prior materialization on capacity refusal', () => {
	const m = new RemoteTranscriptModel()
	for (let n = 1000; n > 746; n -= 2) admit(m, dense(n))
	const handle = admit(m, page([744, 745], 'small'))
	assert.equal(m.snapshot().chunks.length, 128)
	assert.ok(m.protect({ chunkIds: m.snapshot().chunks.map(c => c.id) }))
	const before = m.snapshot()
	assert.equal(m.restore(handle, dense(744)).status, 'capacity')
	assert.equal(m.snapshot(), before)
	m.release()
	assert.equal(m.restore(handle, dense(744)).status, 'accepted')
	assert.equal(m.snapshot().chunks.length, 127)
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		256,
	)
	honest(m)
})

test('thousands of real non-FIFO/truncated live seams retain conservative envelope and bounded checkpoints', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [1, 2, 3])
	admit(m, page([0]))
	for (let n = 4; n < 3004; n++) {
		observe(m, [1, n - 1, n], n, n % 2 === 0)
		if (n % 100 === 0) honest(m)
	}
	const tail = m.inspectRange().at(-1)
	assert.ok(tail)
	assert.equal(tail.first, id(1))
	assert.equal(tail.last, id(3003))
	assert.equal(tail.recordCount, 3003)
	assert.equal(tail.gap, true)
	assert.equal(tail.omitted, true)
	assert.equal(tail.coverage, 'observed')
	assert.equal(m.snapshot().pendingSeam?.unverified, true)
	assert.equal(m.inspectRange().length, 2)
	assert.ok(m.inspectCheckpoints().some(c => c.id === id(1)))
	assert.ok(m.inspectCheckpoints().some(c => c.id === id(3003)))
	honest(m)
})

test('active prefix and legitimate last retry remain addressable during live compaction; stale boundary refuses', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [10000])
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	for (let n = 10001; n < 10300; n++) observe(m, [n], n, true)
	const p = page([9998, 9999])
	const accepted = m.admitPrefix(ticket, p)
	assert.equal(accepted.status, 'accepted')
	assert.ok(accepted.association)
	for (let n = 10300; n < 10600; n++) observe(m, [n], n, true)
	assert.ok(!owned(m).includes(id(9998)))
	const count = m.inspectRange().reduce((n, s) => n + s.recordCount, 0)
	assert.equal(m.admitPrefix(ticket, p).status, 'accepted')
	assert.equal(m.admitPrefix(ticket, p).status, 'unchanged')
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		count,
	)
	assert.equal(m.settle(ticket), false)
	admit(m, page([9996, 9997]))
	const before = m.snapshot()
	assert.equal(m.admitPrefix(ticket, p).status, 'stale')
	assert.equal(m.snapshot(), before)
	honest(m)
})

test('issued restoration is fenced across clear and distinct model instances; coordinates alone never authorize', () => {
	const m = new RemoteTranscriptModel()
	const handle = admit(m, page([1, 2]))
	const other = new RemoteTranscriptModel()
	admit(other, page([1, 2]))
	assert.equal(other.restore(handle, page([1, 2])).status, 'stale')
	m.clear()
	admit(m, page([1, 2]))
	assert.equal(m.restore(handle, page([1, 2])).status, 'stale')
	assert.equal(m.restore({ ...handle, instance: -1 }, page([1, 2])).status, 'stale')
	honest(m)
})

test('repeated page and reread idempotent; genuinely older source interval prepends without lexical sort', () => {
	const m = new RemoteTranscriptModel()
	const p = page([3, 4])
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	const accepted = m.admitPrefix(ticket, p)
	assert.equal(accepted.status, 'accepted')
	const before = m.snapshot()
	assert.equal(m.admitPrefix(ticket, copyPage(p)).status, 'unchanged')
	assert.equal(m.snapshot(), before)
	assert.ok(accepted.association)
	assert.equal(
		m.restore(accepted.association, { ...p, reread: 'renewed', older: 'renewed-older', newer: 'renewed-newer' }).status,
		'unchanged',
	)
	assert.equal(m.snapshot(), before)
	admit(m, page([1, 2, 3]))
	assert.deepEqual(
		m.snapshot().chunks.flatMap(c => c.page.records.map(rid)),
		[1, 2, 3, 4].map(id),
	)
	honest(m)
})
const copyPage = (p: HistoryPage) => JSON.parse(JSON.stringify(p)) as HistoryPage

test('returned snapshots and input copies remain immutable across updates and eviction', () => {
	const m = new RemoteTranscriptModel()
	const input = page([1, 2])
	admit(m, input)
	const before = m.snapshot()
	const serialized = JSON.stringify(before)
	input.records.length = 0
	for (let n = 300; n > 0; n--) admit(m, page([n + 1000]))
	assert.equal(JSON.stringify(before), serialized)
	assert.ok(Object.isFrozen(before.spans[0]))
	assert.ok(Object.isFrozen(before.chunks[0]?.page.records))
	assert.equal(m.snapshot(), m.snapshot())
	honest(m)
})

test('semantic equality ignores revision only; clear resets every baseline and anchor', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [1], 7)
	const first = m.snapshot()
	assert.equal(observe(m, [1], 8), false)
	assert.equal(m.snapshot(), first)
	assert.equal(
		m.observeLive({ records: [rec(1, 'changed at same revision')], revision: 8, historyTruncated: false }),
		true,
	)
	assert.notEqual(m.snapshot(), first)
	m.setViewport({
		scrollTop: 10,
		height: 500,
		width: 800,
		activity: false,
		readingVisible: true,
		anchor: { id: id(1), offset: 4 },
	})
	const view = m.snapshot()
	assert.equal(m.setViewport({ ...view.viewport, scrollTop: 50 }), false)
	assert.equal(m.snapshot(), view)
	m.clear()
	assert.equal(m.snapshot().viewport.anchor, undefined)
	assert.equal(m.snapshot().spans.length, 0)
	assert.equal(m.snapshot().chunks.length, 0)
	assert.equal(m.snapshot().checkpoints.length, 0)
	assert.equal(m.debug().retainedPayloadOwners, 0)
	assert.equal(observe(m, [2], 8), true)
	assert.deepEqual(m.snapshot().live.map(rid), [id(2)])
	honest(m)
})

test('raw-only pages retain coverage, omission and authenticated root separately from record count', () => {
	const m = new RemoteTranscriptModel()
	const raw = {
		...page([], 'raw'),
		oldest: id(1),
		newest: id(2),
		older: null,
		omissions: { clipped: 1, images: 0, unsupported: 2 },
	}
	const handle = admit(m, raw)
	assert.equal(m.snapshot().root, false, 'null Older alone is not authenticated root evidence')
	assert.equal(m.inspectRange()[0]?.recordCount, 0)
	assert.equal(m.inspectRange()[0]?.height, 0)
	assert.equal(m.inspectRange()[0]?.rawOldest, id(1))
	assert.equal(m.inspectRange()[0]?.first, null)
	assert.equal(m.inspectCheckpoints().length, 0)
	assert.equal(m.inspectRange()[0]?.omitted, true)
	assert.equal(m.restore(handle, raw).status, 'unchanged')
	admit(m, page([], 'root', true))
	assert.equal(m.snapshot().root, true)
	assert.equal(m.inspectRange().length, 2)
	honest(m)
})

test('protected metadata refuses new membership instead of clamping spans; release permits aggregation', () => {
	const m = new RemoteTranscriptModel()
	for (let n = 64; n > 0; n--) admit(m, page([n]))
	assert.ok(m.protect({ spanIds: m.inspectRange().map(s => s.id) }))
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	const before = m.snapshot()
	assert.equal(m.admitPrefix(ticket, page([0])).status, 'capacity')
	assert.equal(m.snapshot(), before)
	m.release()
	assert.equal(m.admitPrefix(ticket, page([0])).status, 'accepted')
	assert.equal(m.inspectRange().length, 63)
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		65,
	)
	honest(m)
})

test('replacing a partial source page keeps materialization outside the associated interval', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 2, 3, 4]))
	const span = m.inspectRange()[0]
	assert.ok(span)
	const handle = m.associate(span.id, span.start + 1, span.start + 3)
	assert.ok(handle)
	const p = page([2, 3], 'partial')
	const changed = p.records[0]
	if (changed?.kind === 'message') changed.message.text = 'reread payload'
	assert.equal(m.restore(handle, p).status, 'accepted')
	assert.deepEqual(owned(m), [1, 2, 3, 4].map(id))
	assert.equal(m.inspectRange()[0]?.recordCount, 4)
	honest(m)
})

test('resident interior arrivals reindex atomically in observed source order and preserve pending older admission', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [1, 4])
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	m.setViewport({
		scrollTop: 0,
		width: 800,
		height: 400,
		activity: false,
		readingVisible: true,
		anchor: { id: id(4), offset: 6 },
	})
	const before = m.snapshot()
	const old = JSON.stringify(before)
	observe(m, [1, 2, 3, 4, 5], 2)
	assert.deepEqual(
		m.inspectCheckpoints().map(c => c.id),
		[1, 2, 3, 4, 5].map(id),
	)
	assert.deepEqual(
		m.inspectCheckpoints().map(c => c.position),
		[0, 1, 2, 3, 4],
	)
	assert.equal(m.inspectRange().at(-1)?.recordCount, 5)
	assert.equal(m.snapshot().viewport.anchor?.id, id(4))
	assert.equal(JSON.stringify(before), old)
	assert.equal(m.admitPrefix(ticket, page([0])).status, 'accepted')
	honest(m)
})

test('interior insertion retires affected restore associations, but leaves older-prefix retry valid', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [1, 3])
	const prefix = admit(m, page([0]))
	const span = m.inspectRange().at(-1)
	assert.ok(span)
	const affected = m.associate(span.id)
	assert.ok(affected)
	observe(m, [1, 2, 3], 2)
	assert.equal(m.restore(affected, page([1, 3])).status, 'stale')
	assert.equal(m.restore(prefix, page([0])).status, 'unchanged')
	const fresh = m.associate(span.id)
	assert.ok(fresh)
	assert.equal(fresh.end, affected.end + 1)
	m.settle(fresh)
	honest(m)
})

test('evicted middle reappearance retains uncertain ordering without counting a proved new member; associated proof resolves it', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [0])
	admit(m, page([10000]))
	for (let n = 1; n <= 500; n++) observe(m, [0, n], n)
	const points = m.inspectCheckpoints().filter(c => c.position >= 0)
	const numeric = (value: string) => (Number.parseInt(value, 16) ^ 0xabcdef) >>> 0
	const pairIndex = points.findIndex((c, i) => {
		const next = points[i + 1]
		return (
			next && next.position - c.position > 1 && next.position - c.position < 39 && c.position > 0 && next.position < 300
		)
	})
	assert.ok(pairIndex >= 0)
	const low = points[pairIndex]
	const high = points[pairIndex + 1]
	assert.ok(low && high)
	const missing = numeric(low.id) + 1
	assert.ok(!owned(m).includes(id(missing)))
	const count = m.inspectRange().at(-1)?.recordCount
	observe(m, [0, missing, 500], 501)
	const unresolved = m.inspectCheckpoints().find(c => c.id === id(missing))
	assert.ok(unresolved?.ordering)
	assert.equal(unresolved.ordering.predecessor, id(0))
	assert.equal(unresolved.ordering.successor, id(500))
	assert.equal(m.inspectRange().at(-1)?.recordCount, count)
	observe(m, [0, 501], 502)
	assert.ok(m.snapshot().chunks.some(c => c.ordering && c.page.records.some(r => rid(r) === id(missing))))
	const span = m.inspectRange().at(-1)
	assert.ok(span)
	const associated = m.associate(span.id, low.position, high.position + 1)
	assert.ok(associated)
	const values = Array.from({ length: high.position - low.position + 1 }, (_, i) => numeric(low.id) + i)
	assert.equal(
		m.restore(
			associated,
			page(values),
			values.map((_, i) => low.position + i),
		).status,
		'accepted',
	)
	assert.equal(m.inspectCheckpoints().find(c => c.id === id(missing))?.ordering, undefined)
	assert.equal(m.inspectCheckpoints().find(c => c.id === id(missing))?.position, missing)
	assert.equal(m.inspectRange().at(-1)?.recordCount, (count as number) + 1)
	honest(m)
})

test('reserved live descriptor accepts initial native observation even when all historical spans are protected', () => {
	const m = new RemoteTranscriptModel()
	for (let n = 70; n > 0; n--) admit(m, page([n]))
	assert.equal(m.inspectRange().length, 63)
	assert.ok(m.protect({ spanIds: m.inspectRange().map(s => s.id) }))
	assert.equal(observe(m, [100], 1), true)
	assert.equal(m.inspectRange().length, 64)
	assert.equal(observe(m, [101], 2), true)
	assert.equal(m.inspectRange().at(-1)?.recordCount, 2)
	honest(m)
})

test('live payload bound and marker ownership are independent of sparse raw coverage', () => {
	const m = new RemoteTranscriptModel()
	const records = dense(100).records
	m.observeLive({
		records: Array.from({ length: 40 }, (_, i) => {
			const r = JSON.parse(JSON.stringify(records[0])) as HistoryRecord
			if (r.kind === 'message') r.message.id = id(100 + i)
			return r
		}),
		revision: 1,
		historyTruncated: false,
	})
	assert.ok(m.snapshot().live.length < 40)
	admit(m, { ...page([1]), records: [{ kind: 'marker', id: id(1), marker: 'compaction' }] })
	assert.ok(m.inspectCheckpoints().some(c => c.id === id(1)))
	honest(m)
})

test('overlapping legitimate retry survives eviction of its crop IDs and sparse samples', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [10000, 10001, 10002])
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	const input = page([9998, 9999, 10000, 10001, 10002])
	assert.equal(m.admitPrefix(ticket, input).status, 'accepted')
	for (let n = 10003; n < 13003; n++) observe(m, [n])
	assert.ok(!owned(m).includes(id(10001)))
	assert.ok(!m.inspectCheckpoints().some(c => c.id === id(10001)))
	const before = m.inspectRange()
	assert.ok(['accepted', 'unchanged'].includes(m.admitPrefix(ticket, input).status))
	assert.deepEqual(m.inspectRange(), before)
	assert.equal(m.admitPrefix(ticket, input).status, 'unchanged')
	honest(m)
})

test('fresh prefix ticket refuses retained association but permits genuinely new raw-only coverage', () => {
	const m = new RemoteTranscriptModel()
	const input = page([3, 4])
	admit(m, input)
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	const before = m.snapshot()
	assert.equal(m.admitPrefix(ticket, input).status, 'unverified')
	assert.equal(m.snapshot(), before)
	const raw = { ...page([], 'new-raw'), oldest: id(1), newest: id(2), stopped: 'entries' as const }
	assert.equal(m.admitPrefix(ticket, raw).status, 'accepted')
	assert.equal(m.inspectRange()[0]?.recordCount, 0)
	honest(m)
})

test('native overlap splits source-ordered survivors and transfers mandatory protection through aging', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 2, 3]))
	const protectedChunk = m.snapshot().chunks[0]
	assert.ok(protectedChunk)
	assert.equal(m.protect({ chunkIds: [protectedChunk.id] }), true)
	observe(m, [2])
	observe(m, [4])
	assert.deepEqual(
		m
			.snapshot()
			.chunks.flatMap(c => c.page.records)
			.map(rid),
		[1, 2, 3].map(id),
	)
	for (let n = 5; n < 300; n++) observe(m, [n])
	for (const n of [1, 2, 3]) assert.ok(owned(m).includes(id(n)))
	honest(m)
	m.release()
	for (let n = 300; n < 450; n++) observe(m, [n])
	assert.ok(!owned(m).includes(id(2)))
})

test('singleton chunk protection survives complete native migration and source replacement', () => {
	const m = new RemoteTranscriptModel()
	const association = admit(m, page([1]))
	const protectedChunk = m.snapshot().chunks[0]
	assert.ok(protectedChunk)
	assert.equal(m.protect({ chunkIds: [protectedChunk.id] }), true)
	const changed = { ...page([1]), records: [rec(1, 'replacement')] }
	assert.equal(m.restore(association, changed).status, 'accepted')
	observe(m, [1])
	observe(m, [2])
	for (let n = 3; n < 300; n++) observe(m, [n])
	assert.ok(owned(m).includes(id(1)))
	honest(m)
})

test('valid large native projection ages as a charged native singleton without fake reread authority', () => {
	const m = new RemoteTranscriptModel()
	const message = projectRemoteMessage(
		{
			role: 'assistant',
			content: [
				{ type: 'text', text: '\0'.repeat(8192) },
				{ type: 'thinking', thinking: '界'.repeat(8192) },
			],
		},
		id(1),
	)
	assert.ok(message)
	remoteSnapshotSchema.shape.messages.parse([message])
	assert.ok(bytes([message]) > 64 * 1024)
	assert.equal(m.observeLive({ records: [{ kind: 'message', message }], revision: 1, historyTruncated: false }), true)
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	m.settle(ticket, true)
	observe(m, [2])
	const chunk = m.snapshot().chunks[0]
	assert.ok(chunk)
	assert.equal(chunk.origin, 'native')
	assert.equal(chunk.page.reread, '')
	assert.equal(chunk.page.records.length, 1)
	assert.ok(bytes(chunk) > 64 * 1024 && bytes(chunk) <= 164 * 1024)
	assert.deepEqual(chunk.page.records, [{ kind: 'message', message }])
	honest(m)
})

test('forty near-160KiB native messages retain all rows within separately counted wrapping allowance', () => {
	const m = new RemoteTranscriptModel()
	const messages = Array.from({ length: 40 }, (_, i) => {
		const message = projectRemoteMessage({ role: 'user', content: '\0'.repeat(650) }, id(i + 1))
		assert.ok(message)
		return message
	})
	const last = messages.at(-1)
	assert.ok(last)
	last.text += '\0'.repeat(Math.floor((160 * 1024 - bytes(messages)) / 6))
	remoteSnapshotSchema.shape.messages.parse(messages)
	assert.ok(bytes(messages) <= 160 * 1024 && bytes(messages) > 160 * 1024 - 6)
	const records = messages.map(message => ({ kind: 'message' as const, message }))
	assert.ok(bytes(records) > 160 * 1024)
	assert.equal(m.observeLive({ records, revision: 1, historyTruncated: false }), true)
	assert.deepEqual(m.snapshot().live, records)
	assert.equal(m.debug().currentNativeMessageBytes, bytes(messages))
	assert.equal(m.debug().currentLiveBytes, bytes(records))
	assert.equal(m.beginExpansion() !== null, true)
	assert.equal(m.inspectRange().at(-1)?.omitted, false)
	honest(m)
})

// R2 fixtures run the actual bounded reader against an entry map, never Pi/session files.
function readerFixture(n: number, type: (n: number) => string = () => 'message') {
	const entries = new Map<string, HistoryEntry>()
	let leaf: string | null = null
	let now = 1000
	let reads = 0
	let requests = 0
	let newer = 0
	let progress = 0
	let rawOnly = 0
	const append = (k: number) => {
		entries.set(id(k), { id: id(k), parentId: leaf, type: type(k), message: { role: 'user', content: `message ${k}` } })
		leaf = id(k)
	}
	for (let k = 1; k <= n; k++) append(k)
	const target = { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 }
	const epoch = randomUUID()
	const reader = new RemoteHistoryReader(
		target,
		epoch,
		() => ({
			getLeafId: () => leaf,
			getEntry: key => {
				reads++
				return entries.get(key)
			},
		}),
		() => now,
	)
	const client = () => {
		const viewId = randomUUID()
		let sequence = 0
		return (action: HistoryRequest['action']) => {
			const before = reads
			requests++
			if (action.kind === 'newer') newer++
			const result = reader.execute({
				requestId: randomUUID(),
				principalKey: 'fixture',
				expiresAt: now + 4000,
				request: { version: 1, hostEpoch: epoch, target, viewId, sequence: sequence++, action },
			})
			assert.ok(reads - before <= 128)
			assert.ok(bytes(result) <= 96 * 1024)
			if (result.state === 'progress') progress++
			if (result.page?.records.length === 0) rawOnly++
			return result
		}
	}
	return {
		entries,
		append,
		client,
		expire: () => {
			now += 60001
		},
		stats: () => ({ reads, requests, newer, progress, rawOnly }),
	}
}
function beginRepair(m: Model, association?: TranscriptAssociation) {
	const span = m.inspectRange().at(-1)
	assert.ok(span)
	const a = association ?? m.associate(span.id)
	assert.ok(a)
	const operation = m.beginReconciliation(a)
	assert.ok(operation)
	assert.equal(m.restore(a, page([1])).status, 'stale')
	return operation
}
function driveRepair(
	m: Model,
	read: (a: HistoryRequest['action']) => HistoryResult,
	operation: { handle: TranscriptReconciliation; next: HistoryRequest['action'] },
	onStep: (r: ReturnType<Model['reconcile']>, wire: HistoryResult) => void = () => {},
) {
	let action: HistoryRequest['action'] | null = operation.next
	let steps = 0
	while (action) {
		assert.ok(++steps < 2000)
		const wire = read(action)
		const result = m.reconcile(operation.handle, wire)
		assert.ok(['accepted', 'progress'].includes(result.status), `${result.status}/${result.phase}/${steps}`)
		honest(m)
		onStep(result, wire)
		action = result.next
	}
	return steps
}

test('protect identical mandatory ranges is snapshot-quiet; release still clears migrated protection', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1]))
	const chunk = m.snapshot().chunks[0]
	assert.ok(chunk)
	const p = { chunkIds: [chunk.id] }
	assert.equal(m.protect(p), true)
	const before = m.snapshot()
	assert.equal(m.protect(p), true)
	assert.equal(m.snapshot(), before)
	observe(m, [1])
	observe(m, [2])
	m.release()
	for (let n = 3; n < 150; n++) observe(m, [n])
	assert.ok(!owned(m).includes(id(1)))
	honest(m)
})

test('R2 mapped parent probe 5: actual source [A,B,C,D] replaces two observed slots [A,D]', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [1])
	const t = m.beginExpansion()
	assert.ok(t)
	m.settle(t, true)
	observe(m, [4])
	const beforeRoot = m.snapshot().root
	const beforeOlder = m.snapshot().older
	const f = readerFixture(4)
	const operation = beginRepair(m)
	let final: HistoryResult | undefined
	driveRepair(m, f.client(), operation, (result, wire) => {
		if (result.phase === 'complete') final = wire
	})
	assert.deepEqual(owned(m), [1, 2, 3, 4].map(id))
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		4,
	)
	assert.equal(m.snapshot().root, beforeRoot)
	assert.equal(m.snapshot().older, beforeOlder)
	assert.equal(m.debug().activeWork, 0)
	assert.equal(f.stats().newer, 1)
	assert.ok(final)
	const settled = m.snapshot()
	assert.equal(m.reconcile(operation.handle, final).status, 'unchanged')
	assert.equal(m.snapshot(), settled)
	assert.equal(
		m.reconcile(operation.handle, { ...final, sequence: final.sequence + 1, requestId: randomUUID() }).status,
		'stale',
	)
	assert.equal(m.snapshot(), settled)
	assert.ok(m.beginExpansion())
})

test('source replay resolves colliding estimated seam positions rather than treating them as ordinals', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 4]))
	observe(m, [1, 3, 4])
	observe(m, [1, 2, 4])
	assert.ok(m.inspectCheckpoints().filter(c => c.ordering).length >= 2)
	const op = beginRepair(m)
	driveRepair(m, readerFixture(4).client(), op)
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		4,
	)
	assert.ok(!m.inspectCheckpoints().some(c => c.ordering))
	observe(m, [5])
	assert.deepEqual(
		m
			.snapshot()
			.chunks.flatMap(c => c.page.records)
			.map(rid),
		[1, 2, 3, 4].map(id),
	)
	honest(m)
})

test('R2 mapped parent probe 6: sparse 16000-record aggregate accepts unknown subpage endpoints with linear two-pass work', () => {
	const m = new RemoteTranscriptModel()
	for (let n = 16000; n > 0; n -= 40) admit(m, page(Array.from({ length: 40 }, (_, i) => n - 39 + i)))
	const aggregate = m.inspectRange().find(s => s.source === 'aggregate')
	assert.ok(aggregate)
	const checkpoints = m
		.inspectCheckpoints()
		.filter(c => c.spanId === aggregate.id)
		.sort((a, b) => a.position - b.position)
	assert.ok(checkpoints.some((c, i) => (checkpoints[i + 1]?.position ?? c.position) - c.position > 40))
	const a = m.associate(aggregate.id)
	assert.ok(a)
	const f = readerFixture(16000)
	const op = beginRepair(m, a)
	const oldIds = new Set(m.inspectCheckpoints().map(c => c.id))
	const beforeCount = m.inspectRange().reduce((n, s) => n + s.recordCount, 0)
	let unknownEndpoint = false
	let accepted = 0
	driveRepair(m, f.client(), op, (result, wire) => {
		if (result.status === 'accepted' && wire.page) {
			accepted++
			unknownEndpoint ||= !!wire.page.records[0] && !oldIds.has(rid(wire.page.records[0]))
		}
		assert.ok(m.debug().metadataBytes < 256 * 1024)
		const active = Reflect.get(m, 'state').reconciliation as Record<string, unknown>
		assert.ok(bytes(active) < 8 * 1024)
		assert.deepEqual(Object.keys(active).sort(), [
			'binding',
			'expected',
			'frontier',
			'handle',
			'last',
			'lower',
			'phase',
			'seed',
			'upper',
		])
		assert.ok(!JSON.stringify(active).includes('"records":'))
	})
	assert.ok(unknownEndpoint && accepted > 100)
	assert.equal(m.inspectRange()[0]?.first, id(1))
	assert.equal(m.inspectRange().at(-1)?.last, id(16000))
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		beforeCount,
	)
	assert.equal(f.stats().newer, 1)
	assert.ok(f.stats().reads < 50000, JSON.stringify(f.stats()))
	assert.ok(f.stats().requests < 1100, JSON.stringify(f.stats()))
	console.log('R2 linear reader', f.stats())
})

test('reader raw-only, marker, root singleton and progress all preserve revealed bounds', () => {
	for (const spec of [
		{ n: 1, lo: 1, hi: 1, type: (_n: number) => 'message' },
		{
			n: 620,
			lo: 1,
			hi: 620,
			type: (n: number) => ([1, 620].includes(n) ? 'message' : n === 400 ? 'compaction' : 'custom'),
		},
		{ n: 5010, lo: 2000, hi: 4500, type: (_n: number) => 'message' },
	]) {
		const m = new RemoteTranscriptModel()
		const a = admit(m, page(spec.lo === spec.hi ? [spec.lo] : [spec.lo, spec.hi]))
		const f = readerFixture(spec.n, spec.type)
		const oldRoot = m.snapshot().root
		const oldOlder = m.snapshot().older
		driveRepair(m, f.client(), beginRepair(m, a))
		assert.equal(m.inspectRange()[0]?.first, id(spec.lo))
		assert.equal(m.inspectRange().at(-1)?.last, id(spec.hi))
		assert.equal(m.snapshot().root, oldRoot)
		assert.equal(m.snapshot().older, oldOlder)
		assert.equal(f.stats().newer, 1)
		if (spec.n === 620) {
			assert.ok(f.stats().rawOnly > 0)
			assert.deepEqual(owned(m), [1, 400, 620].map(id))
			assert.equal(
				m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
				3,
			)
			assert.ok(m.snapshot().chunks.some(c => c.page.records.some(r => r.kind === 'marker')))
			assert.ok(m.inspectRange().some(s => s.recordCount === 0 && s.omitted))
			assert.equal(
				m.snapshot().chunks.reduce((n, c) => n + c.page.omissions.unsupported, 0),
				617,
			)
		}
		if (spec.n === 5010) assert.ok(f.stats().progress > 0)
	}
})

test('discovery cancel is nonmutating; partial cancel retains outside payload and protected canonical anchor', () => {
	const m = new RemoteTranscriptModel()
	const a = admit(m, page([1, 2, 200, 201]))
	const span = m.inspectRange()[0]
	assert.ok(span)
	const inner = m.associate(span.id, a.start + 1, a.end - 1)
	assert.ok(inner)
	const f = readerFixture(201)
	const op = beginRepair(m, inner)
	const before = m.snapshot()
	const read = f.client()
	const step = m.reconcile(op.handle, read(op.next))
	assert.equal(step.status, 'progress')
	assert.deepEqual(m.snapshot().chunks, before.chunks)
	assert.deepEqual(m.inspectRange(), before.spans)
	assert.equal(m.cancelReconciliation(op.handle), true)
	assert.equal(m.reconcile(op.handle, read(op.next)).status, 'stale')
	assert.ok(m.protect({ anchorIds: [id(2)] }))
	const again = m.associate(span.id, a.start + 1, a.end - 1)
	assert.ok(again)
	const next = beginRepair(m, again)
	let action = next.next
	const fresh = f.client()
	for (let i = 0; i < 30; i++) {
		const result = m.reconcile(next.handle, fresh(action))
		assert.ok(result.next)
		action = result.next
		if (result.status === 'accepted' && owned(m).length > 4) break
	}
	assert.ok(owned(m).length > 4)
	assert.ok([1, 2, 200, 201].every(n => owned(m).includes(id(n))))
	assert.equal(m.inspectRange()[0]?.first, id(1))
	assert.equal(m.inspectRange().at(-1)?.last, id(201))
	assert.ok(m.inspectRange().some(s => s.countIsEstimate && s.gap))
	assert.equal(m.cancelReconciliation(next.handle), true)
	honest(m)
})

test('wrong result action/binding/sequence and exact duplicates cannot advance discovery twice', () => {
	const m = new RemoteTranscriptModel()
	const a = admit(m, page([1, 100]))
	const op = beginRepair(m, a)
	const read = readerFixture(100).client()
	const first = read(op.next)
	const before = m.snapshot()
	assert.equal(m.reconcile(op.handle, { ...first, input: { kind: 'close' } }).status, 'stale')
	assert.equal(m.snapshot(), before)
	const accepted = m.reconcile(op.handle, first)
	assert.ok(accepted.next)
	const second = read(accepted.next)
	for (const bad of [
		{ ...second, viewId: randomUUID() },
		{ ...second, hostEpoch: randomUUID() },
		{ ...second, target: { ...second.target, generation: 2 } },
		{ ...second, sequence: first.sequence },
	]) {
		const snapshot = m.snapshot()
		assert.equal(m.reconcile(op.handle, bad).status, 'stale')
		assert.equal(m.snapshot(), snapshot)
	}
	const snapshot = m.snapshot()
	assert.equal(m.reconcile(op.handle, first).status, 'unchanged')
	assert.equal(m.snapshot(), snapshot)
	assert.equal(m.reconcile(op.handle, second).status, 'progress')
	assert.equal(m.reconcile(op.handle, first).status, 'stale')
	assert.equal(m.beginExpansion(), null)
	m.clear()
	assert.equal(m.reconcile(op.handle, second).status, 'stale')
})

test('expiry retires old seed; a fresh view with different seed segmentation reconstructs', () => {
	const m = new RemoteTranscriptModel()
	const a = admit(m, page([1, 500]))
	const f = readerFixture(500)
	const op = beginRepair(m, a)
	const read = f.client()
	let result = m.reconcile(op.handle, read(op.next))
	assert.ok(result.next)
	const oldSeed = read(result.next)
	assert.ok(oldSeed.page)
	const oldNewest = oldSeed.page.newest
	result = m.reconcile(op.handle, oldSeed)
	assert.ok(result.next)
	const old = m.snapshot().chunks
	f.expire()
	assert.equal(m.reconcile(op.handle, read(result.next)).status, 'unverified')
	assert.deepEqual(m.snapshot().chunks, old)
	for (let i = 501; i <= 540; i++) f.append(i)
	const retry = beginRepair(m)
	let changedSegmentation = false
	driveRepair(m, f.client(), retry, (_result, wire) => {
		if (wire.input.kind === 'newer' && wire.page) {
			assert.notEqual(wire.page.newest, oldNewest)
			changedSegmentation = true
		}
	})
	assert.equal(changedSegmentation, true)
	assert.equal(m.inspectRange()[0]?.first, id(1))
	assert.equal(m.inspectRange().at(-1)?.last, id(500))
	assert.ok(!owned(m).includes(id(501)))
})

test('actual reader capacity refusal preserves expected replay action and all payload until exact retry', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 200]))
	for (let n = 0; n > -127; n--) admit(m, page([n]))
	assert.equal(m.debug().residentChunks, 128)
	assert.ok(m.protect({ chunkIds: m.snapshot().chunks.map(c => c.id) }))
	const op = beginRepair(m)
	const read = readerFixture(200).client()
	let action = op.next
	let blocked: HistoryResult | null = null
	for (let i = 0; i < 30; i++) {
		const wire = read(action)
		const before = m.snapshot()
		const result = m.reconcile(op.handle, wire)
		if (result.status === 'capacity') {
			assert.equal(m.snapshot(), before)
			assert.deepEqual(result.next, action)
			blocked = wire
			break
		}
		assert.ok(result.next)
		action = result.next
	}
	assert.ok(blocked)
	assert.equal(m.debug().residentChunks, 128)
	assert.ok(m.protect({ anchorIds: [id(1)] }))
	const accepted = m.reconcile(op.handle, blocked)
	assert.equal(accepted.status, 'accepted')
	const before = m.snapshot()
	assert.equal(m.reconcile(op.handle, blocked).status, 'unchanged')
	assert.equal(m.snapshot(), before)
	assert.ok(owned(m).includes(id(1)))
	honest(m)
})

test('native middle insertion and append during discovery retain native payload, protected anchor and outside tail', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [1, 3, 200])
	const t = m.beginExpansion()
	assert.ok(t)
	m.settle(t, true)
	assert.ok(m.protect({ anchorIds: [id(3)] }))
	const op = beginRepair(m)
	const f = readerFixture(200)
	const read = f.client()
	const first = m.reconcile(op.handle, read(op.next))
	assert.ok(first.next)
	m.observeLive({
		records: [rec(1), rec(2), rec(3, 'native current wins'), rec(200), rec(201)],
		revision: 2,
		historyTruncated: true,
	})
	driveRepair(m, read, { handle: op.handle, next: first.next })
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		201,
	)
	assert.equal(m.inspectRange()[0]?.first, id(1))
	assert.equal(m.inspectRange().at(-1)?.last, id(201))
	assert.ok(m.snapshot().live.some(r => r.kind === 'message' && r.message.text === 'native current wins'))
	observe(m, [202])
	const chunkIds = m
		.snapshot()
		.chunks.flatMap(c => c.page.records)
		.map(rid)
	assert.deepEqual(
		chunkIds,
		Array.from({ length: 201 }, (_, i) => id(i + 1)),
	)
	for (let n = 203; n < 350; n++) observe(m, [n])
	assert.ok(owned(m).includes(id(3)))
	honest(m)
})

test('new native membership inside replayed coverage retires proof; late result cannot erase it', () => {
	for (const arrival of [[180, 900, 181], [900]]) {
		const m = new RemoteTranscriptModel()
		const a = admit(m, page([1, 200]))
		const op = beginRepair(m, a)
		const read = readerFixture(200).client()
		let action = op.next
		for (let i = 0; i < 30; i++) {
			const result = m.reconcile(op.handle, read(action))
			assert.ok(result.next)
			action = result.next
			if (owned(m).includes(id(180))) break
		}
		assert.ok(owned(m).includes(id(180)))
		assert.ok(m.protect({ anchorIds: [id(180)] }))
		const late = read(action)
		observe(m, arrival)
		const before = m.snapshot()
		assert.equal(m.reconcile(op.handle, late).status, 'stale')
		assert.equal(m.snapshot(), before)
		assert.ok([1, 180, 200, 900].every(n => owned(m).includes(id(n))))
		assert.ok(m.inspectRange().some(s => s.countIsEstimate && s.gap && s.coverage === 'unverified'))
		assert.equal(m.inspectRange()[0]?.first, id(1))
		// Ambiguous no-overlap arrivals retain M1's observed extension, never label it authenticated.
		if (arrival.length > 1) assert.equal(m.inspectRange().at(-1)?.last, id(200))
		assert.equal(m.debug().activeWork, 0)
		honest(m)
	}
})

test('existing native payload updates and proven outside-upper append do not retire replay', () => {
	const m = new RemoteTranscriptModel()
	const a = admit(m, page([1, 200]))
	const op = beginRepair(m, a)
	const read = readerFixture(200).client()
	let action = op.next
	for (let i = 0; i < 30; i++) {
		const result = m.reconcile(op.handle, read(action))
		assert.ok(result.next)
		action = result.next
		if (owned(m).includes(id(180))) break
	}
	m.observeLive({ records: [rec(180, 'updated'), rec(200), rec(201)], revision: 2, historyTruncated: true })
	assert.equal(m.debug().activeWork, 1)
	driveRepair(m, read, { handle: op.handle, next: action })
	assert.equal(m.inspectRange().at(-1)?.last, id(201))
	assert.ok(m.snapshot().live.some(r => r.kind === 'message' && r.message.text === 'updated'))
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		201,
	)
	honest(m)
})

test('missing canonical bounds or broken ancestry retire discovery without publishing omissions or payload', () => {
	for (const missing of [1, 100, 50]) {
		const m = new RemoteTranscriptModel()
		const a = admit(m, page([1, 100]))
		const op = beginRepair(m, a)
		const before = m.snapshot()
		const fixture = readerFixture(100, n => (n === missing ? 'custom' : 'message'))
		if (missing === 50) fixture.entries.delete(id(50))
		const read = fixture.client()
		let action: HistoryRequest['action'] | null = op.next
		let status = ''
		while (action) {
			const result = m.reconcile(op.handle, read(action))
			status = result.status
			action = result.next
		}
		assert.equal(status, 'unverified')
		assert.deepEqual(m.snapshot().chunks, before.chunks)
		assert.deepEqual(m.snapshot().spans, before.spans)
		assert.equal(m.debug().activeWork, 0)
	}
})

test('unmatched protected native row prevents final commit, preserves uncertain remainder and retires operation', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [1, 3])
	const t = m.beginExpansion()
	assert.ok(t)
	m.settle(t, true)
	observe(m, [3, 100])
	assert.ok(m.protect({ anchorIds: [id(3)] }))
	const op = beginRepair(m)
	const f = readerFixture(100, n => (n === 3 ? 'model_change' : 'message'))
	const read = f.client()
	let action: HistoryRequest['action'] | null = op.next
	let unverified = false
	while (action) {
		const result = m.reconcile(op.handle, read(action))
		if (result.status === 'unverified') unverified = true
		action = result.next
	}
	assert.equal(unverified, true)
	assert.ok([1, 3, 100].every(n => owned(m).includes(id(n))))
	assert.ok(owned(m).length > 3)
	assert.equal(m.inspectRange()[0]?.first, id(1))
	assert.equal(m.inspectRange().at(-1)?.last, id(100))
	assert.ok(m.inspectRange().some(s => s.countIsEstimate && s.gap))
	assert.equal(m.debug().activeWork, 0)
	honest(m)
})

test('actual reader near-64KiB record array admits its larger sealed page framing', () => {
	const target = { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 }
	const epoch = randomUUID()
	const entries = new Map<
		string,
		{ id: string; parentId: string | null; type: string; message: { role: string; content: string } }
	>()
	const records: HistoryRecord[] = []
	for (let n = 1; n <= 8; n++) {
		const text = 'x'.repeat(n === 1 ? 1 : 8192)
		const message = projectRemoteMessage({ role: 'user', content: text }, id(n))
		assert.ok(message)
		records.push({ kind: 'message', message })
		entries.set(id(n), {
			id: id(n),
			parentId: n === 1 ? null : id(n - 1),
			type: 'message',
			message: { role: 'user', content: text },
		})
	}
	const firstEntry = entries.get(id(1))
	assert.ok(firstEntry)
	firstEntry.message.content += 'x'.repeat(65530 - bytes(records))
	entries.set(id(9), { id: id(9), parentId: id(8), type: 'message', message: { role: 'user', content: 'head' } })
	const reader = new RemoteHistoryReader(
		target,
		epoch,
		() => ({ getLeafId: () => id(9), getEntry: key => entries.get(key) }),
		() => 1000,
	)
	const result = reader.execute({
		requestId: randomUUID(),
		principalKey: 'fixture',
		expiresAt: 5000,
		request: {
			version: 1,
			hostEpoch: epoch,
			target,
			viewId: randomUUID(),
			sequence: 1,
			action: { kind: 'open', anchor: id(9) },
		},
	})
	assert.equal(result.state, 'page')
	assert.ok(result.page)
	assert.equal(bytes(result.page.records), 65530)
	assert.ok(bytes(result.page) > 64 * 1024)
	assert.ok(bytes(result) <= 96 * 1024)
	const m = new RemoteTranscriptModel()
	admit(m, result.page)
	assert.equal(m.snapshot().chunks[0]?.origin, 'history')
	assert.ok(bytes(m.snapshot().chunks[0]) > 64 * 1024)
	assert.ok(bytes(m.snapshot().chunks[0]) <= 96 * 1024)
	honest(m)
})

// Stop only after a committed replay fragment; discovery alone needs no recovery annotation.
function partialRepair(
	m: Model,
	f: ReturnType<typeof readerFixture>,
	count: number,
	association?: TranscriptAssociation,
) {
	const op = beginRepair(m, association)
	const read = f.client()
	let action = op.next
	let accepted = 0
	for (let i = 0; i < 2000; i++) {
		const result = m.reconcile(op.handle, read(action))
		assert.ok(['accepted', 'progress'].includes(result.status), result.status)
		assert.ok(result.next)
		action = result.next
		honest(m)
		if (result.status === 'accepted' && ++accepted === count) return { op, read, action }
	}
	assert.fail('did not reach partial replay')
}
function recoveryAssociation(m: Model) {
	const span = m.inspectRange().find(s => s.recovery)
	assert.ok(span)
	const association = m.associate(span.id)
	assert.ok(association)
	return association
}

for (const fragments of [1, 2, 4]) {
	test(`partial cancellation after ${fragments} replay fragments reacquires immutable full recovery bounds`, () => {
		const m = new RemoteTranscriptModel()
		const a = admit(m, page([1, 200]))
		const f = readerFixture(200)
		const { op, read } = partialRepair(m, f, fragments, a)
		assert.ok(m.inspectRange().some(s => s.recovery?.lower === id(1) && s.recovery.upper === id(200)))
		assert.equal(m.cancelReconciliation(op.handle), true)
		read({ kind: 'close' })
		assert.ok(m.protect({ anchorIds: [id(1)] }))
		const quiet = m.snapshot()
		assert.ok(m.protect({ anchorIds: [id(1)] }))
		assert.equal(m.setViewport(quiet.viewport), false)
		assert.equal(m.compact(), false)
		assert.equal(m.snapshot(), quiet)
		const remaining = m.inspectRange().find(s => s.recovery)
		assert.ok(remaining)
		// A point reread must widen BEFORE minting, not reinterpret the handle later.
		const fresh = m.associate(remaining.id, remaining.start, remaining.start + 1)
		assert.ok(fresh)
		assert.equal(fresh.first, id(1))
		assert.equal(fresh.last, id(200))
		const fixed = JSON.stringify(fresh)
		driveRepair(m, f.client(), beginRepair(m, fresh))
		assert.equal(JSON.stringify(fresh), fixed)
		assert.deepEqual(
			owned(m),
			Array.from({ length: 200 }, (_, i) => id(i + 1)),
		)
		assert.equal(
			m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
			200,
		)
		assert.ok(m.inspectRange().every(s => !s.recovery))
		honest(m)
	})
}

for (const failure of ['expired', 'unverified'] as const) {
	test(`partial ${failure} retirement retains recovery, outside payload and the protected canonical anchor`, () => {
		const m = new RemoteTranscriptModel()
		const a = admit(m, page([0, 1, 200, 201]))
		const span = m.inspectRange()[0]
		assert.ok(span)
		const inner = m.associate(span.id, a.start + 1, a.end - 1)
		assert.ok(inner)
		assert.ok(m.protect({ anchorIds: [id(1)] }))
		m.setViewport({
			scrollTop: 0,
			height: 500,
			width: 400,
			activity: false,
			readingVisible: true,
			anchor: { id: id(1), offset: 7 },
		})
		const f = readerFixture(201)
		const { op, read, action } = partialRepair(m, f, 2, inner)
		const before = m.snapshot()
		if (failure === 'expired') f.expire()
		else {
			const entry = f.entries.get(id(100))
			assert.ok(entry)
			f.entries.delete(id(100))
		}
		let next: HistoryRequest['action'] | null = action
		let outcome = ''
		while (next) {
			const result = m.reconcile(op.handle, read(next))
			outcome = result.status
			next = result.next
		}
		assert.equal(outcome, 'unverified')
		assert.ok([0, 1, 200, 201].every(n => owned(m).includes(id(n))))
		assert.deepEqual(m.snapshot().viewport.anchor, before.viewport.anchor)
		assert.ok(m.inspectRange().some(s => s.recovery))
		const freshFixture = readerFixture(201)
		driveRepair(m, freshFixture.client(), beginRepair(m, recoveryAssociation(m)))
		assert.deepEqual(
			owned(m),
			Array.from({ length: 202 }, (_, i) => id(i)),
		)
		assert.equal(m.inspectRange()[0]?.first, id(0))
		assert.equal(m.inspectRange().at(-1)?.last, id(201))
		assert.equal(m.snapshot().older, before.older)
		assert.equal(m.snapshot().root, before.root)
		assert.ok(m.inspectRange().every(s => !s.recovery))
		honest(m)
	})
}

test('overlapping recovery envelopes union transitively; a narrower exact reread cannot clear uncertainty', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 100, 200, 201]))
	const initial = m.inspectRange()[0]
	assert.ok(initial)
	const inner = m.associate(initial.id, initial.start + 1, initial.end - 1)
	assert.ok(inner)
	const f = readerFixture(201)
	const first = partialRepair(m, f, 2, inner)
	m.cancelReconciliation(first.op.handle)
	first.read({ kind: 'close' })
	const spans = m.inspectRange()
	const oldest = spans[0]
	assert.ok(oldest)
	const upper = m.inspectCheckpoints().find(c => c.id === id(200))
	assert.ok(upper)
	// Source-known cross-span request extends the older side of an existing envelope.
	const wider = m.associate(oldest.id, oldest.start, upper.position + 1)
	assert.ok(wider)
	assert.equal(wider.first, id(1))
	assert.equal(wider.last, id(200))
	const second = partialRepair(m, f, 4, wider)
	m.cancelReconciliation(second.op.handle)
	second.read({ kind: 'close' })
	const envelopes = m.inspectRange().flatMap(s => (s.recovery ? [s.recovery] : []))
	// The overlapping requests share a lower-boundary owner during seed replay, so the
	// one-annotation-per-span rule coalesces them before subsequent splits.
	assert.equal(envelopes.length, 1)
	assert.equal(envelopes[0]?.lower, id(1))
	assert.equal(envelopes[0]?.upper, id(200))
	const one = m.inspectCheckpoints().find(c => c.id === id(100))
	assert.ok(one)
	const owner = m.inspectRange().find(s => s.start <= one.position && s.end > one.position)
	assert.ok(owner)
	const narrow = m.associate(owner.id, one.position, one.position + 1)
	assert.ok(narrow)
	assert.equal(narrow.first, id(1))
	assert.equal(narrow.last, id(200))
	const before = m.snapshot()
	assert.equal(m.restore(narrow, page([100])).status, 'unverified')
	assert.equal(m.snapshot(), before)
	driveRepair(m, f.client(), beginRepair(m, narrow))
	assert.deepEqual(
		owned(m),
		Array.from({ length: 201 }, (_, i) => id(i + 1)),
	)
	assert.ok(m.inspectRange().every(s => !s.recovery))
	honest(m)
})

test('repeated partial recovery survives compaction, sparse endpoint eviction and native growth within all bounds', () => {
	const m = new RemoteTranscriptModel()
	const a = admit(m, page([100, 4000]))
	const f = readerFixture(4200)
	let run = partialRepair(m, f, 70, a)
	m.cancelReconciliation(run.op.handle)
	run.read({ kind: 'close' })
	for (let n = 99; n >= 1; n--) admit(m, page([n]))
	for (let n = 4001; n <= 7000; n++) {
		observe(m, [n])
		if (n % 100 === 0) honest(m)
	}
	assert.ok(!owned(m).includes(id(100)))
	assert.ok(!owned(m).includes(id(4000)))
	const envelope = m.inspectRange().find(s => s.recovery)?.recovery
	assert.ok(envelope)
	assert.notEqual(envelope.lower, id(100)) // compaction includes already revealed older neighbors
	assert.equal(envelope.lower, m.inspectRange().find(s => s.recovery)?.first)
	assert.ok(envelope.start >= (m.inspectRange()[0]?.start ?? 0))
	assert.equal(envelope.upper, id(4000))
	assert.ok(!m.inspectCheckpoints().some(c => c.id === id(4000)))
	for (let i = 0; i < 3; i++) {
		run = partialRepair(m, f, i + 1, recoveryAssociation(m))
		m.cancelReconciliation(run.op.handle)
		run.read({ kind: 'close' })
		m.compact()
		assert.ok(m.inspectRange().some(s => s.recovery))
		honest(m)
	}
	const bound = m.inspectRange().at(-1)?.last
	const fixed = recoveryAssociation(m)
	const fixedBytes = JSON.stringify(fixed)
	driveRepair(m, f.client(), beginRepair(m, fixed))
	assert.equal(JSON.stringify(fixed), fixedBytes)
	// Concurrent compaction can conservatively add the last older outside span.
	// Completion of the fixed request must NOT clear that newly broadened uncertainty.
	const broadened = m.inspectRange().find(s => s.recovery)?.recovery
	assert.ok(broadened)
	assert.equal(broadened.lower, id(1))
	assert.notEqual(broadened.lower, fixed.first)
	driveRepair(m, f.client(), beginRepair(m, recoveryAssociation(m)))
	assert.ok(m.inspectRange().every(s => !s.recovery))
	assert.equal(m.inspectRange()[0]?.first, id(1))
	assert.equal(m.inspectRange().at(-1)?.last, bound)
	assert.equal(
		m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
		7000,
	)
	honest(m)
})

test('real sparse straddling protection preserves BOTH outside portions through partial retry, native aging and release', () => {
	const f = readerFixture(122, n => ([1, 2, 120, 121].includes(n) ? 'message' : 'model_change'))
	const initialRead = f.client()
	const source = initialRead({ kind: 'open', anchor: id(122) })
	assert.ok(source.page)
	assert.deepEqual(source.page.records.map(rid), [1, 2, 120, 121].map(id))
	const m = new RemoteTranscriptModel()
	const a = admit(m, source.page)
	initialRead({ kind: 'close' })
	const chunk = m.snapshot().chunks[0]
	assert.ok(chunk)
	assert.ok(m.protect({ chunkIds: [chunk.id] }))
	for (let n = 3; n < 120; n++) {
		const entry = f.entries.get(id(n))
		assert.ok(entry)
		f.entries.set(id(n), { ...entry, type: 'message' })
	}
	const span = m.inspectRange()[0]
	assert.ok(span)
	const inner = m.associate(span.id, a.start + 1, a.end - 1)
	assert.ok(inner)
	const partial = partialRepair(m, f, 2, inner)
	m.cancelReconciliation(partial.op.handle)
	partial.read({ kind: 'close' })
	driveRepair(m, f.client(), beginRepair(m, recoveryAssociation(m)))
	observe(m, [1, 121])
	for (let n = 122; n < 322; n++) assert.equal(observe(m, [n]), true)
	assert.ok(owned(m).includes(id(1)), 'older protected outside portion survives')
	assert.ok(owned(m).includes(id(121)), 'newer protected outside portion survives')
	honest(m)
	m.release()
	for (let n = 322; n < 522; n++) observe(m, [n])
	assert.ok(!owned(m).includes(id(1)))
	assert.ok(!owned(m).includes(id(121)))
	honest(m)
})

for (const arrival of [[180, 900, 181, 200], [900]]) {
	test(`native-race retirement retains recoverable bounds for ${arrival.length > 1 ? 'proven interior insertion' : 'ambiguous new tail'}`, () => {
		const m = new RemoteTranscriptModel()
		const a = admit(m, page([1, 200]))
		const f = readerFixture(200)
		const partial = partialRepair(m, f, 2, a)
		assert.ok(m.protect({ anchorIds: [id(180)] }))
		const late = partial.read(partial.action)
		observe(m, arrival)
		assert.equal(m.debug().activeWork, 0)
		const before = m.snapshot()
		assert.equal(m.reconcile(partial.op.handle, late).status, 'stale')
		assert.equal(m.snapshot(), before)
		assert.ok(m.inspectRange().some(s => s.recovery?.lower === id(1) && s.recovery.upper === id(200)))
		if (arrival.length > 1) {
			f.entries.set(id(900), {
				id: id(900),
				parentId: id(180),
				type: 'message',
				message: { role: 'user', content: 'message 900' },
			})
			const successor = f.entries.get(id(181))
			assert.ok(successor)
			f.entries.set(id(181), { ...successor, parentId: id(900) })
		}
		partial.read({ kind: 'close' })
		driveRepair(m, f.client(), beginRepair(m, recoveryAssociation(m)))
		assert.ok(m.inspectRange().every(s => !s.recovery))
		assert.ok([1, 180, 200, 900].every(n => owned(m).includes(id(n))))
		assert.equal(
			m.inspectRange().reduce((n, s) => n + s.recordCount, 0),
			201,
		)
		honest(m)
	})
}

test('M2 presentation matches thinking, legacy leading newline, structured presence and speaker-neutral tools', () => {
	const base = { id: id(1), role: 'assistant' as const, text: '', thinking: '', truncated: false }
	assert.equal(isLegacyWholeToolActivity({ ...base, text: 'Tool: bash' }), false)
	assert.equal(isLegacyWholeToolActivity({ ...base, text: '\nTool: bash' }), true)
	assert.equal(isLegacyWholeToolActivity({ ...base, text: '\nTool: bash', toolCalls: '' }), false)
	assert.equal(isMessageVisible({ ...base, toolCalls: 'bash' }, false), false)
	assert.equal(isMessageVisible({ ...base, thinking: '**Thinking:** keep this' }, false), true)
	assert.equal(isMessageVisible({ ...base, thinking: '\x1b[31mThinking:\x1b[0m' }, false), false)
	assert.equal(
		classifyTranscriptRecord({ kind: 'message', message: { ...base, role: 'toolResult', text: 'output' } }, true)
			.speaker,
		null,
	)
	const m = new RemoteTranscriptModel()
	const p = page([1, 2, 3, 4])
	p.records = [
		{ kind: 'message', message: { ...base, text: 'first' } },
		{ kind: 'message', message: { ...base, id: id(2), role: 'toolResult', text: 'output' } },
		{ kind: 'message', message: { ...base, id: id(3), thinking: 'Thinking: retained thinking' } },
		{ kind: 'message', message: { ...base, id: id(4), thinking: 'Thinking:' } },
	]
	admit(m, p)
	m.configureLayout(geometryLayout())
	assert.deepEqual(
		windowRows(m).map(row => rid(row.record)),
		[1, 3].map(id),
	)
	assert.deepEqual(
		windowRows(m).map(row => row.grouping),
		['author', 'continuation'],
	)
	m.configureLayout(geometryLayout({ activity: true }))
	assert.deepEqual(
		windowRows(m).map(row => rid(row.record)),
		[1, 2, 3].map(id),
	)
	assert.deepEqual(
		windowRows(m).map(row => row.grouping),
		['author', 'none', 'continuation'],
	)
})

// Atomic checkpoint regressions. These exercise the retained source and geometry together;
// ledger/certified pixel reads/model-issued hydration remain separate, unfinished gates.
function currentWindowPayloads(m: Model) {
	const resident = new Map(
		[...m.snapshot().chunks.flatMap(c => c.page.records), ...m.snapshot().live].map(r => [rid(r), r]),
	)
	for (const row of windowRows(m))
		assert.equal(row.record, resident.get(rid(row.record)), 'window must borrow its current M1 owner')
	honest(m)
}
function captureFirst(m: Model) {
	const row = windowRows(m)[0]
	assert.ok(row)
	const input = { ...geometryReading(m, row.top), anchor: { key: row.key, inRowOffset: 0, viewportOffset: 0 } }
	assert.equal(m.setReading(input).status, 'accepted')
	return row.key
}
function alternatingGeometry(count: number) {
	const m = new RemoteTranscriptModel()
	for (let end = count; end > 0; end -= 40) {
		const ns = Array.from({ length: Math.min(40, end) }, (_, i) => end - Math.min(40, end) + 1 + i)
		const p = page(ns, `alternating-${end}`)
		p.records = ns.map(n => ({
			kind: 'message',
			message: {
				id: id(n),
				role: 'assistant',
				text: n % 2 ? `body ${n}` : '',
				thinking: '',
				toolCalls: n % 2 ? '' : 'tool',
				truncated: false,
			},
		}))
		assert.ok(historyPageSchema.safeParse(p).success)
		admit(m, p)
	}
	assert.equal(m.protect({ chunkIds: m.snapshot().chunks.map(c => c.id) }), true)
	return m
}

test('M2 atomic: required viewport overflow retains private reading, layout and issued measurements', () => {
	const m = new RemoteTranscriptModel()
	for (let end = 200; end > 0; end -= 40) admit(m, page(Array.from({ length: 40 }, (_, i) => end - 39 + i)))
	assert.equal(m.configureLayout(geometryLayout()).status, 'accepted')
	assert.equal(m.setReading({ ...geometryReading(m, 0), viewportHeight: 120 * 80 }).status, 'accepted')
	assert.equal(geometryWindow(m).historicalVisibleCount, 120)
	assert.equal(geometryWindow(m).historicalOverscanCount, 0)
	assert.equal(m.setReading(geometryReading(m, 0)).status, 'accepted')
	const anchor = captureFirst(m)
	const before = m.snapshot()
	const batch = geometryBatch(m, [73])
	assert.equal(
		m.setReading({ ...geometryReading(m, 0), viewportHeight: 20000, direction: 'older', following: true }).status,
		'capacity',
	)
	assert.equal(m.snapshot(), before)
	assert.equal(m.measureWindow(batch).status, 'accepted', 'refusal must retain the issued frame')
	assert.equal(m.configureLayout(geometryLayout({ width: 801 })).status, 'accepted')
	assert.equal(geometryWindow(m).restoration.kind, 'canonical')
	assert.ok(windowRows(m).some(row => row.key === anchor))
	const accepted = m.snapshot()
	assert.equal(
		m.configureLayout(geometryLayout({ viewportHeight: 20000 })).status,
		'accepted',
		'reading capture still owns its observed viewport height',
	)
	assert.notEqual(m.snapshot(), accepted)
	currentWindowPayloads(m)
})

test('M2 atomic: prefix commits its extent and shifts the retained canonical reading neighborhood', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page(Array.from({ length: 40 }, (_, i) => 201 + i)))
	m.configureLayout(geometryLayout())
	const anchor = captureFirst(m)
	const old = geometryWindow(m)
	admit(m, page(Array.from({ length: 40 }, (_, i) => 1 + i)))
	assert.equal(geometryWindow(m).logicalExtent, 6400)
	assert.ok(windowRows(m).some(row => row.key === anchor && row.top === 3200))
	assert.ok(geometryWindow(m).serial > old.serial)
	const capture = Reflect.get(m, 'state').geometry.reading
	assert.equal(capture.logicalViewportTop, 3200)
	assert.equal(capture.physicalScrollTop, -12, 'logical prepend is not physical browser rebasing')
	currentWindowPayloads(m)
})

test('M2 atomic: native payload change retires only changed row measurement identity and aging borrows current source', () => {
	const m = new RemoteTranscriptModel()
	observe(m, [1, 2])
	m.configureLayout(geometryLayout())
	const key = captureFirst(m)
	const batch = geometryBatch(m, [25, 35])
	m.measureWindow(batch)
	const rows = windowRows(m)
	const stale = geometryBatch(m, [50, 60])
	assert.equal(
		m.observeLive({ records: [rec(1, 'changed native body'), rec(2)], revision: 2, historyTruncated: false }),
		true,
	)
	assert.equal(m.measureWindow(stale).status, 'stale')
	assert.equal(windowRows(m)[0].key, key)
	assert.notEqual(windowRows(m)[0].measurementKey, rows[0].measurementKey)
	assert.equal(windowRows(m)[1].measurementKey, rows[1].measurementKey)
	assert.equal(windowRows(m)[1].height, 35)
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	m.settle(ticket, true)
	observe(m, [3])
	assert.equal(windowRows(m).find(row => row.key === key)?.origin, 'history')
	assert.equal(windowRows(m).find(row => row.key === key)?.record.kind, 'message')
	for (let n = 4; n <= 145; n++) assert.equal(observe(m, [n]), true)
	assert.ok(owned(m).includes(id(1)))
	currentWindowPayloads(m)
})

test('M2 atomic: caller pins, geometry pins and temporary restore pins remain independent under cache pressure', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 2, 3, 4]))
	m.configureLayout(geometryLayout())
	const anchor = captureFirst(m)
	const original = m.snapshot().chunks[0]
	assert.ok(m.protect({ chunkIds: [original.id] }))
	const span = m.inspectRange()[0]
	const association = m.associate(span.id, span.start + 1, span.start + 3)
	assert.ok(association)
	const replacement = page([2, 3], 'changed-restore')
	replacement.records[0] = rec(2, 'new middle payload')
	assert.equal(m.restore(association, replacement).status, 'accepted')
	m.settle(association, true)
	currentWindowPayloads(m)
	m.configureLayout(geometryLayout({ enabled: false }))
	for (let n = 5; n < 150; n++) observe(m, [n])
	assert.ok(
		[1, 2, 3, 4].every(n => owned(m).includes(id(n))),
		'disable must not erase the original straddling caller range',
	)
	m.configureLayout(geometryLayout())
	assert.equal(captureFirst(m), anchor)
	m.release()
	for (let n = 150; n < 300; n++) observe(m, [n])
	assert.ok(owned(m).includes(id(1)), 'caller release must not erase current geometry residency')
	const quiet = m.snapshot()
	assert.equal(m.compact(), false)
	assert.equal(m.snapshot(), quiet)
	currentWindowPayloads(m)
	m.configureLayout(geometryLayout({ enabled: false }))
	for (let n = 300; n < 445; n++) observe(m, [n])
	assert.ok(!owned(m).includes(id(1)), 'disabled geometry must actually release its private pins')
	m.clear()
	assert.equal(m.snapshot().window, null)
	assert.equal(m.debug().readingReservedBytes, 0)
	assert.equal(m.debug().readingMetadataBytes, 0)
	assert.equal(m.debug().residentChunks, 0)
})

test('M2 atomic: geometry-enabled source replay and recovery retain anchor, outside sides and current payload ownership', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([0, 1, 200, 201]))
	m.configureLayout(geometryLayout())
	const anchor = captureFirst(m)
	const span = m.inspectRange()[0]
	const association = m.associate(span.id, span.start + 1, span.end - 1)
	assert.ok(association)
	const f = readerFixture(201)
	const { op, read, action } = partialRepair(m, f, 2, association)
	const window = geometryWindow(m)
	assert.equal(m.cancelReconciliation(op.handle), true)
	assert.equal(geometryWindow(m), window, 'metadata-only cancel must not reconstruct rows')
	assert.equal(m.reconcile(op.handle, read(action)).status, 'stale')
	read({ kind: 'close' })
	const fresh = recoveryAssociation(m)
	driveRepair(m, f.client(), beginRepair(m, fresh), () => {
		assert.ok(owned(m).includes(id(0)))
		assert.ok(owned(m).includes(id(201)))
		assert.ok(windowRows(m).some(row => row.key === anchor))
		currentWindowPayloads(m)
	})
	assert.deepEqual(
		owned(m),
		Array.from({ length: 202 }, (_, i) => id(i)),
	)
	currentWindowPayloads(m)
})

test('M2 atomic: shared metadata overflow refuses paired layout, then optional content can be pruned without stale payload', () => {
	const m = alternatingGeometry(2400)
	const before = m.snapshot()
	assert.equal(m.configureLayout(geometryLayout()).status, 'capacity')
	assert.equal(m.snapshot(), before)
	assert.equal(m.debug().readingReservedBytes, 0)
	assert.equal(m.configureLayout(geometryLayout({ activity: true })).status, 'accepted')
	const key = captureFirst(m)
	const visible = m.snapshot()
	assert.equal(m.configureLayout(geometryLayout()).status, 'capacity')
	assert.equal(m.snapshot(), visible)
	assert.equal(m.configureLayout(geometryLayout({ activity: true, width: 801 })).status, 'accepted')
	assert.ok(windowRows(m).some(row => row.key === key))
	m.release()
	assert.equal(m.configureLayout(geometryLayout()).status, 'accepted')
	assert.ok(
		m.debug().residentChunks < before.chunks.length,
		'metadata pressure must prune actual expendable source ownership',
	)
	assert.ok(windowRows(m).some(row => row.key === key))
	assert.equal(m.debug().readingReservedBytes, 2048)
	assert.ok(m.debug().readingMetadataBytes <= 2048)
	assert.equal(m.debug().rangeSamples, 0)
	assert.equal(m.debug().classificationSummaries, 0)
	currentWindowPayloads(m)
})

test('M2 atomic: exact settlement reserve follows token-changing restore and retires without geometry reconstruction', () => {
	// Key namespaces include the actual model instance, whose digit count varies by selected tests.
	// Find a near-limit *admitted* association rather than assuming one fixed serialized size.
	let fixture: { m: Model; association: TranscriptAssociation } | undefined
	for (let count = 2200; count >= 2000; count -= 20) {
		const m = alternatingGeometry(count)
		if (m.configureLayout(geometryLayout()).status !== 'accepted') continue
		const chunk = m.snapshot().chunks[0]
		const span = m.inspectRange().find(s => s.start === chunk.start)
		assert.ok(span)
		const association = m.associate(span.id, chunk.start, chunk.end)
		if (association) {
			fixture = { m, association }
			break
		}
	}
	assert.ok(fixture)
	const { m, association } = fixture
	assert.ok(m.debug().metadataBytes > 250 * 1024)
	const chunk = m.snapshot().chunks[0]
	const replacement = {
		...chunk.page,
		reread: '\0'.repeat(1024),
		records: chunk.page.records.map((r, i) => (i === 0 ? rec(1, 'replacement') : r)),
	}
	assert.ok(historyPageSchema.safeParse(replacement).success)
	const before = m.snapshot()
	assert.equal(
		m.restore(association, replacement).status,
		'capacity',
		'new token settlement headroom must be admitted before replacement',
	)
	assert.equal(m.snapshot(), before)
	const controls = () => {
		const s = Reflect.get(m, 'state')
		return { active: s.active, retry: s.retry }
	}
	const originalControls = controls()
	const reserve = m.debug().settlementReservedBytes
	const window = geometryWindow(m)
	assert.equal(m.settle(association), true)
	assert.equal(geometryWindow(m), window)
	assert.equal(m.debug().settlementReservedBytes, 0)
	assert.equal(
		reserve,
		Math.max(0, bytes(controls()) - bytes(originalControls)),
		'reserve uses exact serialized settlement wrapper growth',
	)
	assert.equal(m.settle(association), false)
	m.release()
	// The legitimate settled association remains retryable; optional source now makes space.
	assert.equal(m.restore(association, replacement).status, 'accepted')
	currentWindowPayloads(m)
	const retainedSpan = m.inspectRange().find(s => s.start <= chunk.start && s.end > chunk.start)
	assert.ok(retainedSpan)
	const active = m.associate(retainedSpan.id, chunk.start, chunk.end)
	assert.ok(active)
	const projected = m.debug()
	const beforeSettle = controls()
	const finalWindow = geometryWindow(m)
	assert.equal(m.settle(active), true)
	assert.equal(geometryWindow(m), finalWindow)
	assert.equal(projected.settlementReservedBytes, Math.max(0, bytes(controls()) - bytes(beforeSettle)))
	assert.ok(
		JSON.stringify(controls()).includes('\\\\u0000'),
		'escaped token must actually be retained by the admitted retry',
	)
	assert.equal(m.settle(active, true), true)
	assert.equal(m.settle(active, true), false)
	assert.equal(geometryWindow(m), finalWindow)
	currentWindowPayloads(m)
})

test('M2 atomic: refused compatibility metadata never leaks and retirement bypasses an obsolete row rebuild', () => {
	const m = new RemoteTranscriptModel()
	const handle = admit(m, page(Array.from({ length: 40 }, (_, i) => i + 1)))
	m.configureLayout(geometryLayout())
	m.measureWindow(geometryBatch(m, [0]))
	m.configureLayout(geometryLayout({ inFlowTail: { epoch: 1, height: 1e12 - 3160 } }))
	m.setReading(geometryReading(m, 2800))
	const before = m.snapshot()
	assert.equal(m.setReading({ ...geometryReading(m, 2800), following: true }).status, 'capacity')
	assert.equal(m.setStatus('error', 'x'.repeat(1025)), false)
	assert.equal(m.setViewport({ ...before.viewport, anchor: { id: 'x'.repeat(65), offset: 0 } }), false)
	assert.equal(m.snapshot(), before)
	assert.equal(m.settle(handle, true), true)
	assert.equal(geometryWindow(m), before.window)
	m.configureLayout(geometryLayout())
	assert.notEqual(geometryWindow(m).restoration.kind, 'follow-tail')
	currentWindowPayloads(m)
})

test('M2 atomic: raw-only zero coverage preserves author, but evicted unknown coverage resets it', () => {
	const assistant = (n: number): HistoryRecord => ({
		kind: 'message',
		message: { id: id(n), role: 'assistant', text: 'body', thinking: '', truncated: false },
	})
	const m = new RemoteTranscriptModel()
	admit(m, { ...page([3]), records: [assistant(3)] })
	admit(m, { ...page([], 'raw-only'), oldest: id(2), newest: id(2), stopped: 'entries' })
	admit(m, { ...page([1]), records: [assistant(1)] })
	m.configureLayout(geometryLayout())
	assert.deepEqual(
		windowRows(m).map(row => row.grouping),
		['author', 'continuation'],
	)
	const unknown = new RemoteTranscriptModel()
	admit(unknown, { ...page([2, 3, 4]), records: [assistant(2), assistant(3), assistant(4)] })
	// Native islands retain both endpoints while their historical middle is genuinely evicted.
	unknown.observeLive({ records: [assistant(2), assistant(4)], revision: 1, historyTruncated: true })
	for (let n = 200; n > 70; n--) admit(unknown, page([n]))
	assert.ok(!owned(unknown).includes(id(3)))
	unknown.configureLayout(geometryLayout())
	const ends = windowRows(unknown).filter(row => [id(2), id(4)].includes(rid(row.record)))
	assert.deepEqual(
		ends.map(row => row.grouping),
		['author', 'author'],
	)
	currentWindowPayloads(unknown)
})

test('M2 atomic: near-limit reconciliation token growth refuses the new step, not its admitted retirement', () => {
	let fixture: { m: Model; handle: TranscriptReconciliation; wire: HistoryResult } | undefined
	for (let count = 2200; count >= 2100; count -= 20) {
		const m = alternatingGeometry(count)
		if (m.configureLayout(geometryLayout()).status !== 'accepted') continue
		const chunk = m.snapshot().chunks[0]
		const span = m.inspectRange().find(s => s.start === chunk.start)
		assert.ok(span)
		const association = m.associate(span.id, chunk.start, chunk.end)
		if (!association) continue
		const operation = m.beginReconciliation(association)
		if (!operation) continue
		const read = readerFixture(count).client()
		let action = operation.next
		let phase = 'open'
		for (let step = 0; step < 50; step++) {
			const wire = read(action)
			if (phase === 'seed' && wire.state === 'page') {
				fixture = { m, handle: operation.handle, wire }
				break
			}
			const applied = m.reconcile(operation.handle, wire)
			if (applied.status !== 'progress') break
			assert.ok(applied.next)
			action = applied.next
			phase = applied.phase
		}
		if (fixture) break
	}
	assert.ok(fixture)
	const { m, handle, wire } = fixture
	assert.equal(wire.state, 'page')
	assert.ok(wire.page)
	const enlarged = { ...wire, page: { ...wire.page, reread: '\0'.repeat(1024), older: '\0'.repeat(1024) } }
	assert.ok(historyPageSchema.safeParse(enlarged.page).success)
	const before = m.snapshot()
	const debug = m.debug()
	assert.equal(m.reconcile(handle, enlarged).status, 'capacity')
	assert.equal(m.snapshot(), before)
	assert.deepEqual(m.debug(), debug, 'failed step cannot leak counters, payload, pins or operation changes')
	assert.equal(m.cancelReconciliation(handle), true)
	assert.equal(geometryWindow(m), before.window)
	assert.equal(m.debug().activeWork, 0)
	assert.equal(m.reconcile(handle, wire).status, 'stale')
	currentWindowPayloads(m)
})

test('M2 coordinate bound: direct anchor rebasing refuses an overflowing derived viewport atomically', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 2]))
	assert.equal(m.configureLayout(geometryLayout()).status, 'accepted')
	const row = windowRows(m)[1]
	assert.ok(row)
	assert.equal(
		m.setReading({
			...geometryReading(m, row.top),
			anchor: { key: row.key, inRowOffset: 0, viewportOffset: 0 },
		}).status,
		'accepted',
	)
	const before = m.snapshot()
	assert.equal(
		m.setReading({
			...geometryReading(m, 0),
			anchor: { key: row.key, inRowOffset: 0, viewportOffset: -1e12 },
		}).status,
		'capacity',
	)
	assert.equal(m.snapshot(), before)
	assert.equal(m.configureLayout(geometryLayout({ width: 801 })).status, 'accepted')
	assert.equal(geometryWindow(m).restoration.kind, 'canonical')
	assert.ok(windowRows(m).some(candidate => candidate.key === row.key))
})

test('M2 coordinate bound: source prepend refuses an overflowing anchor rebase and remains usable', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 2]))
	assert.equal(m.configureLayout(geometryLayout()).status, 'accepted')
	const row = windowRows(m)[0]
	assert.ok(row)
	assert.equal(
		m.setReading({
			...geometryReading(m, 1e12),
			anchor: { key: row.key, inRowOffset: 0, viewportOffset: -1e12 },
		}).status,
		'accepted',
	)
	const ticket = m.beginExpansion()
	assert.ok(ticket)
	const before = m.snapshot()
	assert.equal(m.admitPrefix(ticket, page([0])).status, 'capacity')
	assert.equal(m.snapshot(), before)
	assert.equal(m.configureLayout(geometryLayout({ width: 801 })).status, 'accepted')
	assert.equal(geometryWindow(m).logicalExtent, 160)
	assert.equal(m.settle(ticket, true), true)
})

test('M2 coordinate bound: measurement rebasing retains the issued frame after first-row refusal', () => {
	const m = new RemoteTranscriptModel()
	admit(m, page([1, 2]))
	assert.equal(m.configureLayout(geometryLayout()).status, 'accepted')
	let w = geometryWindow(m)
	const rows = windowRows(m)
	const second = rows[1]
	assert.ok(second)
	assert.equal(
		m.setReading({
			...geometryReading(m, 1e12),
			anchor: { key: second.key, inRowOffset: 0, viewportOffset: 80 - 1e12 },
		}).status,
		'accepted',
	)
	const before = m.snapshot()
	w = geometryWindow(m)
	const frame = {
		instance: w.instance,
		epoch: w.epoch,
		windowSerial: w.serial,
		layoutEpoch: w.layoutEpoch,
	}
	assert.equal(
		m.measureWindow({
			...frame,
			rows: [{ key: rows[0].key, measurementKey: rows[0].measurementKey, top: 0, height: 81 }],
		}).status,
		'capacity',
	)
	assert.equal(m.snapshot(), before)
	assert.equal(
		m.measureWindow({
			...frame,
			rows: [{ key: second.key, measurementKey: second.measurementKey, top: 80, height: 80 }],
		}).status,
		'accepted',
	)
	const after = geometryWindow(m)
	assert.equal(after.logicalExtent, 160)
	assert.deepEqual(after.restoration, w.restoration)
	assert.equal(windowRows(m)[0].height, 80)
})
