import type {
	DurablePlacementCommand,
	DurablePlacementResult,
	SessionPlacementPort,
} from './terminal-placement-session'

/**
 * Immutable renderer identity. A fresh terminal keeps its generated ID even
 * after a runtime later binds a distinct durable session ID to it.
 */
declare const terminalIdBrand: unique symbol
export type TerminalId = string & { readonly [terminalIdBrand]: 'TerminalId' }

export function terminalId(value: string): TerminalId {
	return value as TerminalId
}

export type PlacementSurface = 'strip' | 'background'

export interface PlacementGroup {
	id: string
	name: string
	/** Persisted color is deliberately opaque to this DOM-free module. */
	color: string
	collapsedStrip: boolean
	collapsedBackground: boolean
	memberIds: readonly TerminalId[]
}

export interface PlacementGroupInput extends Omit<PlacementGroup, 'memberIds'> {}

export interface PlacementHydrationTerminal {
	id: TerminalId
	surface: PlacementSurface
	groupId?: string | null
}

export interface PlacementHydration {
	profileId: string
	generation: number
	inventoryVersion?: number
	terminals: readonly PlacementHydrationTerminal[]
	groups: readonly PlacementGroupInput[]
}

export interface PlacementGroupsReconciliation {
	profileId: string
	generation: number
	version: number
	groups: readonly PlacementGroupInput[]
}

export type PlacementInventoryEvent =
	| Readonly<{
			type: 'add'
			profileId: string
			generation: number
			version: number
			terminal: PlacementHydrationTerminal
	  }>
	| Readonly<{
			type: 'remove'
			profileId: string
			generation: number
			version: number
			id: TerminalId
	  }>
	| Readonly<{
			type: 'ownership'
			profileId: string
			generation: number
			version: number
			id: TerminalId
			surface: PlacementSurface
	  }>

export interface PlacementTarget {
	surface: PlacementSurface
	/** Insertion index after the selected block has been removed. */
	index: number
	/** For a terminal drag, explicitly changes membership in the same transaction. Omit to preserve membership. */
	groupId?: string | null
}

export type DragSelection =
	| Readonly<{ type: 'terminal'; id: TerminalId }>
	| Readonly<{ type: 'group'; groupId: string }>

export interface DragProjection {
	id: number
	ids: readonly TerminalId[]
	target: PlacementTarget
	/** Visual-only placement. `PlacementSnapshot.strip/background` remain committed ownership. */
	strip: readonly TerminalId[]
	background: readonly TerminalId[]
	/** Visual-only projected membership, paired with projected order. */
	groups: readonly PlacementGroup[]
}

export interface PlacementSnapshot {
	profileId: string
	generation: number
	revision: number
	inventory: readonly TerminalId[]
	/** Durable foreground ownership and order. */
	strip: readonly TerminalId[]
	/** Durable Background ownership and order. */
	background: readonly TerminalId[]
	groups: readonly PlacementGroup[]
	selectedId: TerminalId | null
	drag: DragProjection | null
	busy: boolean
	/** Canonical local placement has unbound IDs awaiting a later durable flush. */
	durabilityDirty: boolean
}

export type PlacementAction =
	| Readonly<{ type: 'select'; id: TerminalId | null }>
	| Readonly<{ type: 'open-background'; id: TerminalId }>
	| Readonly<{ type: 'park'; id: TerminalId }>
	| Readonly<{ type: 'restore'; id: TerminalId }>
	| Readonly<{ type: 'restore-group'; groupId: string }>
	| Readonly<{ type: 'move-group-to-background'; groupId: string }>
	| Readonly<{
			type: 'set-order'
			surface: PlacementSurface
			order: readonly TerminalId[]
	  }>
	| Readonly<{ type: 'set-membership'; id: TerminalId; groupId: string | null }>
	| Readonly<{
			type: 'set-collapsed'
			groupId: string
			surface: PlacementSurface
			collapsed: boolean
	  }>

export type PlacementRejectReason =
	| 'busy'
	| 'disposed'
	| 'not-hydrated'
	| 'unknown-terminal'
	| 'unknown-group'
	| 'invalid-action'
	| 'stale-drag'
	| 'generation-mismatch'
	| 'port-rejected'
	| 'aborted'

export interface PlacementAccepted {
	ok: true
	snapshot: PlacementSnapshot
	registryEpoch?: number
}

