import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { type HistoryEntry, historyBytes, projectHistoryEntry } from './history-projection.js'
import {
	HISTORY_ATTEMPTS,
	HISTORY_LEASE_MS,
	HISTORY_PAGE_BYTES,
	HISTORY_RESULT_BYTES,
	type HistoryDescriptor,
	type HistoryOmissions,
	type HistoryPage,
	type HistoryRecord,
	type HistoryResult,
	addHistoryOmissions,
	emptyHistoryOmissions,
	historyDescriptorSchema,
	historyEntryIdSchema,
	historyResultSchema,
} from './history-protocol.js'
import { type RemoteTarget, sameRemoteTarget } from './protocol.js'

export interface HistoryManager {
	getLeafId(): string | null
	getEntry(id: string): HistoryEntry | undefined
}
const count = z.number().int().nonnegative().safe()
const walkSchema = z
	.object({
		next: historyEntryIdSchema.nullable(),
		checkpoint: historyEntryIdSchema.nullable(),
		power: count,
		length: count,
		examined: count,
	})
	.strict()
type Walk = z.infer<typeof walkSchema>
const tokenSchema = z
	.object({
		version: z.literal(1),
		view: z.string().uuid(),
		head: historyEntryIdSchema.nullable(),
		kind: z.enum(['page', 'newer', 'search']),
		walk: walkSchema,
		end: historyEntryIdSchema.nullable(),
		nonce: z.string().uuid().nullable(),
	})
	.strict()
type Token = z.infer<typeof tokenSchema>
interface Row {
	before: Walk
	id: string
	record: HistoryRecord | null
	omissions: HistoryOmissions
}
interface Search {
	nonce: string
	mode: 'seek' | 'newer' | 'older'
	stop: string | null
	walk: Walk
	rows: Row[]
}
interface View {
	id: string
	/** Fresh server-owned instance: browser view ID reuse must not revive retired tokens. */
	instance: string
	principal: string
	head: string | null
	expires: number
	sequence: number
	input: string
	latest?: HistoryResult
	search?: Search
}
const startWalk = (next: string | null): Walk => ({ next, checkpoint: next, power: 1, length: 0, examined: 0 })
const increment = (n: number): number => Math.min(Number.MAX_SAFE_INTEGER, n + 1)

