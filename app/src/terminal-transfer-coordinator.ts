// Journaled, main-process-only terminal transfer application service.
//
// The transfer foundation owns durable records and recovery *decisions*. This
// coordinator owns the ordered side effects around them, behind narrow
// injected adapters so it remains deliberately unexposed to IPC/UI code.

import type { BufferMoveResult, BufferStore } from './buffers'
import type { SessionMeta, SessionRegistry } from './sessions'
import {
	type TerminalMasterRecoveryEvidence,
	type TerminalTransferJournal,
	type TerminalTransferJournalStore,
	type TerminalTransferRecoveryObservation,
	attestTerminalTransferMaster,
	decideTerminalTransferRecovery,
} from './terminal-transfer'

export interface TerminalTransferActivity {
	agentRunning: boolean
	agentAttention: boolean
}

/** The renderer/main admission fence must stay closed until release(). */
export interface TerminalTransferAdmission {
	/** Flushes the renderer-owned snapshot and returns a post-flush acknowledgement. */
	prepare(): Promise<{ snapshotFlushed: boolean; activity: TerminalTransferActivity }>
	/** Detaches only Helm's dtach attach client; it must never signal the master. */
	detachAttachClient(): Promise<void>
	/** Re-snapshots after the attach client has exited, establishing the stable final screen boundary. */
	checkpoint(): Promise<{ snapshotFlushed: boolean; activity: TerminalTransferActivity }>
	/** Remove/dispose the source renderer tab only after durable ownership commits. */
	commitSource(): Promise<void>
	/** Restores the source renderer tab after a reversible rollback. */
	rollbackSource(): Promise<void>
	/** Restores the source attach client after a reversible rollback. */
	attachSourceClient(): Promise<void>
	/** Reopens normal terminal admission, or keeps the session fenced when quarantined. */
	release(options: { quarantined: boolean }): void
}

export interface TerminalTransferCoordinatorDeps {
	journal: TerminalTransferJournalStore
	/** Global/process-local serialization; this must cover recovery as well as a new move. */
	runExclusive<T>(operation: () => Promise<T>): Promise<T>
	/** Closes PTY/session/buffer admission and waits for already-admitted work. */
	beginAdmission(sessionId: string): Promise<TerminalTransferAdmission | null>
	/** Renames a namespace entry only; it must not kill or recreate the dtach master. */
	renameSocket(sourceSocket: string, destinationSocket: string): Promise<void>
	/** PID/start-fingerprint attestation, never destination lsof alone. */
	attestMaster(journal: TerminalTransferJournal): Promise<TerminalMasterRecoveryEvidence>
	/** Performs a fail-closed startup observation for the supplied durable claim. */
	observeRecovery(journal: TerminalTransferJournal): Promise<TerminalTransferRecoveryObservation>
	/** Removes only socket directory entries already proven dead by recovery. */
	cleanupDeadSockets(journal: TerminalTransferJournal): Promise<void>
}

export interface TerminalTransferRequest {
	sourceProfileId: string
	destinationProfileId: string
	sessionId: string
	sourceSocket: string
	destinationSocket: string
	sourceRegistry: SessionRegistry
	destinationRegistry: SessionRegistry
	sourceBuffers: BufferStore
	destinationBuffers: BufferStore
	sourceBufferPath: string
	destinationBufferPath: string
	/** Captured from the source namespace before the transfer claim is written. */
	master: TerminalTransferJournal['master']
}

export type TerminalTransferResult =
	| { status: 'moved'; journal: TerminalTransferJournal }
	| { status: 'busy' }
	| {
			status: 'rejected'
			reason: 'same-profile' | 'missing-source' | 'run-owned' | 'collision' | 'admission-unavailable'
	  }
	| { status: 'quarantined'; journal: TerminalTransferJournal; reason: string }

export type TerminalTransferRecoveryResult =
	| { status: 'none' }
	| { status: 'busy' }
	| { status: 'recovered'; action: string }
	| { status: 'quarantined'; reason: string }

/**
 * The sole effectful terminal-transfer seam. It treats any uncertain ownership,
 * failed prepare acknowledgement, or failed post-rename attestation as a
 * quarantine—not as permission to recreate, unlink, or attach another client.
 */
