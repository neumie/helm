import { createHash, createHmac, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats, Dir } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SessionSelector } from './catalog-selector.js'
import type { RemoteCatalogPage, RemoteCatalogRow } from './protocol.js'

export const CATALOG_PAGE_SIZE = 50
const MAX_ROOTS = 8
const MAX_VIEWS = 8
const MAX_VIEWS_PER_PRINCIPAL = 2
const MAX_CACHE = 128
const MAX_CURSOR_BYTES = 512
const READ_BUFFER_BYTES = 64 * 1024
const MAX_LABEL = 160
const VIEW_IDLE_MS = 60_000
const ERROR_RETRY_MS = 1000

type Identity = { dev: number; ino: number }
type FileVersion = Identity & { size: number; mtimeMs: number; mtimeNs: bigint; ctimeNs: bigint }
type Selector = { kind: 'start' } | { kind: 'after' | 'before'; anchor: SortKey }
type SortKey = { modifiedAt: number; id: string }
type PageState = RemoteCatalogPage['state']

interface CachedRecord {
	row: RemoteCatalogRow
	sessionId: string
	key: SortKey
	version: FileVersion
	root: Locator
	project: Locator
	filePath: string
}
interface Locator {
	path: string
	identity: Identity
	mtimeMs: number
	ctimeMs: number
}
interface CatalogRequest {
	viewId: string
	principalId: string
	sequence: number
	overlayStamp: string
}
type Omissions = RemoteCatalogPage['omissions']
interface Job {
	viewKey: string
	principalId: string
	viewId: string
	sequence: number
	hostEpoch: string
	query: string
	overlay: ReadonlySet<string>
	overlayStamp: string
	selector: Selector
	expectedWitness?: string
	handles: Set<FileHandle>
	directories: Set<Dir>
	iterator?: Generator<Operation, void, unknown>
	step?: IteratorResult<Operation, void>
	input?: unknown
	current?: FileScan
	selection: CachedRecord[]
	omissions: Omissions
	hasBefore: boolean
	hasAfter: boolean
	witnessSum: bigint
	witnessCount: bigint
	state: 'scanning' | 'unavailable' | 'done'
	error?: RemoteCatalogPage['reason']
	ready?: Ready
}
interface Operation {
	kind: 'metadata' | 'entry' | 'file' | 'read'
	bytes: number
	run: () => Promise<unknown>
}
function* operation<T>(
	run: () => Promise<T>,
	kind: Operation['kind'] = 'metadata',
	bytes = 0,
): Generator<Operation, T, unknown> {
	return (yield { run, kind, bytes }) as T
}
interface FileScan {
	path: string
	name: string
	root: Locator
	project: Locator
	handle: FileHandle
	version: FileVersion
	offset: number
	parser: SessionSelector
}
interface Ready {
	omissions: Omissions
	rows: RemoteCatalogRow[]
	witness: string
	pageCursor: string
	previousCursor: string | null
	nextCursor: string | null
	overlayStamp: string
}
interface View {
	job?: Job
	desired?: RequestDescriptor
	ready?: Ready
	request?: RequestDescriptor
	/** A completed cursor witness changed; only a fresh start may replace it. */
	invalidated?: boolean
	error?: RemoteCatalogPage['reason']
	lastUsed: number
	sequence: number
	expired?: boolean
	retryAt?: number
}
interface RequestDescriptor {
	hostEpoch: string
	query: string
	overlay: ReadonlySet<string>
	overlayStamp: string
	selector: Selector
	expectedWitness?: string
	request: CatalogRequest
}
export interface PiSessionCatalogOptions {
	pageSize?: number
	cacheSize?: number
	maxViews?: number
	maxViewsPerPrincipal?: number
	entryAttemptsPerSlice?: number
	fileAttemptsPerSlice?: number
	metadataOpsPerSlice?: number
	bytesPerSlice?: number
	onBarrier?: (point: string) => void | Promise<void>
}

/**
 * Bounded, read-only, page-oriented observation of explicitly enabled ordinary
 * Pi session roots. Each requested page rescans the finite inventory and retains
 * only a fixed top-page selection plus a finite metadata cache; it never builds an
 * inventory-wide index, transcript projection, or command target.
 *
 * Directory/path checks are fail-closed for substitutions observed between public
 * Node pathname operations. They are not an atomic snapshot or hostile same-user
 * ABA isolation: a same-user attacker can swap and restore names between checks.
 */
