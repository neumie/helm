import { type ChildProcess, execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { appendScheduledDiagnostic } from './log.js'
import {
	type ScheduledSocketProbe,
	ensureScheduledSocketDir,
	probeScheduledSocket,
	scheduledSocketPath,
} from './session-path.js'

const execFile = promisify(nodeExecFile)

export interface ProcessFingerprint {
	pid: number
	processGroupId: number
	startedAt: string
	executable: string
}

export interface ScheduledProcessIdentity extends ProcessFingerprint {
	socketHolder?: ProcessFingerprint
	/** All members observed after dtach became ready. Surviving members must match these OS fingerprints. */
	groupMembers?: ProcessFingerprint[]
}

export type OwnershipState = 'verified' | 'dead' | 'unknown' | 'mismatch'

export interface SpawnedProcess {
	pid?: number
	unref?: () => void
	once(event: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown
}

export interface DtachSupervisorDeps {
	spawn?: (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => SpawnedProcess
	probe?: (path: string) => Promise<ScheduledSocketProbe>
	signalGroup?: (processGroupId: number, signal: NodeJS.Signals) => void
	/** Mandatory ownership decision before every destructive action. */
	inspectOwnership?: (socketPath: string, identity: ScheduledProcessIdentity) => Promise<OwnershipState>
	inspectProcess?: (pid: number) => Promise<ProcessFingerprint | null>
	inspectGroup?: (processGroupId: number) => Promise<ProcessFingerprint[] | null>
	findSocketHolders?: (socketPath: string) => Promise<ProcessFingerprint[] | null>
	sleep?: (ms: number) => Promise<void>
	unlink?: (path: string) => Promise<void>
}

export interface LaunchDtachInput {
	profileId: string
	sessionId: string
	socketRoot?: string
	dtachBinary: string
	hostCommand: string
	hostArgs: string[]
	cwd: string
	env: NodeJS.ProcessEnv
	diagnosticPath: string
	/** Persists a restart-safe leader identity before readiness. */
	onSpawned: (identity: ScheduledProcessIdentity) => Promise<void> | void
	/** Persists the socket-holder/group fingerprints once the socket is ready. */
	onReady?: (identity: ScheduledProcessIdentity) => Promise<void> | void
	readinessTimeoutMs?: number
}

export type TeardownResult = 'closed' | 'quarantined' | 'already_dead'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function sameFingerprint(expected: ProcessFingerprint, candidate: ProcessFingerprint | undefined): boolean {
	return (
		!!candidate &&
		expected.pid === candidate.pid &&
		expected.processGroupId === candidate.processGroupId &&
		expected.startedAt === candidate.startedAt &&
		basename(expected.executable) === basename(candidate.executable)
	)
}

async function processFingerprint(pid: number): Promise<ProcessFingerprint | null> {
	try {
		const { stdout } = await execFile('ps', [
			'-o',
			'pid=',
			'-o',
			'pgid=',
			'-o',
			'lstart=',
			'-o',
			'comm=',
			'-p',
			String(pid),
		])
		return parsePsLine(stdout.trim())
	} catch {
		return null
	}
}

function parsePsLine(line: string): ProcessFingerprint | null {
	const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/)
	if (!match) return null
	return {
		pid: Number(match[1]),
		processGroupId: Number(match[2]),
		startedAt: match[3].trim(),
		executable: match[4].trim(),
	}
}

async function groupFingerprints(processGroupId: number): Promise<ProcessFingerprint[] | null> {
	try {
		const { stdout } = await execFile('ps', ['-eo', 'pid=,pgid=,lstart=,comm='])
		const rows = stdout
			.split('\n')
			.map(parsePsLine)
			.filter((row): row is ProcessFingerprint => !!row)
		return rows.filter(row => row.processGroupId === processGroupId)
	} catch {
		return null
	}
}

async function socketHolders(socketPath: string): Promise<ProcessFingerprint[] | null> {
	try {
		const { stdout } = await execFile('lsof', ['-t', '--', socketPath])
		const ids = stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger)
		return Promise.all(ids.map(processFingerprint)).then(rows => rows.filter((row): row is ProcessFingerprint => !!row))
	} catch (error) {
		// lsof exit 1 means no holder; any other failure is not safe to classify.
		if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return []
		return null
	}
}

/**
 * Daemon-owned dtach launcher and verified group teardown. It intentionally
 * captures no terminal output: interactive TTY bytes are never diagnostics.
 */
export class DtachSupervisor {
	constructor(private readonly deps: DtachSupervisorDeps = {}) {}

	async launch(input: LaunchDtachInput): Promise<ScheduledProcessIdentity> {
		const socketPath = scheduledSocketPath(input.profileId, input.sessionId, input.socketRoot)
		ensureScheduledSocketDir(input.profileId, input.socketRoot)
		const probe = this.deps.probe ?? probeScheduledSocket
		const existing = await probe(socketPath)
		if (existing === 'live') throw new Error('Scheduled session socket is already live')
		if (existing === 'unknown') throw new Error('Scheduled session socket probe is unknown; quarantined')
		// This is the expected, derived namespace path and its dead state was proven.
		try {
			await (this.deps.unlink ?? unlink)(socketPath)
		} catch {
			/* absent stale socket */
		}

		const spawn = this.deps.spawn ?? nodeSpawn
		const child = spawn(input.dtachBinary, ['-n', socketPath, input.hostCommand, ...input.hostArgs], {
			cwd: input.cwd,
			env: input.env,
			detached: true,
			stdio: 'ignore',
		})
		let spawnFailure: Error | undefined
		let settled = false
		const failed = new Promise<never>((_resolve, reject) => {
			child.once('error', error => {
				if (!settled) {
					spawnFailure = asError(error)
					reject(spawnFailure)
				}
			})
			child.once('exit', (code, signal) => {
				if (!settled) {
					spawnFailure = new Error(`Scheduled dtach exited before readiness (${String(code ?? signal)})`)
					reject(spawnFailure)
				}
			})
		})
		if (!child.pid || child.pid <= 0) throw new Error('Could not start scheduled dtach supervisor')
		const leader = await (this.deps.inspectProcess ?? processFingerprint)(child.pid)
		if (!leader || leader.processGroupId !== child.pid) throw new Error('Could not derive scheduled dtach OS identity')
		const identity: ScheduledProcessIdentity = leader
		await input.onSpawned(identity)
		child.unref?.()
		appendScheduledDiagnostic(input.diagnosticPath, 'dtach_spawned', {
			pid: identity.pid,
			processGroupId: identity.processGroupId,
		})
		const until = Date.now() + (input.readinessTimeoutMs ?? 5_000)
		while (Date.now() < until) {
			const state = await Promise.race([probe(socketPath), failed])
			if (state === 'live') {
				const ready = await this.captureReadyIdentity(socketPath, identity)
				if (!ready) throw new Error('Scheduled socket holder ownership is unknown; quarantined')
				await input.onReady?.(ready)
				settled = true
				appendScheduledDiagnostic(input.diagnosticPath, 'socket_ready', {})
				return ready
			}
			if (state === 'unknown') throw new Error('Scheduled socket readiness is unknown; quarantined')
			await Promise.race([(this.deps.sleep ?? delay)(50), failed])
		}
		if (spawnFailure) throw spawnFailure
		throw new Error('Scheduled dtach socket did not become ready')
	}

	async teardown(
		profileId: string,
		sessionId: string,
		identity: ScheduledProcessIdentity,
		diagnosticPath: string,
		deadlineMs = 5_000,
		socketRoot?: string,
	): Promise<TeardownResult> {
		const socketPath = scheduledSocketPath(profileId, sessionId, socketRoot)
		const inspect = this.deps.inspectOwnership ?? ((path, candidate) => this.inspectOwnership(path, candidate))
		let ownership = await inspect(socketPath, identity)
		if (ownership === 'unknown' || ownership === 'mismatch') return this.quarantine(diagnosticPath, ownership)
		if (ownership === 'dead') return this.removeProvenDeadSocket(socketPath, diagnosticPath, 'already_dead')
		const signal = this.deps.signalGroup ?? ((group, sig) => process.kill(-group, sig))
		signal(identity.processGroupId, 'SIGTERM')
		appendScheduledDiagnostic(diagnosticPath, 'group_term', { processGroupId: identity.processGroupId })
		if (await this.waitForDeath(inspect, socketPath, identity, deadlineMs))
			return this.removeProvenDeadSocket(socketPath, diagnosticPath, 'closed')
		ownership = await inspect(socketPath, identity)
		if (ownership !== 'verified') return this.quarantine(diagnosticPath, ownership)
		signal(identity.processGroupId, 'SIGKILL')
		appendScheduledDiagnostic(diagnosticPath, 'group_kill', { processGroupId: identity.processGroupId })
		if (await this.waitForDeath(inspect, socketPath, identity, deadlineMs))
			return this.removeProvenDeadSocket(socketPath, diagnosticPath, 'closed')
		return this.quarantine(diagnosticPath, 'still_live_after_kill')
	}

	private async waitForDeath(
		inspect: (path: string, identity: ScheduledProcessIdentity) => Promise<OwnershipState>,
		socketPath: string,
		identity: ScheduledProcessIdentity,
		deadlineMs: number,
	): Promise<boolean> {
		const until = Date.now() + deadlineMs
		do {
			const state = await inspect(socketPath, identity)
			if (state === 'dead') return true
			if (state !== 'verified') return false
			await (this.deps.sleep ?? delay)(50)
		} while (Date.now() < until)
		return false
	}

	private async captureReadyIdentity(
		socketPath: string,
		identity: ScheduledProcessIdentity,
	): Promise<ScheduledProcessIdentity | null> {
		const group = await (this.deps.inspectGroup ?? groupFingerprints)(identity.processGroupId)
		const holders = await (this.deps.findSocketHolders ?? socketHolders)(socketPath)
		if (!group?.length || !holders?.length) return null
		const holder = holders.find(candidate => candidate.processGroupId === identity.processGroupId)
		if (!holder || !group.some(member => sameFingerprint(member, holder))) return null
		return { ...identity, socketHolder: holder, groupMembers: group }
	}

	private async inspectOwnership(socketPath: string, identity: ScheduledProcessIdentity): Promise<OwnershipState> {
		const probe = this.deps.probe ?? probeScheduledSocket
		const socket = await probe(socketPath)
		if (socket === 'unknown') return 'unknown'
		const group = await (this.deps.inspectGroup ?? groupFingerprints)(identity.processGroupId)
		if (!group) return 'unknown'
		if (!group.length) return socket === 'dead' ? 'dead' : 'mismatch'
		if (
			!identity.groupMembers?.length ||
			!group.every(member => identity.groupMembers?.some(expected => sameFingerprint(expected, member)))
		)
			return 'mismatch'
		if (socket === 'dead') return 'verified'
		if (!identity.socketHolder) return 'mismatch'
		const holders = await (this.deps.findSocketHolders ?? socketHolders)(socketPath)
		if (!holders) return 'unknown'
		return holders.some(
			holder =>
				sameFingerprint(identity.socketHolder as ProcessFingerprint, holder) &&
				group.some(member => sameFingerprint(member, holder)),
		)
			? 'verified'
			: 'mismatch'
	}

	private async removeProvenDeadSocket(
		socketPath: string,
		diagnosticPath: string,
		result: 'closed' | 'already_dead',
	): Promise<TeardownResult> {
		try {
			await (this.deps.unlink ?? unlink)(socketPath)
		} catch {
			/* master may already have removed it */
		}
		appendScheduledDiagnostic(diagnosticPath, 'socket_dead', { result })
		return result
	}

	private quarantine(diagnosticPath: string, reason: string): TeardownResult {
		appendScheduledDiagnostic(diagnosticPath, 'teardown_quarantined', { reason })
		return 'quarantined'
	}
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value))
}

/** Conservatively compare OS-derived persisted identities after restart. */
export function identityMatchesCandidate(
	expected: ScheduledProcessIdentity,
	candidate: ScheduledProcessIdentity | null,
): boolean {
	return (
		!!candidate &&
		sameFingerprint(expected, candidate) &&
		!!expected.socketHolder &&
		!!candidate.socketHolder &&
		sameFingerprint(expected.socketHolder, candidate.socketHolder)
	)
}