export class TerminalTransferCoordinator {
	readonly #deps: TerminalTransferCoordinatorDeps
	#busy = false
	readonly #releasedAdmissions = new WeakSet<TerminalTransferAdmission>()

	constructor(deps: TerminalTransferCoordinatorDeps) {
		this.#deps = deps
	}

	async move(request: TerminalTransferRequest): Promise<TerminalTransferResult> {
		if (this.#busy) return { status: 'busy' }
		this.#busy = true
		try {
			return await this.#deps.runExclusive(() => this.#moveExclusive(request))
		} finally {
			this.#busy = false
		}
	}

	async recoverStartup(): Promise<TerminalTransferRecoveryResult> {
		if (this.#busy) return { status: 'busy' }
		this.#busy = true
		try {
			return await this.#deps.runExclusive(() => this.#recoverExclusive())
		} finally {
			this.#busy = false
		}
	}

	async #moveExclusive(request: TerminalTransferRequest): Promise<TerminalTransferResult> {
		if (request.sourceProfileId === request.destinationProfileId) return { status: 'rejected', reason: 'same-profile' }
		const sourceMeta = request.sourceRegistry.get(request.sessionId)
		if (!sourceMeta) return { status: 'rejected', reason: 'missing-source' }
		if ((sourceMeta.backing ?? 'ordinary') === 'run-owned') return { status: 'rejected', reason: 'run-owned' }
		if (request.destinationRegistry.get(request.sessionId)) return { status: 'rejected', reason: 'collision' }

		const journal = this.#deps.journal.claim({
			sourceProfileId: request.sourceProfileId,
			destinationProfileId: request.destinationProfileId,
			sessionId: request.sessionId,
			sourceSocket: request.sourceSocket,
			destinationSocket: request.destinationSocket,
			sourceRegistryPath: request.sourceRegistry.filePath,
			destinationRegistryPath: request.destinationRegistry.filePath,
			sourceBufferPath: request.sourceBufferPath,
			destinationBufferPath: request.destinationBufferPath,
			sourceMeta: structuredClone(sourceMeta),
			master: structuredClone(request.master),
		})
		if (!journal) return { status: 'busy' }

