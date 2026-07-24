// Renderer-only terminal-transfer transaction controller.
//
// This deliberately knows nothing about IPC, PTYs, DOM nodes, or profile
// switching. Its caller supplies the small terminal lifecycle operations and
// carries a profile token on every transaction operation. Keeping this seam
// pure lets the eventual bridge fence renderer work before main moves durable
// session ownership.

export interface TerminalTransferRendererActivity {
	agentRunning: boolean
	agentAttention: boolean
}

/** Renderer truth that must survive a source terminal being replaced elsewhere. */
export interface TerminalTransferRendererMetadata extends TerminalTransferRendererActivity {
	/** Current visible title after title arbitration. */
	title: string
	/** Raw title used for the unpinned tooltip. */
	titleRaw: string
	/** Latest normalized OSC title, including one suppressed by a manual pin. */
	oscTitle: string | null
	/** Latest raw OSC title, including one suppressed by a manual pin. */
	oscRaw: string | null
	/** Manual title pin; null means OSC title following is active. */
	customName: string | null
}

export interface TerminalTransferSnapshotAcknowledgement {
	snapshotFlushed: boolean
}

export interface TerminalTransferRendererControllerDeps {
	/** The active renderer namespace token; a caller token must equal this exactly. */
	currentProfileToken(): string
	/** Stop source-tab mutation before its snapshot/title state is read. */
	freeze(sessionId: string): void | Promise<void>
	/** Persist the source xterm buffer and acknowledge that persistence completed. */
	saveSnapshot(
		sessionId: string,
	): boolean | TerminalTransferSnapshotAcknowledgement | Promise<boolean | TerminalTransferSnapshotAcknowledgement>
	/** Return null when the source tab/session is no longer renderer-owned. */
	metadata(
		sessionId: string,
	): TerminalTransferRendererMetadata | null | Promise<TerminalTransferRendererMetadata | null>
	/** Remove only the prepared source terminal after the durable move committed. */
	dispose(sessionId: string): void | Promise<void>
	/** Reopen the source terminal after a failed or abandoned move. */
	unfreeze(sessionId: string): void | Promise<void>
}

export interface TerminalTransferRendererRequest {
	transactionId: string
	sessionId: string
	profileToken: string
}

/** Opaque-to-callers prepared state; metadata is copied before it is returned. */
export interface PreparedTerminalTransfer extends TerminalTransferRendererRequest {
	metadata: TerminalTransferRendererMetadata
}

export type TerminalTransferRendererRejectReason =
	| 'stale-profile-token'
	| 'duplicate-transaction'
	| 'duplicate-session'
	| 'missing-terminal'
	| 'freeze-failed'
	| 'snapshot-not-flushed'
	| 'snapshot-failed'
	| 'metadata-failed'
	| 'dispose-failed'
	| 'rollback-failed'
	| 'unknown-transaction'
	| 'transaction-mismatch'
	| 'transaction-in-progress'

export type TerminalTransferRendererPrepareResult =
	| { status: 'prepared'; prepared: PreparedTerminalTransfer }
	| { status: 'rejected'; reason: TerminalTransferRendererRejectReason }

export type TerminalTransferRendererCompletionResult =
	| { status: 'committed'; prepared: PreparedTerminalTransfer }
	| { status: 'rolled-back'; prepared: PreparedTerminalTransfer | null }
	| { status: 'rejected'; reason: TerminalTransferRendererRejectReason }

type PreparedRecord = {
	prepared: PreparedTerminalTransfer
	phase: 'preparing' | 'cleanup-pending' | 'prepared' | 'releasing'
}

/**
 * Tracks only source renderer state. A successful commit intentionally creates
 * no terminal/tab: the destination owner decides whether it attaches one, so a
 * source profile with zero remaining tabs is valid.
 */
export class TerminalTransferRendererController {
	readonly #deps: TerminalTransferRendererControllerDeps
	readonly #transactions = new Map<string, PreparedRecord>()
	readonly #transactionBySession = new Map<string, string>()

	constructor(deps: TerminalTransferRendererControllerDeps) {
		this.#deps = deps
	}

