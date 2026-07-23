import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { appendScheduledDiagnostic } from './log.js'
import {
	assertScheduledSocketPathUsable,
	ensureScheduledSocketDir,
	probeScheduledSocket,
	type ScheduledSocketProbe,
} from './session-path.js'

export interface ScheduledProcessIdentity {
	pid: number
	processGroupId: number
	startedAt: string
	executable: string
}

export interface SpawnedProcess {
	pid?: number
	unref?: () => void
	once(event: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown
}

export interface DtachSupervisorDeps {
	spawn?: (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => SpawnedProcess
	probe?: (path: string) => Promise<ScheduledSocketProbe>
	signalGroup?: (processGroupId: number, signal: NodeJS.Signals) => void
	verifyIdentity?: (identity: ScheduledProcessIdentity) => Promise<boolean>
	sleep?: (ms: number) => Promise<void>
	unlink?: (path: string) => Promise<void>
	now?: () => Date
}

export interface LaunchDtachInput {
	profileId: string
	socketPath: string
	dtachBinary: string
	hostCommand: string
	hostArgs: string[]
	cwd: string
	env: NodeJS.ProcessEnv
	diagnosticPath: string
	onSpawned: (identity: ScheduledProcessIdentity) => Promise<void> | void
	readinessTimeoutMs?: number
}

export type TeardownResult = 'closed' | 'quarantined' | 'already_dead'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Daemon-owned dtach launcher and verified group teardown. It intentionally
 * captures no terminal output: interactive TTY bytes are never diagnostics.
 */
export class DtachSupervisor {
	constructor(private readonly deps: DtachSupervisorDeps = {}) {}

	async launch(input: LaunchDtachInput): Promise<ScheduledProcessIdentity> {
		assertScheduledSocketPathUsable(input.socketPath)
		ensureScheduledSocketDir(input.profileId, dirname(dirname(input.socketPath)))
		const probe = this.deps.probe ?? probeScheduledSocket
		const existing = await probe(input.socketPath)
		if (existing === 'live') throw new Error('Scheduled session socket is already live')
		if (existing === 'unknown') throw new Error('Scheduled session socket probe is unknown; quarantined')
		const spawn = this.deps.spawn ?? nodeSpawn
		const child = spawn(input.dtachBinary, ['-n', input.socketPath, input.hostCommand, ...input.hostArgs], {
			cwd: input.cwd,
			env: input.env,
			detached: true,
			stdio: 'ignore',
		})
		if (!child.pid || child.pid <= 0) throw new Error('Could not start scheduled dtach supervisor')
		const identity: ScheduledProcessIdentity = {
			pid: child.pid,
			processGroupId: child.pid,
			startedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
			executable: input.dtachBinary,
		}
		// This durable callback is deliberately before socket readiness: crash
		// reconciliation can verify or quarantine rather than relaunching blindly.
		await input.onSpawned(identity)
		child.unref?.()
		appendScheduledDiagnostic(input.diagnosticPath, 'dtach_spawned', { pid: identity.pid, processGroupId: identity.processGroupId })
		const until = Date.now() + (input.readinessTimeoutMs ?? 5_000)
		while (Date.now() < until) {
			const state = await probe(input.socketPath)
			if (state === 'live') {
				appendScheduledDiagnostic(input.diagnosticPath, 'socket_ready', {})
				return identity
			}
			if (state === 'unknown') throw new Error('Scheduled socket readiness is unknown; quarantined')
			await (this.deps.sleep ?? delay)(50)
		}
		throw new Error('Scheduled dtach socket did not become ready')
	}

	async teardown(
		socketPath: string,
		identity: ScheduledProcessIdentity,
		diagnosticPath: string,
		deadlineMs = 5_000,
	): Promise<TeardownResult> {
		const probe = this.deps.probe ?? probeScheduledSocket
		const verify = this.deps.verifyIdentity ?? (async () => true)
		const initial = await probe(socketPath)
		if (initial === 'unknown') {
			appendScheduledDiagnostic(diagnosticPath, 'teardown_quarantined', { reason: 'unknown_socket' })
			return 'quarantined'
		}
		if (initial === 'dead') return this.removeProvenDeadSocket(socketPath, diagnosticPath, 'already_dead')
		if (!(await verify(identity))) {
			appendScheduledDiagnostic(diagnosticPath, 'teardown_quarantined', { reason: 'identity_mismatch' })
			return 'quarantined'
		}
		const signal = this.deps.signalGroup ?? ((group, sig) => process.kill(-group, sig))
		signal(identity.processGroupId, 'SIGTERM')
		appendScheduledDiagnostic(diagnosticPath, 'group_term', { processGroupId: identity.processGroupId })
		const sleep = this.deps.sleep ?? delay
		const until = Date.now() + deadlineMs
		while (Date.now() < until) {
			const state = await probe(socketPath)
			if (state === 'dead') return this.removeProvenDeadSocket(socketPath, diagnosticPath, 'closed')
			if (state === 'unknown') return this.quarantine(diagnosticPath, 'unknown_after_term')
			await sleep(50)
		}
		if (!(await verify(identity))) return this.quarantine(diagnosticPath, 'identity_changed_before_kill')
		signal(identity.processGroupId, 'SIGKILL')
		appendScheduledDiagnostic(diagnosticPath, 'group_kill', { processGroupId: identity.processGroupId })
		const killUntil = Date.now() + deadlineMs
		while (Date.now() < killUntil) {
			const state = await probe(socketPath)
			if (state === 'dead') return this.removeProvenDeadSocket(socketPath, diagnosticPath, 'closed')
			if (state === 'unknown') return this.quarantine(diagnosticPath, 'unknown_after_kill')
			await sleep(50)
		}
		return this.quarantine(diagnosticPath, 'socket_live_after_kill')
	}

	private async removeProvenDeadSocket(socketPath: string, diagnosticPath: string, result: 'closed' | 'already_dead') {
		try {
			await (this.deps.unlink ?? unlink)(socketPath)
		} catch {
			// Master teardown may have already removed it.
		}
		appendScheduledDiagnostic(diagnosticPath, 'socket_dead', { result })
		return result
	}

	private quarantine(diagnosticPath: string, reason: string): TeardownResult {
		appendScheduledDiagnostic(diagnosticPath, 'teardown_quarantined', { reason })
		return 'quarantined'
	}
}

/** Conservatively verify persisted identity before a restart teardown. */
export function identityMatchesCandidate(expected: ScheduledProcessIdentity, candidate: ScheduledProcessIdentity | null): boolean {
	return !!candidate && candidate.pid === expected.pid && candidate.startedAt === expected.startedAt && candidate.executable === expected.executable
}
