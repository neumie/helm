import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { createScopedCapability, hashScopedCapability } from '../auth/scoped-capability.js'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { ProfileRuntime } from '../profiles/store.js'
import type { Drainer } from '../queue/drainer.js'
import { buildInteractiveAgentInvocation } from '../solver/agent-adapter.js'
import { log } from '../util/logger.js'
import {
	scheduledAgentEnvironment,
	scheduledAgentHostArgs,
	writeInvocationDescriptor,
	writeScheduledPrompt,
} from './agent-host.js'
import { ScheduleCommands } from './commands.js'
import { DtachSupervisor, type ScheduledProcessIdentity } from './dtach-supervisor.js'
import { appendScheduledDiagnostic } from './log.js'
import { buildScheduledPrompt } from './prompt.js'
import { latestDueOccurrence, manualSlotKey, nextOccurrence } from './recurrence.js'
import { removeRetainedRunDirectory, terminalRunsToPrune } from './retention.js'
import type { ScheduleRecord, ScheduledRunRecord } from './schema.js'
import { probeScheduledSocket, scheduledSessionId, scheduledSocketPath } from './session-path.js'
import { prepareScheduledWorkspace } from './workspace.js'

const MAX_DUE_PER_TICK = 50
const MAX_ATTENTION_PER_PROFILE = 20
const WATCHDOG_MS = 5_000

export interface ScheduledRunServiceDeps {
	/** Profile registry snapshot. It is read before every async tenant operation. */
	profiles: () => ProfileRuntime[]
	/** Resident admission is deliberately external; no daemon recurrence timer can bypass it. */
	hasResidentLease: () => boolean
	supervisor?: DtachSupervisor
	now?: () => Date
	dtachBinary?: string
	reporterPath?: string
	watchdogIntervalMs?: number
}

export interface ScheduledTickResult {
	processed: number
	admitted: number
	skipped: number
}

/**
 * Dedicated schedule-domain coordinator. It does not touch Items, Solver.solve,
 * or ordinary terminal sessions. Recurrence is admitted only by a valid resident
 * lease tick; watchdog/reconciliation are retained solely for already durable runs.
 */
export class ScheduledRunService {
	private readonly supervisor: DtachSupervisor
	private readonly now: () => Date
	private tickInFlight: Promise<ScheduledTickResult> | null = null
	private stopped = false
	private watchdog: ReturnType<typeof setInterval> | null = null

	constructor(
		private readonly config: HelmConfig,
		private readonly db: DB,
		private readonly drainer: Drainer,
		private readonly deps: ScheduledRunServiceDeps,
	) {
		this.supervisor = deps.supervisor ?? new DtachSupervisor()
		this.now = deps.now ?? (() => new Date())
	}

	start(): void {
		if (!this.config.scheduledRuns.enabled || this.watchdog) return
		this.stopped = false
		this.watchdog = setInterval(() => void this.reconcile(), this.deps.watchdogIntervalMs ?? WATCHDOG_MS)
		this.watchdog.unref?.()
		void this.reconcile()
	}

	/** Close recurrence/manual admission without killing already admitted agents. */
	async stop(): Promise<void> {
		this.stopped = true
		if (this.watchdog) clearInterval(this.watchdog)
		this.watchdog = null
		await this.tickInFlight
	}

	/** The only recurrence entrypoint. A missing/expired lease makes no DB claim. */
	tick(): Promise<ScheduledTickResult> {
		if (!this.isAdmissionOpen()) return Promise.resolve({ processed: 0, admitted: 0, skipped: 0 })
		if (this.tickInFlight) return this.tickInFlight
		this.tickInFlight = this.tickInternal().finally(() => {
			this.tickInFlight = null
		})
		return this.tickInFlight
	}

