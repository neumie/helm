// Main-process adapter for the journaled terminal-transfer coordinator.
//
// Production IPC supplies an authenticated, controller-backed capability.
// Durable quarantine is independent of that capability and the transient busy bit.

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { BufferStore } from './buffers'
import type { SessionRegistry } from './sessions'
import * as sessions from './sessions'
import type { TerminalTransferEvent, TerminalTransferEventType, TerminalTransferPreflight } from './shared'
import {
	type TerminalMasterRecoveryEvidence,
	type TerminalTransferJournal,
	TerminalTransferJournalStore,
	type TerminalTransferRecoveryObservation,
	attestTerminalTransferMaster,
} from './terminal-transfer'
import {
	type TerminalTransferAdmission,
	TerminalTransferCoordinator,
	type TerminalTransferRecoveryResult,
	type TerminalTransferResult,
} from './terminal-transfer-coordinator'

export interface TerminalTransferProfileStorage {
	registry: SessionRegistry
	buffers: BufferStore
	registryPath: string
	bufferDir: string
}

export interface TerminalTransferProfileRuntime {
	/** Profile-specific storage, never resolved from mutable active-profile state. */
	storageForProfile(profileId: string): TerminalTransferProfileStorage | null
	currentProfile(): { profileId: string; token: string }
}

/**
 * Renderer/main integration contract. The renderer owns its xterm
 * snapshot and attach-client state, while this adapter owns all durable paths.
 * These methods are deliberately supplied by an in-process registration, not
 * an unvalidated renderer callback.
 */
export interface TerminalTransferRendererCapability {
	profileToken: string
	sessionId: string
	/** Prepare returns the only acknowledgement shape accepted by the adapter. */
	dispatch(event: TerminalTransferEvent): Promise<unknown>
}

export interface TerminalTransferMoveRequest {
	sourceProfileId: string
	destinationProfileId: string
	sessionId: string
	/** Renderer-captured profile token; stale tokens cannot authorize a move. */
	profileToken: string
}

/**
 * Read-only IPC-safe input. The target ids come from main's profile registry;
 * this adapter still validates source ownership and target socket constraints.
 */
export interface TerminalTransferPreflightRequest {
	sourceProfileId: string
	sessionId: string
	profileToken: string
	destinationProfileIds: readonly string[]
}

export interface TerminalTransferMainAdapterDeps {
	userDataDir: string
	runtime: TerminalTransferProfileRuntime
	/** Main-only detach of Helm's attach client; never signals the dtach master. */
	detachAttachClient?(sessionId: string): Promise<boolean> | boolean
	/** Reattaches a source client only after a verified rollback. */
	attachSourceClient?(sessionId: string): Promise<boolean> | boolean
	journal?: TerminalTransferJournalStore
	captureMaster?(socketPath: string): Promise<sessions.DtachMasterEvidence | null>
	attestMaster?(socketPath: string, expected: sessions.DtachMasterEvidence): Promise<'verified' | 'dead' | 'unknown'>
	renameSocket?(sourceSocket: string, destinationSocket: string): Promise<void>
	probeSocket?(socketPath: string): Promise<sessions.SocketProbe>
}

/**
 * Main-only application service. Its busy bit is used by main.ts to keep
 * profile switching, quit, and grace-close from interleaving a transfer.
 */
