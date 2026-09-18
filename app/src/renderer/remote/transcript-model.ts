import { classifyTranscriptRecord } from './transcript-presentation.js'

// Import-type queries preserve Node16 CJS-to-ESM resolution without unsupported static import attributes.
type HistoryPage = import('../../../../src/remote/history-protocol.js', {
	with: { 'resolution-mode': 'import' },
}).HistoryPage
type HistoryRecord = import('../../../../src/remote/history-protocol.js', {
	with: { 'resolution-mode': 'import' },
}).HistoryRecord

type HistoryResult = import('../../../../src/remote/history-protocol.js', {
	with: { 'resolution-mode': 'import' },
}).HistoryResult
type HistoryAction = HistoryResult['input']

export interface TranscriptReconciliation extends TranscriptTicket {
	associationSerial: number
}
export interface TranscriptReconciliationResult {
	status: TranscriptAdmission['status'] | 'progress'
	next: HistoryAction | null
	phase: 'open' | 'seed' | 'discover' | 'replay' | 'complete'
}
interface Reconciliation {
	handle: TranscriptReconciliation
	lower: string
	upper: string
	frontier: string | null
	phase: 'open' | 'seed' | 'discover' | 'replay'
	expected: HistoryAction
	seed: string | null
	binding: { target: HistoryResult['target']; hostEpoch: string; viewId: string } | null
	last: { sequence: number; stamp: string; output: TranscriptReconciliationResult } | null
}
// A replay stamp is comparison metadata, never authentication or a retained response payload.
const stamp = (value: unknown) => {
	const text = JSON.stringify(value)
	let a = 2166136261
	let b = 5381
	for (let i = 0; i < text.length; i++) {
		a = Math.imul(a ^ text.charCodeAt(i), 16777619)
		b = Math.imul(b, 33) ^ text.charCodeAt(i)
	}
	return `${text.length}:${a}:${b}`
}

const MAX_CHUNKS = 128
const MAX_BYTES = 8 * 1024 * 1024
const MAX_SPANS = 64
const MAX_CHECKPOINTS = 256
const MAX_METADATA = 256 * 1024
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const idOf = (record: HistoryRecord) => (record.kind === 'message' ? record.message.id : record.id)
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function freeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child)
		Object.freeze(value)
	}
	return value
}
const nativeMessageBytes = (records: readonly HistoryRecord[]) =>
	bytes(records.map(r => (r.kind === 'message' ? r.message : r)))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
let instanceSequence = 0

export interface TranscriptChunk {
	page: HistoryPage
	/** Native observations carry no authenticated reread capability. */
	origin: 'history' | 'native'
	ordinal: number
	id: number
	start: number
	end: number
	/** Positions belong to the logical coordinate space, not the chunk array. */
	positions: readonly number[]
	ordering?: { predecessor: string | null; successor: string; unverified: true }
}
interface RecoveryEnvelope {
	lower: string
	upper: string
	start: number
	end: number
}
export interface TranscriptSpan {
	/** Counted endpoint evidence, not payload or a retained wire capability. */
	recovery?: RecoveryEnvelope
	id: number
	start: number
	end: number
	first: string | null
	last: string | null
	rawOldest: string | null
	rawNewest: string | null
	recordCount: number
	countIsEstimate: boolean
	height: number
	source: 'history' | 'live' | 'aggregate'
	coverage: 'authenticated' | 'observed' | 'unverified'
	omitted: boolean
	gap: boolean
	root: boolean
}
export interface TranscriptCheckpoint {
	id: string
	position: number
	spanId: number
	ordering?: { predecessor: string | null; successor: string; unverified: true }
}
export interface TranscriptTicket {
	instance: number
	epoch: number
	serial: number
	boundary: number
}
export interface TranscriptAssociation extends TranscriptTicket {
	start: number
	end: number
	first: string | null
	last: string | null
}
export interface TranscriptAdmission {
	status: 'accepted' | 'unchanged' | 'capacity' | 'stale' | 'unverified'
	association?: TranscriptAssociation
}
export interface TranscriptProtection {
	spanIds?: readonly number[]
	chunkIds?: readonly number[]
	anchorIds?: readonly string[]
	/** Optional overscan is released before refusing mandatory residency. */
	overscanChunkIds?: readonly number[]
}
export interface LiveTranscript {
	records: readonly HistoryRecord[]
	historyTruncated: boolean
	revision: number
}
export type TranscriptCanonicalKey = `${number}:${number}:message:${string}` | `${number}:${number}:marker:${string}`
export function transcriptCanonicalKey(instance: number, epoch: number, record: HistoryRecord): TranscriptCanonicalKey {
	return `${instance}:${epoch}:${record.kind}:${idOf(record)}` as TranscriptCanonicalKey
}
export interface TranscriptViewport {
	scrollTop: number
	height: number
	width: number
	activity: boolean
	readingVisible: boolean
	anchor?: { id: string; offset: number }
}
export interface TranscriptLayoutInput {
	enabled: boolean
	width: number
	viewportHeight: number
	activity: boolean
	presentationEpoch: number
	readingVisible: boolean
	inFlowTail: { epoch: number; height: number }
}
export interface TranscriptReadingInput {
	instance: number
	epoch: number
	windowSerial: number
	logicalViewportTop: number
	physicalScrollTop: number
	viewportHeight: number
	direction: 'older' | 'newer' | 'stationary'
	following: boolean
	anchor: { key: TranscriptCanonicalKey; inRowOffset: number; viewportOffset: number } | null
}
export type TranscriptRestorationIntent =
	| { kind: 'none' }
	| { kind: 'follow-tail' }
	| {
			kind: 'canonical'
			key: TranscriptCanonicalKey
			inRowOffset: number
			viewportOffset: number
			uncertainty: 'exact-row' | 'estimated-neighborhood'
	  }
	| { kind: 'estimated-range'; rangeKey: string; fraction: number; viewportOffset: number }
export interface TranscriptRenderRow {
	kind: 'row'
	key: TranscriptCanonicalKey
	record: HistoryRecord
	origin: 'history' | 'native'
	top: number
	height: number
	position: number | null
	ordering: 'verified' | 'unverified'
	grouping: 'author' | 'continuation' | 'none'
	measurementKey: string
}
export interface TranscriptRenderSpacer {
	kind: 'spacer'
	key: string
	top: number
	height: number
	certainty: 'estimated' | 'unknown' | 'known-hidden'
}
export type TranscriptRenderItem = TranscriptRenderRow | TranscriptRenderSpacer
export interface TranscriptRenderWindow {
	instance: number
	epoch: number
	serial: number
	layoutEpoch: number
	items: readonly TranscriptRenderItem[]
	historicalVisibleCount: number
	historicalOverscanCount: number
	logicalExtent: number
	demand: TranscriptHydrationDemand | null
	restoration: TranscriptRestorationIntent
	capacity: { visibleCap: number; resident: number; metadata: number } | null
}
export interface TranscriptHydrationDemand {
	instance: number
	epoch: number
	demandId: string
	rangeKey: string
	purpose: 'anchor' | 'viewport' | 'overscan'
}
export interface TranscriptGeometryUpdate {
	status: 'accepted' | 'unchanged' | 'stale' | 'invalid' | 'capacity'
	published: boolean
}
export interface TranscriptWindowMeasurement {
	instance: number
	epoch: number
	windowSerial: number
	layoutEpoch: number
	rows: readonly {
		key: TranscriptCanonicalKey
		measurementKey: string
		top: number
		height: number
	}[]
}
export interface TranscriptSnapshot {
	chunks: readonly TranscriptChunk[]
	live: readonly HistoryRecord[]
	spans: readonly TranscriptSpan[]
	checkpoints: readonly TranscriptCheckpoint[]
	pendingSeam: { from: string | null; to: string | null; unverified: true } | null
	phase: 'idle' | 'loading' | 'progress' | 'error'
	issue: string | null
	expanded: boolean
	older: string | null
	root: boolean
	liveContinuity: 'unknown' | 'observed' | 'proved'
	layoutGeneration: number
	viewport: TranscriptViewport
	window: TranscriptRenderWindow | null
}
export interface TranscriptDebug {
	chunks: number
	residentChunks: number
	residentBytes: number
	currentLiveBytes: number
	currentNativeMessageBytes: number
	metadataSpans: number
	checkpoints: number
	metadataBytes: number
	retainedPayloadOwners: number
	activeWork: number
	geometryMetadataBytes: number
	readingMetadataBytes: number
	readingReservedBytes: number
	metadataActualBytes: number
	settlementReservedBytes: number
	rangeSamples: number
	classificationSummaries: number
}
interface Cached {
	value: TranscriptChunk
	bytes: number
}
interface GeometryState {
	layout: TranscriptLayoutInput | null
	reading: (TranscriptReadingInput & { restoration: TranscriptRestorationIntent }) | null
	window: TranscriptRenderWindow | null
	windowSerial: number
	epoch: number
	measurementSequence: number
	measurements: Map<TranscriptCanonicalKey, { measurementKey: string; height: number; layoutEpoch: number }>
	mandatory: readonly string[]
	optional: readonly string[]
}
const initialGeometry = (): GeometryState => ({
	layout: null,
	reading: null,
	window: null,
	windowSerial: 0,
	epoch: 0,
	measurementSequence: 0,
	measurements: new Map(),
	mandatory: [],
	optional: [],
})
const READING_RESERVATION = 2048
interface State {
	sequence: number
	phase: TranscriptSnapshot['phase']
	issue: string | null
	viewport: TranscriptViewport
	geometry: GeometryState
	spans: TranscriptSpan[]
	checkpoints: TranscriptCheckpoint[]
	cache: Cached[]
	live: readonly HistoryRecord[]
	truncated: boolean
	expanded: boolean
	older: string | null
	root: boolean
	boundary: number
	active: TranscriptTicket | TranscriptAssociation | null
	retry: {
		ticket: TranscriptTicket
		association: TranscriptAssociation
		range: string | null
		cropIds: readonly string[]
	} | null
	reconciliation: Reconciliation | null
	protectedRanges: readonly { start: number; end: number }[]
	protection: Required<TranscriptProtection>
	seam: TranscriptSnapshot['pendingSeam']
}
const protection = (): Required<TranscriptProtection> => ({
	spanIds: [],
	chunkIds: [],
	anchorIds: [],
	overscanChunkIds: [],
})
const initial = (): State => ({
	sequence: 0,
	phase: 'idle',
	issue: null,
	viewport: { scrollTop: 0, height: 0, width: 0, activity: false, readingVisible: true },
	geometry: initialGeometry(),
	spans: [],
	checkpoints: [],
	cache: [],
	live: [],
	truncated: false,
	expanded: false,
	older: null,
	root: false,
	boundary: 0,
	active: null,
	retry: null,
	protection: protection(),
	protectedRanges: [],
	reconciliation: null,
	seam: null,
})
const rangeKey = (page: HistoryPage) => JSON.stringify([page.oldest, page.newest, page.reread])
const blankPage = (records: HistoryRecord[]): HistoryPage => ({
	records,
	oldest: records[0] ? idOf(records[0]) : null,
	newest: records.at(-1) ? idOf(records.at(-1) as HistoryRecord) : null,
	older: null,
	newer: null,
	reread: '',
	omissions: { clipped: 0, images: 0, unsupported: 0 },
	stopped: 'boundary',
})