	/** Manual execution uses the same tenant preflight and shared capacity budget. */
	async runNow(profileId: string, scheduleId: string): Promise<ScheduledRunRecord> {
		if (!this.isAdmissionOpen()) throw new Error('Scheduled admission requires a live resident lease')
		const runtime = this.captureProfile(profileId)
		if (runtime.profile.archivedAt) throw new Error('Archived profile cannot admit scheduled runs')
		const runDb = this.db.forProfile(profileId)
		const commands = new ScheduleCommands(runDb.schedules)
		const schedule = runDb.schedules.require(scheduleId)
		if (!schedule.enabled || schedule.archivedAt) throw new Error('Schedule is not enabled')
		return this.admit(runtime, runDb, commands, schedule, {
			scheduledFor: this.now().toISOString(),
			localCivilSlot: 'manual',
			offsetMinutes: 0,
			slotKey: manualSlotKey(randomUUID()),
			missedCount: 0,
			missedMany: false,
			advanceTo: null,
			manual: true,
		})
	}

	/** Transaction-first reporter hook; API auth is intentionally Task 8. */
	async report(
		profileId: string,
		runId: string,
		kind: 'quiet' | 'needs_attention',
		summary: string,
	): Promise<ScheduledRunRecord> {
		const runDb = this.db.forProfile(profileId)
		const commands = new ScheduleCommands(runDb.schedules)
		let run = runDb.schedules.requireRun(runId)
		run = commands.report(run.id, run.revision, kind, summary)
		if (kind === 'needs_attention') {
			this.drainer.releaseExternalSolve(run.id)
			return run
		}
		return this.closeQuiet(profileId, commands, run)
	}

	async cancel(profileId: string, runId: string): Promise<ScheduledRunRecord> {
		const runDb = this.db.forProfile(profileId)
		const commands = new ScheduleCommands(runDb.schedules)
		let run = commands.requestCancel(runId, runDb.schedules.requireRun(runId).revision)
		const result = await this.teardown(profileId, run)
		if (result === 'quarantined')
			return commands.markQuarantined(run.id, run.revision, 'Scheduled teardown ownership is unknown')
		run = runDb.schedules.requireRun(run.id)
		this.drainer.releaseExternalSolve(run.id)
		return commands.markCancelled(run.id, run.revision)
	}

	/** Recover durable runs on daemon start; never relaunch an existing session. */
	async reconcile(): Promise<void> {
		for (const runtime of this.deps.profiles()) {
			const profileId = runtime.profile.id
			const runDb = this.db.forProfile(profileId) // capture tenant seam before await
			const commands = new ScheduleCommands(runDb.schedules)
			for (const initial of runDb.schedules.listRecoverableRuns()) {
				if (this.stopped) return
				await this.reconcileRun(profileId, commands, initial)
			}
			// Retention is bounded and never treats attention as history.
			for (const terminal of terminalRunsToPrune(runDb.schedules, this.now()).slice(0, 50)) {
				if (!terminal.runDir || (await removeRetainedRunDirectory(runtime.rootDir, terminal, this.now())))
					runDb.schedules.deleteRun(terminal.id)
			}
		}
	}

	private async tickInternal(): Promise<ScheduledTickResult> {
		let processed = 0
		let admitted = 0
		let skipped = 0
		const runtimes = this.deps.profiles()
		// Round-robin one due definition per profile per pass prevents a busy tenant
		// from consuming the tick's entire bounded budget.
		for (let cursor = 0; processed < MAX_DUE_PER_TICK; cursor++) {
			let progressed = false
			for (const runtime of runtimes) {
				if (processed >= MAX_DUE_PER_TICK) break
				const profileId = runtime.profile.id
				const runDb = this.db.forProfile(profileId) // capture before await/admission
				const due = runDb.schedules.listDue(this.now().toISOString(), 1)[0]
				if (!due) continue
				progressed = true
				processed++
				const commands = new ScheduleCommands(runDb.schedules)
				try {
					const result = await this.admitDue(runtime, runDb, commands, due)
					if (result.state === 'running' || result.state === 'preparing' || result.state === 'launching') admitted++
					else skipped++
				} catch (error) {
					log.warn('scheduled-runs', `Scheduled admission failed for ${due.id}: ${message(error)}`)
					skipped++
				}
			}
			if (!progressed) break
		}
		return { processed, admitted, skipped }
	}