/** Owner-local bounded read state. No filesystem, conversation writes or command ledger. */
export class RemoteHistoryReader {
	private readonly secret = randomBytes(32)
	private readonly views = new Map<string, View>()
	private disposed = false
	constructor(
		private readonly target: RemoteTarget,
		private readonly epoch: string,
		private readonly manager: () => HistoryManager | null,
		private readonly now: () => number = Date.now,
	) {}
	dispose(): void {
		this.disposed = true
		this.views.clear()
		this.secret.fill(0)
	}
	get storage(): { views: number; searchRows: number; searchBytes: number; retryBytes: number } {
		this.expire()
		return {
			views: this.views.size,
			searchRows: [...this.views.values()].reduce((n, v) => n + (v.search?.rows.length ?? 0), 0),
			searchBytes: [...this.views.values()].reduce(
				(n, v) => n + historyBytes(v.search?.rows.flatMap(r => (r.record ? [r.record] : [])) ?? []),
				0,
			),
			retryBytes: [...this.views.values()].reduce((n, v) => n + (v.latest ? historyBytes(v.latest) : 0), 0),
		}
	}
	execute(input: HistoryDescriptor): HistoryResult {
		const descriptor = historyDescriptorSchema.parse(input)
		const request = descriptor.request
		const result: HistoryResult = {
			version: 1,
			requestId: descriptor.requestId,
			hostEpoch: request.hostEpoch,
			target: request.target,
			viewId: request.viewId,
			sequence: request.sequence,
			input: request.action,
			state: 'stale',
			page: null,
			continuation: null,
			attempts: 0,
			examined: 0,
		}
		if (
			this.disposed ||
			descriptor.expiresAt <= this.now() ||
			request.hostEpoch !== this.epoch ||
			!sameRemoteTarget(request.target, this.target)
		)
			return result
		this.expire()
		// Reacquired only for this synchronous admitted slice, never held across awaits.
		const manager = this.manager()
		if (!manager) return result
		let view = this.views.get(request.viewId)
		const actionKey = JSON.stringify(request.action)
		if (view && view.principal !== descriptor.principalKey) return result
		if (view && request.sequence === view.sequence) {
			if (view.input !== actionKey || !view.latest) return result
			if (view.latest.state !== 'gap') view.expires = this.now() + HISTORY_LEASE_MS
			return { ...view.latest, requestId: descriptor.requestId }
		}
		if (view && request.sequence <= view.sequence) return result
		if (request.action.kind === 'close') {
			this.views.delete(request.viewId)
			return { ...result, state: 'closed' }
		}
		if (request.action.kind === 'open') {
			if (view) return result
			if (this.views.size >= 8) return { ...result, state: 'busy' }
			const head = manager.getLeafId()
			if (head !== null && !historyEntryIdSchema.safeParse(head).success) return { ...result, state: 'gap' }
			view = {
				id: request.viewId,
				instance: randomUUID(),
				principal: descriptor.principalKey,
				head,
				expires: this.now() + HISTORY_LEASE_MS,
				sequence: -1,
				input: '',
			}
			this.views.set(view.id, view)
		} else if (!view) return { ...result, state: 'expired' }
		if (!view) return result
		let admitted = request.action.kind === 'open'
		try {
			const action = request.action
			if (action.kind === 'open') {
				if (action.anchor) {
					view.search = { nonce: randomUUID(), mode: 'seek', stop: action.anchor, walk: startWalk(view.head), rows: [] }
					this.search(view, manager, result)
				} else this.page(view, manager, startWalk(view.head), null, result)
			} else {
				const token = this.openToken(view, action.cursor)
				if (action.kind === 'page' && token.kind === 'page') {
					admitted = true
					view.search = undefined
					this.page(view, manager, { ...token.walk }, token.end, result)
				} else if (action.kind === 'newer' && token.kind === 'newer') {
					admitted = true
					view.search = { nonce: randomUUID(), mode: 'newer', stop: token.end, walk: startWalk(view.head), rows: [] }
					this.search(view, manager, result)
				} else if (
					action.kind === 'continue' &&
					token.kind === 'search' &&
					view.search &&
					token.nonce === view.search.nonce &&
					token.walk.next === view.search.walk.next &&
					token.walk.examined === view.search.walk.examined
				) {
					admitted = true
					this.search(view, manager, result)
				} else throw new Error('stale_cursor')
			}
		} catch {
			// Invalid capabilities cannot renew a lease, replace retry evidence or
			// cancel an otherwise valid in-progress search.
			if (!admitted) return { ...result, state: 'gap' }
			view.search = undefined
			result.state = 'gap'
			result.page = null
			result.continuation = null
		}
		if (descriptor.expiresAt <= this.now() || !this.manager() || this.disposed)
			return { ...result, state: 'stale', page: null, continuation: null }
		view.sequence = request.sequence
		view.input = actionKey
		if (result.state !== 'gap') view.expires = this.now() + HISTORY_LEASE_MS
		historyResultSchema.parse(result)
		if (historyBytes(result) > HISTORY_RESULT_BYTES) throw new Error('history_result_bound')
		view.latest = result
		return result
	}

