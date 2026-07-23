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
		next.master = { ...journal.master, currentSocketPath: expectedMasterSocketPath(next) }
		this.#write(next)
		return next
	}

	complete(journal: TerminalTransferJournal): void {
		const completed = { ...journal, state: 'completed' as const }
		completed.master = { ...journal.master, currentSocketPath: expectedMasterSocketPath(completed) }
		this.#write(completed)
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

/**
 * Recovery must distinguish the journaled master from a replacement listener
 * at either socket path. `dead` is definitive only for the captured PID; a
 * reused PID or any path/fingerprint disagreement is `mismatch`.
 */
export type TerminalMasterRecoveryOwnership = 'verified' | 'dead' | 'unknown' | 'mismatch'

export type TerminalMasterRecoveryEvidence =
	| {
			state: 'present'
			pid: number
			processStartFingerprint: string
			originalSocketPath: string
			currentSocketPath: string
	  }
	| { state: 'dead' }
	| { state: 'unknown' }

function expectedMasterSocketPath(journal: TerminalTransferJournal): string {
	switch (journal.state) {
		case 'claimed':
		case 'snapshot-flushed':
		case 'client-detached':
			return journal.sourceSocket
		case 'socket-moved':
		case 'registries-committed':
		case 'completed':
		case 'rollback-needed':
			return journal.destinationSocket
	}
}

/**
 * Attest a process observation against the durable master identity. The
 * process continues to advertise its original dtach path after rename, while
 * `currentSocketPath` records the sole expected namespace entry. Neither a
 * listener at the moved path nor a reused PID can produce `verified`.
 */
export function attestTerminalTransferMaster(
	journal: TerminalTransferJournal,
	evidence: TerminalMasterRecoveryEvidence,
): TerminalMasterRecoveryOwnership {
	const identity = journal.master
	const journalIdentityIsCoherent =
		Number.isSafeInteger(identity.pid) &&
		identity.pid > 0 &&
		identity.processStartFingerprint.length > 0 &&
		identity.originalSocketPath === journal.sourceSocket &&
		identity.currentSocketPath === expectedMasterSocketPath(journal)
	if (!journalIdentityIsCoherent) return 'mismatch'
	if (evidence.state === 'dead') return 'dead'
	if (evidence.state === 'unknown') return 'unknown'
	return evidence.pid === identity.pid &&
		evidence.processStartFingerprint === identity.processStartFingerprint &&
		evidence.originalSocketPath === identity.originalSocketPath &&
		evidence.currentSocketPath === identity.currentSocketPath
		? 'verified'
		: 'mismatch'
}

export interface TerminalTransferRecoveryObservation {
	/** Attested from the journaled PID/start fingerprint and socket identities. */
	masterOwnership: TerminalMasterRecoveryOwnership
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
	| { action: 'rollback-destination-transfer'; reason: string }
	| { action: 'remove-completed-journal'; reason: string }
	/** Remove only definitively-dead socket directory entries; retain the journal and all metadata. */
	| { action: 'cleanup-dead-sockets'; reason: string }
	| { action: 'quarantine'; reason: string }

type BufferPlacement = 'source' | 'destination' | 'none' | 'conflict'

function bufferPlacement(observation: TerminalTransferRecoveryObservation): BufferPlacement {
	if (observation.sourceBufferPresent && observation.destinationBufferPresent) return 'conflict'
	if (observation.sourceBufferPresent) return 'source'
	if (observation.destinationBufferPresent) return 'destination'
	return 'none'
}

function sourceRegistryOnly(observation: TerminalTransferRecoveryObservation): boolean {
	return observation.sourceRegistryHasSession && !observation.destinationRegistryHasSession
}

/**
 * Pure, fail-closed recovery policy. The coordinator performs any rename,
 * registry repair, or attach only after obtaining this decision. In particular
 * unknown probes never authorize deletion or a second attach. A snapshot can
 * legitimately be absent, but duplicate snapshots are never reconciled: a
 * no-copy move has no safe way to choose which bytes are authoritative.
 */
export function decideTerminalTransferRecovery(
	journal: TerminalTransferJournal,
	observation: TerminalTransferRecoveryObservation,
): TerminalTransferRecoveryDecision {
	if (observation.masterOwnership === 'unknown' || observation.masterOwnership === 'mismatch') {
		return {
			action: 'quarantine',
			reason: 'journaled master identity is not verified; preserve both namespaces and journal',
		}
	}
	if (observation.masterOwnership === 'dead') {
		if (observation.sourceSocket === 'dead' && observation.destinationSocket === 'dead') {
			return {
				action: 'cleanup-dead-sockets',
				reason: 'journaled master is dead and both socket entries are definitively dead; retain journal and metadata',
			}
		}
		return { action: 'quarantine', reason: 'dead journaled master has a live or unknown socket entry' }
	}
	if (observation.sourceSocket === 'unknown' || observation.destinationSocket === 'unknown') {
		return { action: 'quarantine', reason: 'socket probe is unknown; preserve both namespaces and journal' }
	}
	const sourceLive = observation.sourceSocket === 'live'
	const destinationLive = observation.destinationSocket === 'live'
	if (sourceLive && destinationLive) return { action: 'quarantine', reason: 'both socket paths are live' }
	if (!sourceLive && !destinationLive) return { action: 'quarantine', reason: 'no authoritative live socket' }

	const buffers = bufferPlacement(observation)
	if (buffers === 'conflict') {
		return { action: 'quarantine', reason: 'both buffer paths exist; no-copy ownership is ambiguous' }
	}
	const sourceOnly = sourceRegistryOnly(observation)
	const destinationOwnsRegistry = observation.destinationRegistryHasSession

	if (journal.state === 'claimed' || journal.state === 'snapshot-flushed') {
		if (sourceLive && sourceOnly && buffers !== 'destination') {
			return {
				action: 'source-authoritative',
				reason: 'source socket, registry, and snapshot placement are authoritative',
			}
		}
		return { action: 'quarantine', reason: 'pre-move artifacts do not prove source-only ownership' }
	}
	if (journal.state === 'client-detached') {
		if (sourceLive && sourceOnly && buffers !== 'destination') {
			return { action: 'reattach-source', reason: 'source master survived detached client with source-owned artifacts' }
		}
		return { action: 'quarantine', reason: 'detached state does not prove source-only ownership' }
	}
	if (journal.state === 'socket-moved' || journal.state === 'rollback-needed') {
		if (destinationLive && sourceOnly) {
			return {
				action: 'rollback-destination-transfer',
				reason: `destination socket moved before registry commit; buffer is ${buffers}-owned`,
			}
		}
		return { action: 'quarantine', reason: 'moved-state artifacts do not prove a reversible source owner' }
	}
	if (journal.state === 'registries-committed') {
		// Destination registry is written first. A remaining source entry is the
		// expected between-renames crash and is repairable only when the socket is
		// live at destination and snapshot ownership is unambiguous. A source-only
		// buffer is moved by rename as part of repair; an absent snapshot is valid.
		if (destinationLive && destinationOwnsRegistry) {
			return {
				action: 'repair-destination',
				reason: observation.sourceRegistryHasSession
					? `destination registry committed before source removal; buffer is ${buffers}-owned`
					: `destination socket and registry are authoritative; buffer is ${buffers}-owned`,
			}
		}
		return { action: 'quarantine', reason: 'committed state does not prove destination ownership' }
	}
	// A completed marker is removable only after verifying the actual terminal
	// and final single-owner registry/buffer arrangement. Never discard a claim
	// merely because the final journal write survived a crash.
	if (destinationLive && destinationOwnsRegistry && !observation.sourceRegistryHasSession && buffers !== 'source') {
		return { action: 'remove-completed-journal', reason: 'destination owns the completed transfer' }
	}
	return { action: 'quarantine', reason: 'completed journal does not match final destination ownership' }
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