	private async admitDue(runtime: ProfileRuntime, runDb: DB, commands: ScheduleCommands, schedule: ScheduleRecord) {
		const latest = latestDueOccurrence(
			schedule.cron,
			schedule.timezone,
			new Date(schedule.nextRunAt as string),
			this.now(),
		)
		if (!latest) throw new Error('Due schedule has no calculable occurrence')
		const following = nextOccurrence(schedule.cron, schedule.timezone, latest.occurrence.at)?.scheduledFor ?? null
		return this.admit(runtime, runDb, commands, schedule, {
			scheduledFor: latest.occurrence.scheduledFor,
			localCivilSlot: latest.occurrence.localCivil,
			offsetMinutes: latest.occurrence.offsetMinutes,
			slotKey: latest.occurrence.slotKey,
			missedCount: latest.dropped.count,
			missedMany: latest.dropped.many,
			advanceTo: following,
			manual: false,
			misfire: latest.decision === 'skipped_misfire',
		})
	}

	private async admit(
		runtime: ProfileRuntime,
		runDb: DB,
		commands: ScheduleCommands,
		schedule: ScheduleRecord,
		occurrence: {
			scheduledFor: string
			localCivilSlot: string
			offsetMinutes: number
			slotKey: string
			missedCount: number
			missedMany: boolean
			advanceTo: string | null
			manual: boolean
			misfire?: boolean
		},
	): Promise<ScheduledRunRecord> {
		const runId = randomUUID()
		const reportCapability = createScopedCapability()
		const state = occurrence.misfire ? 'skipped_misfire' : 'admitted'
		const claim = {
			id: runId,
			scheduleId: schedule.id,
			scheduleRevision: schedule.revision,
			scheduledFor: occurrence.scheduledFor,
			localCivilSlot: occurrence.localCivilSlot,
			utcOffsetMinutes: occurrence.offsetMinutes,
			slotKey: occurrence.slotKey,
			definitionSnapshot: schedule.definition,
			state,
			sessionId: scheduledSessionId(runId),
			socketDescriptor: null,
			reportTokenHash: hashScopedCapability(reportCapability),
			reportTokenVersion: 1,
			processFingerprint: null,
			cwd: null,
			worktreePath: null,
			branchName: null,
			runDir: null,
			missedCount: occurrence.missedCount,
			missedMany: occurrence.missedMany,
		} as const
		let run: ScheduledRunRecord
		if (occurrence.manual) {
			run = runDb.schedules.transaction(() => {
				if (runDb.schedules.findRunBySlot(schedule.id, claim.slotKey))
					throw new Error('Manual occurrence already claimed')
				return runDb.schedules.createRun(claim)
			})
		} else run = commands.claimOccurrence(schedule.id, schedule.revision, occurrence.advanceTo, claim)
		if (occurrence.misfire) return run
		if (runtime.profile.archivedAt)
			return this.disableAndSkip(runDb, commands, schedule.id, run, 'skipped_profile_archived')
		if (
			schedule.definition.target.kind === 'project' &&
			!runtime.profile.enabledProjects.includes(schedule.definition.target.projectSlug)
		) {
			return this.disableAndSkip(runDb, commands, schedule.id, run, 'skipped_project_disabled')
		}
		if (runDb.schedules.countAttentionRuns() >= MAX_ATTENTION_PER_PROFILE)
			return this.skip(runDb, run, 'skipped_capacity')
		const active = runDb.schedules
			.listRecoverableRuns()
			.some(candidate => candidate.scheduleId === schedule.id && candidate.id !== run.id)
		if (active) return this.skip(runDb, run, 'skipped_overlap')
		if (!this.drainer.reserveExternalSolve(run.id)) return this.skip(runDb, run, 'skipped_capacity')
		try {
			run = commands.beginPreparing(run.id, run.revision)
			const workspace = await prepareScheduledWorkspace({
				profileRuntime: runtime,
				runId: run.id,
				scheduleId: schedule.id,
				definition: run.definitionSnapshot,
				config: this.config,
			})
			const socketPath = scheduledSocketPath(runtime.profile.id, run.sessionId)
			run = commands.recordRuntime(run.id, run.revision, {
				processFingerprint: null,
				cwd: workspace.cwd,
				worktreePath: workspace.worktreePath,
				branchName: workspace.branchName,
				runDir: workspace.runDir,
				socketDescriptor: socketPath,
			})
			const diagnosticPath = diagnosticPathFor(workspace.runDir)
			const reporterPath = this.requireReporterPath()
			const prompt = buildScheduledPrompt({ definition: run.definitionSnapshot, reporterPath })
			const promptPath = writeScheduledPrompt(workspace.runDir, prompt)
			const invocation = buildInteractiveAgentInvocation(
				{
					...this.config.solver,
					agent: run.definitionSnapshot.agent,
					model: run.definitionSnapshot.model ?? this.config.solver.model,
				},
				run.definitionSnapshot.effort,
			)
			const descriptor = writeInvocationDescriptor(workspace.runDir, {
				cwd: workspace.cwd,
				promptPath,
				invocation,
				shell: process.env.SHELL || '/bin/sh',
			})
			run = commands.beginLaunching(run.id, run.revision)
			const launched = await this.supervisor.launch({
				profileId: runtime.profile.id,
				sessionId: run.sessionId,
				dtachBinary: this.deps.dtachBinary ?? 'dtach',
				hostCommand: process.execPath,
				hostArgs: scheduledAgentHostArgs(descriptor),
				cwd: workspace.cwd,
				env: scheduledAgentEnvironment({
					agent: run.definitionSnapshot.agent,
					daemonUrl: `http://${this.config.server.host}:${this.config.server.port}`,
					runId: run.id,
					reportCapability,
				}),
				diagnosticPath,
				onSpawned: identity => {
					run = commands.recordRuntime(run.id, run.revision, runtimeFields(run, identity))
				},
			})
			// onSpawned advanced the revision; do not mark running before it was durable.
			run = commands.markRunning(run.id, run.revision)
			appendScheduledDiagnostic(diagnosticPath, 'scheduled_running', { pid: launched.pid })
			return run
		} catch (error) {
			const current = runDb.schedules.requireRun(run.id)
			if (!commands.isTerminal(current)) {
				try {
					commands.markFailed(current.id, current.revision, message(error))
				} catch {
					/* preserve first durable failure */
				}
			}
			this.drainer.releaseExternalSolve(run.id)
			throw error
		}
	}