	private read(manager: HistoryManager, walk: Walk, result: HistoryResult): HistoryEntry {
		if (!walk.next || result.attempts >= HISTORY_ATTEMPTS) throw new Error('read_budget')
		result.attempts++
		const entry = manager.getEntry(walk.next)
		if (
			!entry ||
			entry.id !== walk.next ||
			(entry.parentId !== null && !historyEntryIdSchema.safeParse(entry.parentId).success)
		)
			throw new Error('broken_ancestry')
		return entry
	}
	/** Brent-style constant-space cycle detection follows only already-read parent edges. */
	private advance(walk: Walk, parent: string | null): void {
		if (parent !== null && parent === walk.checkpoint) throw new Error('cycle')
		walk.length++
		if (walk.length === walk.power) {
			walk.checkpoint = parent
			walk.length = 0
			walk.power = Math.min(Number.MAX_SAFE_INTEGER, walk.power * 2)
		}
		walk.next = parent
		walk.examined = increment(walk.examined)
	}
	private page(view: View, manager: HistoryManager, walk: Walk, end: string | null, result: HistoryResult): void {
		const initial = { ...walk }
		const rows: Row[] = []
		let stopped: HistoryPage['stopped'] = 'entries'
		let records = 0
		let bytes = 2
		while (walk.next !== null && walk.next !== end && result.attempts < HISTORY_ATTEMPTS) {
			const entry = this.read(manager, walk, result)
			const projected = projectHistoryEntry(entry)
			const cost = projected.record ? historyBytes(projected.record) + (records ? 1 : 0) : 0
			if (bytes + cost > HISTORY_PAGE_BYTES) {
				stopped = 'bytes'
				break
			}
			rows.push({ before: { ...walk }, id: entry.id, ...projected })
			bytes += cost
			if (projected.record) records++
			this.advance(walk, entry.parentId)
			if (records === 40) {
				stopped = 'records'
				break
			}
		}
		if (walk.next === null) stopped = 'root'
		else if (walk.next === end) stopped = 'boundary'
		result.examined = walk.examined
		result.state = 'page'
		result.page = this.makePage(view, rows, initial, walk, stopped)
		view.search = undefined
	}
	private makePage(view: View, rows: Row[], initial: Walk, after: Walk, stopped: HistoryPage['stopped']): HistoryPage {
		const newest = rows[0]?.id ?? null
		return {
			newest,
			oldest: rows.at(-1)?.id ?? null,
			records: rows.flatMap(row => (row.record ? [row.record] : [])).reverse(),
			omissions: rows.reduce((total, row) => addHistoryOmissions(total, row.omissions), emptyHistoryOmissions()),
			reread: this.seal(view, { kind: 'page', walk: initial, end: after.next, nonce: null }),
			older: after.next ? this.seal(view, { kind: 'page', walk: after, end: null, nonce: null }) : null,
			// A root seek may return no raw rows. Its authenticated null boundary
			// still has a newer range, unlike an actually empty captured branch.
			newer:
				view.head !== null && initial.next !== view.head
					? this.seal(view, { kind: 'newer', walk: startWalk(view.head), end: initial.next, nonce: null })
					: null,
			stopped,
		}
	}
	private search(view: View, manager: HistoryManager, result: HistoryResult): void {
		const search = view.search
		if (!search) throw new Error('missing_search')
		if (search.mode === 'older') {
			this.page(view, manager, search.walk, null, result)
			return
		}
		while (search.walk.next !== null && result.attempts < HISTORY_ATTEMPTS) {
			const before = { ...search.walk }
			const entry = this.read(manager, search.walk, result)
			if (entry.id === search.stop) {
				if (search.mode === 'seek') {
					this.advance(search.walk, entry.parentId)
					search.mode = 'older'
					if (result.attempts < HISTORY_ATTEMPTS || search.walk.next === null) {
						this.page(view, manager, search.walk, null, result)
						return
					}
				} else {
					if (!search.rows.length) throw new Error('missing_newer_range')
					result.state = 'page'
					result.examined = search.walk.examined
					result.page = this.makePage(view, search.rows, search.rows[0].before, search.walk, 'boundary')
					view.search = undefined
					return
				}
				break
			}
			if (search.mode === 'newer') {
				search.rows.push({ before, id: entry.id, ...projectHistoryEntry(entry) })
				while (
					search.rows.length > 128 ||
					search.rows.filter(row => row.record).length > 40 ||
					historyBytes(search.rows.flatMap(row => (row.record ? [row.record] : []))) > HISTORY_PAGE_BYTES
				)
					search.rows.shift()
			}
			this.advance(search.walk, entry.parentId)
		}
		if (search.walk.next === null && search.mode === 'newer' && search.stop === null) {
			if (!search.rows.length) throw new Error('missing_newer_range')
			result.state = 'page'
			result.examined = search.walk.examined
			result.page = this.makePage(view, search.rows, search.rows[0].before, search.walk, 'root')
			view.search = undefined
			return
		}
		if (search.walk.next === null && search.mode !== 'older') throw new Error('anchor_not_in_branch')
		result.state = 'progress'
		result.examined = search.walk.examined
		result.continuation = this.seal(view, { kind: 'search', walk: search.walk, end: search.stop, nonce: search.nonce })
	}
	private seal(view: View, fields: Pick<Token, 'kind' | 'walk' | 'end' | 'nonce'>): string {
		const data = Buffer.from(JSON.stringify({ version: 1, view: view.id, head: view.head, ...fields })).toString(
			'base64url',
		)
		const signature = this.sign(view, data).toString('base64url')
		const token = `${data}.${signature}`
		if (token.length > 1024) throw new Error('cursor_bound')
		return token
	}
	private sign(view: View, data: string): Buffer {
		return createHmac('sha256', this.secret)
			.update(JSON.stringify([this.epoch, this.target, view.principal, view.instance]))
			.update('\0')
			.update(data)
			.digest()
	}
	private openToken(view: View, value: string): Token {
		if (value.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('invalid_cursor')
		const [data, signature] = value.split('.')
		const bytes = Buffer.from(signature, 'base64url')
		if (bytes.length !== 32 || !timingSafeEqual(bytes, this.sign(view, data))) throw new Error('invalid_cursor')
		const token = tokenSchema.parse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8')))
		if (token.view !== view.id || token.head !== view.head) throw new Error('invalid_cursor')
		return token
	}
	private expire(): void {
		for (const [id, view] of this.views) if (view.expires <= this.now()) this.views.delete(id)
	}
}