export class TerminalTransferMainAdapter {
	readonly #runtime: TerminalTransferProfileRuntime
	readonly #journal: TerminalTransferJournalStore
	readonly #captureMaster: (socketPath: string) => Promise<sessions.DtachMasterEvidence | null>
	readonly #attestMaster: (
		socketPath: string,
		expected: sessions.DtachMasterEvidence,
	) => Promise<'verified' | 'dead' | 'unknown'>
	readonly #renameSocket: (sourceSocket: string, destinationSocket: string) => Promise<void>
	readonly #probeSocket: (socketPath: string) => Promise<sessions.SocketProbe>
	readonly #detachAttachClient: (sessionId: string) => Promise<boolean>
	readonly #attachSourceClient: (sessionId: string) => Promise<boolean>
	readonly #capabilities = new Map<string, TerminalTransferRendererCapability>()
	readonly #coordinator: TerminalTransferCoordinator
	#activeRequest: TerminalTransferMoveRequest | null = null
	#quarantine: Array<{ profileId: string; sessionId: string }> = []
	#journalUnavailable = false
	#busy = false
	#idleWaiters: Array<() => void> = []

	constructor(deps: TerminalTransferMainAdapterDeps) {
		this.#runtime = deps.runtime
		this.#journal = deps.journal ?? new TerminalTransferJournalStore(deps.userDataDir)
		this.#captureMaster = deps.captureMaster ?? sessions.captureDtachMaster
		this.#attestMaster = deps.attestMaster ?? sessions.attestDtachMaster
		this.#renameSocket =
			deps.renameSocket ?? (async (source, destination) => sessions.renameSocketEntry(source, destination))
		this.#probeSocket = deps.probeSocket ?? sessions.probeSocket
		this.#detachAttachClient = async sessionId => (await deps.detachAttachClient?.(sessionId)) === true
		this.#attachSourceClient = async sessionId => (await deps.attachSourceClient?.(sessionId)) === true
		this.#refreshQuarantine()
		this.#coordinator = new TerminalTransferCoordinator({
			journal: this.#journal,
			runExclusive: async operation => operation(),
			beginAdmission: async sessionId => this.#beginAdmission(sessionId),
			renameSocket: (source, destination) => this.#renameSocket(source, destination),
			attestMaster: journal => this.#attestJournalMaster(journal),
			observeRecovery: journal => this.#observeRecovery(journal),
			cleanupDeadSockets: async journal => this.#cleanupDeadSockets(journal),
		})
	}

	/** At most the two namespace identities of the single durable claim. */
	quarantinedSessions(): { unavailable: boolean; identities: readonly { profileId: string; sessionId: string }[] } {
		this.#refreshQuarantine()
		return { unavailable: this.#journalUnavailable, identities: this.#quarantine.map(identity => ({ ...identity })) }
	}

	isSessionQuarantined(profileId: string, sessionId: string): boolean {
		const exclusion = this.quarantinedSessions()
		return (
			exclusion.unavailable ||
			exclusion.identities.some(identity => identity.profileId === profileId && identity.sessionId === sessionId)
		)
	}

	#refreshQuarantine(): void {
		try {
			const journal = this.#journal.load()
			// Disappearance alone is not recovery evidence.
			if (!journal) return
			const identities = [journal.sourceProfileId, journal.destinationProfileId].map(profileId => ({
				profileId,
				sessionId: journal.sessionId,
			}))
			if (
				this.#quarantine.some(
					old =>
						!identities.some(identity => identity.profileId === old.profileId && identity.sessionId === old.sessionId),
				)
			) {
				this.#journalUnavailable = true
				return
			}
			this.#quarantine = identities
		} catch {
			// Unknown journal identity must fence every ordinary admission.
			this.#journalUnavailable = true
		}
	}

	isBusy(): boolean {
		return this.#busy
	}

	isSessionBusy(sessionId: string): boolean {
		return this.#activeRequest?.sessionId === sessionId
	}

	whenIdle(): Promise<void> {
		return this.#busy ? new Promise(resolve => this.#idleWaiters.push(resolve)) : Promise.resolve()
	}

	/** Registration rejects stale profile tokens and replaces only its own session capability. */
	registerRendererCapability(capability: TerminalTransferRendererCapability): boolean {
		const current = this.#runtime.currentProfile()
		if (
			capability.profileToken !== current.token ||
			!sessions.isValidSessionId(capability.sessionId) ||
			this.isSessionQuarantined(current.profileId, capability.sessionId)
		)
			return false
		this.#capabilities.set(capability.sessionId, capability)
		return true
	}

	unregisterRendererCapability(sessionId: string, capability?: TerminalTransferRendererCapability): void {
		if (!capability || this.#capabilities.get(sessionId) === capability) this.#capabilities.delete(sessionId)
	}

	/**
	 * Non-mutating capability/list-target check for the restricted IPC surface.
	 * It intentionally does not capture a master or register a renderer
	 * capability: move() repeats them through its authenticated
	 * controller-backed snapshot/detach/attach hand-off.
	 */
	preflight(request: TerminalTransferPreflightRequest): TerminalTransferPreflight {
		if (this.#busy || this.isSessionQuarantined(request.sourceProfileId, request.sessionId))
			return { status: 'unavailable', reason: 'busy' }
		const current = this.#runtime.currentProfile()
		if (request.sourceProfileId !== current.profileId || request.profileToken !== current.token)
			return { status: 'unavailable', reason: 'stale-profile' }
		if (!sessions.isValidSessionId(request.sessionId)) return { status: 'unavailable', reason: 'invalid-session' }
		const source = this.#runtime.storageForProfile(request.sourceProfileId)
		const sourceMeta = source?.registry.get(request.sessionId)
		if (!sourceMeta) return { status: 'unavailable', reason: 'missing-source' }
		if ((sourceMeta.backing ?? 'ordinary') === 'run-owned') return { status: 'unavailable', reason: 'run-owned' }
		const targetProfileIds = [...new Set(request.destinationProfileIds)].filter(
			profileId =>
				profileId !== request.sourceProfileId &&
				sessions.isValidSessionProfileId(profileId) &&
				this.#runtime.storageForProfile(profileId) !== null &&
				sessions.socketPathUsable(sessions.socketPathForProfile(profileId, request.sessionId)),
		)
		return targetProfileIds.length > 0
			? { status: 'available', targetProfileIds }
			: { status: 'unavailable', reason: 'no-targets' }
	}

	async move(request: TerminalTransferMoveRequest): Promise<TerminalTransferResult> {
		if (this.#busy) return { status: 'busy' }
		if (
			this.isSessionQuarantined(request.sourceProfileId, request.sessionId) ||
			this.isSessionQuarantined(request.destinationProfileId, request.sessionId)
		)
			return { status: 'rejected', reason: 'admission-unavailable' }
		const current = this.#runtime.currentProfile()
		const capability = this.#capabilities.get(request.sessionId)
		// Moves are source-active only. A detached/parked destination needs a
		// later renderer handoff; do not guess at renderer ownership here.
		if (
			request.sourceProfileId !== current.profileId ||
			request.profileToken !== current.token ||
			capability?.profileToken !== current.token
		) {
			return { status: 'rejected', reason: 'admission-unavailable' }
		}
		const source = this.#runtime.storageForProfile(request.sourceProfileId)
		const destination = this.#runtime.storageForProfile(request.destinationProfileId)
		if (!source || !destination || !sessions.isValidSessionId(request.sessionId)) {
			return { status: 'rejected', reason: 'admission-unavailable' }
		}
		const sourceSocket = sessions.socketPathForProfile(request.sourceProfileId, request.sessionId)
		const destinationSocket = sessions.socketPathForProfile(request.destinationProfileId, request.sessionId)
		if (!sessions.socketPathUsable(destinationSocket)) return { status: 'rejected', reason: 'admission-unavailable' }

		return this.#runBusy(async () => {
			this.#activeRequest = request
			try {
				// Busy/profile-switch/grace-close fencing is already active before
				// this first await; captured ownership may not race another mutation.
				const master = await this.#captureMaster(sourceSocket)
				if (!master) return { status: 'rejected', reason: 'admission-unavailable' }
				return await this.#coordinator.move({
					sourceProfileId: request.sourceProfileId,
					destinationProfileId: request.destinationProfileId,
					sessionId: request.sessionId,
					sourceSocket,
					destinationSocket,
					sourceRegistry: source.registry,
					destinationRegistry: destination.registry,
					sourceBuffers: source.buffers,
					destinationBuffers: destination.buffers,
					sourceBufferPath: path.join(source.bufferDir, `${request.sessionId}.bin`),
					destinationBufferPath: path.join(destination.bufferDir, `${request.sessionId}.bin`),
					master: {
						...master,
						originalSocketPath: sourceSocket,
						currentSocketPath: sourceSocket,
					},
				})
			} finally {
				this.#activeRequest = null
			}
		})
	}

	/** Run before the first sessions:list request; uncertain recovery stays journaled and fenced. */
	async recoverStartup(): Promise<TerminalTransferRecoveryResult> {
		if (this.#busy) return { status: 'busy' }
		return this.#runBusy(async () => {
			this.#refreshQuarantine()
			const result = await this.#coordinator.recoverStartup()
			if (result.status === 'recovered' && result.action === 'remove-completed-journal' && !this.#journalUnavailable)
				this.#quarantine = []
			return result
		})
	}

	async #runBusy<T>(operation: () => Promise<T>): Promise<T> {
		this.#busy = true
		try {
			return await operation()
		} finally {
			this.#refreshQuarantine()
			this.#busy = false
			const waiters = this.#idleWaiters.splice(0)
			for (const resolve of waiters) resolve()
		}
	}

	async #beginAdmission(sessionId: string): Promise<TerminalTransferAdmission | null> {
		const capability = this.#capabilities.get(sessionId)
		const current = this.#runtime.currentProfile()
		const request = this.#activeRequest
		if (!capability || !request || capability.profileToken !== current.token || request.sessionId !== sessionId)
			return null
		const transactionId = crypto.randomUUID()
		const event = (type: TerminalTransferEventType): TerminalTransferEvent => ({
			type,
			transactionId,
			sessionId,
			sourceProfileId: request.sourceProfileId,
			destinationProfileId: request.destinationProfileId,
			profileToken: request.profileToken,
		})
		let released = false
		const snapshot = async (type: 'prepare' | 'checkpoint') => {
			const acknowledgement = await capability.dispatch(event(type))
			if (!isPrepareAcknowledgement(acknowledgement))
				return { snapshotFlushed: false, activity: { agentRunning: false, agentAttention: false } }
			const metadata = acknowledgement.prepared.metadata
			return {
				snapshotFlushed: true,
				activity: { agentRunning: metadata.agentRunning, agentAttention: metadata.agentAttention },
			}
		}
		return {
			prepare: () => snapshot('prepare'),
			detachAttachClient: async () => {
				if (!(await this.#detachAttachClient(sessionId))) throw new Error('source attach client is unavailable')
			},
			checkpoint: () => snapshot('checkpoint'),
			commitSource: async () => {
				if (!isCompletionAcknowledgement(await capability.dispatch(event('commit')), 'committed'))
					throw new Error('source renderer did not commit the transfer')
			},
			rollbackSource: async () => {
				if (!isCompletionAcknowledgement(await capability.dispatch(event('rollback')), 'rolled-back'))
					throw new Error('source renderer did not roll back the transfer')
			},
			attachSourceClient: async () => {
				if (!(await this.#attachSourceClient(sessionId))) throw new Error('source attach client could not be restored')
			},
			release: ({ quarantined }) => {
				if (released) return
				released = true
				this.#capabilities.delete(sessionId)
				if (!quarantined && !this.#journalUnavailable) this.#quarantine = []
				else this.#refreshQuarantine()
			},
		}
	}

	async #attestJournalMaster(journal: TerminalTransferJournal): Promise<TerminalMasterRecoveryEvidence> {
		const result = await this.#attestMaster(journal.master.currentSocketPath, journal.master)
		if (result === 'dead') return { state: 'dead' }
		if (result !== 'verified') return { state: 'unknown' }
		return {
			state: 'present',
			pid: journal.master.pid,
			processStartFingerprint: journal.master.processStartFingerprint,
			originalSocketPath: journal.master.originalSocketPath,
			currentSocketPath: journal.master.currentSocketPath,
		}
	}

	async #observeRecovery(journal: TerminalTransferJournal): Promise<TerminalTransferRecoveryObservation> {
		const source = this.#runtime.storageForProfile(journal.sourceProfileId)
		const destination = this.#runtime.storageForProfile(journal.destinationProfileId)
		const sourceSocket = sessions.socketPathForProfile(journal.sourceProfileId, journal.sessionId)
		const destinationSocket = sessions.socketPathForProfile(journal.destinationProfileId, journal.sessionId)
		const pathsMatch =
			source !== null &&
			destination !== null &&
			journal.sourceSocket === sourceSocket &&
			journal.destinationSocket === destinationSocket &&
			journal.sourceRegistryPath === source.registryPath &&
			journal.destinationRegistryPath === destination.registryPath &&
			journal.sourceBufferPath === path.join(source.bufferDir, `${journal.sessionId}.bin`) &&
			journal.destinationBufferPath === path.join(destination.bufferDir, `${journal.sessionId}.bin`)
		if (!pathsMatch || !source || !destination) {
			return {
				masterOwnership: 'mismatch',
				sourceSocket: 'unknown',
				destinationSocket: 'unknown',
				sourceRegistryHasSession: false,
				destinationRegistryHasSession: false,
				sourceBufferPresent: false,
				destinationBufferPresent: false,
			}
		}
		const masterOwnership = attestTerminalTransferMaster(journal, await this.#attestJournalMaster(journal))
		return {
			masterOwnership,
			sourceSocket: await this.#probeSocket(sourceSocket),
			destinationSocket: await this.#probeSocket(destinationSocket),
			sourceRegistryHasSession: source.registry.get(journal.sessionId) !== undefined,
			destinationRegistryHasSession: destination.registry.get(journal.sessionId) !== undefined,
			sourceBufferPresent: fs.existsSync(journal.sourceBufferPath),
			destinationBufferPresent: fs.existsSync(journal.destinationBufferPath),
		}
	}

	async #cleanupDeadSockets(journal: TerminalTransferJournal): Promise<void> {
		for (const socket of [journal.sourceSocket, journal.destinationSocket]) {
			if ((await this.#probeSocket(socket)) !== 'dead') continue
			try {
				fs.unlinkSync(socket)
			} catch {
				// A recovery race may already have removed it. Unknown never reaches here.
			}
		}
	}
}

function isCompletionAcknowledgement(value: unknown, status: 'committed' | 'rolled-back'): boolean {
	return Boolean(value && typeof value === 'object' && (value as { status?: unknown }).status === status)
}

function isPrepareAcknowledgement(
	value: unknown,
): value is { status: 'prepared'; prepared: { metadata: { agentRunning: boolean; agentAttention: boolean } } } {
	if (!value || typeof value !== 'object') return false
	const candidate = value as Record<string, unknown>
	// Renderer controller returns { status, prepared: { metadata } }; retain this
	// narrow decoding here so the coordinator never sees renderer DOM state.
	const metadata =
		candidate.status === 'prepared' && candidate.prepared && typeof candidate.prepared === 'object'
			? (candidate.prepared as { metadata?: unknown }).metadata
			: undefined
	if (!metadata || typeof metadata !== 'object') return false
	const activity = metadata as Record<string, unknown>
	return typeof activity.agentRunning === 'boolean' && typeof activity.agentAttention === 'boolean'
}