export interface PlacementRejected {
	ok: false
	reason: PlacementRejectReason
	snapshot: PlacementSnapshot
}

export type PlacementResult = PlacementAccepted | PlacementRejected
export type PlacementTransitionResult = PlacementAccepted | PlacementRejected

export interface PlacementDrag {
	project(target: PlacementTarget): PlacementTransitionResult
	cancel(): PlacementTransitionResult
	commit(signal?: AbortSignal): Promise<PlacementResult>
}

export interface TerminalPlacementOptions {
	profileId: string
	generation: number
	port: SessionPlacementPort
}

interface CommittedPlacement {
	inventory: TerminalId[]
	strip: TerminalId[]
	background: TerminalId[]
	groups: PlacementGroup[]
	selectedId: TerminalId | null
}

interface DragState {
	id: number
	ids: TerminalId[]
	groupId: string | null
	projection: DragProjection | null
	committing: boolean
}

interface UserTransaction {
	kind: 'drag' | 'action'
	dragId?: number
	/** Reconciliation generation observed when this transaction began. */
	groupsVersion: number
	candidate: CommittedPlacement
}

function uniqueKnown(ids: readonly TerminalId[], inventory: readonly TerminalId[]): TerminalId[] {
	const known = new Set(inventory)
	const seen = new Set<TerminalId>()
	return ids.filter(id => {
		if (!known.has(id) || seen.has(id)) return false
		seen.add(id)
		return true
	})
}

function copyGroup(group: PlacementGroup): PlacementGroup {
	return {
		id: group.id,
		name: group.name,
		color: group.color,
		collapsedStrip: group.collapsedStrip,
		collapsedBackground: group.collapsedBackground,
		memberIds: [...group.memberIds],
	}
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
	return Object.freeze([...items])
}

function freezeGroup(group: PlacementGroup): PlacementGroup {
	return Object.freeze({
		...copyGroup(group),
		memberIds: freezeArray(group.memberIds),
	})
}

function freezeProjection(projection: DragProjection): DragProjection {
	return Object.freeze({
		id: projection.id,
		ids: freezeArray(projection.ids),
		target: Object.freeze({ ...projection.target }),
		strip: freezeArray(projection.strip),
		background: freezeArray(projection.background),
		groups: freezeArray(projection.groups.map(freezeGroup)),
	})
}

function without<T>(items: readonly T[], remove: ReadonlySet<T>): T[] {
	return items.filter(item => !remove.has(item))
}

function insertAt<T>(items: readonly T[], index: number, inserted: readonly T[]): T[] {
	const at = Math.max(0, Math.min(index, items.length))
	return [...items.slice(0, at), ...inserted, ...items.slice(at)]
}

function sameMembers(left: readonly TerminalId[], right: readonly TerminalId[]): boolean {
	return left.length === right.length && left.every(id => right.includes(id))
}

function cloneCommitted(state: CommittedPlacement): CommittedPlacement {
	return {
		inventory: [...state.inventory],
		strip: [...state.strip],
		background: [...state.background],
		groups: state.groups.map(copyGroup),
		selectedId: state.selectedId,
	}
}

/**
 * Placement policy only. It has no DOM, xterm, preload, process, or session
 * registry dependency beyond the injected narrow persistence port.
 */
