import type { PlacementGroup, TerminalId } from './terminal-placement'

/**
 * Narrow placement request. It intentionally contains no session-registry
 * document: Electron main remains the only registry reader/writer in Slice 2.
 */
export type DurablePlacementCommand =
	| Readonly<{
			type: 'move'
			profileId: string
			generation: number
			affectedIds: readonly TerminalId[]
			groupId?: string
			/** Full durability sync; immutable runtime-only IDs may be omitted by the port. */
			flush?: boolean
			strip: readonly TerminalId[]
			background: readonly TerminalId[]
			/** Full binding-time membership sync; carries no registry document. */
			memberships?: readonly Readonly<{
				terminalId: TerminalId
				groupId: string | null
			}>[]
	  }>
	| Readonly<{
			type: 'set-membership'
			profileId: string
			generation: number
			terminalId: TerminalId
			groupId: string | null
			strip: readonly TerminalId[]
			background: readonly TerminalId[]
	  }>
	| Readonly<{
			type: 'set-collapsed'
			profileId: string
			generation: number
			groupId: string
			surface: 'strip' | 'background'
			collapsed: boolean
	  }>

/** Main's canonical answer after applying a narrow command to its latest registry document. */
export interface DurablePlacementResult {
	profileId: string
	generation: number
	/** Whether this command wrote the main-owned registry. False is a valid local-only acceptance. */
	persisted: boolean
	/** A later binding must flush the current canonical placement. */
	durabilityDirty: boolean
	registryEpoch: number
	affectedIds: readonly TerminalId[]
	/** Complete durable order, never a registry/document snapshot. */
	authoritativeOrder: readonly TerminalId[]
	authoritativeGroups: readonly PlacementGroup[]
}

/** The remote-but-owned session registry boundary. */
export interface SessionPlacementPort {
	authorizeAndCommit(command: DurablePlacementCommand, signal?: AbortSignal): Promise<DurablePlacementResult>
}

export interface InMemorySessionPlacementPortOptions {
	profileId: string
	generation: number
	groups?: readonly PlacementGroup[]
}

function copyGroup(group: PlacementGroup): PlacementGroup {
	return {
		...group,
		memberIds: [...group.memberIds],
	}
}

/**
 * Deterministic Slice 1 test adapter. Production code must use the narrow,
 * token-fenced main-process port added in Slice 2 instead.
 */
export class InMemorySessionPlacementPort implements SessionPlacementPort {
	readonly commands: DurablePlacementCommand[] = []
	#profileId: string
	#generation: number
	#groups: PlacementGroup[]
	#epoch = 0
	#queued: Array<Promise<DurablePlacementResult>> = []

	constructor(options: InMemorySessionPlacementPortOptions) {
		this.#profileId = options.profileId
		this.#generation = options.generation
		this.#groups = (options.groups ?? []).map(copyGroup)
	}

	/** Queue a controlled outcome, including a deferred/rejected Promise. */
	enqueue(outcome: Promise<DurablePlacementResult>): void {
		this.#queued.push(outcome)
	}

	async authorizeAndCommit(command: DurablePlacementCommand, _signal?: AbortSignal): Promise<DurablePlacementResult> {
		this.commands.push(command)
		const queued = this.#queued.shift()
		if (queued) return queued

		if (command.type === 'set-membership') {
			this.#groups = this.#groups
				.map(group => ({
					...group,
					memberIds: group.memberIds.filter(id => id !== command.terminalId),
				}))
				.filter(group => group.memberIds.length > 0 || group.id === command.groupId)
			if (command.groupId !== null) {
				const group = this.#groups.find(candidate => candidate.id === command.groupId)
				if (group) group.memberIds = [...group.memberIds, command.terminalId]
			}
		}
		if (command.type === 'set-collapsed') {
			this.#groups = this.#groups.map(group => {
				if (group.id !== command.groupId) return group
				return command.surface === 'strip'
					? { ...group, collapsedStrip: command.collapsed }
					: { ...group, collapsedBackground: command.collapsed }
			})
		}

		const order = command.type === 'set-collapsed' ? [] : [...command.strip, ...command.background]
		return {
			profileId: this.#profileId,
			generation: this.#generation,
			persisted: true,
			durabilityDirty: false,
			registryEpoch: ++this.#epoch,
			affectedIds:
				command.type === 'move'
					? [...command.affectedIds]
					: command.type === 'set-membership'
						? [command.terminalId]
						: [],
			authoritativeOrder: order,
			authoritativeGroups: this.#groups.map(copyGroup),
		}
	}
}

/** CommonJS-compatible runtime entry for Node tests importing app-scoped TypeScript. */
export default { InMemorySessionPlacementPort }