	private async closeQuiet(
		profileId: string,
		commands: ScheduleCommands,
		reported: ScheduledRunRecord,
	): Promise<ScheduledRunRecord> {
		let run = commands.beginClose(reported.id, reported.revision)
		const result = await this.teardown(profileId, run)
		if (result === 'quarantined')
			return commands.markQuarantined(run.id, run.revision, 'Quiet teardown ownership is unknown')
		run = this.db.forProfile(profileId).schedules.requireRun(run.id)
		this.drainer.releaseExternalSolve(run.id)
		return commands.closeQuiet(run.id, run.revision)
	}

	private async teardown(profileId: string, run: ScheduledRunRecord) {
		const identity = parseIdentity(run.processFingerprint)
		if (!identity || !run.runDir) return 'quarantined' as const
		return this.supervisor.teardown(profileId, run.sessionId, identity, diagnosticPathFor(run.runDir))
	}

	private async reconcileRun(
		profileId: string,
		commands: ScheduleCommands,
		initial: ScheduledRunRecord,
	): Promise<void> {
		let run = initial
		const socket = await probeScheduledSocket(scheduledSocketPath(profileId, run.sessionId))
		if (socket === 'unknown') {
			if (run.state !== 'quarantined')
				commands.markQuarantined(run.id, run.revision, 'Scheduled socket probe is unknown')
			return
		}
		if (run.state === 'needs_attention') {
			this.drainer.releaseExternalSolve(run.id)
			return
		}
		if (socket === 'live') {
			if (run.state === 'reported_quiet') {
				await this.closeQuiet(profileId, commands, run)
				return
			}
			if (run.state === 'closing' || run.state === 'cancel_requested') {
				await this.cancel(profileId, run.id)
				return
			}
			if (run.state === 'launching' || run.state === 'running') this.drainer.reserveExternalSolve(run.id)
			if (
				run.startedAt &&
				Date.parse(run.startedAt) + run.definitionSnapshot.maximumRuntimeMinutes * 60_000 <= this.now().getTime()
			) {
				await this.timeout(profileId, commands, run)
			}
			return
		}
		// Definitively dead. Reports retain their durable meaning; no report is never quiet.
		if (run.state === 'reported_quiet' || run.state === 'closing') {
			if (run.state === 'reported_quiet') run = commands.beginClose(run.id, run.revision)
			this.drainer.releaseExternalSolve(run.id)
			commands.closeQuiet(run.id, run.revision)
		} else if (run.state === 'cancel_requested') {
			this.drainer.releaseExternalSolve(run.id)
			commands.markCancelled(run.id, run.revision)
		} else if (run.state !== 'quarantined') {
			this.drainer.releaseExternalSolve(run.id)
			commands.markInterrupted(run.id, run.revision, 'Scheduled session was dead during reconciliation')
		}
	}