		const admission = await this.#deps.beginAdmission(request.sessionId)
		if (!admission) return this.#quarantine(journal, 'terminal admission is unavailable')
		let fenced = true
		let movedSocket = false
		let movedBuffer = false
		try {
			const prepared = await admission.prepare()
			if (!prepared.snapshotFlushed || !sameActivity(prepared.activity, sourceMeta)) {
				return this.#quarantine(journal, 'snapshot/activity prepare acknowledgement is incomplete', admission)
			}
			let current = this.#deps.journal.update(journal, 'snapshot-flushed')
			await admission.detachAttachClient()
			current = this.#deps.journal.update(current, 'client-detached')
			const checkpoint = await admission.checkpoint()
			if (!checkpoint.snapshotFlushed) {
				return this.#quarantine(current, 'stable post-detach snapshot acknowledgement is incomplete', admission)
			}
			request.sourceRegistry.setActivity(request.sessionId, checkpoint.activity)
			if (attestTerminalTransferMaster(current, await this.#deps.attestMaster(current)) !== 'verified') {
				return this.#quarantine(current, 'master attestation failed before socket rename', admission)
			}
			await this.#deps.renameSocket(current.sourceSocket, current.destinationSocket)
			movedSocket = true
			current = this.#deps.journal.update(current, 'socket-moved')
			if (attestTerminalTransferMaster(current, await this.#deps.attestMaster(current)) !== 'verified') {
				return this.#quarantine(current, 'master attestation failed after socket rename', admission)
			}

			const bufferResult = request.sourceBuffers.moveTo(request.destinationBuffers, request.sessionId)
			if (bufferResult === 'moved') movedBuffer = true
			if (!isAcceptableBufferMove(bufferResult)) {
				return await this.#rollbackOrQuarantine(
					current,
					request,
					admission,
					movedSocket,
					movedBuffer,
					`buffer move ${bufferResult}`,
				)
			}
			const registryResult = request.sourceRegistry.transferTo(request.destinationRegistry, request.sessionId)
			if (registryResult.status !== 'moved') {
				return await this.#rollbackOrQuarantine(
					current,
					request,
					admission,
					movedSocket,
					movedBuffer,
					`registry move ${registryResult.status}`,
				)
			}
			current = this.#deps.journal.update(current, 'registries-committed')
			// The target profile may be inactive. It owns a parked registry entry,
			// not an attach client in this source renderer.
			await admission.commitSource()
			this.#deps.journal.complete(current)
			this.#releaseAdmission(admission, false)
			fenced = false
			return { status: 'moved', journal: current }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const active = this.#deps.journal.load() ?? journal
			return this.#quarantine(active, `transfer effect failed: ${message}`, admission)
		} finally {
			if (fenced) this.#releaseAdmission(admission, true)
		}
	}

	async #rollbackOrQuarantine(
		journal: TerminalTransferJournal,
		request: TerminalTransferRequest,
		admission: TerminalTransferAdmission,
		movedSocket: boolean,
		movedBuffer: boolean,
		reason: string,
	): Promise<TerminalTransferResult> {
		const rollback = this.#deps.journal.update(journal, 'rollback-needed')
		if (
			!movedSocket ||
			attestTerminalTransferMaster(rollback, await this.#deps.attestMaster(rollback)) !== 'verified'
		) {
			return this.#quarantine(rollback, `${reason}; rollback ownership is not verified`, admission)
		}
		try {
			await this.#deps.renameSocket(rollback.destinationSocket, rollback.sourceSocket)
			const restored = this.#deps.journal.update(rollback, 'client-detached')
			if (attestTerminalTransferMaster(restored, await this.#deps.attestMaster(restored)) !== 'verified') {
				return this.#quarantine(restored, `${reason}; source ownership is not verified after rollback`, admission)
			}
			if (movedBuffer && request.destinationBuffers.moveTo(request.sourceBuffers, request.sessionId) !== 'moved') {
				return this.#quarantine(restored, `${reason}; buffer rollback failed`, admission)
			}
			await admission.attachSourceClient()
			await admission.rollbackSource()
			this.#deps.journal.complete(restored)
			this.#releaseAdmission(admission, false)
			return { status: 'quarantined', journal: restored, reason: `${reason}; source transfer rolled back` }
		} catch (error) {
			return this.#quarantine(
				rollback,
				`${reason}; rollback failed: ${error instanceof Error ? error.message : String(error)}`,
				admission,
			)
		}
	}

	async #recoverExclusive(): Promise<TerminalTransferRecoveryResult> {
		const journal = this.#deps.journal.load()
		if (!journal) return { status: 'none' }
		const decision = decideTerminalTransferRecovery(journal, await this.#deps.observeRecovery(journal))
		if (decision.action === 'remove-completed-journal') {
			this.#deps.journal.complete(journal)
			return { status: 'recovered', action: decision.action }
		}
		if (decision.action === 'cleanup-dead-sockets') {
			await this.#deps.cleanupDeadSockets(journal)
			return { status: 'recovered', action: decision.action }
		}
		// Repair/rollback/reattach require live main-process session adapters and
		// therefore remain journaled and fenced until that owner explicitly acts.
		return { status: 'quarantined', reason: decision.reason }
	}

	#quarantine(
		journal: TerminalTransferJournal,
		reason: string,
		admission?: TerminalTransferAdmission,
	): TerminalTransferResult {
		const quarantined =
			journal.state === 'rollback-needed' ? journal : this.#deps.journal.update(journal, 'rollback-needed')
		if (admission) this.#releaseAdmission(admission, true)
		return { status: 'quarantined', journal: quarantined, reason }
	}

	#releaseAdmission(admission: TerminalTransferAdmission, quarantined: boolean): void {
		if (this.#releasedAdmissions.has(admission)) return
		this.#releasedAdmissions.add(admission)
		admission.release({ quarantined })
	}
}

function sameActivity(activity: TerminalTransferActivity, meta: SessionMeta): boolean {
	return (
		activity.agentRunning === (meta.agentRunning === true) && activity.agentAttention === (meta.agentAttention === true)
	)
}

function isAcceptableBufferMove(result: BufferMoveResult): boolean {
	// A session without a renderer snapshot is valid; all other outcomes mean
	// destination ownership was not established without copying bytes.
	return result === 'moved' || result === 'missing'
}
