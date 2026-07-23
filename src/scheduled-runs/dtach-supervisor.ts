import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process'
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
	sessionId: number
	startedAt: string
	executable: string
}

export interface ScheduledProcessIdentity extends ProcessFingerprint {
	/** The verified dtach master holding this exact derived socket. */
	socketHolder?: ProcessFingerprint
	/** Legacy observational data; later same-PGID/SID descendants are permitted. */
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
	inspectProcessCommand?: (pid: number) => Promise<string | null>
	inspectGroup?: (processGroupId: number) => Promise<ProcessFingerprint[] | null>
	findSocketHolders?: (socketPath: string) => Promise<ProcessFingerprint[] | null>
	sleep?: (ms: number) => Promise<void>
	unlink?: (path: string) => Promise<void>
}

export interface LaunchQuarantine {
	state: 'quarantined'
	reason: string
	/** Present only when command + OS fingerprint rediscovery verified a candidate. */
	identity?: ScheduledProcessIdentity
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
	/** Persists the verified daemonized master identity before readiness. */
	onSpawned: (identity: ScheduledProcessIdentity) => Promise<void> | void
	/** Runs only after the master identity has been persisted. */
	onReady?: (identity: ScheduledProcessIdentity) => Promise<void> | void
	/** Durable handoff when failed launch cleanup cannot prove termination. */
	onQuarantined?: (quarantine: LaunchQuarantine) => Promise<void> | void
	readinessTimeoutMs?: number
}

export type TeardownResult = 'closed' | 'quarantined' | 'already_dead'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function sameFingerprint(expected: ProcessFingerprint, candidate: ProcessFingerprint | undefined): boolean {
	return (
		!!candidate &&
		expected.pid === candidate.pid &&
		expected.processGroupId === candidate.processGroupId &&
		expected.sessionId === candidate.sessionId &&
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
			'sess=',
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

async function processCommand(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execFile('ps', ['-o', 'command=', '-p', String(pid)])
		return stdout.trim() || null
	} catch {
		return null
	}
}

function parsePsLine(line: string): ProcessFingerprint | null {
	const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/)
	if (!match) return null
	return {
		pid: Number(match[1]),
		processGroupId: Number(match[2]),
		sessionId: Number(match[3]),
		startedAt: match[4].trim(),
		executable: match[5].trim(),
	}
}