	private async timeout(profileId: string, commands: ScheduleCommands, run: ScheduledRunRecord): Promise<void> {
		const result = await this.teardown(profileId, run)
		if (result === 'quarantined') {
			commands.markQuarantined(run.id, run.revision, 'Timeout teardown ownership is unknown')
			return
		}
		const current = this.db.forProfile(profileId).schedules.requireRun(run.id)
		this.drainer.releaseExternalSolve(run.id)
		commands.markTimedOut(current.id, current.revision)
	}

	private skip(runDb: DB, run: ScheduledRunRecord, state: 'skipped_overlap' | 'skipped_capacity'): ScheduledRunRecord {
		this.drainer.releaseExternalSolve(run.id)
		return runDb.schedules.transitionRun(run.id, run.revision, state, { closedAt: this.now().toISOString() })
	}
	private disableAndSkip(
		runDb: DB,
		_commands: ScheduleCommands,
		scheduleId: string,
		run: ScheduledRunRecord,
		state: 'skipped_profile_archived' | 'skipped_project_disabled',
	): ScheduledRunRecord {
		const schedule = runDb.schedules.require(scheduleId)
		runDb.schedules.setEnabled(schedule.id, schedule.revision, false, state)
		return runDb.schedules.transitionRun(run.id, run.revision, state, { closedAt: this.now().toISOString() })
	}
	private captureProfile(profileId: string): ProfileRuntime {
		const runtime = this.deps.profiles().find(candidate => candidate.profile.id === profileId)
		if (!runtime) throw new Error('Scheduled profile is not registered')
		return runtime
	}
	private isAdmissionOpen(): boolean {
		return this.config.scheduledRuns.enabled && !this.stopped && this.deps.hasResidentLease()
	}
	private requireReporterPath(): string {
		if (!this.deps.reporterPath || !isAbsolute(this.deps.reporterPath))
			throw new Error('Scheduled reporter helper is not configured')
		return this.deps.reporterPath
	}
}

function diagnosticPathFor(runDir: string): string {
	return join(runDir, 'supervisor.jsonl')
}
function runtimeFields(run: ScheduledRunRecord, identity: ScheduledProcessIdentity) {
	return {
		processFingerprint: JSON.stringify(identity),
		cwd: run.cwd,
		worktreePath: run.worktreePath,
		branchName: run.branchName,
		runDir: run.runDir,
		socketDescriptor: run.socketDescriptor,
	}
}
function parseIdentity(value: string | null): ScheduledProcessIdentity | null {
	if (!value) return null
	try {
		const parsed = JSON.parse(value) as ScheduledProcessIdentity
		return parsed.pid > 0 && parsed.processGroupId > 0 && parsed.sessionId > 0 ? parsed : null
	} catch {
		return null
	}
}
function message(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 4096) : String(error).slice(0, 4096)
}
