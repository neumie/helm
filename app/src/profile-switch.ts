import type { HelmResult, ProfileActivationResult, ProfilesState } from './shared-helm'

export interface ProfileSwitchFence {
	epoch: number
	ready: Promise<void>
	/** Only the operation that owns this epoch may restore ordinary polling. */
	cancelIfCurrent(): void
	/** Admit a coherently observed non-target identity to this epoch's renderer fence. */
	adoptObservedProfile(profileId: string): void
	/** Releases bridge detail blocking only after this coordinator's forward chain. */
	completeIfCurrent(): void
	observeCoherently(): Promise<ProfilesState | null>
}

export interface ProfileSwitchCoordinatorDependencies {
	currentState(): ProfilesState
	listProfiles(): Promise<HelmResult<ProfilesState>>
	beginRunContextDrain(): { ok: false } | { ok: true; drained: Promise<void>; release(): void }
	flushBuffers(): Promise<void>
	beginFence(targetId: string): ProfileSwitchFence
	advanceLocalGeneration(): void
	restorePrecommitGeneration(): void
	activateDaemon(profileId: string): Promise<HelmResult<ProfileActivationResult>>
	installAuthoritativeState(state: ProfilesState): void
	closeSessionIpc(): void
	flushOldRegistryBestEffort(): void
	detachOldClients(): void | Promise<void>
	installSessionNamespace(profileId: string): void | Promise<void>
	openSessionIpc(): void
	reloadOrCreateWindow(epoch: number): Promise<void>
	queueOrDeliverItem(itemId: string, epoch: number): void
	refreshMenuBestEffort(): void
	log(message: string, detail?: Record<string, unknown>): void
	setTimer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>
	clearTimer?(timer: ReturnType<typeof setTimeout>): void
}

type OperationPhase = 'precommit' | 'activating' | 'activation-unknown' | 'forward'

interface Deferred<T> {
	promise: Promise<T>
	resolve(value: T): void
}

interface Operation {
	epoch: number
	targetId: string
	requestedItemId?: string
	expected: ProfilesState
	fence: ProfileSwitchFence | null
	phase: OperationPhase
	generationAdvanced: boolean
	drainRelease: (() => void) | null
	deferred: Deferred<HelmResult<ProfileActivationResult>>
	probeTimer: ReturnType<typeof setTimeout> | null
	diagnosticTimer: ReturnType<typeof setTimeout> | null
	superseded: boolean
	forwardRetries: number
}

const FORWARD_RETRY_MS = [100, 500, 2_000, 5_000] as const
const UNKNOWN_PROBE_MS = 150
const DIAGNOSTIC_MS = 10_000

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function errorResult(error: unknown): HelmResult<ProfileActivationResult> {
	return { error: error instanceof Error ? error.message : String(error) }
}

function sameIdentity(left: ProfilesState, right: ProfilesState): boolean {
	return left.activeProfileId === right.activeProfileId && left.generation === right.generation
}

/**
 * Electron-free commit coordinator for daemon-global profile activation.
 * It owns operation/epoch policy only; BrowserWindow, cache, dtach and IPC
 * mechanics are injected by main.ts.
 */
export class ProfileSwitchCoordinator {
	private operation: Operation | null = null
	private nextEpoch = 0

	constructor(private readonly deps: ProfileSwitchCoordinatorDependencies) {}

	isSwitching(): boolean {
		return this.operation !== null
	}

	switchTo(profileId: string, openItemId?: string): Promise<HelmResult<ProfileActivationResult>> {
		const current = this.operation
		if (current) {
			if (current.targetId === profileId) {
				if (openItemId && !current.requestedItemId) current.requestedItemId = openItemId
				return current.deferred.promise
			}
			// Only an explicitly requested target may supersede an unknowable
			// activation. Deep links wait in main composition and never reach here
			// until their current operation settles.
			if (current.phase !== 'activation-unknown') {
				return Promise.resolve({ error: 'A profile switch is already in progress.' })
			}
			this.supersedeUnknown(current)
		}

		const state = this.deps.currentState()
		if (profileId === state.activeProfileId) {
			return this.deps
				.listProfiles()
				.then(result => (result.error === undefined ? { data: { state: result.data, applied: true } } : result))
		}
		const operation: Operation = {
			epoch: ++this.nextEpoch,
			targetId: profileId,
			requestedItemId: openItemId,
			expected: state,
			fence: null,
			phase: 'precommit',
			generationAdvanced: false,
			drainRelease: null,
			deferred: deferred(),
			probeTimer: null,
			diagnosticTimer: null,
			superseded: false,
			forwardRetries: 0,
		}
		this.operation = operation
		void this.run(operation)
		return operation.deferred.promise
	}