async function groupFingerprints(processGroupId: number): Promise<ProcessFingerprint[] | null> {
	try {
		const { stdout } = await execFile('ps', ['-eo', 'pid=,pgid=,sess=,lstart=,comm='])
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
		// dtach retains its original socket pathname in argv. This works after
		// daemonization on macOS, where lsof does not reliably expose the listener.
		const { stdout } = await execFile('pgrep', ['-f', socketPath])
		const ids = stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger)
		return Promise.all(ids.map(processFingerprint)).then(rows => rows.filter((row): row is ProcessFingerprint => !!row))
	} catch (error) {
		// pgrep exit 1 means no candidate; any other failure is not safe to classify.
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
		if (!child.pid || child.pid <= 0) throw new Error('Could not start scheduled dtach supervisor')

		let settled = false
		let spawnFailure: Error | undefined
		let wakeFailure: (() => void) | undefined
		const failure = new Promise<void>(resolve => {
			wakeFailure = resolve
		})
		const fail = (error: unknown) => {
			if (settled || spawnFailure) return
			spawnFailure = asError(error)
			wakeFailure?.()
		}
		child.once('error', fail)
		child.once('exit', (code, signal) => {
			// `dtach -n` is allowed to daemonize normally: its zero launcher exit is
			// not session failure. Non-zero/terminated launchers still wake the loop.
			if (code !== 0) fail(new Error(`Scheduled dtach launcher exited before readiness (${String(code ?? signal)})`))
		})

		let bootstrap: ProcessFingerprint | undefined
		let master: ScheduledProcessIdentity | undefined
		try {
			// The `dtach -n` PID is bootstrap-only and may already have exited after
			// successfully daemonizing before ps can observe it.
			const inspectedBootstrap = await (this.deps.inspectProcess ?? processFingerprint)(child.pid)
			bootstrap =
				inspectedBootstrap?.pid === child.pid && inspectedBootstrap.processGroupId === child.pid
					? inspectedBootstrap
					: undefined
			child.unref?.()
			appendScheduledDiagnostic(input.diagnosticPath, 'dtach_launcher_spawned', {
				pid: child.pid,
				processGroupId: bootstrap?.processGroupId ?? null,
			})
			const until = Date.now() + (input.readinessTimeoutMs ?? 5_000)
			while (Date.now() < until) {
				const state = await this.raceFailure(probe(socketPath), failure, () => spawnFailure)
				if (state === 'live') {
					const discoveredMaster = await this.captureReadyIdentity(socketPath)
					// dtach can publish the socket a moment before lsof/ps has a stable
					// daemon record; keep waiting within the bounded readiness window.
					if (!discoveredMaster) {
						await this.raceFailure(this.deps.sleep?.(50) ?? delay(50), failure, () => spawnFailure)
						continue
					}
					master = discoveredMaster
					// This durable write is deliberately before onReady/public readiness.
					await input.onSpawned(master)
					appendScheduledDiagnostic(input.diagnosticPath, 'dtach_master_persisted', {
						pid: master.pid,
						processGroupId: master.processGroupId,
						sessionId: master.sessionId,
					})
					await input.onReady?.(master)
					settled = true
					appendScheduledDiagnostic(input.diagnosticPath, 'socket_ready', {})
					return master
				}
				if (state === 'unknown') throw new Error('Scheduled socket readiness is unknown; quarantined')
				await this.raceFailure(this.deps.sleep?.(50) ?? delay(50), failure, () => spawnFailure)
			}
			throw spawnFailure ?? new Error('Scheduled dtach socket did not become ready')
		} catch (error) {
			settled = true
			await this.cleanupLaunchFailure(socketPath, master, bootstrap, input.diagnosticPath, input.onQuarantined)
			throw error
		}
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

	private async raceFailure<T>(
		operation: Promise<T>,
		failure: Promise<void>,
		getFailure: () => Error | undefined,
	): Promise<T> {
		return Promise.race([
			operation,
			failure.then(() => Promise.reject(getFailure() ?? new Error('Scheduled dtach launcher failed'))),
		])
	}

	private async cleanupLaunchFailure(
		socketPath: string,
		master: ScheduledProcessIdentity | undefined,
		bootstrap: ProcessFingerprint | undefined,
		diagnosticPath: string,
		onQuarantined: LaunchDtachInput['onQuarantined'],
	): Promise<void> {
		let owned = master
		if (!owned) {
			try {
				// A daemonized dtach master may outlive its launcher before the socket is
				// observable. Rediscover from its exact derived socket argv and fresh OS
				// fingerprint, never from socket liveness.
				owned = (await this.captureReadyIdentity(socketPath)) ?? undefined
			} catch {
				// A failed observation is quarantined below; never guess ownership.
			}
		}
		if (owned) {
			const result = await this.teardownByPath(socketPath, owned, diagnosticPath)
			appendScheduledDiagnostic(diagnosticPath, 'launch_cleanup', { result })
			if (result !== 'quarantined') return
			await this.reportLaunchQuarantine(onQuarantined, diagnosticPath, 'master_teardown_unverified', owned)
			return
		}
		const currentBootstrap = bootstrap ? await (this.deps.inspectProcess ?? processFingerprint)(bootstrap.pid) : null
		if (bootstrap && sameFingerprint(bootstrap, currentBootstrap ?? undefined)) {
			try {
				;(this.deps.signalGroup ?? ((group, sig) => process.kill(-group, sig)))(bootstrap.processGroupId, 'SIGTERM')
				appendScheduledDiagnostic(diagnosticPath, 'launch_cleanup_bootstrap_term', {
					processGroupId: bootstrap.processGroupId,
				})
				return
			} catch {
				// Fall through to a durable quarantine handoff.
			}
		}
		await this.reportLaunchQuarantine(onQuarantined, diagnosticPath, 'master_identity_unavailable')
	}

	private async reportLaunchQuarantine(
		onQuarantined: LaunchDtachInput['onQuarantined'],
		diagnosticPath: string,
		reason: string,
		identity?: ScheduledProcessIdentity,
	): Promise<void> {
		appendScheduledDiagnostic(diagnosticPath, 'launch_cleanup_quarantined', { reason, pid: identity?.pid ?? null })
		await onQuarantined?.({ state: 'quarantined', reason, identity })
	}

	private async teardownByPath(
		socketPath: string,
		identity: ScheduledProcessIdentity,
		diagnosticPath: string,
	): Promise<TeardownResult> {
		const inspect = this.deps.inspectOwnership ?? ((path, candidate) => this.inspectOwnership(path, candidate))
		let ownership = await inspect(socketPath, identity)
		if (ownership === 'unknown' || ownership === 'mismatch') return this.quarantine(diagnosticPath, ownership)
		if (ownership === 'dead') return this.removeProvenDeadSocket(socketPath, diagnosticPath, 'already_dead')
		const signal = this.deps.signalGroup ?? ((group, sig) => process.kill(-group, sig))
		signal(identity.processGroupId, 'SIGTERM')
		if (await this.waitForDeath(inspect, socketPath, identity, 5_000))
			return this.removeProvenDeadSocket(socketPath, diagnosticPath, 'closed')
		ownership = await inspect(socketPath, identity)
		if (ownership !== 'verified') return this.quarantine(diagnosticPath, ownership)
		signal(identity.processGroupId, 'SIGKILL')
		if (await this.waitForDeath(inspect, socketPath, identity, 5_000))
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

	private async captureReadyIdentity(socketPath: string): Promise<ScheduledProcessIdentity | null> {
		const holders = await (this.deps.findSocketHolders ?? socketHolders)(socketPath)
		if (!holders?.length) return null
		const candidates = await Promise.all(
			holders.map(async holder => {
				const current = await (this.deps.inspectProcess ?? processFingerprint)(holder.pid)
				const command = await (this.deps.inspectProcessCommand ?? processCommand)(holder.pid)
				return current && sameFingerprint(holder, current) && this.isOwnedDtachMaster(current, command, socketPath)
					? current
					: null
			}),
		)
		const masters = candidates.filter((candidate): candidate is ProcessFingerprint => !!candidate)
		if (masters.length !== 1) return null
		const master = masters[0]
		// The master PID/start/PGID/SID plus exact original socket command are the
		// durable ownership anchor. Group enumeration is deferred to teardown.
		return { ...master, socketHolder: master }
	}

	private isOwnedDtachMaster(candidate: ProcessFingerprint, command: string | null, socketPath: string): boolean {
		// `pgrep -f` is only candidate discovery. Exact derived namespace argv plus
		// a fresh PID/start fingerprint is the ownership proof before signaling.
		return basename(candidate.executable) === 'dtach' && !!command?.includes(`-n ${socketPath}`)
	}

	private async inspectOwnership(socketPath: string, identity: ScheduledProcessIdentity): Promise<OwnershipState> {
		const probe = this.deps.probe ?? probeScheduledSocket
		const socket = await probe(socketPath)
		if (socket === 'unknown') return 'unknown'
		const master = await (this.deps.inspectProcess ?? processFingerprint)(identity.pid)
		const group = await (this.deps.inspectGroup ?? groupFingerprints)(identity.processGroupId)
		if (!group || !master) {
			return !master && group?.length === 0 && socket === 'dead' ? 'dead' : 'mismatch'
		}
		if (
			!sameFingerprint(identity, master) ||
			master.processGroupId !== identity.processGroupId ||
			master.sessionId !== identity.sessionId ||
			!group.some(member => sameFingerprint(master, member))
		)
			return 'mismatch'
		// New shell/tool descendants are allowed: master PID/start/PGID/SID is the anchor.
		if (socket === 'dead') return 'verified'
		if (!identity.socketHolder) return 'mismatch'
		const holders = await (this.deps.findSocketHolders ?? socketHolders)(socketPath)
		if (!holders) return 'unknown'
		return holders.some(holder => sameFingerprint(identity.socketHolder as ProcessFingerprint, holder))
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
