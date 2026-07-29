import type { SessionsApi, TerminalPlacementCommitCommand } from './shared'
import { type PlacementGroup, type TerminalId, terminalId } from './terminal-placement'
import type {
	DurablePlacementCommand,
	DurablePlacementResult,
	SessionPlacementPort,
} from './terminal-placement-session'

/**
 * Production persistence adapter for TerminalPlacement. Renderer visual IDs are
 * never sent to main; only live, bound same-profile registry session IDs are.
 */
export interface TerminalSessionBindings {
	/** Resolves a stable renderer ID to its currently durable session binding. */
	sessionIdFor(terminalId: string): string | null
	/** Resolves a durable main-process session ID back to the stable renderer ID. */
	terminalIdFor(sessionId: string): string | null
	/** False only for exited/missing runtime rows; run-owned sessions remain placeable. */
	placementEligibleFor?(terminalId: string): boolean
}

export class ProductionSessionPlacementPort implements SessionPlacementPort {
	readonly #sessions: Pick<SessionsApi, 'placementCommit'>
	readonly #bindings: TerminalSessionBindings

	constructor(sessions: Pick<SessionsApi, 'placementCommit'>, bindings: TerminalSessionBindings) {
		this.#sessions = sessions
		this.#bindings = bindings
	}

	async authorizeAndCommit(command: DurablePlacementCommand, signal?: AbortSignal): Promise<DurablePlacementResult> {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
		const sessionFor = (id: TerminalId): string | null => this.#bindings.sessionIdFor(id)
		const eligible = (id: TerminalId): boolean =>
			sessionFor(id) !== null && (this.#bindings.placementEligibleFor?.(id) ?? true)
		const eligibleOrder = (ids: readonly TerminalId[]): string[] =>
			ids.flatMap(id => {
				const sessionId = sessionFor(id)
				return sessionId && eligible(id) ? [sessionId] : []
			})
		const placementIds = command.type === 'set-collapsed' ? [] : [...command.strip, ...command.background]
		const projectedStrip = command.type === 'set-collapsed' ? [] : eligibleOrder(command.strip)
		const projectedBackground = command.type === 'set-collapsed' ? [] : eligibleOrder(command.background)
		const unboundInPlacement = placementIds.some(id => sessionFor(id) === null)
		const affected =
			command.type === 'move' ? command.affectedIds : command.type === 'set-membership' ? [command.terminalId] : []
		const eligibleAffected = affected.filter(eligible)
		const allAffectedUnbound = affected.length > 0 && affected.every(id => sessionFor(id) === null)
		if (
			command.type !== 'set-collapsed' &&
			(allAffectedUnbound || (command.type === 'set-membership' && !eligible(command.terminalId)))
		) {
			return this.#localResult(command, unboundInPlacement)
		}
		const operation: TerminalPlacementCommitCommand | null =
			command.type === 'move'
				? eligibleAffected.length === 0
					? command.flush
						? null
						: null
					: {
							type: 'move',
							affectedIds: eligibleAffected.flatMap(id => {
								const sessionId = sessionFor(id)
								return sessionId ? [sessionId] : []
							}),
							...(command.groupId && eligibleAffected.length === affected.length ? { groupId: command.groupId } : {}),
							strip: projectedStrip,
							background: projectedBackground,
							...(command.flush && command.memberships
								? {
										memberships: command.memberships.flatMap(entry => {
											const sessionId = sessionFor(entry.terminalId)
											return sessionId && eligible(entry.terminalId)
												? [{ terminalId: sessionId, groupId: entry.groupId }]
												: []
										}),
									}
								: {}),
						}
				: command.type === 'set-membership'
					? (() => {
							const sessionId = sessionFor(command.terminalId)
							if (!sessionId || !eligible(command.terminalId)) return null
							return {
								type: 'set-membership' as const,
								terminalId: sessionId,
								groupId: command.groupId,
								strip: projectedStrip,
								background: projectedBackground,
							}
						})()
					: {
							type: 'set-collapsed',
							groupId: command.groupId,
							surface: command.surface,
							collapsed: command.collapsed,
						}
		if (!operation) return this.#localResult(command, unboundInPlacement)
		// Main commits synchronously. A post-dispatch abort is ambiguous/committed,
		// so return its authoritative result rather than rolling local state back.
		const result = await this.#sessions.placementCommit(operation)
		if (!result) throw new Error('placement commit rejected')
		const fromSession = (sessionId: string): TerminalId | null => {
			const id = this.#bindings.terminalIdFor(sessionId)
			return id && eligible(terminalId(id)) ? terminalId(id) : null
		}
		const authoritativeGroups: PlacementGroup[] = result.authoritativeGroups.map(group => ({
			...group,
			memberIds: group.memberIds.flatMap(sessionId => {
				const id = fromSession(sessionId)
				return id ? [id] : []
			}),
		}))
		return {
			profileId: command.profileId,
			generation: command.generation,
			persisted: true,
			// Unbound IDs require a later binding flush. Run-owned/exited IDs do not.
			durabilityDirty: unboundInPlacement,
			registryEpoch: result.registryEpoch,
			affectedIds:
				command.type === 'move'
					? [...command.affectedIds]
					: result.affectedIds.flatMap(sessionId => {
							const id = fromSession(sessionId)
							return id ? [id] : []
						}),
			authoritativeOrder: result.authoritativeOrder.flatMap(sessionId => {
				const id = fromSession(sessionId)
				return id ? [id] : []
			}),
			authoritativeGroups,
		}
	}

	#localResult(command: DurablePlacementCommand, durabilityDirty: boolean): DurablePlacementResult {
		return {
			profileId: command.profileId,
			generation: command.generation,
			persisted: false,
			durabilityDirty,
			registryEpoch: 0,
			affectedIds: [],
			authoritativeOrder: [],
			authoritativeGroups: [],
		}
	}
}

export default { ProductionSessionPlacementPort }