	async prepare(request: TerminalTransferRendererRequest): Promise<TerminalTransferRendererPrepareResult> {
		if (!this.#hasCurrentToken(request.profileToken)) return { status: 'rejected', reason: 'stale-profile-token' }
		if (this.#transactions.has(request.transactionId)) return { status: 'rejected', reason: 'duplicate-transaction' }
		if (this.#transactionBySession.has(request.sessionId)) return { status: 'rejected', reason: 'duplicate-session' }

		// Reserve before awaiting any renderer callback so reentrant/concurrent
		// prepare calls cannot snapshot or freeze the same terminal twice.
		const placeholder: PreparedRecord = {
			prepared: { ...request, metadata: emptyMetadata() },
			phase: 'preparing',
		}
		this.#transactions.set(request.transactionId, placeholder)
		this.#transactionBySession.set(request.sessionId, request.transactionId)

		try {
			await this.#deps.freeze(request.sessionId)
		} catch {
			this.#forget(placeholder)
			return { status: 'rejected', reason: 'freeze-failed' }
		}

		let acknowledgement: boolean | TerminalTransferSnapshotAcknowledgement
		try {
			acknowledgement = await this.#deps.saveSnapshot(request.sessionId)
		} catch {
			return this.#rejectAfterFreeze(placeholder, 'snapshot-failed')
		}
		if (!snapshotFlushed(acknowledgement)) return this.#rejectAfterFreeze(placeholder, 'snapshot-not-flushed')

		let metadata: TerminalTransferRendererMetadata | null
		try {
			metadata = await this.#deps.metadata(request.sessionId)
		} catch {
			return this.#rejectAfterFreeze(placeholder, 'metadata-failed')
		}
		if (metadata === null) return this.#rejectAfterFreeze(placeholder, 'missing-terminal')

		const prepared: PreparedTerminalTransfer = { ...request, metadata: copyMetadata(metadata) }
		placeholder.prepared = prepared
		placeholder.phase = 'prepared'
		return { status: 'prepared', prepared }
	}

	async commit(request: TerminalTransferRendererRequest): Promise<TerminalTransferRendererCompletionResult> {
		const record = this.#completionRecord(request, false)
		if ('reason' in record) return { status: 'rejected', reason: record.reason }
		if (!this.#hasCurrentToken(request.profileToken)) {
			if (!(await this.#rollbackStale(record))) return { status: 'rejected', reason: 'rollback-failed' }
			return { status: 'rejected', reason: 'stale-profile-token' }
		}
		record.phase = 'releasing'
		try {
			await this.#deps.dispose(record.prepared.sessionId)
			this.#forget(record)
			return { status: 'committed', prepared: record.prepared }
		} catch {
			return this.#rejectAfterFreeze(record, 'dispose-failed')
		}
	}

	async rollback(request: TerminalTransferRendererRequest): Promise<TerminalTransferRendererCompletionResult> {
		const record = this.#completionRecord(request, true)
		if ('reason' in record) return { status: 'rejected', reason: record.reason }
		if (!this.#hasCurrentToken(request.profileToken)) {
			if (!(await this.#rollbackStale(record))) return { status: 'rejected', reason: 'rollback-failed' }
			return { status: 'rejected', reason: 'stale-profile-token' }
		}
		const prepared = record.phase === 'prepared' ? record.prepared : null
		try {
			await this.#release(record)
			return { status: 'rolled-back', prepared }
		} catch {
			return { status: 'rejected', reason: 'rollback-failed' }
		}
	}

	#completionRecord(
		request: TerminalTransferRendererRequest,
		allowCleanupPending: boolean,
	): PreparedRecord | { reason: TerminalTransferRendererRejectReason } {
		const record = this.#transactions.get(request.transactionId)
		if (!record) return { reason: 'unknown-transaction' }
		if (record.phase !== 'prepared' && !(allowCleanupPending && record.phase === 'cleanup-pending'))
			return { reason: 'transaction-in-progress' }
		if (record.prepared.sessionId !== request.sessionId || record.prepared.profileToken !== request.profileToken)
			return { reason: 'transaction-mismatch' }
		return record
	}

	async #rollbackStale(record: PreparedRecord): Promise<boolean> {
		try {
			await this.#release(record)
			return true
		} catch {
			return false
		}
	}

	async #rejectAfterFreeze(
		record: PreparedRecord,
		reason: TerminalTransferRendererRejectReason,
	): Promise<{ status: 'rejected'; reason: TerminalTransferRendererRejectReason }> {
		try {
			await this.#release(record, record.phase === 'releasing')
			return { status: 'rejected', reason }
		} catch {
			return { status: 'rejected', reason: 'rollback-failed' }
		}
	}

	async #release(record: PreparedRecord, continueRelease = false): Promise<void> {
		if (record.phase === 'releasing' && !continueRelease)
			throw new Error('terminal transfer release already in progress')
		const priorPhase = record.phase === 'releasing' ? 'prepared' : record.phase
		record.phase = 'releasing'
		try {
			await this.#deps.unfreeze(record.prepared.sessionId)
			this.#forget(record)
		} catch (error) {
			// Failed preparation cleanup is rollback-only: placeholder metadata was
			// never completed, so commit must remain impossible. Other cleanup
			// failures return to their prepared phase for an explicit retry.
			record.phase = priorPhase === 'preparing' ? 'cleanup-pending' : priorPhase
			throw error
		}
	}

	#forget(record: PreparedRecord): void {
		this.#transactions.delete(record.prepared.transactionId)
		if (this.#transactionBySession.get(record.prepared.sessionId) === record.prepared.transactionId)
			this.#transactionBySession.delete(record.prepared.sessionId)
	}

	#hasCurrentToken(token: string): boolean {
		return token === this.#deps.currentProfileToken()
	}
}

function snapshotFlushed(value: boolean | TerminalTransferSnapshotAcknowledgement): boolean {
	return value === true || (typeof value === 'object' && value.snapshotFlushed === true)
}

function emptyMetadata(): TerminalTransferRendererMetadata {
	return {
		title: '',
		titleRaw: '',
		oscTitle: null,
		oscRaw: null,
		customName: null,
		agentRunning: false,
		agentAttention: false,
	}
}

function copyMetadata(metadata: TerminalTransferRendererMetadata): TerminalTransferRendererMetadata {
	return {
		title: metadata.title,
		titleRaw: metadata.titleRaw,
		oscTitle: metadata.oscTitle,
		oscRaw: metadata.oscRaw,
		customName: metadata.customName,
		agentRunning: metadata.agentRunning,
		agentAttention: metadata.agentAttention,
	}
}