/** Pure retention/index/cache, bounded replay and paired render geometry. No scheduling or external authentication.
 * Coordinates survive prepend/coalescing. Only the active and last-settled operation handles are retained;
 * an older caller must acquire a fresh association from surviving range/checkpoint evidence.
 * Geometry candidates share retention admission; unmounted evidence and automatic hydration remain separate work.
 */
export class RemoteTranscriptModel {
	private readonly instance = ++instanceSequence
	private epoch = 0
	private state = initial()
	private get phase() {
		return this.state.phase
	}
	private get issue() {
		return this.state.issue
	}
	private get viewport() {
		return this.state.viewport
	}
	private generation = 0
	private published: TranscriptSnapshot | null = null
	private get layout() {
		return this.state.geometry.layout
	}
	private get window() {
		return this.state.geometry.window
	}
	private get geometryEpoch() {
		return this.state.geometry.epoch
	}
	private get measurements() {
		return this.state.geometry.measurements
	}

	snapshot(): TranscriptSnapshot {
		if (!this.published)
			this.published = freeze({
				chunks: this.state.cache.map(c => c.value).sort((a, b) => a.start - b.start),
				live: this.state.live,
				spans: this.state.spans,
				checkpoints: this.state.checkpoints,
				pendingSeam: this.state.seam,
				phase: this.phase,
				issue: this.issue,
				expanded: this.state.expanded,
				older: this.state.older,
				root: this.state.root,
				liveContinuity: this.state.expanded ? 'observed' : 'unknown',
				layoutGeneration: this.generation,
				viewport: this.viewport,
				window: this.window,
			})
		return this.published
	}
	private draft(source = this.state): State {
		return {
			...source,
			spans: source.spans.slice(),
			checkpoints: source.checkpoints.slice(),
			cache: source.cache.slice(),
			protection: { ...source.protection },
			geometry: { ...source.geometry, measurements: new Map(source.geometry.measurements) },
		}
	}
	private commit(next: State) {
		this.state = next
		this.generation++
		this.published = null
	}
	private metadata(s: State) {
		return {
			spans: s.spans,
			checkpoints: s.checkpoints,
			active: s.active,
			retry: s.retry,
			reconciliation: s.reconciliation,
			protection: s.protection,
			protectedRanges: s.protectedRanges,
			seam: s.seam,
			boundary: s.boundary,
			older: s.older,
			root: s.root,
			expanded: s.expanded,
			truncated: s.truncated,
			instance: this.instance,
			epoch: this.epoch,
			sequence: s.sequence,
			viewport: s.viewport,
			phase: s.phase,
			issue: s.issue,
			geometry: this.geometryDescriptor(s.geometry),
			reading: s.geometry.reading,
			effectiveAnchorIds: [...new Set([...s.protection.anchorIds, ...s.geometry.mandatory])],
		}
	}
	private geometryDescriptor(g: GeometryState) {
		return {
			layout: g.layout,
			window: this.windowDescriptor(g.window),
			measurements: [...g.measurements],
			mandatory: g.mandatory,
			optional: g.optional,
			windowSerial: g.windowSerial,
			epoch: g.epoch,
			measurementSequence: g.measurementSequence,
			readingReservationBytes: g.layout?.enabled || g.reading ? READING_RESERVATION : 0,
		}
	}
	private actualMetadataBytes(s: State) {
		return bytes(this.metadata(s))
	}
	private chargedMetadataBytes(s: State) {
		const actual = this.actualMetadataBytes(s)
		return s.geometry.layout?.enabled || s.geometry.reading
			? actual - bytes(s.geometry.reading) + READING_RESERVATION
			: actual
	}
	private metadataBytes(s: State) {
		// The same pure projection used by settle reserves its exact encoded wrapper/token growth.
		// No second token or projected retry is retained. Recompute after every candidate change.
		const current = this.chargedMetadataBytes(s)
		return s.active
			? Math.max(current, this.chargedMetadataBytes({ ...s, ...this.settlement(s, s.active, false) }))
			: current
	}