	private async run(operation: Operation): Promise<void> {
		try {
			const drain = this.deps.beginRunContextDrain()
			if (!drain.ok) {
				this.finish(operation, { error: 'Save or discard the open Run Context draft before switching profiles.' })
				return
			}
			operation.drainRelease = drain.release
			await drain.drained
			if (!this.isCurrent(operation)) return
			await this.deps.flushBuffers()
			if (!this.isCurrent(operation)) return
			operation.fence = this.deps.beginFence(operation.targetId)
			this.deps.advanceLocalGeneration()
			operation.generationAdvanced = true
			operation.phase = 'activating'
			const activated = await this.deps.activateDaemon(operation.targetId)
			if (!this.isCurrent(operation)) return
			const observed = await operation.fence.observeCoherently()
			if (!this.isCurrent(operation)) return
			if (observed) {
				await this.reconcileObserved(operation, observed, activated)
				return
			}
			this.enterUnknown(operation, activated.error)
		} catch (error) {
			if (!this.isCurrent(operation)) return
			if (operation.phase === 'precommit') {
				operation.fence?.cancelIfCurrent()
				this.finish(operation, errorResult(error))
				return
			}
			this.enterUnknown(operation, errorResult(error).error)
		}
	}

	private async reconcileObserved(
		operation: Operation,
		observed: ProfilesState,
		activation: HelmResult<ProfileActivationResult>,
	): Promise<void> {
		if (!this.isCurrent(operation)) return
		if (observed.activeProfileId === operation.targetId) {
			await this.commitForward(operation, observed, { data: { state: observed, applied: true } })
			return
		}
		if (activation.error !== undefined && sameIdentity(observed, operation.expected)) {
			// Rollback is legal only for this original operation after an explicit,
			// coherent observation of precisely the old daemon document.
			if (operation.generationAdvanced) this.deps.restorePrecommitGeneration()
			operation.fence?.cancelIfCurrent()
			this.finish(operation, activation)
			return
		}
		// A third identity or an old identity after an apparently successful POST
		// is daemon truth. Never decrement/re-publish a speculative baseline.
		await this.commitForward(operation, observed, {
			error: `Profile activation resolved to ${observed.activeProfileId}, not ${operation.targetId}.`,
		})
	}

	private enterUnknown(operation: Operation, reason?: string): void {
		if (!this.isCurrent(operation)) return
		operation.phase = 'activation-unknown'
		this.deps.log('Profile activation remains unknown; keeping terminal admission closed.', {
			epoch: operation.epoch,
			expected: operation.expected.activeProfileId,
			target: operation.targetId,
			reason,
		})
		this.scheduleUnknownProbe(operation)
		this.scheduleDiagnostic(operation)
	}

	private scheduleUnknownProbe(operation: Operation): void {
		if (!this.isCurrent(operation) || operation.probeTimer) return
		operation.probeTimer = this.setTimer(() => {
			operation.probeTimer = null
			void this.probeUnknown(operation)
		}, UNKNOWN_PROBE_MS)
	}

	private async probeUnknown(operation: Operation): Promise<void> {
		if (!this.isCurrent(operation) || operation.phase !== 'activation-unknown' || !operation.fence) return
		try {
			const observed = await operation.fence.observeCoherently()
			if (!this.isCurrent(operation)) return
			if (observed) {
				await this.reconcileObserved(operation, observed, { error: 'Activation response was unavailable.' })
				return
			}
		} catch (error) {
			this.deps.log('Profile activation diagnostic probe failed.', { epoch: operation.epoch, error: String(error) })
		}
		this.scheduleUnknownProbe(operation)
	}