export class PiSessionCatalog {
	private readonly secret = randomBytes(32)
	private readonly cache = new Map<string, CachedRecord>()
	private readonly views = new Map<string, View>()
	private readonly queue: Job[] = []
	private readonly buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES)
	private active: Promise<void> | undefined
	private scheduled = false
	private stopped = false
	private timer: ReturnType<typeof setTimeout> | undefined
	private readonly pageSize: number
	private readonly cacheSize: number
	private readonly maxViews: number
	private readonly maxViewsPerPrincipal: number
	private readonly entryAttempts: number
	private readonly fileAttempts: number
	private readonly metadataOps: number
	private readonly bytesPerSlice: number
	private readonly rootStamp: string
	private maxRetainedRecords = 0
	private maxOpenHandles = 0
	private readonly admittedRoots = new Map<string, Locator>()
	private openHandles = 0
	private maxParserCharacters = 0
	private maxParserDepth = 0
	private maxDecodedCharacters = 0
	private maxSliceOperations = 0
	private maxSliceBytes = 0
	private totalOperations = 0
	private totalBytes = 0
	private totalEntries = 0
	private totalFileAttempts = 0
	private maxRequests = 0
	private readonly options: PiSessionCatalogOptions

	constructor(
		private readonly roots: string[],
		options: PiSessionCatalogOptions = {},
	) {
		this.options = options
		this.roots = [...roots]
		if (roots.length > MAX_ROOTS || roots.some(root => Buffer.byteLength(root) > 4096))
			throw new Error('Too many or oversized Pi session roots')
		this.pageSize = bounded(options.pageSize, CATALOG_PAGE_SIZE, 1, CATALOG_PAGE_SIZE)
		this.cacheSize = bounded(options.cacheSize, MAX_CACHE, 1, MAX_CACHE)
		this.maxViews = bounded(options.maxViews, MAX_VIEWS, 1, MAX_VIEWS)
		this.maxViewsPerPrincipal = bounded(
			options.maxViewsPerPrincipal,
			MAX_VIEWS_PER_PRINCIPAL,
			1,
			MAX_VIEWS_PER_PRINCIPAL,
		)
		this.entryAttempts = bounded(options.entryAttemptsPerSlice, 512, 1, 512)
		this.fileAttempts = bounded(options.fileAttemptsPerSlice, 128, 1, 128)
		this.metadataOps = bounded(options.metadataOpsPerSlice, 128, 1, 128)
		this.bytesPerSlice = bounded(options.bytesPerSlice, 1024 * 1024, 1, 1024 * 1024)
		this.rootStamp = createHash('sha256')
			.update(
				roots
					.map(value => resolve(value))
					.sort()
					.join('\0'),
			)
			.digest('hex')
			.slice(0, 24)
	}

	/** Continuations are driven by requests; this only schedules future admitted work. */
	start(): void {
		if (this.stopped) this.stopped = false
		if (this.timer) return
		const tick = () => {
			if (this.stopped) return
			this.expireViews()
			for (const view of this.views.values())
				if (!view.expired && (view.ready || view.error) && !view.job && view.request) this.startJob(view, view.request)
			this.timer = setTimeout(tick, 5000)
			this.timer.unref()
		}
		this.timer = setTimeout(tick, 5000)
		this.timer.unref()
	}

	/** Kept for runtime control compatibility; it admits slices and never waits for a full scan. */
	async refresh(): Promise<void> {
		if (this.stopped) return
		this.expireViews()
		for (const view of this.views.values())
			if (!view.expired && (view.ready || view.error) && !view.job && view.request) this.startJob(view, view.request)
		this.schedule()
	}

	page(
		hostEpoch: string,
		cursor?: string,
		query = '',
		liveSessionIds: ReadonlySet<string> = new Set(),
		request: Partial<CatalogRequest> = {},
	): RemoteCatalogPage {
		const normalized = normalizeQuery(query)
		const descriptor = this.descriptor(hostEpoch, cursor, normalized, liveSessionIds, request)
		if (!descriptor) return this.result(hostEpoch, 'invalidated', [], null, 'invalid_cursor')
		if (this.stopped) return this.result(hostEpoch, 'unavailable', [], null, 'stopped')
		this.expireViews()
		const key = `${descriptor.request.principalId}:${descriptor.request.viewId}`
		let view = this.views.get(key)
		if (!view) {
			if (
				this.views.size >= this.maxViews ||
				this.principalViews(descriptor.request.principalId) >= this.maxViewsPerPrincipal
			)
				return this.result(hostEpoch, 'busy', [], null, 'view_capacity')
			view = { lastUsed: Date.now(), sequence: descriptor.request.sequence }
			this.views.set(key, view)
		}
		if (view.expired) return this.result(hostEpoch, 'busy', [], null, 'view_capacity')
		const admitted = view.desired ?? view.request
		if (
			descriptor.request.sequence < view.sequence ||
			(descriptor.request.sequence === view.sequence && admitted && !sameDescriptor(admitted, descriptor))
		)
			return this.result(hostEpoch, 'superseded', [], null, 'superseding')
		view.sequence = descriptor.request.sequence
		view.lastUsed = Date.now()
		const evidence =
			view.ready && view.request && sameDescriptor(view.request, descriptor) && sameReady(view.ready, descriptor)
				? view.ready
				: undefined
		if (view.error && admitted && sameDescriptor(admitted, descriptor)) {
			if (!view.job && Date.now() >= (view.retryAt ?? 0)) this.startJob(view, descriptor)
			return this.result(hostEpoch, 'unavailable', evidence?.rows ?? [], evidence ?? null, view.error)
		}
		if (view.invalidated && cursor) return this.result(hostEpoch, 'invalidated', [], null, 'filesystem_error')
		if (!cursor) view.invalidated = false
		const same = view.job && sameRequest(view.job, descriptor)
		if (same) {
			// A newer return to this running query supersedes any intervening
			// desired query, without restarting the already useful scan.
			view.desired = undefined
			view.request = descriptor
		}
		const readySame =
			!!view.ready && !!view.request && sameDescriptor(view.request, descriptor) && sameReady(view.ready, descriptor)
		if (!same && !readySame) {
			if (view.job) {
				view.desired = descriptor
				this.track() // one bounded replacement descriptor while current IO drains.
				return this.result(hostEpoch, 'pending', evidence?.rows ?? [], evidence ?? null, 'superseding')
			}
			this.startJob(view, descriptor)
			return this.result(hostEpoch, 'pending', evidence?.rows ?? [], evidence ?? null, 'scanning')
		}
		if (view.job) return this.result(hostEpoch, 'pending', evidence?.rows ?? [], evidence ?? null, 'scanning')
		if (!view.ready) return this.result(hostEpoch, 'pending', [], null, 'scanning')
		view.request = descriptor
		return this.result(hostEpoch, 'ready', view.ready.rows, view.ready)
	}

	/** Read-only diagnostics for test resource attestation; never exposed on browser routes. */
	diagnostics() {
		return {
			views: this.views.size,
			cache: this.cache.size,
			queued: this.queue.length,
			active: !!this.active,
			maxRetainedRecords: this.maxRetainedRecords,
			maxOpenHandles: this.maxOpenHandles,
			bufferBytes: this.buffer.byteLength,
			openHandles: this.openHandles,
			maxParserCharacters: this.maxParserCharacters,
			maxParserDepth: this.maxParserDepth,
			maxDecodedCharacters: this.maxDecodedCharacters,
			maxSliceOperations: this.maxSliceOperations,
			maxSliceBytes: this.maxSliceBytes,
			totalOperations: this.totalOperations,
			totalBytes: this.totalBytes,
			totalEntries: this.totalEntries,
			totalFileAttempts: this.totalFileAttempts,
			maxRequests: this.maxRequests,
		}
	}

	async stop(): Promise<void> {
		this.stopped = true
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		await this.active
		for (const view of this.views.values()) await this.closeJob(view.job)
		this.queue.length = 0
		this.views.clear()
		this.cache.clear()
		this.admittedRoots.clear()
	}

	private descriptor(
		hostEpoch: string,
		cursor: string | undefined,
		query: string,
		overlay: ReadonlySet<string>,
		request: Partial<CatalogRequest>,
	): RequestDescriptor | undefined {
		if (overlay.size > 64) return undefined
		const overlayStamp = request.overlayStamp ?? overlayWitness(overlay)
		const viewId = request.viewId && /^[A-Za-z0-9_-]{1,64}$/.test(request.viewId) ? request.viewId : 'default'
		const principalId = request.principalId && request.principalId.length <= 64 ? request.principalId : 'development'
		const sequence =
			Number.isSafeInteger(request.sequence) && (request.sequence ?? 0) >= 0 ? (request.sequence ?? 0) : 0
		let selector: Selector = { kind: 'start' }
		let expectedWitness: string | undefined
		if (cursor) {
			const parsed = this.parseCursor(cursor, hostEpoch, `${principalId}\0${query}`, overlayStamp)
			if (!parsed) return undefined
			selector = parsed.selector
			expectedWitness = parsed.witness
		}
		return {
			hostEpoch,
			query,
			overlay: new Set(overlay),
			overlayStamp,
			selector,
			expectedWitness,
			request: { viewId, principalId, sequence, overlayStamp },
		}
	}

	private startJob(view: View, descriptor: RequestDescriptor): void {
		if (view.request && !sameDescriptor(view.request, descriptor)) view.ready = undefined
		view.error = undefined
		view.request = descriptor
		const job: Job = {
			viewKey: `${descriptor.request.principalId}:${descriptor.request.viewId}`,
			principalId: descriptor.request.principalId,
			viewId: descriptor.request.viewId,
			sequence: descriptor.request.sequence,
			hostEpoch: descriptor.hostEpoch,
			query: descriptor.query,
			overlay: descriptor.overlay,
			overlayStamp: descriptor.overlayStamp,
			selector: descriptor.selector,
			expectedWitness: descriptor.expectedWitness,
			handles: new Set(),
			directories: new Set(),
			selection: [],
			omissions: { malformed: 0, unsupported: 0 },
			hasBefore: false,
			hasAfter: false,
			witnessSum: 0n,
			witnessCount: 0n,
			state: 'scanning',
		}
		job.iterator = this.scan(job)
		view.job = job
		this.queue.push(job)
		this.track()
		this.schedule()
	}

	private schedule(): void {
		if (this.scheduled || this.active || this.stopped || this.queue.length === 0) return
		this.scheduled = true
		setImmediate(() => {
			this.scheduled = false
			if (this.stopped || this.active || this.queue.length === 0) return
			const job = this.queue.shift()
			if (!job) return
			this.active = this.runSlice(job)
				.catch((error: unknown) => {
					job.state = 'unavailable'
					job.error =
						error instanceof Error && ['malformed_metadata', 'unsupported_metadata'].includes(error.message)
							? (error.message as 'malformed_metadata' | 'unsupported_metadata')
							: 'filesystem_error'
					this.cache.clear()
				})
				.then(() => this.afterSlice(job))
				.finally(() => {
					this.active = undefined
					this.schedule()
				})
		})
	}

	private async runSlice(job: Job): Promise<void> {
		let entries = 0
		let files = 0
		let operations = 0
		let bytes = 0
		while (
			!this.stopped &&
			!this.views.get(job.viewKey)?.expired &&
			!this.views.get(job.viewKey)?.desired &&
			job.state === 'scanning'
		) {
			job.step ??= job.iterator?.next(job.input)
			job.input = undefined
			if (!job.step || job.step.done) return
			const step = job.step.value
			if (
				operations >= this.metadataOps ||
				(step.kind === 'entry' && entries >= this.entryAttempts) ||
				(step.kind === 'file' && files >= this.fileAttempts) ||
				bytes + step.bytes > this.bytesPerSlice
			)
				break
			// Every individual filesystem call (including closes/publication) is
			// charged BEFORE it starts. No helper can hide additional awaited IO.
			operations++
			this.totalOperations++
			if (step.kind === 'entry') {
				entries++
				this.totalEntries++
			}
			if (step.kind === 'file') {
				files++
				this.totalFileAttempts++
			}
			bytes += step.bytes
			this.maxSliceOperations = Math.max(this.maxSliceOperations, operations)
			this.maxSliceBytes = Math.max(this.maxSliceBytes, bytes)
			job.input = await step.run()
			job.step = undefined
			this.track()
		}
	}

	private *scan(job: Job): Generator<Operation, void, unknown> {
		for (const path of this.roots) {
			const root = yield* this.openDirectory(job, path)
			for (;;) {
				const entry = yield* operation(() => root.dir.read(), 'entry')
				if (!entry) break
				if (!entry.isDirectory() || entry.isSymbolicLink()) continue
				yield* this.match(root.locator)
				const project = yield* this.openDirectory(job, resolve(root.locator.path, entry.name), root.locator)
				for (;;) {
					const fileEntry = yield* operation(() => project.dir.read(), 'entry')
					if (!fileEntry) break
					if (!fileEntry.isFile() || fileEntry.isSymbolicLink() || !fileEntry.name.endsWith('.jsonl')) continue
					const filePath = resolve(project.locator.path, fileEntry.name)
					yield* this.match(root.locator)
					yield* this.match(project.locator)
					const handle = yield* this.openHandle(
						job,
						filePath,
						constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
						'file',
					)
					yield* operation(async () => {
						await this.options.onBarrier?.('after_file_open')
					})
					const stat = yield* operation(() => handle.stat({ bigint: true }))
					if (!stat.isFile() || stat.nlink !== 1n) {
						yield* this.closeOwned(job, handle)
						continue
					}
					yield* this.match(root.locator)
					yield* this.match(project.locator)
					const version: FileVersion = {
						dev: Number(stat.dev),
						ino: Number(stat.ino),
						size: Number(stat.size),
						mtimeMs: Number(stat.mtimeNs) / 1_000_000,
						mtimeNs: stat.mtimeNs,
						ctimeNs: stat.ctimeNs,
					}
					if (![version.dev, version.ino, version.size].every(Number.isSafeInteger))
						throw new Error('unrepresentable_file')
					const file: FileScan = {
						path: filePath,
						name: fileEntry.name,
						root: root.locator,
						project: project.locator,
						handle,
						version,
						offset: 0,
						parser: new SessionSelector(),
					}
					job.current = file
					this.track()
					const cached = this.cache.get(versionKey(version))
					if (
						cached &&
						cached.filePath === filePath &&
						sameIdentity(cached.root.identity, root.locator.identity) &&
						sameIdentity(cached.project.identity, project.locator.identity)
					) {
						const current = { ...cached, root: root.locator, project: project.locator }
						this.putCache(current)
						this.accept(job, current)
					} else {
						let omitted: keyof Omissions | undefined
						while (file.offset < version.size) {
							yield* operation(async () => {
								await this.options.onBarrier?.('before_file_read')
							})
							yield* this.match(root.locator)
							yield* this.match(project.locator)
							const length = Math.min(this.buffer.length, this.bytesPerSlice, version.size - file.offset)
							const { bytesRead } = yield* operation(
								async () => {
									const result = await handle.read(this.buffer, 0, length, file.offset)
									this.totalBytes += result.bytesRead
									return result
								},
								'read',
								length,
							)
							if (!bytesRead) throw new Error('observation_changed')
							file.offset += bytesRead
							// Parse before another job may overwrite the one shared buffer.
							try {
								file.parser.push(this.buffer.subarray(0, bytesRead), job.overlay)
							} catch (error) {
								omitted = omission(error)
								if (!omitted) throw error
							}
							this.track()
							yield* operation(async () => {
								await this.options.onBarrier?.('after_file_read')
							})
							if (omitted || (file.parser.sessionId && job.overlay.has(file.parser.sessionId))) break
						}
						if (!(file.parser.sessionId && job.overlay.has(file.parser.sessionId))) {
							if (!omitted) {
								try {
									file.parser.finish()
								} catch (error) {
									omitted = omission(error)
									if (!omitted) throw error
								}
							}
							const final = yield* operation(() => handle.stat({ bigint: true }))
							if (!sameVersion(version, final)) throw new Error('observation_changed')
							yield* this.match(root.locator)
							yield* this.match(project.locator)
							const pathStat = yield* operation(() => lstat(filePath, { bigint: true }))
							if (!sameVersion(version, pathStat) || pathStat.isSymbolicLink()) throw new Error('observation_changed')
							if (omitted) {
								job.omissions[omitted] = Math.min(1_000_000, job.omissions[omitted] + 1)
								job.witnessSum =
									(job.witnessSum +
										BigInt(
											`0x${createHash('sha256')
												.update(`${omitted}:${versionKey(version)}`)
												.digest('hex')}`,
										)) &
									((1n << 256n) - 1n)
								job.witnessCount++
							} else {
								const metadata = file.parser.metadata()
								if (!metadata) throw new Error('unsupported_metadata')
								const record: CachedRecord = {
									row: {
										id: catalogId(version),
										label: metadata.name ?? 'Pi conversation',
										createdAt: metadata.createdAt,
										modifiedAt: Math.floor(version.mtimeMs),
										messageCount: null,
										hasParent: metadata.hasParent,
										liveness: 'unknown',
										readOnly: true,
									},
									sessionId: metadata.sessionId,
									key: { modifiedAt: Math.floor(version.mtimeMs), id: catalogId(version) },
									version,
									root: root.locator,
									project: project.locator,
									filePath,
								}
								this.putCache(record)
								this.accept(job, record)
							}
						}
					}
					yield* this.closeOwned(job, handle)
					job.current = undefined
				}
				yield* this.match(project.locator)
				yield* this.match(root.locator)
				yield* this.closeOwned(job, project.dir)
				yield* this.closeOwned(job, project.handle)
			}
			yield* this.match(root.locator)
			yield* this.closeOwned(job, root.dir)
			yield* this.closeOwned(job, root.handle)
		}
		for (const record of job.selection) {
			yield* operation(async () => {
				await this.options.onBarrier?.('before_publication')
			})
			const rootHandle = yield* this.pinDirectory(job, record.root)
			const projectHandle = yield* this.pinDirectory(job, record.project)
			const handle = yield* this.openHandle(
				job,
				record.filePath,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			)
			const stat = yield* operation(() => handle.stat({ bigint: true }))
			if (!stat.isFile() || stat.nlink !== 1n || !sameVersion(record.version, stat))
				throw new Error('publication_substitution')
			yield* this.match(record.root)
			yield* this.match(record.project)
			const pathStat = yield* operation(() => lstat(record.filePath, { bigint: true }))
			if (!sameVersion(record.version, pathStat) || pathStat.isSymbolicLink())
				throw new Error('publication_substitution')
			yield* this.closeOwned(job, handle)
			yield* this.closeOwned(job, projectHandle)
			yield* this.closeOwned(job, rootHandle)
		}
		this.finishJob(job)
	}

	private *openHandle(
		job: Job,
		path: string,
		flags: number,
		kind: Operation['kind'] = 'metadata',
	): Generator<Operation, FileHandle, unknown> {
		return yield* operation(async () => {
			const handle = await open(path, flags)
			job.handles.add(handle)
			this.openHandles++
			this.track()
			return handle
		}, kind)
	}
	private *openDirectory(
		job: Job,
		path: string,
		parent?: Locator,
	): Generator<Operation, { locator: Locator; handle: FileHandle; dir: Dir }, unknown> {
		yield* operation(async () => {
			await this.options.onBarrier?.(parent ? 'before_project_open' : 'before_root_open')
		})
		if (parent) yield* this.match(parent)
		const resolved = resolve(path)
		const stat = yield* operation(() => lstat(resolved))
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('directory_substitution')
		const canonical = yield* operation(() => realpath(resolved))
		if (parent && !within(parent.path, canonical)) throw new Error('directory_substitution')
		const locator = {
			path: canonical,
			identity: { dev: stat.dev, ino: stat.ino },
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
		}
		if (!parent) {
			const admitted = this.admittedRoots.get(path)
			if (admitted && (admitted.path !== canonical || !sameIdentity(admitted.identity, locator.identity)))
				throw new Error('root_substitution')
			this.admittedRoots.set(path, locator)
		}
		const handle = yield* this.openHandle(
			job,
			canonical,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		)
		yield* operation(async () => {
			await this.options.onBarrier?.(parent ? 'after_project_handle' : 'after_root_handle')
		})
		const pinned = yield* operation(() => handle.stat())
		if (!sameIdentity(locator.identity, pinned)) throw new Error('directory_substitution')
		yield* this.match(locator)
		if (parent) yield* this.match(parent)
		const dir = yield* operation(async () => {
			const value = await opendir(canonical, { bufferSize: 1 })
			job.directories.add(value)
			this.openHandles++
			this.track()
			return value
		})
		yield* operation(async () => {
			await this.options.onBarrier?.(parent ? 'after_project_iterator' : 'after_root_iterator')
		})
		yield* this.match(locator)
		if (parent) yield* this.match(parent)
		return { locator, handle, dir }
	}
	private *pinDirectory(job: Job, locator: Locator): Generator<Operation, FileHandle, unknown> {
		yield* this.match(locator)
		const handle = yield* this.openHandle(
			job,
			locator.path,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		)
		const stat = yield* operation(() => handle.stat())
		if (!stat.isDirectory() || !sameIdentity(locator.identity, stat)) throw new Error('publication_substitution')
		yield* this.match(locator)
		return handle
	}
	private *match(locator: Locator): Generator<Operation, void, unknown> {
		const stat = yield* operation(() => lstat(locator.path))
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			!sameIdentity(locator.identity, stat) ||
			stat.mtimeMs !== locator.mtimeMs ||
			stat.ctimeMs !== locator.ctimeMs
		)
			throw new Error('directory_substitution')
	}
	private *closeOwned(job: Job, value: FileHandle | Dir): Generator<Operation, void, unknown> {
		yield* operation(() => this.release(job, value))
	}
	private async release(job: Job, value: FileHandle | Dir): Promise<void> {
		const owned = job.handles.has(value as FileHandle) || job.directories.has(value as Dir)
		if (!owned) return
		await value.close()
		job.handles.delete(value as FileHandle)
		job.directories.delete(value as Dir)
		this.openHandles--
		this.track()
	}

	private accept(job: Job, record: CachedRecord): void {
		if (job.overlay.has(record.sessionId)) return
		job.witnessSum = (job.witnessSum + leaf(record)) & ((1n << 256n) - 1n)
		job.witnessCount++
		if (!record.row.label.toLocaleLowerCase().includes(job.query)) return
		const relative = compareKey(record.key, job.selector.kind === 'start' ? undefined : job.selector.anchor)
		if (job.selector.kind === 'after' && relative <= 0) {
			job.hasBefore = true
			return
		}
		if (job.selector.kind === 'before' && relative >= 0) {
			job.hasAfter = true
			return
		}
		insertSelected(job.selection, record, job.selector.kind === 'before' ? 'before' : 'after', this.pageSize + 1)
		this.track()
	}

	private finishJob(job: Job): void {
		const witness = createHash('sha256')
			.update(`${this.rootStamp}:${job.witnessCount}:${job.witnessSum.toString(16)}:${job.overlayStamp}`)
			.digest('base64url')
		if (job.expectedWitness && job.expectedWitness !== witness) {
			job.state = 'done'
			return
		}
		const ordered = job.selection.sort((a, b) => compareKey(a.key, b.key))
		const page = job.selector.kind === 'before' ? ordered.slice(-this.pageSize) : ordered.slice(0, this.pageSize)
		const rows = page.map(record => record.row)
		const first = page[0]
		const last = page.at(-1)
		const extra = job.selection.length > this.pageSize
		const previous =
			first && (job.selector.kind === 'before' ? extra : job.hasBefore)
				? { kind: 'before' as const, anchor: first.key }
				: undefined
		const next =
			last && (job.selector.kind === 'before' ? job.hasAfter : extra)
				? { kind: 'after' as const, anchor: last.key }
				: undefined
		job.ready = {
			rows,
			omissions: job.omissions,
			witness,
			pageCursor: this.makeCursor(
				job.hostEpoch,
				`${job.principalId}\0${job.query}`,
				job.overlayStamp,
				witness,
				job.selector,
			),
			previousCursor: previous
				? this.makeCursor(job.hostEpoch, `${job.principalId}\0${job.query}`, job.overlayStamp, witness, previous)
				: null,
			nextCursor: next
				? this.makeCursor(job.hostEpoch, `${job.principalId}\0${job.query}`, job.overlayStamp, witness, next)
				: null,
			overlayStamp: job.overlayStamp,
		}
		job.state = 'done'
	}

	private async afterSlice(job: Job): Promise<void> {
		const view = this.views.get(job.viewKey)
		if (!view || view.job !== job) return
		if (this.stopped) {
			await this.closeJob(job)
			return
		}
		if (!view.expired && !view.desired && job.state === 'scanning') {
			this.queue.push(job)
			return
		}
		await this.closeJob(job)
		view.job = undefined
		if (view.expired) {
			this.views.delete(job.viewKey)
			return
		}
		if (view.desired) {
			const desired = view.desired
			view.desired = undefined
			this.startJob(view, desired)
			return
		}
		if (job.state === 'done' && job.ready) {
			view.ready = job.ready
			view.error = undefined
		} else if (job.state === 'done' && job.expectedWitness) {
			view.ready = undefined
			view.invalidated = true
		} else if (job.state === 'unavailable') {
			view.error = job.error ?? 'filesystem_error'
			view.retryAt = Date.now() + ERROR_RETRY_MS
		}
	}

	private result(
		hostEpoch: string,
		state: PageState,
		rows: RemoteCatalogRow[],
		ready: Ready | null,
		reason?: RemoteCatalogPage['reason'],
	): RemoteCatalogPage {
		return {
			protocol: 1,
			hostEpoch,
			state,
			rows,
			omissions: ready?.omissions ?? { malformed: 0, unsupported: 0 },
			pageCursor: ready?.pageCursor ?? null,
			previousCursor: ready?.previousCursor ?? null,
			nextCursor: ready?.nextCursor ?? null,
			overlayStamp: ready?.overlayStamp ?? '',
			reason: reason ?? null,
		}
	}

	private makeCursor(
		hostEpoch: string,
		query: string,
		overlayStamp: string,
		witness: string,
		selector: Selector,
	): string {
		const body = Buffer.from(
			JSON.stringify({ v: 1, h: hostEpoch, q: hash(query), o: overlayStamp, w: witness, s: selector }),
			'utf8',
		).toString('base64url')
		const mac = createHmac('sha256', this.secret).update(body).digest('base64url')
		const cursor = `${body}.${mac}`
		if (Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) throw new Error('Catalog cursor exceeds bound')
		return cursor
	}

	private parseCursor(
		cursor: string,
		hostEpoch: string,
		query: string,
		overlayStamp: string,
	): { witness: string; selector: Selector } | undefined {
		if (Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) return undefined
		const [body, mac, extra] = cursor.split('.')
		if (!body || !mac || extra || !timingEqual(createHmac('sha256', this.secret).update(body).digest('base64url'), mac))
			return undefined
		try {
			const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
			if (
				value.v !== 1 ||
				value.h !== hostEpoch ||
				value.q !== hash(query) ||
				value.o !== overlayStamp ||
				typeof value.w !== 'string'
			)
				return undefined
			const selector = value.s as Selector
			if (selector?.kind === 'start') return { witness: value.w, selector }
			if (
				(selector?.kind === 'after' || selector?.kind === 'before') &&
				selector.anchor &&
				Number.isSafeInteger(selector.anchor.modifiedAt) &&
				typeof selector.anchor.id === 'string' &&
				/^catalog_[a-f0-9]{32}$/.test(selector.anchor.id)
			)
				return { witness: value.w, selector }
		} catch {
			return undefined
		}
		return undefined
	}

	private putCache(record: CachedRecord): void {
		const key = versionKey(record.version)
		this.cache.delete(key)
		this.cache.set(key, record)
		while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value as string)
		this.track()
	}
	private principalViews(id: string): number {
		return [...this.views.keys()].filter(key => key.startsWith(`${id}:`)).length
	}
	private expireViews(): void {
		for (const [key, view] of this.views) {
			if (Date.now() - view.lastUsed < VIEW_IDLE_MS) continue
			if (!view.job) this.views.delete(key)
			else {
				view.expired = true
				view.desired = undefined
			}
		}
		this.schedule()
	}
	private async closeJob(job: Job | undefined): Promise<void> {
		if (!job) return
		for (const dir of job.directories) await this.release(job, dir)
		for (const handle of job.handles) await this.release(job, handle)
		job.current = undefined
		job.iterator = undefined
		job.step = undefined
		job.input = undefined
	}
	private track(): void {
		let retained = this.cache.size
		let requests = this.views.size
		let parserCharacters = 0
		for (const view of this.views.values()) requests += Number(!!view.desired)
		this.maxRequests = Math.max(this.maxRequests, requests)
		for (const view of this.views.values()) {
			retained += (view.ready?.rows.length ?? 0) + (view.job?.selection.length ?? 0) + Number(!!view.job?.current)
			const parser = view.job?.current?.parser.diagnostics()
			if (parser) {
				parserCharacters += parser.retainedCharacters
				this.maxDecodedCharacters = Math.max(this.maxDecodedCharacters, parser.decodedCharacters)
				this.maxParserDepth = Math.max(this.maxParserDepth, parser.depth)
			}
		}
		this.maxParserCharacters = Math.max(this.maxParserCharacters, parserCharacters)
		this.maxRetainedRecords = Math.max(this.maxRetainedRecords, retained)
		this.maxOpenHandles = Math.max(this.maxOpenHandles, this.openHandles)
	}
}
function sameIdentity(a: Identity, b: Identity): boolean {
	return a.dev === b.dev && a.ino === b.ino
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback
}
function normalizeQuery(value: string): string {
	return value.trim().toLocaleLowerCase().slice(0, MAX_LABEL)
}
function hash(value: string): string {
	return createHash('sha256').update(value).digest('base64url').slice(0, 24)
}
function overlayWitness(overlay: ReadonlySet<string>): string {
	return createHash('sha256')
		.update([...overlay].sort().join('\0'))
		.digest('base64url')
		.slice(0, 24)
}
function catalogId(version: FileVersion): string {
	return `catalog_${createHash('sha256').update(`${version.dev}:${version.ino}`).digest('hex').slice(0, 32)}`
}
function versionKey(version: FileVersion): string {
	return `${version.dev}:${version.ino}:${version.size}:${version.mtimeNs}:${version.ctimeNs}`
}
function leaf(record: CachedRecord): bigint {
	return BigInt(
		`0x${createHash('sha256')
			.update(`${record.row.id}:${record.row.label}:${versionKey(record.version)}`)
			.digest('hex')}`,
	)
}
function compareKey(a: SortKey, b?: SortKey): number {
	if (!b) return -1
	return b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id)
}
function insertSelected(
	values: CachedRecord[],
	record: CachedRecord,
	direction: 'after' | 'before',
	limit: number,
): void {
	if (values.length === limit) {
		const edge = direction === 'before' ? values[0] : values.at(-1)
		if (
			edge &&
			(direction === 'before' ? compareKey(record.key, edge.key) <= 0 : compareKey(record.key, edge.key) >= 0)
		)
			return
		if (direction === 'before') values.shift()
		else values.pop()
	}
	values.push(record)
	values.sort((a, b) => compareKey(a.key, b.key))
}
function sameVersion(version: FileVersion, stat: BigIntStats): boolean {
	return (
		BigInt(version.dev) === stat.dev &&
		BigInt(version.ino) === stat.ino &&
		BigInt(version.size) === stat.size &&
		version.mtimeNs === stat.mtimeNs &&
		version.ctimeNs === stat.ctimeNs
	)
}
function within(parent: string, path: string): boolean {
	return path.startsWith(`${parent}/`)
}
function sameDescriptor(left: RequestDescriptor, right: RequestDescriptor): boolean {
	return (
		left.hostEpoch === right.hostEpoch &&
		left.query === right.query &&
		left.overlayStamp === right.overlayStamp &&
		left.expectedWitness === right.expectedWitness &&
		JSON.stringify(left.selector) === JSON.stringify(right.selector)
	)
}
function sameRequest(job: Job, descriptor: RequestDescriptor): boolean {
	return (
		job.hostEpoch === descriptor.hostEpoch &&
		job.query === descriptor.query &&
		job.overlayStamp === descriptor.overlayStamp &&
		JSON.stringify(job.selector) === JSON.stringify(descriptor.selector) &&
		job.expectedWitness === descriptor.expectedWitness
	)
}
function sameReady(ready: Ready, descriptor: RequestDescriptor): boolean {
	return (
		ready.overlayStamp === descriptor.overlayStamp &&
		JSON.stringify(selectorFromCursor(ready.pageCursor)) === JSON.stringify(descriptor.selector) &&
		(!descriptor.expectedWitness || ready.witness === descriptor.expectedWitness)
	)
}
function selectorFromCursor(cursor: string): Selector | undefined {
	try {
		const value = JSON.parse(Buffer.from(cursor.split('.')[0] ?? '', 'base64url').toString('utf8')) as { s?: Selector }
		const selector = value.s
		if (selector?.kind === 'start') return selector
		if ((selector?.kind === 'after' || selector?.kind === 'before') && selector.anchor) return selector
	} catch {
		// Malformed internal cursor cannot represent a reusable page.
	}
	return undefined
}
function timingEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false
	let value = 0
	for (let index = 0; index < left.length; index++) value |= left.charCodeAt(index) ^ right.charCodeAt(index)
	return value === 0
}

function omission(error: unknown): keyof Omissions | undefined {
	if (!(error instanceof Error)) return undefined
	if (
		error.message === 'malformed_metadata' ||
		(error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
	)
		return 'malformed'
	if (error.message === 'unsupported_metadata') return 'unsupported'
	return undefined
}
