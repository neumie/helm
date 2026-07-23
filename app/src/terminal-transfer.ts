// Cross-profile terminal transfer foundation (main process only; intentionally
// not wired to IPC yet). This module owns durable claim records and pure crash
// recovery decisions, never terminal/process operations themselves.

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SessionMeta, SocketProbe } from './sessions'

export type TerminalTransferState =
	| 'claimed'
	| 'snapshot-flushed'
	| 'client-detached'
	| 'socket-moved'
	| 'registries-committed'
	| 'completed'
	| 'rollback-needed'

/**
 * Dtach keeps its original pathname in argv after a socket directory entry is
 * renamed on macOS. Never rediscover a moved master solely through destination
 * `lsof`; retain the original path and a process-start fingerprint instead.
 */
export interface TerminalMasterIdentity {
	pid: number
	processStartFingerprint: string
	originalSocketPath: string
	currentSocketPath: string
}

export interface TerminalTransferJournal {
	version: 1
	transferId: string
	state: TerminalTransferState
	sourceProfileId: string
	destinationProfileId: string
	sessionId: string
	sourceSocket: string
	destinationSocket: string
	sourceRegistryPath: string
	destinationRegistryPath: string
	sourceBufferPath: string
	destinationBufferPath: string
	sourceMeta: SessionMeta
	master: TerminalMasterIdentity
	startedAt: string
}

export function terminalTransferJournalPath(userDataDir: string): string {
	return path.join(userDataDir, 'terminal-transfer-journal.json')
}

/** Atomic, app-global transfer claim storage. It must not live in either profile. */
export class TerminalTransferJournalStore {
	readonly #file: string

	constructor(userDataDirOrFile: string, fileIsExplicit = false) {
		this.#file = fileIsExplicit ? userDataDirOrFile : terminalTransferJournalPath(userDataDirOrFile)
	}

	get filePath(): string {
		return this.#file
	}

	claim(
		journal: Omit<TerminalTransferJournal, 'version' | 'transferId' | 'state' | 'startedAt'>,
	): TerminalTransferJournal | null {
		const record: TerminalTransferJournal = {
			...journal,
			version: 1,
			transferId: crypto.randomUUID(),
			state: 'claimed',
			startedAt: new Date().toISOString(),
		}
		try {
			fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 })
			fs.writeFileSync(this.#file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
			return record
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
			throw error
		}
	}

	load(): TerminalTransferJournal | null {
		try {
			const value = JSON.parse(fs.readFileSync(this.#file, 'utf8')) as TerminalTransferJournal
			if (!isTerminalTransferJournal(value)) throw new Error('Invalid terminal transfer journal')
			return value
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw error
		}
	}

	update(journal: TerminalTransferJournal, state: TerminalTransferState): TerminalTransferJournal {
		const next = { ...journal, state }
		this.#write(next)
		return next
	}

	complete(journal: TerminalTransferJournal): void {
		this.#write({ ...journal, state: 'completed' })
		fs.unlinkSync(this.#file)
	}

	#write(journal: TerminalTransferJournal): void {
		const temp = `${this.#file}.${process.pid}.${crypto.randomUUID()}.tmp`
		try {
			fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 })
			fs.writeFileSync(temp, JSON.stringify(journal), { encoding: 'utf8', mode: 0o600 })
			fs.renameSync(temp, this.#file)
		} finally {
			try {
				fs.unlinkSync(temp)
			} catch {
				// successful rename or failed pre-write
			}
		}
	}
}

export interface TerminalTransferRecoveryObservation {
	sourceSocket: SocketProbe
	destinationSocket: SocketProbe
	sourceRegistryHasSession: boolean
	destinationRegistryHasSession: boolean
	sourceBufferPresent: boolean
	destinationBufferPresent: boolean
}

export type TerminalTransferRecoveryDecision =
	| { action: 'source-authoritative'; reason: string }
	| { action: 'reattach-source'; reason: string }
	| { action: 'repair-destination'; reason: string }
	| { action: 'rollback-destination-socket'; reason: string }
	| { action: 'remove-completed-journal'; reason: string }
	| { action: 'quarantine'; reason: string }

/**
 * Pure, fail-closed recovery policy. The coordinator performs any rename,
 * registry repair, or attach only after obtaining this decision. In particular
 * unknown probes never authorize deletion or a second attach.
 */
export function decideTerminalTransferRecovery(
	journal: TerminalTransferJournal,
	observation: TerminalTransferRecoveryObservation,
): TerminalTransferRecoveryDecision {
	if (observation.sourceSocket === 'unknown' || observation.destinationSocket === 'unknown') {
		return { action: 'quarantine', reason: 'socket probe is unknown; preserve both namespaces and journal' }
	}
	if (journal.state === 'completed') {
		return { action: 'remove-completed-journal', reason: 'completed journal survived its final cleanup' }
	}
	const sourceLive = observation.sourceSocket === 'live'
	const destinationLive = observation.destinationSocket === 'live'
	if (sourceLive && destinationLive) return { action: 'quarantine', reason: 'both socket paths are live' }
	if (!sourceLive && !destinationLive) return { action: 'quarantine', reason: 'no authoritative live socket' }

	if (journal.state === 'claimed' || journal.state === 'snapshot-flushed') {
		return sourceLive
			? { action: 'source-authoritative', reason: 'socket was not moved' }
			: { action: 'quarantine', reason: 'pre-detach state lost its source socket' }
	}
	if (journal.state === 'client-detached') {
		return sourceLive
			? { action: 'reattach-source', reason: 'source master survived detached client' }
			: { action: 'quarantine', reason: 'detached source master cannot be proven live' }
	}
	if (journal.state === 'socket-moved' || journal.state === 'rollback-needed') {
		return destinationLive
			? { action: 'rollback-destination-socket', reason: 'socket moved before metadata commit' }
			: { action: 'quarantine', reason: 'socket location contradicts moved-state journal' }
	}
	// registries-committed: a live destination is sufficient to finish repair;
	// source must no longer own the entry. Any other combination is preserved.
	if (destinationLive && observation.destinationRegistryHasSession && !observation.sourceRegistryHasSession) {
		return { action: 'repair-destination', reason: 'destination socket and registry are authoritative' }
	}
	return { action: 'quarantine', reason: 'registry state does not prove one owner after commit' }
}

export function isTerminalTransferJournal(value: unknown): value is TerminalTransferJournal {
	if (!value || typeof value !== 'object') return false
	const candidate = value as Record<string, unknown>
	return (
		candidate.version === 1 &&
		typeof candidate.transferId === 'string' &&
		typeof candidate.sessionId === 'string' &&
		typeof candidate.sourceProfileId === 'string' &&
		typeof candidate.destinationProfileId === 'string' &&
		typeof candidate.sourceSocket === 'string' &&
		typeof candidate.destinationSocket === 'string' &&
		typeof candidate.sourceRegistryPath === 'string' &&
		typeof candidate.destinationRegistryPath === 'string' &&
		typeof candidate.sourceBufferPath === 'string' &&
		typeof candidate.destinationBufferPath === 'string' &&
		typeof candidate.startedAt === 'string' &&
		typeof candidate.master === 'object' &&
		[
			'claimed',
			'snapshot-flushed',
			'client-detached',
			'socket-moved',
			'registries-committed',
			'completed',
			'rollback-needed',
		].includes(candidate.state as string)
	)
}