	private scheduleDiagnostic(operation: Operation): void {
		if (!this.isCurrent(operation) || operation.diagnosticTimer) return
		operation.diagnosticTimer = this.setTimer(() => {
			operation.diagnosticTimer = null
			if (!this.isCurrent(operation) || operation.phase !== 'activation-unknown') return
			this.deps.log('Profile activation is still unknown; terminal admission remains closed.', {
				epoch: operation.epoch,
				expected: operation.expected.activeProfileId,
				target: operation.targetId,
			})
			this.scheduleDiagnostic(operation)
		}, DIAGNOSTIC_MS)
	}

	private async commitForward(
		operation: Operation,
		state: ProfilesState,
		result: HelmResult<ProfileActivationResult>,
	): Promise<void> {
		if (!this.isCurrent(operation) || !operation.fence) return
		operation.phase = 'forward'
		operation.fence.adoptObservedProfile(state.activeProfileId)
		try {
			// Cache persistence and menu rebuilding are intentionally best effort;
			// their callbacks retain authoritative memory before they can throw.
			try {
				this.deps.installAuthoritativeState(state)
			} catch (error) {
				this.deps.log('Could not persist app profile cache.', { error: String(error) })
			}
			this.deps.closeSessionIpc()
			try {
				this.deps.flushOldRegistryBestEffort()
			} catch (error) {
				this.deps.log('Could not flush old terminal registry.', { error: String(error) })
			}
			await this.deps.detachOldClients()
			if (!this.isCurrent(operation)) return
			await this.deps.installSessionNamespace(state.activeProfileId)
			if (!this.isCurrent(operation)) return
			this.deps.openSessionIpc()
			await this.deps.reloadOrCreateWindow(operation.epoch)
			if (!this.isCurrent(operation)) return
			await operation.fence.ready
			if (!this.isCurrent(operation)) return
			try {
				this.deps.refreshMenuBestEffort()
			} catch (error) {
				this.deps.log('Could not refresh profile menu.', { error: String(error) })
			}
			if (operation.requestedItemId) {
				try {
					this.deps.queueOrDeliverItem(operation.requestedItemId, operation.epoch)
				} catch (error) {
					this.deps.log('Could not immediately deliver profile item; retaining it for load.', { error: String(error) })
				}
			}
			operation.fence.completeIfCurrent()
			this.finish(operation, result.error === undefined ? { data: { state, applied: true } } : result)
		} catch (error) {
			if (!this.isCurrent(operation)) return
			// Never reopen admission on a failed namespace/reload chain. Retry only
			// forward using the coherently observed daemon state.
			this.deps.closeSessionIpc()
			this.retryForward(operation, state, result, error, operation.forwardRetries++)
		}
	}

	private retryForward(
		operation: Operation,
		state: ProfilesState,
		result: HelmResult<ProfileActivationResult>,
		error: unknown,
		attempt: number,
	): void {
		this.deps.log('Profile switch critical local step failed; retrying forward with terminal admission closed.', {
			epoch: operation.epoch,
			target: state.activeProfileId,
			attempt,
			error: String(error),
		})
		this.setTimer(
			() => {
				if (!this.isCurrent(operation)) return
				void this.commitForward(operation, state, result)
			},
			FORWARD_RETRY_MS[Math.min(attempt, FORWARD_RETRY_MS.length - 1)] ?? 5_000,
		)
	}

	private supersedeUnknown(operation: Operation): void {
		operation.superseded = true
		this.clearOperationTimers(operation)
		operation.drainRelease?.()
		operation.deferred.resolve({
			error: `Profile switch to ${operation.targetId} was superseded by an explicit activation.`,
		})
		if (this.operation === operation) this.operation = null
	}

	private finish(operation: Operation, result: HelmResult<ProfileActivationResult>): void {
		if (!this.isCurrent(operation)) return
		this.clearOperationTimers(operation)
		operation.drainRelease?.()
		this.operation = null
		operation.deferred.resolve(result)
	}

	private isCurrent(operation: Operation): boolean {
		return this.operation === operation && !operation.superseded
	}

	private setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
		return (this.deps.setTimer ?? setTimeout)(callback, ms)
	}

	private clearOperationTimers(operation: Operation): void {
		const clear = this.deps.clearTimer ?? clearTimeout
		if (operation.probeTimer) clear(operation.probeTimer)
		if (operation.diagnosticTimer) clear(operation.diagnosticTimer)
		operation.probeTimer = null
		operation.diagnosticTimer = null
	}
}

export default { ProfileSwitchCoordinator }