export class TerminalPlacement {
	readonly #profileId: string
	readonly #generation: number
	readonly #port: SessionPlacementPort
	#state: CommittedPlacement = {
		inventory: [],
		strip: [],
		background: [],
		groups: [],
		selectedId: null,
	}
	#snapshot: PlacementSnapshot
	#listeners = new Set<(snapshot: PlacementSnapshot) => void>()
	#revision = 0
	#inventoryVersion = -1
	#groupsVersion = -1
	#hydrated = false
	#disposed = false
	#drag: DragState | null = null
	#transaction: UserTransaction | null = null
	#nextDragId = 1
	#durabilityDirty = false
	#durabilityFlushQueued = false

	constructor(options: TerminalPlacementOptions) {
		this.#profileId = options.profileId
		this.#generation = options.generation
		this.#port = options.port
		this.#snapshot = this.#makeSnapshot()
	}

	snapshot(): PlacementSnapshot {
		return this.#snapshot
	}

	subscribe(listener: (snapshot: PlacementSnapshot) => void): () => void {
		if (this.#disposed) return () => undefined
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
	}

	hydrate(input: PlacementHydration): PlacementSnapshot {
		if (
			this.#disposed ||
			this.#hydrated ||
			input.profileId !== this.#profileId ||
			input.generation !== this.#generation
		) {
			return this.#snapshot
		}

		const inventory: TerminalId[] = []
		const seen = new Set<TerminalId>()
		const strip: TerminalId[] = []
		const background: TerminalId[] = []
		const membership = new Map<TerminalId, string | null>()
		for (const terminal of input.terminals) {
			if (seen.has(terminal.id)) continue
			seen.add(terminal.id)
			inventory.push(terminal.id)
			membership.set(terminal.id, terminal.groupId ?? null)
			;(terminal.surface === 'strip' ? strip : background).push(terminal.id)
		}
		const knownGroupIds = new Set(input.groups.map(group => group.id))
		this.#state = {
			inventory,
			strip,
			background,
			groups: input.groups.map(group => ({
				...group,
				memberIds: inventory.filter(id => membership.get(id) === group.id && knownGroupIds.has(group.id)),
			})),
			selectedId: null,
		}
		this.#normalize()
		this.#hydrated = true
		this.#inventoryVersion = input.inventoryVersion ?? 0
		this.#groupsVersion = 0
		return this.#publish()
	}

	reconcileGroups(input: PlacementGroupsReconciliation): PlacementSnapshot {
		if (
			this.#disposed ||
			!this.#hydrated ||
			input.profileId !== this.#profileId ||
			input.generation !== this.#generation ||
			input.version <= this.#groupsVersion
		) {
			return this.#snapshot
		}
		this.#groupsVersion = input.version
		const current = new Map(this.#state.groups.map(group => [group.id, group]))
		this.#state.groups = input.groups.map(group => ({
			...group,
			memberIds: [...(current.get(group.id)?.memberIds ?? [])],
		}))
		if (this.#drag?.groupId && !this.#state.groups.some(group => group.id === this.#drag?.groupId)) {
			if (!this.#drag.committing) this.#drag = null
		}
		this.#normalize()
		return this.#publish()
	}

	inventory(event: PlacementInventoryEvent): PlacementSnapshot {
		if (
			this.#disposed ||
			!this.#hydrated ||
			event.profileId !== this.#profileId ||
			event.generation !== this.#generation ||
			event.version <= this.#inventoryVersion
		) {
			return this.#snapshot
		}
		this.#inventoryVersion = event.version
		const inventory = new Set(this.#state.inventory)
		if (event.type === 'add') {
			if (inventory.has(event.terminal.id)) return this.#snapshot
			this.#state.inventory.push(event.terminal.id)
			;(event.terminal.surface === 'strip' ? this.#state.strip : this.#state.background).push(event.terminal.id)
			if (event.terminal.groupId && this.#state.groups.some(group => group.id === event.terminal.groupId)) {
				this.#state.groups = this.#state.groups.map(group =>
					group.id === event.terminal.groupId
						? { ...group, memberIds: [...group.memberIds, event.terminal.id] }
						: group,
				)
			}
		}
		if (event.type === 'remove') {
			if (!inventory.has(event.id)) return this.#snapshot
			this.#state.inventory = this.#state.inventory.filter(id => id !== event.id)
			this.#state.strip = this.#state.strip.filter(id => id !== event.id)
			this.#state.background = this.#state.background.filter(id => id !== event.id)
			this.#state.groups = this.#state.groups
				.map(group => ({
					...group,
					memberIds: group.memberIds.filter(id => id !== event.id),
				}))
				.filter(group => group.memberIds.length > 0)
			if (this.#state.selectedId === event.id) this.#state.selectedId = this.#fallbackSelection()
			if (this.#drag) {
				this.#drag.ids = this.#drag.ids.filter(id => id !== event.id)
				if (this.#drag.projection) this.#drag.projection = this.#projectionFor(this.#drag, this.#drag.projection.target)
			}
		}
		if (event.type === 'ownership') {
			if (!inventory.has(event.id)) return this.#snapshot
			this.#state.strip = this.#state.strip.filter(id => id !== event.id)
			this.#state.background = this.#state.background.filter(id => id !== event.id)
			;(event.surface === 'strip' ? this.#state.strip : this.#state.background).push(event.id)
		}
		this.#normalize()
		return this.#publish()
	}

	/** Flush the current canonical placement after runtime bindings change. */
	async flushDurability(signal?: AbortSignal): Promise<PlacementResult> {
		const unavailable = this.#unavailable()
		if (unavailable) return this.#rejected(unavailable)
		if (!this.#hydrated) return this.#rejected('not-hydrated')
		if (this.#drag || this.#transaction) {
			this.#durabilityFlushQueued = true
			return this.#rejected('busy')
		}
		if (!this.#durabilityDirty) return { ok: true, snapshot: this.#snapshot }
		const candidate = cloneCommitted(this.#state)
		const command: DurablePlacementCommand = {
			type: 'move',
			profileId: this.#profileId,
			generation: this.#generation,
			affectedIds: [...candidate.inventory],
			flush: true,
			strip: [...candidate.strip],
			background: [...candidate.background],
			...(candidate.groups.some(group => group.memberIds.length > 0)
				? {
						memberships: candidate.groups.flatMap(group =>
							group.memberIds.map(terminalId => ({ terminalId, groupId: group.id })),
						),
					}
				: {}),
		}
		this.#transaction = {
			kind: 'action',
			groupsVersion: this.#groupsVersion,
			candidate,
		}
		this.#publish()
		return this.#commit(command, this.#transaction, signal)
	}

	async execute(action: PlacementAction, signal?: AbortSignal): Promise<PlacementResult> {
		const unavailable = this.#unavailable()
		if (unavailable) return this.#rejected(unavailable)
		if (!this.#hydrated) return this.#rejected('not-hydrated')
		if (this.#drag || this.#transaction) return this.#rejected('busy')

		if (action.type === 'select' || action.type === 'open-background') {
			const id = action.type === 'select' ? action.id : action.id
			if (id !== null && !this.#state.inventory.includes(id)) return this.#rejected('unknown-terminal')
			if (action.type === 'open-background' && !this.#state.background.includes(id as TerminalId)) {
				return this.#rejected('invalid-action')
			}
			this.#state.selectedId = id
			return { ok: true, snapshot: this.#publish() }
		}

		const candidate = cloneCommitted(this.#state)
		const command = this.#applyAction(candidate, action)
		if (!command) return this.#rejected(this.#actionFailure(action))
		this.#transaction = {
			kind: 'action',
			groupsVersion: this.#groupsVersion,
			candidate,
		}
		this.#publish()
		return this.#commit(command, this.#transaction, signal)
	}

	beginDrag(selection: DragSelection): PlacementDrag {
		const unavailable = this.#unavailable()
		let failure: PlacementRejectReason | null = unavailable ?? (!this.#hydrated ? 'not-hydrated' : null)
		let ids: TerminalId[] = []
		if (!failure) {
			ids = this.#dragIds(selection)
			if (ids.length === 0) failure = selection.type === 'group' ? 'unknown-group' : 'unknown-terminal'
			if (this.#drag || this.#transaction) failure = 'busy'
		}
		const state: DragState | null = failure
			? null
			: {
					id: this.#nextDragId++,
					ids,
					groupId: selection.type === 'group' ? selection.groupId : null,
					projection: null,
					committing: false,
				}
		if (state) {
			this.#drag = state
			this.#publish()
		}
		return this.#dragHandle(state, failure)
	}

	dispose(): void {
		if (this.#disposed) return
		this.#disposed = true
		this.#drag = null
		this.#transaction = null
		this.#snapshot = this.#makeSnapshot()
		this.#listeners.clear()
	}

	#dragHandle(state: DragState | null, initialFailure: PlacementRejectReason | null): PlacementDrag {
		const stale = (): PlacementRejectReason | null => {
			if (initialFailure) return initialFailure
			if (this.#disposed) return 'disposed'
			if (!state || this.#drag !== state || state.committing) return 'stale-drag'
			return null
		}
		return {
			project: target => {
				const reason = stale()
				if (reason || !state) return this.#rejected(reason ?? 'stale-drag')
				if (
					state.groupId === null &&
					Object.hasOwn(target, 'groupId') &&
					target.groupId !== null &&
					!this.#state.groups.some(group => group.id === target.groupId)
				)
					return this.#rejected('unknown-group')
				state.projection = this.#projectionFor(state, target)
				return { ok: true, snapshot: this.#publish() }
			},
			cancel: () => {
				const reason = stale()
				if (reason || !state) return this.#rejected(reason ?? 'stale-drag')
				this.#drag = null
				const accepted = { ok: true as const, snapshot: this.#publish() }
				this.#drainQueuedDurabilityFlush()
				return accepted
			},
			commit: async signal => {
				const reason = stale()
				if (reason || !state) return this.#rejected(reason ?? 'stale-drag')
				if (!state.projection) return this.#rejected('invalid-action')
				state.committing = true
				const candidate = this.#candidateFromProjection(state.projection)
				const membershipChanged =
					state.groupId === null &&
					Object.hasOwn(state.projection.target, 'groupId') &&
					this.#membershipFor(this.#state, state.ids[0] as TerminalId) !== state.projection.target.groupId
				const command: DurablePlacementCommand = membershipChanged
					? {
							type: 'set-membership',
							profileId: this.#profileId,
							generation: this.#generation,
							terminalId: state.ids[0] as TerminalId,
							groupId: state.projection.target.groupId ?? null,
							strip: [...candidate.strip],
							background: [...candidate.background],
						}
					: {
							type: 'move',
							profileId: this.#profileId,
							generation: this.#generation,
							affectedIds: [...state.ids],
							...(state.groupId ? { groupId: state.groupId } : {}),
							strip: [...candidate.strip],
							background: [...candidate.background],
						}
				const transaction: UserTransaction = {
					kind: 'drag',
					dragId: state.id,
					groupsVersion: this.#groupsVersion,
					candidate,
				}
				this.#transaction = transaction
				this.#publish()
				return this.#commit(command, transaction, signal)
			},
		}
	}

	#applyAction(
		candidate: CommittedPlacement,
		action: Exclude<PlacementAction, { type: 'select' | 'open-background' }>,
	): DurablePlacementCommand | null {
		const move = (affectedIds: readonly TerminalId[], groupId?: string): DurablePlacementCommand => ({
			type: 'move',
			profileId: this.#profileId,
			generation: this.#generation,
			affectedIds: [...affectedIds],
			...(groupId ? { groupId } : {}),
			strip: [...candidate.strip],
			background: [...candidate.background],
		})
		if (action.type === 'park') {
			const index = candidate.strip.indexOf(action.id)
			if (index < 0) return null
			candidate.strip.splice(index, 1)
			candidate.background.push(action.id)
			if (candidate.selectedId === action.id)
				candidate.selectedId = candidate.strip[index] ?? candidate.strip[index - 1] ?? null
			this.#normalize(candidate)
			return move([action.id])
		}
		if (action.type === 'restore') {
			if (!candidate.background.includes(action.id)) return null
			candidate.background = candidate.background.filter(id => id !== action.id)
			candidate.strip.push(action.id)
			candidate.selectedId = action.id
			this.#normalize(candidate)
			return move([action.id])
		}
		if (action.type === 'restore-group' || action.type === 'move-group-to-background') {
			const group = candidate.groups.find(item => item.id === action.groupId)
			if (!group) return null
			// A group can be split across surfaces. Bulk actions always move the
			// complete current membership so main can atomically revalidate it.
			const ids = group.memberIds.filter(id => candidate.inventory.includes(id))
			if (ids.length === 0) return null
			if (action.type === 'restore-group') {
				candidate.strip = candidate.strip.filter(id => !ids.includes(id))
				candidate.background = candidate.background.filter(id => !ids.includes(id))
				candidate.strip.push(...ids)
				candidate.selectedId = ids.at(-1) ?? null
			} else {
				const firstIndex = candidate.strip.findIndex(id => ids.includes(id))
				candidate.strip = candidate.strip.filter(id => !ids.includes(id))
				candidate.background = candidate.background.filter(id => !ids.includes(id))
				candidate.background.push(...ids)
				if (ids.includes(candidate.selectedId as TerminalId)) {
					candidate.selectedId = candidate.strip[firstIndex] ?? candidate.strip[firstIndex - 1] ?? null
				}
			}
			this.#normalize(candidate)
			return move(ids, action.groupId)
		}
		if (action.type === 'set-order') {
			const existing = action.surface === 'strip' ? candidate.strip : candidate.background
			if (!sameMembers(uniqueKnown(action.order, candidate.inventory), existing)) return null
			if (action.surface === 'strip') candidate.strip = [...action.order]
			else candidate.background = [...action.order]
			this.#normalize(candidate)
			return move(action.order)
		}
		if (action.type === 'set-membership') {
			if (!candidate.inventory.includes(action.id)) return null
			if (action.groupId !== null && !candidate.groups.some(group => group.id === action.groupId)) return null
			this.#setMembership(candidate, action.id, action.groupId)
			this.#normalize(candidate)
			return {
				type: 'set-membership',
				profileId: this.#profileId,
				generation: this.#generation,
				terminalId: action.id,
				groupId: action.groupId,
				strip: [...candidate.strip],
				background: [...candidate.background],
			}
		}
		if (action.type === 'set-collapsed') {
			const group = candidate.groups.find(item => item.id === action.groupId)
			if (!group) return null
			candidate.groups = candidate.groups.map(item => {
				if (item.id !== action.groupId) return item
				return action.surface === 'strip'
					? { ...item, collapsedStrip: action.collapsed }
					: { ...item, collapsedBackground: action.collapsed }
			})
			return {
				type: 'set-collapsed',
				profileId: this.#profileId,
				generation: this.#generation,
				groupId: action.groupId,
				surface: action.surface,
				collapsed: action.collapsed,
			}
		}
		return null
	}

	async #commit(
		command: DurablePlacementCommand,
		transaction: UserTransaction,
		signal?: AbortSignal,
	): Promise<PlacementResult> {
		try {
			if (signal?.aborted) return this.#finishRejected(transaction, 'aborted')
			const result = await this.#port.authorizeAndCommit(command, signal)
			// Once main has returned a result its synchronous registry write is
			// ambiguous/committed; reconcile it even if the caller aborted meanwhile.
			if (this.#disposed || result.profileId !== this.#profileId || result.generation !== this.#generation) {
				return this.#finishRejected(transaction, this.#disposed ? 'disposed' : 'generation-mismatch')
			}
			if (this.#transaction !== transaction) return this.#rejected('stale-drag')
			this.#state = result.persisted ? this.#mergeCommitted(transaction, result) : transaction.candidate
			// Collapsing has no order projection and must never clear an earlier unbound-placement debt.
			this.#durabilityDirty =
				command.type === 'set-collapsed'
					? this.#durabilityDirty
					: command.type === 'move' && command.flush === true && result.persisted
						? result.durabilityDirty
						: this.#durabilityDirty || result.durabilityDirty
			this.#drag = null
			this.#transaction = null
			const accepted = {
				ok: true as const,
				snapshot: this.#publish(),
				registryEpoch: result.registryEpoch,
			}
			this.#drainQueuedDurabilityFlush()
			return accepted
		} catch (error) {
			const reason: PlacementRejectReason =
				signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'aborted' : 'port-rejected'
			return this.#finishRejected(transaction, reason)
		}
	}

	#finishRejected(transaction: UserTransaction, reason: PlacementRejectReason): PlacementRejected {
		if (this.#disposed) return this.#rejected('disposed')
		if (this.#transaction === transaction) {
			this.#drag = null
			this.#transaction = null
			const rejected = this.#rejected(reason, true)
			this.#drainQueuedDurabilityFlush()
			return rejected
		}
		return this.#rejected(reason)
	}

	#mergeCommitted(transaction: UserTransaction, result: DurablePlacementResult): CommittedPlacement {
		const candidate = transaction.candidate
		const inventory = [...this.#state.inventory]
		const currentSurface = new Map<TerminalId, PlacementSurface>()
		for (const id of this.#state.strip) currentSurface.set(id, 'strip')
		for (const id of this.#state.background) currentSurface.set(id, 'background')
		const candidateSurface = new Map<TerminalId, PlacementSurface>()
		for (const id of candidate.strip) candidateSurface.set(id, 'strip')
		for (const id of candidate.background) candidateSurface.set(id, 'background')
		// Inventory ownership events are authoritative for unrelated identities while
		// a request awaits. Only IDs main says this transaction affected may take the
		// candidate surface.
		for (const id of result.affectedIds) {
			const surface = candidateSurface.get(id)
			if (surface) currentSurface.set(id, surface)
		}
		const authoritative = uniqueKnown(result.authoritativeOrder, inventory)
		const authoritativeSet = new Set(authoritative)
		const orderFor = (surface: PlacementSurface): TerminalId[] => {
			// Main returns only the durable subset. Keep local-only identities (for
			// example an exited row) in their projected slots while replacing only
			// durable slots with main's authoritative relative order.
			const candidateOrder = surface === 'strip' ? candidate.strip : candidate.background
			const currentOrder = surface === 'strip' ? this.#state.strip : this.#state.background
			const baseline = uniqueKnown([...candidateOrder, ...currentOrder, ...inventory], inventory).filter(
				id => currentSurface.get(id) === surface,
			)
			const durable = authoritative.filter(id => currentSurface.get(id) === surface)
			let durableIndex = 0
			const merged = baseline.map(id => {
				const next = durable[durableIndex]
				if (!authoritativeSet.has(id) || next === undefined) return id
				durableIndex += 1
				return next
			})
			return [...merged, ...durable.slice(durableIndex)].filter((id, index, ids) => ids.indexOf(id) === index)
		}
		const strip = orderFor('strip')
		const background = orderFor('background')
		const currentGroups = new Map(this.#state.groups.map(group => [group.id, copyGroup(group)]))
		const authoritativeIds = new Set(authoritative)
		// Never introduce definitions from an older response: reconciliation is the
		// definition authority. Apply returned durable memberships only to IDs main
		// actually knows, retaining unbound/local members from current state.
		for (const returned of result.authoritativeGroups) {
			const current = currentGroups.get(returned.id)
			if (!current) continue
			const durableMembers = uniqueKnown(returned.memberIds, inventory).filter(id => authoritativeIds.has(id))
			const localMembers = current.memberIds.filter(id => !authoritativeIds.has(id))
			const presentation = transaction.groupsVersion === this.#groupsVersion ? returned : current
			currentGroups.set(returned.id, {
				...presentation,
				memberIds: [...durableMembers, ...localMembers.filter(id => !durableMembers.includes(id))],
			})
		}
		const known = new Set(inventory)
		const selectedId =
			candidate.selectedId && known.has(candidate.selectedId) ? candidate.selectedId : this.#fallbackSelection(strip)
		const merged = {
			inventory,
			strip,
			background,
			groups: [...currentGroups.values()],
			selectedId,
		}
		this.#normalize(merged)
		return merged
	}

	#candidateFromProjection(projection: DragProjection): CommittedPlacement {
		const candidate = cloneCommitted(this.#state)
		candidate.strip = uniqueKnown(projection.strip, candidate.inventory)
		candidate.background = uniqueKnown(projection.background, candidate.inventory).filter(
			id => !candidate.strip.includes(id),
		)
		candidate.groups = projection.groups.map(copyGroup)
		this.#normalize(candidate)
		return candidate
	}

	#projectionFor(drag: DragState, target: PlacementTarget): DragProjection {
		const ids = uniqueKnown(drag.ids, this.#state.inventory)
		const selected = new Set(ids)
		const strip = without(this.#state.strip, selected)
		const background = without(this.#state.background, selected)
		const destination = target.surface === 'strip' ? strip : background
		const projected = insertAt(destination, target.index, ids)
		const projectedTarget = {
			surface: target.surface,
			index: Math.max(0, Math.min(target.index, destination.length)),
			...(Object.hasOwn(target, 'groupId') ? { groupId: target.groupId ?? null } : {}),
		}
		const groups = this.#state.groups.map(copyGroup)
		if (drag.groupId === null && Object.hasOwn(projectedTarget, 'groupId')) {
			const id = ids[0]
			if (id) {
				const candidate = {
					inventory: [...this.#state.inventory],
					strip: [...this.#state.strip],
					background: [...this.#state.background],
					groups,
					selectedId: this.#state.selectedId,
				}
				this.#setMembership(candidate, id, projectedTarget.groupId ?? null)
				this.#normalize(candidate)
				groups.splice(0, groups.length, ...candidate.groups)
			}
		}
		const projection: DragProjection = {
			id: drag.id,
			ids,
			target: projectedTarget,
			strip: target.surface === 'strip' ? projected : strip,
			background: target.surface === 'background' ? projected : background,
			groups,
		}
		return projection
	}

	#dragIds(selection: DragSelection): TerminalId[] {
		if (selection.type === 'terminal') return this.#state.inventory.includes(selection.id) ? [selection.id] : []
		const group = this.#state.groups.find(item => item.id === selection.groupId)
		if (!group) return []
		const ordered = [...this.#state.strip, ...this.#state.background]
		return ordered.filter(id => group.memberIds.includes(id))
	}

	#actionFailure(action: PlacementAction): PlacementRejectReason {
		if ('id' in action && action.id !== null && !this.#state.inventory.includes(action.id)) return 'unknown-terminal'
		if (
			'groupId' in action &&
			action.groupId !== null &&
			!this.#state.groups.some(group => group.id === action.groupId)
		) {
			return 'unknown-group'
		}
		return 'invalid-action'
	}

	#membershipFor(state: CommittedPlacement, id: TerminalId): string | null {
		return state.groups.find(group => group.memberIds.includes(id))?.id ?? null
	}

	#setMembership(state: CommittedPlacement, id: TerminalId, groupId: string | null): void {
		state.groups = state.groups
			.map(group => ({
				...group,
				memberIds: group.memberIds.filter(member => member !== id),
			}))
			.filter(group => group.memberIds.length > 0 || group.id === groupId)
		if (groupId !== null)
			state.groups = state.groups.map(group =>
				group.id === groupId ? { ...group, memberIds: [...group.memberIds, id] } : group,
			)
	}

	#normalize(state = this.#state): void {
		state.inventory = uniqueKnown(state.inventory, state.inventory)
		const inventory = state.inventory
		state.strip = uniqueKnown(state.strip, inventory)
		state.background = uniqueKnown(state.background, inventory).filter(id => !state.strip.includes(id))
		for (const id of inventory) if (!state.strip.includes(id) && !state.background.includes(id)) state.strip.push(id)

		const assigned = new Set<TerminalId>()
		state.groups = state.groups.map(group => ({
			...copyGroup(group),
			memberIds: uniqueKnown(group.memberIds, inventory).filter(id => {
				if (assigned.has(id)) return false
				assigned.add(id)
				return true
			}),
		}))
		state.strip = this.#contiguousGroups(state.strip, state.groups)
		state.background = this.#contiguousGroups(state.background, state.groups)
		if (state.selectedId !== null && !inventory.includes(state.selectedId))
			state.selectedId = this.#fallbackSelection(state.strip)
	}

	#contiguousGroups(order: readonly TerminalId[], groups: readonly PlacementGroup[]): TerminalId[] {
		const membership = new Map<TerminalId, string>()
		for (const group of groups) for (const id of group.memberIds) membership.set(id, group.id)
		const emitted = new Set<string>()
		const result: TerminalId[] = []
		for (const id of order) {
			const groupId = membership.get(id)
			if (!groupId) {
				result.push(id)
				continue
			}
			if (emitted.has(groupId)) continue
			emitted.add(groupId)
			const group = groups.find(item => item.id === groupId)
			if (group) result.push(...order.filter(candidate => group.memberIds.includes(candidate)))
		}
		return result
	}

	#fallbackSelection(strip = this.#state.strip): TerminalId | null {
		return strip[0] ?? null
	}

	#drainQueuedDurabilityFlush(): void {
		if (!this.#durabilityFlushQueued || !this.#durabilityDirty || this.#drag || this.#transaction || this.#disposed)
			return
		this.#durabilityFlushQueued = false
		void this.flushDurability().then(result => {
			if (!result.ok && result.reason === 'busy') this.#durabilityFlushQueued = true
		})
	}

	#unavailable(): PlacementRejectReason | null {
		return this.#disposed ? 'disposed' : null
	}

	#rejected(reason: PlacementRejectReason, publish = false): PlacementRejected {
		return {
			ok: false,
			reason,
			snapshot: publish ? this.#publish() : this.#snapshot,
		}
	}

	#makeSnapshot(): PlacementSnapshot {
		const projection = this.#drag?.projection ? freezeProjection(this.#drag.projection) : null
		return Object.freeze({
			profileId: this.#profileId,
			generation: this.#generation,
			revision: this.#revision,
			inventory: freezeArray(this.#state.inventory),
			strip: freezeArray(this.#state.strip),
			background: freezeArray(this.#state.background),
			groups: freezeArray(this.#state.groups.map(freezeGroup)),
			selectedId: this.#state.selectedId,
			drag: projection,
			busy: this.#drag !== null || this.#transaction !== null,
			durabilityDirty: this.#durabilityDirty,
		})
	}

	#publish(): PlacementSnapshot {
		this.#revision += 1
		this.#snapshot = this.#makeSnapshot()
		for (const listener of this.#listeners) listener(this.#snapshot)
		return this.#snapshot
	}
}

/** CommonJS-compatible runtime entry for Node tests importing app-scoped TypeScript. */
export default { TerminalPlacement, terminalId }