	private known(s: State): Map<string, number> {
		const result = new Map<string, number>()
		for (const span of s.spans) {
			if (span.recovery) {
				result.set(span.recovery.lower, span.recovery.start)
				result.set(span.recovery.upper, span.recovery.end - 1)
			}
		}
		for (const c of s.checkpoints) result.set(c.id, c.position)
		for (const c of s.cache) c.value.page.records.forEach((r, i) => result.set(idOf(r), c.value.positions[i] as number))
		return result
	}
	private unionRecovery(envelopes: readonly RecoveryEnvelope[]): RecoveryEnvelope {
		const first = envelopes.reduce((a, b) => (a.start <= b.start ? a : b))
		const last = envelopes.reduce((a, b) => (a.end >= b.end ? a : b))
		return { lower: first.lower, upper: last.upper, start: first.start, end: last.end }
	}
	private placeRecovery(s: State, envelopes: readonly RecoveryEnvelope[]) {
		s.spans = s.spans.map(span => {
			const { recovery: _recovery, ...rest } = span
			return rest
		})
		for (const envelope of envelopes) {
			const index = s.spans.findIndex(span => span.start <= envelope.start && span.end > envelope.start)
			const span = s.spans[index]
			if (!span) return false
			s.spans[index] = {
				...span,
				recovery: span.recovery ? this.unionRecovery([span.recovery, envelope]) : envelope,
			}
		}
		return true
	}
	private coalesceRanges(ranges: readonly { start: number; end: number }[]) {
		const result: { start: number; end: number }[] = []
		for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
			if (range.end <= range.start) continue
			const last = result.at(-1)
			if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
			else result.push({ ...range })
		}
		return result
	}
	private checkpoint(s: State, id: string, position: number, ordering?: TranscriptCheckpoint['ordering']) {
		if (s.checkpoints.some(c => c.id === id)) return
		const span = s.spans.find(c => c.start <= position && c.end > position)
		if (span) s.checkpoints.push({ id, position, spanId: span.id, ...(ordering ? { ordering } : {}) })
	}
	private chunk(
		s: State,
		page: HistoryPage,
		positions: readonly number[],
		start: number,
		end: number,
		origin: TranscriptChunk['origin'] = 'history',
	) {
		const value = freeze({
			page: copy(page),
			origin,
			positions: [...positions],
			start,
			end,
			ordinal: start,
			id: ++s.sequence,
			...(page.records.length === 1 &&
			s.checkpoints.find(c => c.id === idOf(page.records[0] as HistoryRecord))?.ordering
				? { ordering: s.checkpoints.find(c => c.id === idOf(page.records[0] as HistoryRecord))?.ordering }
				: {}),
		})
		s.cache.push({ value, bytes: bytes(value) })
	}
	private pinned(s: State, c: TranscriptChunk, optional = true) {
		const p = s.protection
		return (
			p.chunkIds.includes(c.id) ||
			s.protectedRanges.some(range => c.positions.some(p => p >= range.start && p < range.end)) ||
			(optional && p.overscanChunkIds.includes(c.id)) ||
			c.page.records.some(
				r =>
					p.anchorIds.includes(idOf(r)) ||
					s.geometry.mandatory.includes(idOf(r)) ||
					(optional && s.geometry.optional.includes(idOf(r))),
			) ||
			s.spans.some(span => p.spanIds.includes(span.id) && span.start < c.end && span.end > c.start)
		)
	}
	/** Transactional: failure never publishes the candidate logical membership or evictions. */
	private fit(s: State): boolean {
		const base = this.draft(s)
		const sameRows = (a: readonly unknown[], b: readonly unknown[]) =>
			a.length === b.length && a.every((v, i) => v === b[i])
		for (const overscan of [true, false]) {
			const candidate = this.draft(base)
			const g = candidate.geometry
			const old = this.state.geometry
			const unchanged =
				candidate.live === this.state.live &&
				candidate.expanded === this.state.expanded &&
				sameRows(candidate.cache, this.state.cache) &&
				sameRows(candidate.spans, this.state.spans) &&
				sameRows(candidate.checkpoints, this.state.checkpoints) &&
				g.layout === old.layout &&
				g.reading === old.reading &&
				equal([...g.measurements], [...old.measurements])
			if ((!unchanged || !overscan) && this.projectWindow(candidate, overscan).status === 'capacity') continue
			// Each retry below strictly removes one expendable cache owner. There are at most128;
			// there is no convergence guess, automatic read, or accepted-state mutation.
			for (let removed = 0; removed <= MAX_CHUNKS; removed++) {
				const cache = candidate.cache.slice()
				const spans = candidate.spans.slice()
				const checkpoints = candidate.checkpoints.slice()
				const retained = this.fitRetention(candidate)
				const changed =
					!sameRows(cache, candidate.cache) ||
					!sameRows(spans, candidate.spans) ||
					!sameRows(checkpoints, candidate.checkpoints)
				if (changed && this.projectWindow(candidate, overscan).status === 'capacity') break
				if (retained && this.metadataBytes(candidate) <= MAX_METADATA) {
					Object.assign(s, candidate)
					return true
				}
				if (overscan || this.metadataBytes(candidate) <= MAX_METADATA) break
				const victim = candidate.cache.findIndex(c => !this.pinned(candidate, c.value, false))
				if (victim < 0) break
				candidate.cache.splice(victim, 1)
				if (this.projectWindow(candidate, false).status === 'capacity') break
			}
		}
		return false
	}

	private fitRetention(s: State): boolean {
		if (
			s.cache.some(
				c =>
					c.bytes >
					(c.value.origin === 'history' ? 96 * 1024 : c.value.page.records.length === 1 ? 164 * 1024 : 64 * 1024),
			)
		)
			return false
		let size = s.cache.reduce((sum, c) => sum + c.bytes, 2) + Math.max(0, s.cache.length - 1)
		while (s.cache.length > MAX_CHUNKS || size > MAX_BYTES) {
			let index = s.cache.findIndex(c => !this.pinned(s, c.value))
			if (index < 0) {
				s.protection = { ...s.protection, overscanChunkIds: [] }
				index = s.cache.findIndex(c => !this.pinned(s, c.value, false))
			}
			if (index < 0) return false
			const [removed] = s.cache.splice(index, 1)
			if (removed) size -= removed.bytes + (s.cache.length ? 1 : 0)
		}
		// Reserve one descriptor for a future native tail even if expansion began with no native rows.
		const spanLimit = s.spans.some(span => span.source === 'live') ? MAX_SPANS : MAX_SPANS - 1
		const protectedSpan = (span: TranscriptSpan) =>
			s.protection.spanIds.includes(span.id) ||
			s.checkpoints.some(
				c => c.spanId === span.id && (s.protection.anchorIds.includes(c.id) || s.geometry.mandatory.includes(c.id)),
			) ||
			s.cache.some(c => c.value.start < span.end && c.value.end > span.start && this.pinned(s, c.value, false))
		while (s.spans.length > spanLimit || this.metadataBytes(s) > MAX_METADATA) {
			const index = s.spans.findIndex((a, i) => {
				const b = s.spans[i + 1]
				return b && a.source !== 'live' && b.source !== 'live' && !protectedSpan(a) && !protectedSpan(b)
			})
			if (index < 0) return false
			const a = s.spans[index] as TranscriptSpan
			const b = s.spans[index + 1] as TranscriptSpan
			const merged: TranscriptSpan = {
				...a,
				end: b.end,
				first: a.first ?? b.first,
				last: b.last ?? a.last,
				rawNewest: b.rawNewest,
				recordCount: a.recordCount + b.recordCount,
				countIsEstimate: a.countIsEstimate || b.countIsEstimate,
				height: a.height + b.height,
				source: 'aggregate',
				coverage:
					a.coverage === 'authenticated' && b.coverage === 'authenticated' && !a.gap && !b.gap
						? 'authenticated'
						: 'unverified',
				gap: a.gap || b.gap,
				omitted: a.omitted || b.omitted,
				root: a.root || b.root,
			}
			if (a.recovery || b.recovery) {
				const envelopes = [a.recovery, b.recovery].filter((r): r is RecoveryEnvelope => !!r)
				// Raw-only padding is not a canonical endpoint position. Broaden only with
				// retained endpoint references, never by assigning an ID to an outer raw slot.
				const known = this.known(s)
				const start = merged.first ? known.get(merged.first) : undefined
				const end = merged.last ? known.get(merged.last) : undefined
				if (merged.first && merged.last && start !== undefined && end !== undefined)
					envelopes.push({ lower: merged.first, upper: merged.last, start, end: end + 1 })
				merged.recovery = this.unionRecovery(envelopes)
			}
			s.spans.splice(index, 2, merged)
			s.checkpoints = s.checkpoints.map(c => (c.spanId === b.id ? { ...c, spanId: a.id } : c))
		}
		const mandatory = new Set([...s.live.map(idOf), ...s.protection.anchorIds, ...s.geometry.mandatory])
		if (s.reconciliation) {
			mandatory.add(s.reconciliation.lower)
			mandatory.add(s.reconciliation.upper)
			if (s.reconciliation.frontier) mandatory.add(s.reconciliation.frontier)
		}
		const endpoints = [s.spans[0]?.first, s.spans.at(-1)?.last]
		for (const id of endpoints) if (id) mandatory.add(id)
		// Chunk endpoints/positions remain in their counted payload; no duplicate permanent page index.
		s.checkpoints.sort((a, b) => a.position - b.position)
		while (s.checkpoints.length > MAX_CHECKPOINTS) {
			let victim = -1
			let smallestNeighborhood = Number.POSITIVE_INFINITY
			for (let i = 0; i < s.checkpoints.length; i++) {
				const checkpoint = s.checkpoints[i] as TranscriptCheckpoint
				if (mandatory.has(checkpoint.id)) continue
				const neighborhood =
					(s.checkpoints[i + 1]?.position ?? checkpoint.position) -
					(s.checkpoints[i - 1]?.position ?? checkpoint.position)
				if (neighborhood < smallestNeighborhood) {
					victim = i
					smallestNeighborhood = neighborhood
				}
			}
			if (victim < 0) return false
			// Remove the densest redundant sample, so one-at-a-time live appends cannot strand
			// all 256 checkpoints at the old end of an ever-growing envelope.
			s.checkpoints.splice(victim, 1)
		}
		return this.metadataBytes(s) <= MAX_METADATA
	}
	private canonical(records: readonly HistoryRecord[]) {
		const seen = new Set<string>()
		return records.filter(r => {
			const id = idOf(r)
			if (id === 'current' || seen.has(id)) return false
			seen.add(id)
			return true
		})
	}
	/** Admission-time capture; pre-expansion polling never archives old live payload. */
	beginExpansion(): TranscriptTicket | null {
		if (this.state.active || (this.state.reconciliation && this.state.reconciliation.last?.output.phase !== 'complete'))
			return null
		const s = this.draft()
		s.reconciliation = null
		if (!s.expanded) {
			s.expanded = true
			this.appendLive(s, s.live)
		}
		const ticket = freeze({ instance: this.instance, epoch: this.epoch, serial: ++s.sequence, boundary: s.boundary })
		s.active = ticket
		if (!this.fit(s)) return null
		this.commit(s)
		return ticket
	}
	private appendLive(s: State, records: readonly HistoryRecord[]) {
		if (!records.length) return
		let tail = s.spans.at(-1)
		if (!tail || tail.source !== 'live') {
			tail = {
				id: ++s.sequence,
				start: Math.max(0, tail?.end ?? 0),
				end: Math.max(0, tail?.end ?? 0),
				first: null,
				last: null,
				rawOldest: null,
				rawNewest: null,
				recordCount: 0,
				countIsEstimate: true,
				height: 0,
				source: 'live',
				coverage: 'observed',
				omitted: s.truncated,
				gap: true,
				root: false,
			}
			s.spans.push(tail)
		}
		const start = tail.end
		s.spans[s.spans.length - 1] = {
			...tail,
			end: start + records.length,
			first: tail.first ?? idOf(records[0] as HistoryRecord),
			last: idOf(records.at(-1) as HistoryRecord),
			recordCount: tail.recordCount + records.length,
			height: tail.height + records.length * 80,
			omitted: tail.omitted || s.truncated,
			gap: true,
		}
		records.forEach((r, i) => this.checkpoint(s, idOf(r), start + i))
	}
	private insertObserved(s: State, records: readonly HistoryRecord[], previous: readonly HistoryRecord[]) {
		for (let index = 0; index < records.length; index++) {
			const record = records[index] as HistoryRecord
			const known = this.known(s)
			if (known.has(idOf(record))) continue
			const successor = records.slice(index + 1).find(r => known.has(idOf(r)))
			if (!successor) {
				this.appendLive(s, [record])
				continue
			}
			const upper = known.get(idOf(successor)) as number
			const predecessor = records
				.slice(0, index)
				.reverse()
				.find(r => known.has(idOf(r)))
			const lower = predecessor ? (known.get(idOf(predecessor)) as number) : upper - 1
			const span = s.spans.find(span => span.start <= upper && span.end > upper)
			if (!span) continue
			const resident = new Set([
				...s.cache.flatMap(c => c.value.positions),
				...previous.map(r => known.get(idOf(r))).filter((p): p is number => p !== undefined),
			])
			const covered =
				upper - lower - 1 <= resident.size &&
				[...resident].filter(p => p > lower && p < upper && Number.isInteger(p)).length === upper - lower - 1
			if (
				span.source !== 'live' ||
				!Number.isInteger(upper) ||
				!Number.isInteger(lower) ||
				!covered ||
				(!predecessor && upper !== span.start)
			) {
				// An old, now unmaterialized slot may already own this ID. Keep its source ordering,
				// but do not pretend it is a newly proved member or grow the dense range/count.
				const position = lower + (upper - lower) / 2
				this.checkpoint(s, idOf(record), position, {
					predecessor: predecessor ? idOf(predecessor) : null,
					successor: idOf(successor),
					unverified: true,
				})
				continue
			}
			this.insertAt(s, span.id, upper, record)
		}
	}
	private insertAt(s: State, spanId: number, position: number, record: HistoryRecord) {
		// Associations are coordinates, not mutable array offsets. Retire every affected handle BEFORE
		// publishing a changed interpretation; older-prefix tickets without interval coordinates survive.
		if (s.active && 'end' in s.active && s.active.end > position) s.active = null
		if (s.retry && s.retry.association.end > position) s.retry = null
		const oldest = s.spans[0]
		if (oldest?.id === spanId && oldest.start === position) {
			s.boundary++
			if (s.active && !('end' in s.active)) s.active = null
		}
		s.spans = s.spans.map(span => ({
			...span,
			...(span.recovery
				? {
						recovery: {
							...span.recovery,
							start: span.recovery.start >= position ? span.recovery.start + 1 : span.recovery.start,
							end: span.recovery.end > position ? span.recovery.end + 1 : span.recovery.end,
						},
					}
				: {}),
			start: span.id === spanId ? span.start : span.start >= position ? span.start + 1 : span.start,
			end: span.end > position ? span.end + 1 : span.end,
			...(span.id === spanId
				? {
						first: span.start === position ? idOf(record) : span.first,
						recordCount: span.recordCount + 1,
						height: span.height + 80,
					}
				: {}),
		}))
		s.protectedRanges = s.protectedRanges.map(range => ({
			start: range.start >= position ? range.start + 1 : range.start,
			end: range.end > position ? range.end + 1 : range.end,
		}))
		s.checkpoints = s.checkpoints.map(c => (c.position >= position ? { ...c, position: c.position + 1 } : c))
		s.cache = s.cache.map(c => {
			if (c.value.end <= position) return c
			const value = freeze({
				...c.value,
				start: c.value.start >= position ? c.value.start + 1 : c.value.start,
				end: c.value.end + 1,
				positions: c.value.positions.map(p => (p >= position ? p + 1 : p)),
			})
			return { value, bytes: bytes(value) }
		})
		this.checkpoint(s, idOf(record), position)
	}
	observeLive(next: LiveTranscript): boolean {
		const live = copy(this.canonical(next.records).slice(-40))
		while (nativeMessageBytes(live) > 160 * 1024 || bytes(live) > 164 * 1024) live.shift()
		const truncated = next.historyTruncated || live.length !== this.canonical(next.records).length
		if (equal(live, this.state.live) && truncated === this.state.truncated) return false
		const s = this.draft()
		const previous = s.live
		s.live = freeze(live)
		s.truncated = truncated
		if (s.expanded) {
			const known = this.known(s)
			const ids = new Set(live.map(idOf))
			// The outgoing native payload moves into the shared cache before its only owner is replaced.
			for (const record of previous) {
				const position = known.get(idOf(record))
				if (!ids.has(idOf(record)) && position !== undefined)
					this.chunk(s, blankPage([record]), [position], position, position + 1, 'native')
			}
			this.insertObserved(s, live, previous)
			const operation = s.reconciliation
			if (operation?.frontier && operation.last?.output.phase !== 'complete') {
				const frontier = known.get(operation.frontier)
				const upper = known.get(operation.upper)
				const changedProof = live.some((record, i) => {
					if (known.has(idOf(record))) return false
					const before = live
						.slice(0, i)
						.reverse()
						.find(r => known.has(idOf(r)))
					const after = live.slice(i + 1).find(r => known.has(idOf(r)))
					// Only actual native order relative to a retained bound proves an outside append
					// or an older-side arrival. An assigned estimated coordinate alone does not.
					if (before && upper !== undefined && (known.get(idOf(before)) as number) >= upper) return false
					if (after && frontier !== undefined && (known.get(idOf(after)) as number) <= frontier) return false
					return true
				})
				if (changedProof) {
					const positions = this.known(s)
					const low = positions.get(operation.frontier) ?? Number.NEGATIVE_INFINITY
					const high = (positions.get(operation.upper) ?? Number.POSITIVE_INFINITY) + 1
					s.spans = s.spans.map(span =>
						span.start < high && span.end > low
							? {
									...span,
									coverage: 'unverified',
									countIsEstimate: true,
									gap: true,
								}
							: span,
					)
					s.reconciliation = null
				}
			}
			// Native payload wins; remove overlap from every historical materialization.
			s.cache = s.cache.flatMap(c => {
				if (!c.value.page.records.some(r => ids.has(idOf(r)))) return [c]
				const runs: { r: HistoryRecord; p: number }[][] = []
				let run: { r: HistoryRecord; p: number }[] = []
				c.value.page.records.forEach((r, i) => {
					if (ids.has(idOf(r))) {
						if (run.length) runs.push(run)
						run = []
					} else run.push({ r, p: c.value.positions[i] as number })
				})
				if (run.length) runs.push(run)
				return runs.map(rows => {
					const value = freeze({
						...c.value,
						id: ++s.sequence,
						start: (rows[0] as { p: number }).p,
						end: (rows.at(-1) as { p: number }).p + 1,
						page: { ...c.value.page, records: rows.map(x => x.r) },
						positions: rows.map(x => x.p),
					})
					return { value, bytes: bytes(value) }
				})
			})
			const residentIds = new Set(s.cache.map(c => c.value.id))
			s.protection = {
				...s.protection,
				chunkIds: s.protection.chunkIds.filter(id => residentIds.has(id)),
				overscanChunkIds: s.protection.overscanChunkIds.filter(id => residentIds.has(id)),
			}
			s.seam = {
				from: previous.at(-1) ? idOf(previous.at(-1) as HistoryRecord) : null,
				to: live.at(-1) ? idOf(live.at(-1) as HistoryRecord) : null,
				unverified: true,
			}
			const tail = s.spans.at(-1)
			if (tail?.source === 'live')
				s.spans[s.spans.length - 1] = { ...tail, omitted: tail.omitted || truncated, gap: true }
		}
		if (!this.fit(s)) return false
		this.commit(s)
		return true
	}
	/** Strict new-prefix admission. Wire authentication and boundary proof belong to the future controller. */
	admitPrefix(ticket: TranscriptTicket, input: HistoryPage): TranscriptAdmission {
		if (!this.valid(ticket)) return { status: 'stale' }
		if (bytes(input) > 96 * 1024 || input.records.length > 40) return { status: 'capacity' }
		if (this.state.retry && equal(ticket, this.state.retry.ticket)) {
			if (rangeKey(input) !== this.state.retry.range) return { status: 'stale' }
			return this.restore(this.state.retry.association, input)
		}
		if (!equal(ticket, this.state.active) || ticket.boundary !== this.state.boundary) return { status: 'stale' }
		// A retained wire association is not new older coverage, even under a fresh ticket.
		if (this.state.cache.some(c => c.value.origin === 'history' && rangeKey(c.value.page) === rangeKey(input)))
			return { status: 'unverified' }
		const s = this.draft()
		const records = this.canonical(input.records)
		const known = this.known(s)
		const existingLive = new Set(s.live.map(idOf))
		const isKnown = (r: HistoryRecord) => known.has(idOf(r)) || existingLive.has(idOf(r))
		const overlap = records.findIndex(isKnown)
		if (overlap >= 0 && records.slice(overlap).some(r => !isKnown(r))) return { status: 'unverified' }
		const prefix = overlap < 0 ? records : records.slice(0, overlap)
		const end = s.spans[0]?.start ?? 0
		const start = end - Math.max(1, prefix.length)
		const span: TranscriptSpan = {
			id: ++s.sequence,
			start,
			end,
			first: prefix[0] ? idOf(prefix[0]) : null,
			last: prefix.at(-1) ? idOf(prefix.at(-1) as HistoryRecord) : null,
			rawOldest: input.oldest,
			rawNewest: input.newest,
			recordCount: prefix.length,
			countIsEstimate: false,
			height: prefix.length * 80,
			source: 'history',
			coverage: 'authenticated',
			omitted: Object.values(input.omissions).some(n => n > 0),
			gap: s.spans.length > 0,
			root: input.stopped === 'root',
		}
		s.spans.unshift(span)
		prefix.forEach((r, i) => this.checkpoint(s, idOf(r), start + i))
		const association = freeze({ ...ticket, start, end, first: span.first, last: span.last })
		this.chunk(
			s,
			{ ...input, records: prefix },
			prefix.map((_, i) => start + i),
			start,
			end,
		)
		const incoming = s.cache.at(-1)?.value.id
		// Incoming payload is mandatory for this transaction, not permanently pinned after settlement.
		const oldPins = s.protection.chunkIds
		s.protection = { ...s.protection, chunkIds: [...oldPins, ...(incoming === undefined ? [] : [incoming])] }
		s.active = null
		s.retry = {
			ticket: copy(ticket),
			association,
			range: rangeKey(input),
			cropIds: records.slice(prefix.length).map(idOf),
		}
		s.boundary++
		s.older = input.older
		s.root = span.root
		if (!this.fit(s)) return { status: 'capacity' }
		s.protection = { ...s.protection, chunkIds: oldPins }
		this.commit(s)
		return { status: 'accepted', association }
	}
	/** Compatibility only: no unassociated page may silently acquire new logical membership. */
	prepend(page: HistoryPage): boolean {
		const ticket = this.state.active ?? this.state.retry?.ticket
		if (!ticket) return false
		return this.admitPrefix(ticket, page).status === 'accepted'
	}
	private valid(ticket: TranscriptTicket) {
		return ticket.instance === this.instance && ticket.epoch === this.epoch
	}
	/** Mint one bounded restoration association from retained endpoints/checkpoints, not caller coordinates alone. */
	associate(spanId: number, start?: number, end?: number): TranscriptAssociation | null {
		if (this.state.active || (this.state.reconciliation && this.state.reconciliation.last?.output.phase !== 'complete'))
			return null
		const span = this.state.spans.find(s => s.id === spanId)
		if (!span) return null
		const low = start ?? span.start
		const high = end ?? span.end
		if (
			!Number.isSafeInteger(low) ||
			!Number.isSafeInteger(high) ||
			low < span.start ||
			high > (this.state.spans.at(-1)?.end ?? 0) ||
			low >= high ||
			low >= span.end ||
			high <= span.start
		)
			return null
		const at = (position: number) =>
			this.state.checkpoints.find(c => c.position === position && !c.ordering)?.id ??
			this.state.cache
				.filter(c => !c.value.ordering)
				.flatMap(c => c.value.page.records.map((r, i) => ({ id: idOf(r), position: c.value.positions[i] })))
				.find(c => c.position === position)?.id
		const endpoint = (position: number, side: 'first' | 'last') => {
			const recovery = this.state.spans.flatMap(s => (s.recovery ? [s.recovery] : []))
			const envelope = recovery.find(r => (side === 'first' ? r.start === position : r.end - 1 === position))
			if (envelope) return side === 'first' ? envelope.lower : envelope.upper
			return (
				at(position) ??
				this.state.spans.find(s => (side === 'first' ? s.start === position : s.end - 1 === position))?.[side]
			)
		}
		const first = endpoint(low, 'first')
		const last = endpoint(high - 1, 'last')
		if (first === undefined || last === undefined) return null
		const s = this.draft()
		const association: TranscriptAssociation = {
			instance: this.instance,
			epoch: this.epoch,
			serial: ++s.sequence,
			boundary: this.state.boundary,
			start: low,
			end: high,
			first,
			last,
		}
		s.active = association
		s.reconciliation = null
		// Union to a fixed point, including any capacity-driven compaction in this
		// unpublished candidate. Only then mint the immutable handle with actual bounds.
		for (let pass = 0; pass <= MAX_SPANS; pass++) {
			if (!this.fit(s)) return null
			let widened = false
			for (const span of s.spans) {
				const r = span.recovery
				if (!r || r.start >= association.end || r.end <= association.start) continue
				if (r.start < association.start) {
					association.start = r.start
					association.first = r.lower
					widened = true
				}
				if (r.end > association.end) {
					association.end = r.end
					association.last = r.upper
					widened = true
				}
			}
			if (widened) continue
			freeze(association)
			this.commit(s)
			return association
		}
		return null
	}
	/** Consume an issued association. The caller still authenticates every external response. */
	beginReconciliation(
		association: TranscriptAssociation,
	): { handle: TranscriptReconciliation; next: HistoryAction } | null {
		if (
			this.state.reconciliation ||
			!this.valid(association) ||
			!association.first ||
			!association.last ||
			(this.state.active !== null && !equal(association, this.state.active)) ||
			(!equal(association, this.state.active) && !equal(association, this.state.retry?.association))
		)
			return null
		const s = this.draft()
		const handle = freeze({
			instance: this.instance,
			epoch: this.epoch,
			serial: ++s.sequence,
			boundary: s.boundary,
			associationSerial: association.serial,
		})
		const next: HistoryAction = { kind: 'open', anchor: association.last }
		s.active = null
		s.retry = null
		s.reconciliation = {
			handle,
			lower: association.first,
			upper: association.last,
			frontier: null,
			phase: 'open',
			expected: next,
			seed: null,
			binding: null,
			last: null,
		}
		this.checkpoint(s, association.first, association.start)
		this.checkpoint(s, association.last, association.end - 1)
		if (!this.fit(s)) return null
		this.commit(s)
		return { handle, next }
	}
	cancelReconciliation(handle: TranscriptReconciliation): boolean {
		if (!equal(handle, this.state.reconciliation?.handle)) return false
		const s = this.draft()
		s.reconciliation = null
		this.commit(s)
		return true
	}
	/** One result, one bounded transaction. No response/page chain and no per-page Newer search. */
	reconcile(handle: TranscriptReconciliation, result: HistoryResult): TranscriptReconciliationResult {
		const current = this.state.reconciliation
		const refusal = (status: TranscriptAdmission['status']): TranscriptReconciliationResult => ({
			status,
			next: current?.expected ?? null,
			phase: current?.phase ?? 'complete',
		})
		if (!current || !this.valid(handle) || !equal(handle, current.handle)) return refusal('stale')
		if (bytes(result) > 96 * 1024 || (result.page?.records.length ?? 0) > 40) return refusal('capacity')
		const binding = { target: result.target, hostEpoch: result.hostEpoch, viewId: result.viewId }
		if (current.binding && !equal(binding, current.binding)) return refusal('stale')
		const fingerprint = stamp(result)
		if (current.last && result.sequence <= current.last.sequence) {
			if (result.sequence === current.last.sequence && fingerprint === current.last.stamp)
				return { ...copy(current.last.output), status: 'unchanged' }
			return refusal('stale')
		}
		if (current.last?.output.phase === 'complete' || !equal(result.input, current.expected)) return refusal('stale')
		const s = this.draft()
		const op = copy(current)
		s.reconciliation = op
		op.binding = copy(binding)
		const fail = (): TranscriptReconciliationResult => {
			// Prior accepted fragments survive; never install a final fragment that strands known rows.
			const retired = this.draft()
			retired.reconciliation = null
			this.commit(retired)
			return { status: 'unverified', next: null, phase: op.phase }
		}
		let status: TranscriptReconciliationResult['status'] = 'progress'
		let complete = false
		if (result.state === 'progress' && result.continuation) {
			op.expected = { kind: 'continue', cursor: result.continuation }
		} else if (result.state === 'page' && result.page) {
			const page = result.page
			if (op.phase === 'open') {
				if (!page.newer) return fail()
				op.phase = 'seed'
				op.expected = { kind: 'newer', cursor: page.newer }
			} else {
				let rows = page.records
				if (op.phase === 'seed' || (op.phase === 'replay' && !op.frontier)) {
					const upper = rows.findIndex(r => idOf(r) === op.upper)
					if (upper < 0) return fail()
					rows = rows.slice(0, upper + 1)
				}
				if (op.phase === 'seed') {
					op.seed = page.reread
					op.phase = 'discover'
				}
				const lower = rows.findIndex(r => idOf(r) === op.lower)
				if (op.phase === 'discover') {
					if (lower >= 0) {
						if (!op.seed) return fail()
						op.phase = 'replay'
						op.expected = { kind: 'page', cursor: op.seed }
					} else {
						if (!page.older) return fail()
						op.expected = { kind: 'page', cursor: page.older }
					}
				} else {
					complete = lower >= 0
					if (complete) rows = rows.slice(lower)
					if (!complete && !page.older) return fail()
					const applied = this.reconcileFragment(s, op, page, rows, complete)
					if (applied === 'capacity') return refusal('capacity')
					if (applied === 'unverified') return fail()
					status = 'accepted'
					if (rows.length) op.frontier = idOf(rows[0] as HistoryRecord)
					if (!complete) op.expected = { kind: 'page', cursor: page.older as string }
				}
			}
		} else return fail()
		const output: TranscriptReconciliationResult = {
			status,
			next: complete ? null : copy(op.expected),
			phase: complete ? 'complete' : op.phase,
		}
		op.last = { sequence: result.sequence, stamp: fingerprint, output }
		// Keep just the final replay stamp for duplicate settlement, not a live operation reservation.
		if (complete) {
			op.seed = null
			const known = this.known(s)
			const low = known.get(op.lower) as number
			const high = (known.get(op.upper) as number) + 1
			s.spans = s.spans.map(span => {
				if (!span.recovery || span.recovery.start < low || span.recovery.end > high) return span
				const { recovery: _recovery, ...rest } = span
				return rest
			})
			// The entire bounded envelope has now been walked; prior compaction may have combined
			// its estimated remainder with exact fragments. Completion resolves that estimate only here.
			s.spans = s.spans.map(span =>
				span.start >= low && span.end <= high && !span.recovery
					? {
							...span,
							recordCount: span.end - span.start,
							countIsEstimate: false,
							coverage: 'authenticated',
							gap: false,
							root: false,
						}
					: span,
			)
		}
		if (!this.fit(s)) return refusal('capacity')
		this.commit(s)
		return copy(output)
	}

	private reconcileFragment(
		s: State,
		op: Reconciliation,
		page: HistoryPage,
		rows: readonly HistoryRecord[],
		complete: boolean,
	): 'accepted' | 'capacity' | 'unverified' {
		const known = this.known(s)
		const low = known.get(op.lower)
		const high = op.frontier ? known.get(op.frontier) : (known.get(op.upper) ?? Number.NaN) + 1
		if (low === undefined || high === undefined || !Number.isFinite(high) || high <= low) return 'unverified'
		const ids = new Set(rows.map(idOf))
		if (ids.size !== rows.length || ids.has('current')) return 'unverified'
		const existing = [...known].filter(([, p]) => p >= low && p < high).sort((a, b) => a[1] - b[1])
		const remaining = existing.filter(([id]) => !ids.has(id))
		const uncertain = new Set([
			...s.checkpoints.filter(c => c.ordering).map(c => c.id),
			...s.cache.filter(c => c.value.ordering).flatMap(c => c.value.page.records.map(idOf)),
		])
		const matched = existing.filter(([id]) => ids.has(id) && !uncertain.has(id))
		// A surviving known row cannot be moved through a source-proven fragment. Estimated
		// seam placements are not ordinal proof and cannot veto the observed canonical order. Leave a real gap.
		if (
			(complete && remaining.length) ||
			(matched.length && remaining.some(([id, p]) => !uncertain.has(id) && p > (matched[0] as [string, number])[1]))
		)
			return 'unverified'
		if (
			rows.some(r => {
				const p = known.get(idOf(r))
				return p !== undefined && (p < low || p >= high)
			})
		)
			return 'unverified'
		const orderedMatches = rows.map(idOf).filter(id => known.has(id) && !uncertain.has(id))
		if (
			!equal(
				orderedMatches,
				matched.map(([id]) => id),
			)
		)
			return 'unverified'
		const oldWidth = high - low
		const remainingWidth = complete ? 0 : Math.max(remaining.length, Math.ceil(oldWidth) - rows.length, 1)
		const fragmentStart = low + remainingWidth
		const end = fragmentStart + rows.length
		const delta = end - high
		const remPositions = new Map(
			remaining.map(([id], i) => [id, low + Math.floor((i * remainingWidth) / remaining.length)]),
		)
		const positions = new Map(rows.map((r, i) => [idOf(r), fragmentStart + i]))
		const move = (id: string, p: number) =>
			p >= high ? p + delta : p < low ? p : (positions.get(id) ?? remPositions.get(id) ?? p)
		const envelopes = s.spans.flatMap(span => (span.recovery ? [span.recovery] : []))
		if (!complete && !op.frontier)
			envelopes.push({ lower: op.lower, upper: op.upper, start: low, end: (known.get(op.upper) as number) + 1 })
		const movedEnvelopes = envelopes.map(r => ({
			...r,
			start: move(r.lower, r.start),
			end: move(r.upper, r.end - 1) + 1,
		}))
		const affected = s.spans.filter(span => span.start < high && span.end > low)
		if (!affected.length) return 'unverified'
		const first = affected[0] as TranscriptSpan
		const last = affected.at(-1) as TranscriptSpan
		const segments: TranscriptSpan[] = []
		const segment = (
			base: TranscriptSpan,
			start: number,
			end: number,
			firstId: string | null,
			lastId: string | null,
		): TranscriptSpan => ({
			...base,
			id: ++s.sequence,
			start,
			end,
			first: firstId,
			last: lastId,
			recordCount: end - start,
			height: base.end > base.start ? (base.height * (end - start)) / (base.end - base.start) : 0,
			rawOldest: start === base.start ? base.rawOldest : null,
			rawNewest: end === base.end ? base.rawNewest : null,
			root: start === base.start && base.root,
		})
		const at = (p: number) => [...known].find(([, position]) => position === p)?.[0] ?? null
		if (first.start < low) segments.push(segment(first, first.start, low, first.first, at(low - 1)))
		if (remainingWidth)
			segments.push({
				...segment(first, low, fragmentStart, op.lower, remaining.at(-1)?.[0] ?? op.lower),
				source: 'aggregate',
				countIsEstimate: true,
				coverage: 'unverified',
				gap: true,
				root: false,
				height: remainingWidth * 80,
			})
		// Raw-only pages have zero rendered extent; coverage remains separate from record count/height.
		segments.push({
			...segment(
				first,
				fragmentStart,
				end,
				rows[0] ? idOf(rows[0]) : null,
				rows.at(-1) ? idOf(rows.at(-1) as HistoryRecord) : null,
			),
			source: 'history',
			height: rows.length * 80,
			countIsEstimate: false,
			coverage: 'authenticated',
			gap: false,
			omitted: Object.values(page.omissions).some(n => n > 0),
			rawOldest: rows.length === page.records.length ? page.oldest : null,
			rawNewest: rows.length === page.records.length ? page.newest : null,
			root: false,
		})
		if (last.end > high) segments.push(segment(last, end, last.end + delta, at(high), last.last))
		s.spans = s.spans.flatMap(span =>
			span.id === first.id
				? segments
				: affected.some(a => a.id === span.id)
					? []
					: [
							{
								...span,
								start: span.start >= high ? span.start + delta : span.start,
								end: span.end >= high ? span.end + delta : span.end,
							},
						],
		)
		if (!this.placeRecovery(s, movedEnvelopes)) return 'unverified'
		const priorPins = s.protection.chunkIds
		const priorRanges = s.protectedRanges
		const protectedIds = new Set([
			...s.protection.anchorIds,
			...existing.filter(([, p]) => priorRanges.some(r => p >= r.start && p < r.end)).map(([id]) => id),
		])
		const newCache: Cached[] = []
		const temporary: number[] = []
		const permanent: number[] = []
		for (const cached of s.cache) {
			const c = cached.value
			if (!c.positions.some(p => p >= low && p < high)) {
				const value = freeze({
					...c,
					start: c.start >= high ? c.start + delta : c.start,
					end: c.end >= high ? c.end + delta : c.end,
					positions: c.positions.map(p => (p >= high ? p + delta : p)),
				})
				newCache.push({ value, bytes: bytes(value) })
				if (priorPins.includes(c.id)) permanent.push(c.id)
				continue
			}
			// Keep both outside sides and every unmatched known row, in separate source-ordered chunks.
			for (const side of [-1, 0, 1]) {
				const kept = c.page.records
					.map((r, i) => ({ r, p: c.positions[i] as number }))
					.filter(
						({ r, p }) => !ids.has(idOf(r)) && (side === -1 ? p < low : side === 1 ? p >= high : p >= low && p < high),
					)
				if (!kept.length) continue
				const ps = kept.map(({ r, p }) => move(idOf(r), p))
				const value = freeze({
					...c,
					id: ++s.sequence,
					start: ps[0] as number,
					end: (ps.at(-1) as number) + 1,
					page: { ...c.page, records: kept.map(x => x.r) },
					positions: ps,
				})
				newCache.push({ value, bytes: bytes(value) })
				temporary.push(value.id)
				if (priorPins.includes(c.id)) permanent.push(value.id)
			}
		}
		s.cache = newCache
		s.checkpoints = s.checkpoints.filter(c => !ids.has(c.id)).map(c => ({ ...c, position: move(c.id, c.position) }))
		for (const r of rows) s.checkpoints.push({ id: idOf(r), position: positions.get(idOf(r)) as number, spanId: 0 })
		s.checkpoints = s.checkpoints.map(c => ({
			...c,
			spanId: s.spans.find(span => span.start <= c.position && span.end > c.position)?.id ?? c.spanId,
		}))
		const live = new Set(s.live.map(idOf))
		const runs: HistoryRecord[][] = []
		let run: HistoryRecord[] = []
		for (const row of rows) {
			if (live.has(idOf(row))) {
				if (run.length) runs.push(run)
				run = []
			} else run.push(row)
		}
		if (run.length) runs.push(run)
		if (!rows.length) runs.push([])
		const incoming: number[] = []
		for (const [index, kept] of runs.entries()) {
			const ps = kept.map(r => positions.get(idOf(r)) as number)
			this.chunk(
				s,
				{
					...page,
					records: kept,
					stopped: 'boundary',
					// Count raw omissions once, only when the full raw range is retained. Clipped
					// ranges retain the span's omitted warning without attributing outside counts.
					omissions:
						index === 0 && rows.length === page.records.length
							? page.omissions
							: { clipped: 0, images: 0, unsupported: 0 },
					oldest: kept.length === page.records.length ? page.oldest : null,
					newest: kept.length === page.records.length ? page.newest : null,
				},
				ps,
				ps[0] ?? fragmentStart,
				ps.length ? (ps.at(-1) as number) + 1 : end,
			)
			const id = s.cache.at(-1)?.value.id as number
			incoming.push(id)
			if (kept.some(r => protectedIds.has(idOf(r)))) permanent.push(id)
		}
		s.protectedRanges = this.coalesceRanges([
			...priorRanges.flatMap(r => [
				{ start: r.start, end: Math.min(r.end, low) },
				{ start: Math.max(r.start, high) + delta, end: r.end + delta },
			]),
			...s.checkpoints.filter(c => protectedIds.has(c.id)).map(c => ({ start: c.position, end: c.position + 1 })),
		])
		s.protection = {
			...s.protection,
			spanIds: s.protection.spanIds.flatMap(id => (affected.some(a => a.id === id) ? segments.map(a => a.id) : [id])),
			chunkIds: [...new Set([...permanent, ...temporary, ...incoming])],
			overscanChunkIds: [],
		}
		s.retry = null
		if (!this.fit(s)) return 'capacity'
		s.protection = { ...s.protection, chunkIds: [...new Set(permanent)] }
		return 'accepted'
	}

	/** Replace only an issued interval. Ordered positions are controller-supplied authenticated coverage evidence.
	 * Without explicit positions only an exact dense canonical range can be reconstructed. No cropping guesses.
	 */
	restore(handle: TranscriptAssociation, input: HistoryPage, proof?: readonly number[]): TranscriptAdmission {
		if (!this.valid(handle) || (!equal(handle, this.state.active) && !equal(handle, this.state.retry?.association)))
			return { status: 'stale' }
		if (bytes(input) > 96 * 1024 || input.records.length > 40) return { status: 'capacity' }
		const records = this.canonical(input.records)
		const known = this.known(this.state)
		const uncertain = new Set([
			...this.state.checkpoints.filter(c => c.ordering).map(c => c.id),
			...this.state.cache.filter(c => c.value.ordering).flatMap(c => c.value.page.records.map(idOf)),
		])
		// A retry may include overlap beyond the associated prefix. Crop only IDs with retained position evidence.
		const cropped = records.filter(r => {
			if (
				equal(handle, this.state.retry?.association) &&
				rangeKey(input) === this.state.retry?.range &&
				this.state.retry.cropIds.includes(idOf(r))
			)
				return false
			const p = known.get(idOf(r))
			return p === undefined || uncertain.has(idOf(r)) || (p >= handle.start && p < handle.end)
		})
		if (
			(cropped[0] ? idOf(cropped[0]) : null) !== handle.first ||
			(cropped.at(-1) ? idOf(cropped.at(-1) as HistoryRecord) : null) !== handle.last
		)
			return { status: 'unverified' }
		const positions = proof ? [...proof] : cropped.map((_, i) => handle.start + i)
		if (
			positions.length !== cropped.length ||
			(!proof && cropped.length > 0 && cropped.length !== handle.end - handle.start) ||
			positions.some(
				(p, i) =>
					!Number.isSafeInteger(p) ||
					p < handle.start ||
					p >= handle.end ||
					(i > 0 && p <= (positions[i - 1] as number)),
			)
		)
			return { status: 'unverified' }
		if (cropped.some((r, i) => !uncertain.has(idOf(r)) && known.has(idOf(r)) && known.get(idOf(r)) !== positions[i]))
			return { status: 'unverified' }
		const s = this.draft()
		const resolving = new Set(cropped.map(idOf).filter(id => uncertain.has(id)))
		s.checkpoints = s.checkpoints.filter(c => !resolving.has(c.id))
		cropped.forEach((r, i) => {
			if (resolving.has(idOf(r))) this.checkpoint(s, idOf(r), positions[i] as number)
		})
		const liveIds = new Set(s.live.map(idOf))
		const kept = cropped.map((r, i) => ({ r, p: positions[i] as number })).filter(x => !liveIds.has(idOf(x.r)))
		const replacement = { ...input, records: kept.map(x => x.r) }
		const intersects = (c: TranscriptChunk) =>
			c.positions.length
				? c.positions.some(p => p >= handle.start && p < handle.end)
				: c.start < handle.end && c.end > handle.start
		const old = s.cache.filter(c => intersects(c.value) || c.value.page.records.some(r => resolving.has(idOf(r))))
		const semanticPage = (p: HistoryPage) => ({
			records: p.records,
			oldest: p.oldest,
			newest: p.newest,
			omissions: p.omissions,
			stopped: p.stopped,
		})
		if (
			old.length === 1 &&
			old[0]?.value.start === handle.start &&
			old[0]?.value.end === handle.end &&
			equal(semanticPage(old[0].value.page), semanticPage(replacement)) &&
			equal(
				old[0]?.value.positions,
				kept.map(x => x.p),
			)
		)
			return { status: 'unchanged', association: handle }
		// Split both surviving sides so snapshot chunk order remains source order, not [left,right,middle].
		const mandatory = old.some(c => s.protection.chunkIds.includes(c.value.id))
		const optional = old.some(c => s.protection.overscanChunkIds.includes(c.value.id))
		const removedIds = new Set(old.map(c => c.value.id))
		const additions: Cached[] = []
		s.cache = s.cache.filter(c => !removedIds.has(c.value.id))
		for (const c of old) {
			const rows = c.value.page.records
				.map((r, i) => ({ r, p: c.value.positions[i] as number }))
				.filter(x => !resolving.has(idOf(x.r)))
			for (const side of [rows.filter(x => x.p < handle.start), rows.filter(x => x.p >= handle.end)]) {
				if (!side.length) continue
				const value = freeze({
					...c.value,
					id: ++s.sequence,
					start: (side[0] as { p: number }).p,
					end: (side.at(-1) as { p: number }).p + 1,
					page: { ...c.value.page, records: side.map(x => x.r) },
					positions: side.map(x => x.p),
				})
				additions.push({ value, bytes: bytes(value) })
			}
		}
		s.cache.push(...additions)
		this.chunk(
			s,
			replacement,
			kept.map(x => x.p),
			handle.start,
			handle.end,
		)
		const incoming = s.cache.at(-1)?.value.id
		const replacementIds = [...additions.map(c => c.value.id), ...(incoming === undefined ? [] : [incoming])]
		const oldPins = [...s.protection.chunkIds.filter(id => !removedIds.has(id)), ...(mandatory ? replacementIds : [])]
		s.protection = {
			...s.protection,
			chunkIds: [...oldPins, ...(incoming === undefined || oldPins.includes(incoming) ? [] : [incoming])],
			overscanChunkIds: [
				...s.protection.overscanChunkIds.filter(id => !removedIds.has(id)),
				...(optional ? replacementIds : []),
			],
		}
		if (!this.fit(s)) return { status: 'capacity' }
		s.protection = { ...s.protection, chunkIds: oldPins }
		this.commit(s)
		return { status: 'accepted', association: handle }
	}
	replaceChunk(reread: string, page: HistoryPage): boolean {
		const retry = this.state.retry
		if (!retry?.range || JSON.parse(retry.range)[2] !== reread) return false
		return this.restore(retry.association, page).status === 'accepted'
	}
	private settlement(s: State, handle: TranscriptTicket, retire: boolean): Pick<State, 'active' | 'retry'> {
		let { active, retry } = s
		if (equal(active, handle)) {
			if (active && 'end' in active) {
				const association = active
				const cached = s.cache.find(c => c.value.start === association.start && c.value.end === association.end)
				retry = {
					ticket: {
						instance: association.instance,
						epoch: association.epoch,
						serial: association.serial,
						boundary: association.boundary,
					},
					association,
					range: cached?.value.origin === 'history' ? rangeKey(cached.value.page) : null,
					cropIds: [],
				}
			}
			active = null
		}
		if (retire && (equal(retry?.ticket, handle) || equal(retry?.association, handle))) retry = null
		return { active, retry }
	}
	/** Admission already reserved exact settlement growth. Retirement never rebuilds rows or needs capacity. */
	settle(handle: TranscriptTicket, retire = false): boolean {
		if (!this.valid(handle)) return false
		const settled = this.settlement(this.state, handle, retire)
		if (settled.active === this.state.active && settled.retry === this.state.retry) return false
		this.commit({ ...this.state, ...settled })
		return true
	}

	protect(input: TranscriptProtection): boolean {
		const supplied = { ...protection(), ...copy(input) }
		const p = {
			spanIds: [...new Set(supplied.spanIds)],
			chunkIds: [...new Set(supplied.chunkIds)],
			anchorIds: [...new Set(supplied.anchorIds)],
			overscanChunkIds: [...new Set(supplied.overscanChunkIds)],
		}
		if (
			p.spanIds.length > MAX_SPANS ||
			p.chunkIds.length > MAX_CHUNKS ||
			p.overscanChunkIds.length > MAX_CHUNKS ||
			p.anchorIds.length > 40
		)
			return false
		const known = this.known(this.state)
		if (
			p.spanIds.some(id => !this.state.spans.some(s => s.id === id)) ||
			[...p.chunkIds, ...p.overscanChunkIds].some(id => !this.state.cache.some(c => c.value.id === id)) ||
			p.anchorIds.some(id => !known.has(id))
		)
			return false
		const ranges = this.coalesceRanges(
			this.state.cache
				.filter(c => p.chunkIds.includes(c.value.id))
				.map(c => ({ start: c.value.start, end: c.value.end })),
		)
		if (equal(p, this.state.protection) && equal(ranges, this.state.protectedRanges)) return true
		const s = this.draft()
		s.protection = p
		s.protectedRanges = ranges
		if (!this.fit(s)) return false
		this.commit(s)
		return true
	}
	release(): void {
		this.protect({})
	}
	private windowDescriptor(window: TranscriptRenderWindow | null) {
		if (!window) return null
		return {
			...window,
			items: window.items.map(item => {
				if (item.kind === 'spacer') return item
				const { record: _record, ...descriptor } = item
				return descriptor
			}),
		}
	}
	private projectWindow(s: State, overscan: boolean): TranscriptGeometryUpdate {
		const g = s.geometry
		if (!g.layout?.enabled) {
			const changed = g.window !== null
			g.window = null
			g.measurements.clear()
			g.reading = null
			g.mandatory = []
			g.optional = []
			return { status: changed ? 'accepted' : 'unchanged', published: changed }
		}
		const positions = this.known(s)
		const native = new Set(s.live.map(idOf))
		const candidates = new Map<string, { record: HistoryRecord; at: number; unverified: boolean }>()
		for (const chunk of s.cache) {
			chunk.value.page.records.forEach((record, index) => {
				candidates.set(idOf(record), {
					record,
					at: chunk.value.positions[index] as number,
					unverified: !!chunk.value.ordering,
				})
			})
		}
		s.live.forEach((record, index) => {
			candidates.set(idOf(record), {
				record,
				at: positions.get(idOf(record)) ?? index,
				unverified: !s.expanded || !!s.checkpoints.find(c => c.id === idOf(record))?.ordering,
			})
		})
		const ordered = [...candidates.values()].sort((a, b) => a.at - b.at)
		const prior = new Map(g.window?.items.filter(item => item.kind === 'row').map(row => [row.key, row]))
		const all: TranscriptRenderItem[] = []
		let top = 0
		let cursor = s.spans[0]?.start ?? 0
		let speaker: ReturnType<typeof classifyTranscriptRecord>['speaker'] = null
		const gap = (end: number) => {
			if (end <= cursor) return
			let unknown = false
			let covered = cursor
			// Only the M1 fallback is divisible. No measured aggregate is scaled here.
			for (const span of s.spans) {
				const start = Math.max(cursor, span.start)
				const stop = Math.min(end, span.end)
				if (stop <= start) continue
				if (start > covered) unknown = true
				covered = stop
				const knownEmpty = span.recordCount === 0 && !span.countIsEstimate && span.coverage === 'authenticated'
				if (!knownEmpty) unknown = true
				const height = span.recordCount === 0 ? 0 : span.height * ((stop - start) / (span.end - span.start))
				all.push({
					kind: 'spacer',
					key: `range:${this.instance}:${this.epoch}:${start}:${stop}`,
					top,
					height,
					certainty: knownEmpty ? 'known-hidden' : span.recordCount === 0 ? 'unknown' : 'estimated',
				})
				top += height
			}
			if (unknown || covered < end) speaker = null
			cursor = end
		}
		for (const candidate of ordered) {
			gap(candidate.at)
			const { record, at, unverified } = candidate
			const key = transcriptCanonicalKey(this.instance, this.epoch, record)
			const presentation = classifyTranscriptRecord(record, g.layout.activity)
			cursor = Math.max(cursor, at + (unverified && s.expanded ? 0 : 1))
			if (presentation.visibility === 'known-hidden') {
				all.push({ kind: 'spacer', key: `hidden:${key}`, top, height: 0, certainty: 'known-hidden' })
				continue
			}
			const grouping =
				presentation.speaker === null ? 'none' : presentation.speaker === speaker ? 'continuation' : 'author'
			if (presentation.speaker !== null) speaker = presentation.speaker
			const old = prior.get(key)
			const measurementKey =
				old && g.window?.layoutEpoch === g.epoch && old.grouping === grouping && equal(old.record, record)
					? old.measurementKey
					: `measurement:${this.instance}:${this.epoch}:${++g.measurementSequence}`
			const measurement = g.measurements.get(key)
			const height =
				measurement?.layoutEpoch === g.epoch && measurement.measurementKey === measurementKey ? measurement.height : 80
			all.push({
				kind: 'row',
				key,
				record,
				origin: native.has(idOf(record)) ? 'native' : 'history',
				top,
				height,
				position: unverified ? null : at,
				ordering: unverified ? 'unverified' : 'verified',
				grouping,
				measurementKey,
			})
			top += height
		}
		gap(s.spans.at(-1)?.end ?? cursor)
		const logicalExtent = top + g.layout.inFlowTail.height
		if (!Number.isFinite(logicalExtent) || logicalExtent > 1e12) return { status: 'capacity', published: false }
		const history = all.filter((item): item is TranscriptRenderRow => item.kind === 'row' && item.origin === 'history')
		// Retained canonical reading follows its new source neighborhood after prepend/measurement,
		// while the independently observed physical scroll value is never rewritten.
		const anchor = g.reading?.anchor
		const anchorRow = anchor
			? all.find((row): row is TranscriptRenderRow => row.kind === 'row' && row.key === anchor.key)
			: undefined
		const viewportTop =
			anchor && anchorRow
				? Math.max(0, anchorRow.top + anchor.inRowOffset - anchor.viewportOffset)
				: (g.reading?.logicalViewportTop ?? 0)
		if (!Number.isFinite(viewportTop) || viewportTop > 1e12) return { status: 'capacity', published: false }
		if (g.reading && viewportTop !== g.reading.logicalViewportTop)
			g.reading = { ...g.reading, logicalViewportTop: viewportTop }
		const viewportBottom = viewportTop + (g.reading?.viewportHeight ?? g.layout.viewportHeight)
		const intersects = (row: TranscriptRenderRow) =>
			row.height === 0
				? row.top >= viewportTop && row.top <= viewportBottom
				: row.top + row.height > viewportTop && row.top < viewportBottom
		let first = history.findIndex(row =>
			row.height === 0 ? row.top >= viewportTop : row.top + row.height > viewportTop,
		)
		if (first < 0) first = history.length
		let last = first
		while (last < history.length && intersects(history[last] as TranscriptRenderRow)) last++
		const required = new Set(history.slice(first, last).map(row => row.key))
		if (anchorRow?.origin === 'history') required.add(anchorRow.key)
		if (required.size > 120) return { status: 'capacity', published: false }
		const before = overscan ? Math.min(10, first, Math.max(0, 120 - required.size)) : 0
		const after = overscan ? Math.min(10, history.length - last, Math.max(0, 120 - required.size - before)) : 0
		const selected = new Set([...required, ...history.slice(first - before, last + after).map(row => row.key)])
		g.mandatory = all
			.filter(
				(row): row is TranscriptRenderRow =>
					row.kind === 'row' && (required.has(row.key) || row.key === anchor?.key || intersects(row)),
			)
			.map(row => idOf(row.record))
		g.optional = history.filter(row => selected.has(row.key) && !required.has(row.key)).map(row => idOf(row.record))
		const items: TranscriptRenderItem[] = []
		for (const item of all) {
			if (
				item.kind === 'spacer' &&
				item.certainty === 'known-hidden' &&
				items.at(-1)?.kind === 'spacer' &&
				(items.at(-1) as TranscriptRenderSpacer).certainty === 'known-hidden'
			)
				continue
			if (item.kind !== 'row' || item.origin === 'native' || selected.has(item.key)) items.push(item)
			else {
				const previous = items.at(-1)
				if (
					previous?.kind === 'spacer' &&
					previous.certainty === 'estimated' &&
					previous.top + previous.height === item.top
				)
					items[items.length - 1] = { ...previous, height: previous.height + item.height }
				else
					items.push({
						kind: 'spacer',
						key: `unmounted:${item.key}`,
						top: item.top,
						height: item.height,
						certainty: 'estimated',
					})
			}
		}
		const mounted = new Map(items.filter(item => item.kind === 'row').map(row => [row.key, row]))
		g.measurements = new Map(
			[...g.measurements].filter(([key, value]) => mounted.get(key)?.measurementKey === value.measurementKey),
		)
		g.window = freeze({
			instance: this.instance,
			epoch: this.epoch,
			serial: ++g.windowSerial,
			layoutEpoch: g.epoch,
			items,
			historicalVisibleCount: selected.size,
			historicalOverscanCount: before + after,
			logicalExtent,
			demand: g.window?.demand ?? null,
			restoration: g.reading?.restoration ?? { kind: 'none' },
			capacity: null,
		})
		return { status: 'accepted', published: true }
	}
	configureLayout(input: TranscriptLayoutInput): TranscriptGeometryUpdate {
		if (
			typeof input.enabled !== 'boolean' ||
			typeof input.activity !== 'boolean' ||
			typeof input.readingVisible !== 'boolean' ||
			!Number.isSafeInteger(input.presentationEpoch) ||
			input.presentationEpoch < 0 ||
			!Number.isSafeInteger(input.inFlowTail.epoch) ||
			input.inFlowTail.epoch < 0 ||
			!Number.isFinite(input.width) ||
			!Number.isFinite(input.viewportHeight) ||
			input.width < 0 ||
			input.width > 1e6 ||
			input.viewportHeight < 0 ||
			input.viewportHeight > 1e6 ||
			!Number.isFinite(input.inFlowTail.height) ||
			input.inFlowTail.height < 0 ||
			input.inFlowTail.height > 1e12
		)
			return { status: 'invalid', published: false }
		const same = equal(this.layout, input)
		if (same) return { status: 'unchanged', published: false }
		const s = this.draft()
		const previous = s.geometry.layout
		s.geometry.layout = {
			enabled: input.enabled,
			width: input.width,
			viewportHeight: input.viewportHeight,
			activity: input.activity,
			presentationEpoch: input.presentationEpoch,
			readingVisible: input.readingVisible,
			inFlowTail: { epoch: input.inFlowTail.epoch, height: input.inFlowTail.height },
		}
		if (
			!previous ||
			previous.width !== input.width ||
			previous.activity !== input.activity ||
			previous.presentationEpoch !== input.presentationEpoch ||
			previous.readingVisible !== input.readingVisible
		)
			s.geometry.epoch++
		if (!this.fit(s)) return { status: 'capacity', published: false }
		this.commit(s)
		return { status: 'accepted', published: true }
	}
	setReading(input: TranscriptReadingInput): TranscriptGeometryUpdate {
		if (
			!this.layout?.enabled ||
			input.instance !== this.instance ||
			input.epoch !== this.epoch ||
			input.windowSerial !== this.window?.serial ||
			!Number.isFinite(input.logicalViewportTop) ||
			input.logicalViewportTop < 0 ||
			!Number.isFinite(input.physicalScrollTop) ||
			Math.abs(input.physicalScrollTop) > 1e12 ||
			input.viewportHeight < 0 ||
			input.viewportHeight > 1e6
		)
			return { status: 'stale', published: false }
		if (
			!Number.isFinite(input.viewportHeight) ||
			input.logicalViewportTop > 1e12 ||
			!['older', 'newer', 'stationary'].includes(input.direction) ||
			typeof input.following !== 'boolean'
		)
			return { status: 'invalid', published: false }
		if (input.anchor) {
			const row = this.window?.items.find(item => item.kind === 'row' && item.key === input.anchor?.key)
			if (
				!row ||
				input.anchor.key.length > 256 ||
				!Number.isFinite(input.anchor.inRowOffset) ||
				!Number.isFinite(input.anchor.viewportOffset) ||
				input.anchor.inRowOffset < 0 ||
				input.anchor.inRowOffset > 1e12 ||
				Math.abs(input.anchor.viewportOffset) > 1e12 ||
				(this.measurements.has(input.anchor.key) && input.anchor.inRowOffset > row.height)
			)
				return { status: 'invalid', published: false }
		}
		const restoration: TranscriptRestorationIntent = input.following
			? { kind: 'follow-tail' }
			: input.anchor
				? {
						kind: 'canonical',
						key: input.anchor.key,
						inRowOffset: input.anchor.inRowOffset,
						viewportOffset: input.anchor.viewportOffset,
						uncertainty: 'exact-row',
					}
				: { kind: 'none' }
		const s = this.draft()
		// Copy declared bounded scalars only: callers cannot smuggle auxiliary payload into the reservation.
		s.geometry.reading = {
			instance: input.instance,
			epoch: input.epoch,
			windowSerial: input.windowSerial,
			logicalViewportTop: input.logicalViewportTop,
			physicalScrollTop: input.physicalScrollTop,
			viewportHeight: input.viewportHeight,
			direction: input.direction,
			following: input.following,
			anchor: input.anchor
				? { key: input.anchor.key, inRowOffset: input.anchor.inRowOffset, viewportOffset: input.anchor.viewportOffset }
				: null,
			restoration,
		}
		if (bytes(s.geometry.reading) > READING_RESERVATION || !this.fit(s)) return { status: 'capacity', published: false }
		this.commit(s)
		return { status: 'accepted', published: true }
	}
	measureWindow(input: TranscriptWindowMeasurement): TranscriptGeometryUpdate {
		if (
			!this.window ||
			input.instance !== this.instance ||
			input.epoch !== this.epoch ||
			input.windowSerial !== this.window.serial ||
			input.layoutEpoch !== this.geometryEpoch
		)
			return { status: 'stale', published: false }
		if (!Array.isArray(input.rows) || input.rows.length > 160) return { status: 'invalid', published: false }
		const issued = this.window.items.filter(item => item.kind === 'row')
		const seen = new Set<TranscriptCanonicalKey>()
		let end = 0
		let lastIndex = -1
		for (const row of input.rows) {
			const index = issued.findIndex(item => item.key === row.key)
			if (
				index <= lastIndex ||
				index < 0 ||
				seen.has(row.key) ||
				issued[index]?.measurementKey !== row.measurementKey ||
				!Number.isFinite(row.top) ||
				!Number.isFinite(row.height) ||
				row.top < end ||
				row.height < 0 ||
				row.top > 1e12 ||
				row.height > 1e12 ||
				row.top + row.height > 1e12
			)
				return { status: 'invalid', published: false }
			seen.add(row.key)
			lastIndex = index
			end = row.top + row.height
		}
		if (
			input.rows.every(row => {
				const old = this.measurements.get(row.key)
				return !!old && old.measurementKey === row.measurementKey && old.height === row.height
			})
		)
			return { status: 'unchanged', published: false }
		const s = this.draft()
		for (const row of input.rows)
			s.geometry.measurements.set(row.key, {
				measurementKey: row.measurementKey,
				height: row.height,
				layoutEpoch: input.layoutEpoch,
			})
		if (!this.fit(s)) return { status: 'capacity', published: false }
		this.commit(s)
		return { status: 'accepted', published: true }
	}
	beginHydration(demand: TranscriptHydrationDemand): TranscriptAssociation | null {
		if (
			!this.layout?.enabled ||
			demand.instance !== this.instance ||
			demand.epoch !== this.epoch ||
			!this.layout.readingVisible ||
			!this.window?.demand ||
			!equal(this.window.demand, demand)
		)
			return null
		const span = this.state.spans.find(
			candidate => candidate.coverage !== 'unverified' && candidate.end > candidate.start,
		)
		return span ? this.associate(span.id, span.start, span.end) : null
	}
	compact(): boolean {
		const s = this.draft()
		if (!this.fit(s)) return false
		if (equal(this.metadata(s), this.metadata(this.state)) && s.cache.length === this.state.cache.length) return false
		this.commit(s)
		return true
	}
	inspectRange(): readonly TranscriptSpan[] {
		return this.snapshot().spans
	}
	inspectCheckpoints(): readonly TranscriptCheckpoint[] {
		return this.snapshot().checkpoints
	}
	measure(spanId: number, height: number): boolean {
		if (this.layout?.enabled) return false
		if (!Number.isFinite(height) || height < 0 || height > Number.MAX_SAFE_INTEGER) return false
		const index = this.state.spans.findIndex(s => s.id === spanId)
		const span = this.state.spans[index]
		if (!span || span.height === height) return false
		const s = this.draft()
		s.spans[index] = { ...span, height }
		if (!this.fit(s)) return false
		this.commit(s)
		return true
	}
	setViewport(viewport: TranscriptViewport): boolean {
		// Compatibility metadata only. M2 owns geometry/window selection; pixel motion is deliberately quiet.
		if (
			!Number.isFinite(viewport.height) ||
			!Number.isFinite(viewport.width) ||
			typeof viewport.activity !== 'boolean' ||
			typeof viewport.readingVisible !== 'boolean'
		)
			return false
		const next = {
			scrollTop: 0,
			height: Math.max(0, Math.min(1e6, viewport.height)),
			width: Math.max(0, Math.min(1e6, viewport.width)),
			activity: viewport.activity,
			readingVisible: viewport.readingVisible,
			...(viewport.anchor ? { anchor: { id: viewport.anchor.id, offset: viewport.anchor.offset } } : {}),
		}
		if (next.anchor && (!Number.isFinite(next.anchor.offset) || next.anchor.id.length > 64)) return false
		if (equal(this.viewport, next)) return false
		const s = this.draft()
		s.viewport = freeze(next)
		if (!this.fit(s)) return false
		this.commit(s)
		return true
	}
	setStatus(phase: TranscriptSnapshot['phase'], issue: string | null = null): boolean {
		if (
			!['idle', 'loading', 'progress', 'error'].includes(phase) ||
			(issue !== null && (typeof issue !== 'string' || issue.length > 1024))
		)
			return false
		if (this.phase === phase && this.issue === issue) return false
		const s = this.draft()
		s.phase = phase
		s.issue = issue
		if (!this.fit(s)) return false
		this.commit(s)
		return true
	}

	clear(): void {
		this.epoch++
		this.state = initial()

		this.generation++
		this.published = null
	}
	debug(activeWork = 0): TranscriptDebug {
		return {
			chunks: this.state.cache.length,
			residentChunks: this.state.cache.length,
			residentBytes: this.state.cache.reduce((sum, c) => sum + c.bytes, 2) + Math.max(0, this.state.cache.length - 1),
			currentLiveBytes: bytes(this.state.live),
			currentNativeMessageBytes: nativeMessageBytes(this.state.live),
			metadataSpans: this.state.spans.length,
			checkpoints: this.state.checkpoints.length,
			metadataBytes: this.metadataBytes(this.state),
			retainedPayloadOwners: this.state.cache.length + (this.state.live.length ? 1 : 0),
			geometryMetadataBytes:
				bytes({ ...this.geometryDescriptor(this.state.geometry), reading: this.state.geometry.reading }) +
				(this.layout?.enabled || this.state.geometry.reading
					? READING_RESERVATION - bytes(this.state.geometry.reading)
					: 0),
			readingMetadataBytes: this.state.geometry.reading ? bytes(this.state.geometry.reading) : 0,
			readingReservedBytes: this.layout?.enabled || this.state.geometry.reading ? READING_RESERVATION : 0,
			metadataActualBytes: this.actualMetadataBytes(this.state),
			settlementReservedBytes: this.metadataBytes(this.state) - this.chargedMetadataBytes(this.state),
			rangeSamples: 0,
			classificationSummaries: 0,
			activeWork: Math.max(
				activeWork,
				this.state.active || (this.state.reconciliation && this.state.reconciliation.last?.output.phase !== 'complete')
					? 1
					: 0,
			),
		}
	}
}
export {
	MAX_BYTES as TRANSCRIPT_MAX_RESIDENT_BYTES,
	MAX_CHUNKS as TRANSCRIPT_MAX_CHUNKS,
	MAX_SPANS as TRANSCRIPT_MAX_SPANS,
	MAX_CHECKPOINTS as TRANSCRIPT_MAX_CHECKPOINTS,
}
