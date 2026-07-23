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
	| { status: 'rolled-back'; prepared: PreparedTerminalTransfer }
	| { status: 'rejected'; reason: TerminalTransferRendererRejectReason }

type PreparedRecord = {
	prepared: PreparedTerminalTransfer
	phase: 'prepared' | 'releasing'
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
			phase: 'prepared',
		}
		this.#transactions.set(request.transactionId, placeholder)
		this.#transactionBySession.set(request.sessionId, request.transactionId)

		let frozen = false
		try {
			await this.#deps.freeze(request.sessionId)
			frozen = true
			const acknowledgement = await this.#deps.saveSnapshot(request.sessionId)
			if (!snapshotFlushed(acknowledgement)) {
				await this.#release(placeholder)
				return { status: 'rejected', reason: 'snapshot-not-flushed' }
			}
			const metadata = await this.#deps.metadata(request.sessionId)
			if (metadata === null) {
				await this.#release(placeholder)
				return { status: 'rejected', reason: 'missing-terminal' }
			}
			const prepared: PreparedTerminalTransfer = { ...request, metadata: copyMetadata(metadata) }
			placeholder.prepared = prepared
			return { status: 'prepared', prepared }
		} catch {
			if (frozen) {
				try {
					await this.#release(placeholder)
				} catch {
					return { status: 'rejected', reason: 'rollback-failed' }
				}
			}
			this.#forget(placeholder)
			return { status: 'rejected', reason: frozen ? 'snapshot-failed' : 'metadata-failed' }
		}
	}

	async commit(request: TerminalTransferRendererRequest): Promise<TerminalTransferRendererCompletionResult> {
		const record = this.#completionRecord(request)
		if ('reason' in record) return { status: 'rejected', reason: record.reason }
		if (!this.#hasCurrentToken(request.profileToken)) {
			await this.#rollbackStale(record)
			return { status: 'rejected', reason: 'stale-profile-token' }
		}
		record.phase = 'releasing'
		try {
			await this.#deps.dispose(record.prepared.sessionId)
			this.#forget(record)
			return { status: 'committed', prepared: record.prepared }
		} catch {
			try {
				await this.#release(record)
			} catch {
				return { status: 'rejected', reason: 'rollback-failed' }
			}
			return { status: 'rejected', reason: 'dispose-failed' }
		}
	}

	async rollback(request: TerminalTransferRendererRequest): Promise<TerminalTransferRendererCompletionResult> {
		const record = this.#completionRecord(request)
		if ('reason' in record) return { status: 'rejected', reason: record.reason }
		if (!this.#hasCurrentToken(request.profileToken)) {
			await this.#rollbackStale(record)
			return { status: 'rejected', reason: 'stale-profile-token' }
		}
		try {
			await this.#release(record)
			return { status: 'rolled-back', prepared: record.prepared }
		} catch {
			return { status: 'rejected', reason: 'rollback-failed' }
		}
	}

	#completionRecord(
		request: TerminalTransferRendererRequest,
	): PreparedRecord | { reason: TerminalTransferRendererRejectReason } {
		const record = this.#transactions.get(request.transactionId)
		if (!record) return { reason: 'unknown-transaction' }
		if (record.phase !== 'prepared') return { reason: 'transaction-in-progress' }
		if (record.prepared.sessionId !== request.sessionId || record.prepared.profileToken !== request.profileToken)
			return { reason: 'transaction-mismatch' }
		return record
	}

	async #rollbackStale(record: PreparedRecord): Promise<void> {
		try {
			await this.#release(record)
		} catch {
			// The stale caller is rejected regardless. The injection boundary owns
			// reporting an unfreeze failure to the profile-switch fence.
		}
	}

	async #release(record: PreparedRecord): Promise<void> {
		if (record.phase === 'releasing') throw new Error('terminal transfer release already in progress')
		record.phase = 'releasing'
		await this.#deps.unfreeze(record.prepared.sessionId)
		this.#forget(record)
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
