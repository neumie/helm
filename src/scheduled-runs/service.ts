import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { createScopedCapability, hashScopedCapability } from '../auth/scoped-capability.js'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { ProfileRuntime } from '../profiles/store.js'
import type { Drainer } from '../queue/drainer.js'
import { buildInteractiveAgentInvocation } from '../solver/agent-adapter.js'
import { log } from '../util/logger.js'
import { type AttentionAdoptionGrant, AttentionAdoptionGrantManager } from './adoption-grants.js'
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
import { type ScheduledWorkspaceCleaner, defaultScheduledWorkspaceCleaner, terminalRunsToPrune } from './retention.js'
import type {
	AttentionAdoptionIdentity,
	ScheduleRecord,
	ScheduledRunRecord,
	ScheduledTerminalIntent,
} from './schema.js'
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
	reporterCommand?: readonly [string, ...string[]]
	watchdogIntervalMs?: number
	/** Optional future descriptor-pinned workspace cleaner; default is inert and fail-closed. */
	workspaceCleaner?: ScheduledWorkspaceCleaner
	/** One daemon-lifetime manager; capabilities never persist in scheduled rows. */
	adoptionGrants?: AttentionAdoptionGrantManager
}

export interface ScheduledTickResult {
	processed: number
	admitted: number
	skipped: number
}

export interface AttentionAdoptionReservation {
	run: ScheduledRunRecord
	grant: AttentionAdoptionGrant
}

/** Internal main-process handoff; this is never a scheduled run contract. */
export interface AttentionAttachDescriptor {
	socketPath: string
	mode: 'attach-existing'
	redraw: 'winch'
}

/**
 * Dedicated schedule-domain coordinator. It does not touch Items, Solver.solve,
 * or ordinary terminal sessions. Recurrence is admitted only by a valid resident
 * lease tick; watchdog/reconciliation are retained solely for already durable runs.
 */
export class ScheduledRunService {
	private readonly supervisor: DtachSupervisor
	private readonly workspaceCleaner: ScheduledWorkspaceCleaner
	private readonly adoptionGrants: AttentionAdoptionGrantManager
	private readonly now: () => Date
	private tickInFlight: Promise<ScheduledTickResult> | null = null
	private reconcileInFlight: Promise<void> | null = null
	/** Current-process workspace/launch ownership; crash recovery sees an empty set. */
	private readonly admissionInFlight = new Set<string>()
	private readonly adoptionInFlight = new Set<Promise<unknown>>()
	/** Per-run single-flight guards duplicate teardown while durable intent arbitrates winners. */
	private readonly terminalInFlight = new Map<string, Promise<ScheduledRunRecord>>()
	private startInFlight: Promise<void> | null = null
	private stopped = false
	private reconcileAdmissionOpen = true
	private restoringStartup = false
	private readonly startupReservationFailures = new Set<string>()
	private watchdog: ReturnType<typeof setInterval> | null = null

	constructor(
		private readonly config: HelmConfig,
		private readonly db: DB,
		private readonly drainer: Drainer,
		private readonly deps: ScheduledRunServiceDeps,
	) {
		this.supervisor = deps.supervisor ?? new DtachSupervisor()
		this.workspaceCleaner = deps.workspaceCleaner ?? defaultScheduledWorkspaceCleaner
		this.adoptionGrants = deps.adoptionGrants ?? new AttentionAdoptionGrantManager()
		this.now = deps.now ?? (() => new Date())
	}

	/**
	 * Restore durable sessions before ordinary Item admission opens. This always
	 * runs, even when schedule creation/recurrence is rollout-disabled.
	 */
	start(): Promise<void> {
		if (this.startInFlight) return this.startInFlight
		if (this.watchdog) return this.reconcile()
		// A daemon restart has no surviving Electron owner or bearer authority.
		// Do this synchronously before startup's first await opens reconciliation.
		this.adoptionGrants.clear()
		this.rollbackReservedAdoptionsOnRestart()
		this.startInFlight = this.startInternal().finally(() => {
			this.startInFlight = null
		})
		return this.startInFlight
	}

	private async startInternal(): Promise<void> {
		this.stopped = false
		this.reconcileAdmissionOpen = true
		this.startupReservationFailures.clear()
		this.restoringStartup = true
		try {
			await this.reconcile()
			if (this.startupReservationFailures.size > 0) {
				throw new Error(
					`Scheduled startup restoration could not reserve solve capacity for ${this.startupReservationFailures.size} run(s)`,
				)
			}
			if (this.stopped) return
			this.watchdog = setInterval(() => void this.reconcile(), this.deps.watchdogIntervalMs ?? WATCHDOG_MS)
			this.watchdog.unref?.()
		} catch (error) {
			this.stopped = true
			this.reconcileAdmissionOpen = false
			if (this.watchdog) clearInterval(this.watchdog)
			this.watchdog = null
			throw error
		} finally {
			this.restoringStartup = false
		}
	}

	/** Close recurrence/manual admission without killing already admitted agents. */
	async stop(): Promise<void> {
		this.stopped = true
		this.reconcileAdmissionOpen = false
		if (this.watchdog) clearInterval(this.watchdog)
		this.watchdog = null
		const tick = this.tickInFlight
		const reconcile = this.reconcileInFlight
		await Promise.all([tick, reconcile, Promise.allSettled([...this.adoptionInFlight])])
		this.adoptionGrants.clear()
	}

	/**
	 * Reserve one attention-reported run and prove its existing dtach ownership
	 * before issuing a per-reservation memory-only capability.
	 */
	reserveAttentionAdoption(
		profileId: string,
		runId: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
	): Promise<AttentionAdoptionReservation> {
		return this.trackAdoption(this.reserveAttentionAdoptionInternal(profileId, runId, revision, identity))
	}
	private async reserveAttentionAdoptionInternal(
		profileId: string,
		runId: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
	): Promise<AttentionAdoptionReservation> {
		const runtime = this.captureProfile(profileId)
		const runDb = this.db.forProfile(runtime.profile.id)
		if (this.stopped) throw new Error('Scheduled attention adoption is unavailable')
		const commands = new ScheduleCommands(runDb.schedules, this.config.scheduledRuns.systemTargetsEnabled)
		let reserved: ScheduledRunRecord | null = null
		let issued = false
		const before = runDb.schedules.requireRun(runId)
		const createdReservation = before.attentionAdoption?.state !== 'reserved'
		let binding: { profileId: string; runId: string; revision: number; adoptionId: string; adopter: string } | null =
			null
		try {
			reserved = commands.reserveAttentionAdoption(runId, revision, identity)
			binding = { profileId, runId, revision: reserved.revision, ...identity }
			const persistedIdentity = parseIdentity(reserved.processFingerprint)
			if (!persistedIdentity) throw new Error('Scheduled attention session cannot be attested')
			const attestation = await this.supervisor.attestLiveSession(profileId, reserved.sessionId, persistedIdentity)
			if (attestation.state !== 'verified') throw new Error('Scheduled attention session cannot be attested')
			const current = runDb.schedules.requireRun(runId)
			this.assertReservedAdoption(current, reserved.revision, identity)
			const grant = this.adoptionGrants.issue(binding)
			issued = true
			return { run: current, grant }
		} catch (error) {
			if (binding && issued) this.adoptionGrants.revoke(binding)
			if (reserved && createdReservation && (!binding || !this.adoptionGrants.hasActive(binding)))
				this.rollbackAdoption(commands, runDb, reserved, identity, 'attestation_failed')
			throw error
		}
	}

	/** Burn the transient bearer synchronously, then re-attest before attach. */
	attachAttentionDescriptor(
		profileId: string,
		runId: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
		capability: string,
	): Promise<AttentionAttachDescriptor> {
		return this.trackAdoption(this.attachAttentionDescriptorInternal(profileId, runId, revision, identity, capability))
	}
	private async attachAttentionDescriptorInternal(
		profileId: string,
		runId: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
		capability: string,
	): Promise<AttentionAttachDescriptor> {
		const runtime = this.captureProfile(profileId)
		const runDb = this.db.forProfile(runtime.profile.id)
		if (this.stopped) throw new Error('Scheduled attention adoption is unavailable')
		const commands = new ScheduleCommands(runDb.schedules, this.config.scheduledRuns.systemTargetsEnabled)
		const binding = { profileId, runId, revision, ...identity }
		if (!this.adoptionGrants.redeem(binding, capability)) throw new Error('Scheduled attention adoption is unavailable')
		let reserved: ScheduledRunRecord | null = null
		try {
			reserved = runDb.schedules.requireRun(runId)
			this.assertReservedAdoption(reserved, revision, identity)
			const persistedIdentity = parseIdentity(reserved.processFingerprint)
			if (!persistedIdentity) throw new Error('Scheduled attention session cannot be attested')
			const attestation = await this.supervisor.attestLiveSession(profileId, reserved.sessionId, persistedIdentity)
			if (attestation.state !== 'verified') throw new Error('Scheduled attention session cannot be attested')
			this.assertReservedAdoption(runDb.schedules.requireRun(runId), revision, identity)
			return { socketPath: attestation.socketPath, mode: 'attach-existing', redraw: 'winch' }
		} catch (error) {
			if (reserved) this.rollbackAdoption(commands, runDb, reserved, identity, 'attestation_failed')
			this.adoptionGrants.revoke(binding)
			throw error
		}
	}

	completeAttentionAdoption(
		profileId: string,
		runId: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
		ownershipRegistered: true,
	): ScheduledRunRecord {
		if (this.stopped) throw new Error('Scheduled attention adoption is unavailable')
		const runtime = this.captureProfile(profileId)
		const runDb = this.db.forProfile(runtime.profile.id)
		return new ScheduleCommands(
			runDb.schedules,
			this.config.scheduledRuns.systemTargetsEnabled,
		).completeAttentionAdoption(runId, revision, identity, this.adoptionGrants, ownershipRegistered)
	}

	/**
	 * Main-only restart restoration for an already completed Electron owner.
	 * It accepts only the durable non-secret registry identity and performs the
	 * same exact read-only attestation before returning an ephemeral descriptor.
	 */
	restoreCompletedAttentionDescriptor(
		profileId: string,
		runId: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
	): Promise<AttentionAttachDescriptor> {
		return this.trackAdoption(this.restoreCompletedAttentionDescriptorInternal(profileId, runId, revision, identity))
	}
	private async restoreCompletedAttentionDescriptorInternal(
		profileId: string,
		runId: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
	): Promise<AttentionAttachDescriptor> {
		const runtime = this.captureProfile(profileId)
		const runDb = this.db.forProfile(runtime.profile.id)
		if (this.stopped) throw new Error('Scheduled attention adoption is unavailable')
		const run = runDb.schedules.requireRun(runId)
		if (
			run.attentionAdoption?.state !== 'completed' ||
			run.attentionAdoption.adoptionId !== identity.adoptionId ||
			run.attentionAdoption.adopter !== identity.adopter ||
			run.terminalResolvedAt === null ||
			// Completion increments the reservation revision once; later independent
			// lifecycle writers may advance it further without invalidating ownership.
			run.revision < revision + 1
		)
			throw new Error('Scheduled attention adoption is unavailable')
		const persistedIdentity = parseIdentity(run.processFingerprint)
		if (!persistedIdentity) throw new Error('Scheduled attention session cannot be attested')
		const attestation = await this.supervisor.attestLiveSession(profileId, run.sessionId, persistedIdentity)
		if (attestation.state !== 'verified' || this.stopped)
			throw new Error('Scheduled attention session cannot be attested')
		const current = runDb.schedules.requireRun(runId)
		if (
			current.attentionAdoption?.state !== 'completed' ||
			current.attentionAdoption.adoptionId !== identity.adoptionId ||
			current.attentionAdoption.adopter !== identity.adopter ||
			current.terminalResolvedAt === null
		)
			throw new Error('Scheduled attention adoption is unavailable')
		return { socketPath: attestation.socketPath, mode: 'attach-existing', redraw: 'winch' }
	}

	rollbackAttentionAdoption(
		profileId: string,
		runId: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
	): ScheduledRunRecord {
		if (this.stopped) throw new Error('Scheduled attention adoption is unavailable')
		const runtime = this.captureProfile(profileId)
		const runDb = this.db.forProfile(runtime.profile.id)
		const binding = { profileId, runId, revision, ...identity }
		try {
			return new ScheduleCommands(
				runDb.schedules,
				this.config.scheduledRuns.systemTargetsEnabled,
			).rollbackAttentionAdoption(runId, revision, identity, 'client')
		} finally {
			this.adoptionGrants.revoke(binding)
		}
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

	/** Active or quarantined durable runs make a daemon restart unsafe. */
	restartBlockingRunCount(): number {
		let count = 0
		// Snapshot profile IDs before touching tenant stores so a profile activation
		// cannot redirect this read to a different tenant mid-count.
		for (const { profile } of this.deps.profiles())
			count += this.db.forProfile(profile.id).schedules.countRecoverableRuns()
		return count
	}

	/** Manual execution uses the same tenant preflight and shared capacity budget. */
	async runNow(profileId: string, scheduleId: string): Promise<ScheduledRunRecord> {
		if (!this.isAdmissionOpen()) throw new Error('Scheduled admission requires a live resident lease')
		const runtime = this.captureProfile(profileId)
		if (runtime.profile.archivedAt) throw new Error('Archived profile cannot admit scheduled runs')
		const runDb = this.db.forProfile(profileId)
		const commands = new ScheduleCommands(runDb.schedules, this.config.scheduledRuns.systemTargetsEnabled)
		const schedule = runDb.schedules.require(scheduleId)
		if (!schedule.enabled || schedule.archivedAt) throw new Error('Schedule is not enabled')
		if (schedule.definition.target.kind === 'system' && !this.config.scheduledRuns.systemTargetsEnabled)
			throw new Error('System scheduled targets are disabled')
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
		const commands = new ScheduleCommands(runDb.schedules, this.config.scheduledRuns.systemTargetsEnabled)
		let run = runDb.schedules.requireRun(runId)
		run = commands.report(run.id, run.revision, kind, summary)
		if (kind === 'needs_attention') {
			this.releaseReservation(run.id)
			return run
		}
		// Identical quiet retries converge through the durable state rather than
		// attempting a second reported_quiet -> closing transition.
		return this.closeQuiet(profileId, commands, run)
	}

	async cancel(profileId: string, runId: string): Promise<ScheduledRunRecord> {
		const runDb = this.db.forProfile(profileId)
		const commands = new ScheduleCommands(runDb.schedules, this.config.scheduledRuns.systemTargetsEnabled)
		const requested = commands.requestCancel(runId, runDb.schedules.requireRun(runId).revision)
		return this.runTerminalOperation(profileId, runId, async () => {
			let run = requested
			const result = await this.teardown(profileId, run)
			if (result === 'quarantined')
				return commands.markQuarantined(run.id, run.revision, 'Scheduled teardown ownership is unknown')
			run = commands.markCancelled(run.id, runDb.schedules.requireRun(run.id).revision)
			this.releaseReservation(run.id)
			return run
		})
	}

	/** Recover durable runs on daemon start; never relaunch an existing session. */
	async reconcile(): Promise<void> {
		if (!this.reconcileAdmissionOpen) return
		if (this.reconcileInFlight) return this.reconcileInFlight
		this.reconcileInFlight = this.reconcileInternal().finally(() => {
			this.reconcileInFlight = null
		})
		return this.reconcileInFlight
	}

	private async reconcileInternal(): Promise<void> {
		for (const runtime of this.deps.profiles()) {
			const profileId = runtime.profile.id
			const runDb = this.db.forProfile(profileId) // capture tenant seam before await
			const commands = new ScheduleCommands(runDb.schedules, this.config.scheduledRuns.systemTargetsEnabled)
			let after: { createdAt: string; id: string } | null = null
			for (;;) {
				const page = runDb.schedules.listRecoverableRunsPage(after)
				if (page.length === 0) break
				for (const initial of page) {
					after = { createdAt: initial.createdAt, id: initial.id }
					if (this.stopped) return
					try {
						await this.reconcileRun(profileId, commands, initial)
					} catch (error) {
						// Another durable actor may have won a revision; the next pass converges.
						log.warn('scheduled-runs', `Recovery failed for ${initial.id}: ${message(error)}`)
					}
				}
				if (page.length < 500) break
			}
			for (const terminal of terminalRunsToPrune(runDb.schedules, this.now()).slice(0, 50)) {
				if (terminal.runDir && terminal.closedAt) {
					try {
						const cleanup = await this.workspaceCleaner.cleanup({
							profileId,
							profileRoot: runtime.rootDir,
							runId: terminal.id,
							expectedRunDir: terminal.runDir,
							closedAt: terminal.closedAt,
						})
						if (cleanup.status === 'retained')
							log.warn('scheduled-runs', `Retention workspace retained for ${terminal.id}: ${cleanup.reason}`)
					} catch {
						log.warn('scheduled-runs', `Retention workspace retained for ${terminal.id}: failed`)
					}
				}
				try {
					runDb.schedules.deleteRun(terminal.id)
				} catch (error) {
					log.warn('scheduled-runs', `Retention metadata prune failed for ${terminal.id}: ${message(error)}`)
				}
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
				if (processed >= MAX_DUE_PER_TICK || !this.isAdmissionOpen()) break
				const profileId = runtime.profile.id
				const runDb = this.db.forProfile(profileId) // capture before await/admission
				const due = runDb.schedules.listDue(this.now().toISOString(), 1)[0]
				if (!due) continue
				progressed = true
				processed++
				const commands = new ScheduleCommands(runDb.schedules, this.config.scheduledRuns.systemTargetsEnabled)
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
		if (schedule.definition.target.kind === 'system' && !this.config.scheduledRuns.systemTargetsEnabled) {
			const runId = randomUUID()
			return commands.disableSystemTargetAndCloseOccurrence(schedule.id, schedule.revision, following, {
				id: runId,
				scheduleId: schedule.id,
				scheduleRevision: schedule.revision,
				scheduledFor: latest.occurrence.scheduledFor,
				localCivilSlot: latest.occurrence.localCivil,
				utcOffsetMinutes: latest.occurrence.offsetMinutes,
				slotKey: latest.occurrence.slotKey,
				definitionSnapshot: schedule.definition,
				sessionId: scheduledSessionId(runId),
				missedCount: latest.dropped.count,
				missedMany: latest.dropped.many,
			})
		}
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
		if (schedule.definition.target.kind === 'system' && !this.config.scheduledRuns.systemTargetsEnabled)
			throw new Error('System scheduled targets are disabled')
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
		if (occurrence.manual) run = commands.claimManualOccurrence(schedule.id, schedule.revision, claim)
		else run = commands.claimOccurrence(schedule.id, schedule.revision, occurrence.advanceTo, claim)
		if (occurrence.misfire || run.state === 'skipped_overlap') return run
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
		if (!this.drainer.reserveExternalSolve(run.id)) return this.skip(runDb, run, 'skipped_capacity')
		this.admissionInFlight.add(run.id)
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
			const reporterCommand = this.requireReporterCommand()
			const prompt = buildScheduledPrompt({ definition: run.definitionSnapshot, reporterCommand })
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
				onQuarantined: quarantine => {
					if (quarantine.identity)
						run = commands.recordRuntime(run.id, run.revision, runtimeFields(run, quarantine.identity))
					if (!commands.isTerminal(run))
						run = commands.markQuarantined(run.id, run.revision, `Launch cleanup: ${quarantine.reason}`)
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
			// A supervisor handoff to quarantine means ownership may still be live;
			// retain the reservation until a definitive probe/teardown resolves it.
			if (current.state !== 'quarantined') this.releaseReservation(run.id)
			throw error
		} finally {
			this.admissionInFlight.delete(run.id)
		}
	}

	private closeQuiet(
		profileId: string,
		commands: ScheduleCommands,
		reported: ScheduledRunRecord,
	): Promise<ScheduledRunRecord> {
		return this.runTerminalOperation(profileId, reported.id, () =>
			this.closeQuietInternal(profileId, commands, reported),
		)
	}

	private async closeQuietInternal(
		profileId: string,
		commands: ScheduleCommands,
		reported: ScheduledRunRecord,
	): Promise<ScheduledRunRecord> {
		let run = this.db.forProfile(profileId).schedules.requireRun(reported.id)
		if (run.state === 'closed_quiet') return run
		run = commands.beginClose(run.id, run.revision)
		if (run.state !== 'closing' && run.state !== 'quarantined') return run
		const result = await this.teardown(profileId, run)
		if (result === 'quarantined')
			return commands.markQuarantined(run.id, run.revision, 'Quiet teardown ownership is unknown')
		run = commands.closeQuiet(run.id, this.db.forProfile(profileId).schedules.requireRun(run.id).revision)
		this.releaseReservation(run.id)
		return run
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
		// A workspace or dtach launch owned by this process has not necessarily
		// published its socket yet. Only a future process may recover that row.
		if (this.admissionInFlight.has(initial.id)) return
		this.rollbackExpiredAdoption(commands, initial)
		// Migration 29 deliberately leaves existing rows nullable. Preserve the
		// exact request encoded by legacy lifecycle state before an unknown probe
		// can replace that state with the generic quarantine state.
		let run = commands.materializeTerminalIntent(initial.id, initial.revision)
		const socket = await probeScheduledSocket(scheduledSocketPath(profileId, run.sessionId))
		if (run.state === 'needs_attention') {
			this.releaseReservation(run.id)
			return
		}
		// Unknown ownership is capacity-bearing until a later probe proves death.
		if (socket === 'unknown') {
			this.restoreReservation(run)
			if (run.state !== 'quarantined')
				commands.markQuarantined(run.id, run.revision, 'Scheduled socket probe is unknown')
			return
		}
		if (socket === 'live') {
			this.restoreReservation(run)
			const intent = this.terminalIntent(run)
			if (intent === 'quiet') {
				await this.closeQuiet(profileId, commands, run)
				return
			}
			if (intent === 'cancel') {
				await this.cancel(profileId, run.id)
				return
			}
			if (intent === 'timeout') {
				await this.timeout(profileId, commands, run)
				return
			}
			if (
				run.startedAt &&
				Date.parse(run.startedAt) + run.definitionSnapshot.maximumRuntimeMinutes * 60_000 <= this.now().getTime()
			) {
				await this.timeout(profileId, commands, run)
			}
			return
		}
		// A durable intent, including one retained through quarantine, decides the
		// exact terminal outcome. Only an intent-less quarantine is unknowable.
		const intent = this.terminalIntent(run)
		if (intent === 'quiet') {
			run = commands.beginClose(run.id, run.revision)
			commands.closeQuiet(run.id, run.revision)
		} else if (intent === 'cancel') {
			run = commands.requestCancel(run.id, run.revision)
			commands.markCancelled(run.id, run.revision)
		} else if (intent === 'timeout') {
			run = commands.requestTimeout(run.id, run.revision)
			commands.markTimedOut(run.id, run.revision)
		} else if (run.state === 'quarantined') {
			commands.markSessionLost(run.id, run.revision, 'Scheduled session was dead after ownership quarantine')
		} else {
			commands.markInterrupted(run.id, run.revision, 'Scheduled session was dead during reconciliation')
		}
		this.releaseReservation(run.id)
	}

	private async timeout(profileId: string, commands: ScheduleCommands, run: ScheduledRunRecord): Promise<void> {
		const requested = run.state === 'timeout_requested' ? run : commands.requestTimeout(run.id, run.revision)
		await this.runTerminalOperation(profileId, run.id, async () => {
			const result = await this.teardown(profileId, requested)
			if (result === 'quarantined')
				return commands.markQuarantined(requested.id, requested.revision, 'Timeout teardown ownership is unknown')
			const timedOut = commands.markTimedOut(
				requested.id,
				this.db.forProfile(profileId).schedules.requireRun(requested.id).revision,
			)
			this.releaseReservation(timedOut.id)
			return timedOut
		})
	}
	private runTerminalOperation(
		profileId: string,
		runId: string,
		operation: () => Promise<ScheduledRunRecord>,
	): Promise<ScheduledRunRecord> {
		const key = `${profileId}:${runId}`
		const inFlight = this.terminalInFlight.get(key)
		if (inFlight) return inFlight
		const pending = operation().finally(() => {
			if (this.terminalInFlight.get(key) === pending) this.terminalInFlight.delete(key)
		})
		this.terminalInFlight.set(key, pending)
		return pending
	}
	/** Persisted intent wins; legacy pre-migration request states are deterministic evidence, never a guess. */
	private terminalIntent(run: ScheduledRunRecord): ScheduledTerminalIntent | null {
		if (run.pendingTerminalIntent) return run.pendingTerminalIntent
		if (run.state === 'reported_quiet' || run.state === 'closing') return 'quiet'
		if (run.state === 'cancel_requested') return 'cancel'
		if (run.state === 'timeout_requested') return 'timeout'
		return null
	}
	private restoreReservation(run: ScheduledRunRecord): boolean {
		if (this.drainer.reserveExternalSolve(run.id)) {
			this.startupReservationFailures.delete(run.id)
			return true
		}
		if (this.restoringStartup) this.startupReservationFailures.add(run.id)
		log.warn(
			'scheduled-runs',
			`Scheduled run ${run.id} could not reserve solve capacity; Item admission remains fenced`,
		)
		return false
	}

	private releaseReservation(runId: string): boolean {
		this.startupReservationFailures.delete(runId)
		return this.drainer.releaseExternalSolve(runId)
	}

	private skip(runDb: DB, run: ScheduledRunRecord, state: 'skipped_overlap' | 'skipped_capacity'): ScheduledRunRecord {
		this.releaseReservation(run.id)
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
	private trackAdoption<T>(operation: Promise<T>): Promise<T> {
		this.adoptionInFlight.add(operation)
		void operation.finally(() => this.adoptionInFlight.delete(operation)).catch(() => undefined)
		return operation
	}
	private assertReservedAdoption(run: ScheduledRunRecord, revision: number, identity: AttentionAdoptionIdentity): void {
		if (
			run.revision !== revision ||
			run.attentionAdoption?.state !== 'reserved' ||
			run.attentionAdoption.adoptionId !== identity.adoptionId ||
			run.attentionAdoption.adopter !== identity.adopter
		)
			throw new Error('Scheduled attention adoption is unavailable')
	}
	private rollbackAdoption(
		commands: ScheduleCommands,
		runDb: DB,
		reserved: ScheduledRunRecord,
		identity: AttentionAdoptionIdentity,
		reason: 'attestation_failed' | 'expired',
	): void {
		try {
			const current = runDb.schedules.requireRun(reserved.id)
			if (current.attentionAdoption?.state === 'reserved')
				commands.rollbackAttentionAdoption(current.id, current.revision, identity, reason)
		} catch {
			// A concurrent terminal intent/revision winner is already fail-closed.
		}
	}
	private rollbackExpiredAdoption(commands: ScheduleCommands, run: ScheduledRunRecord): void {
		if (
			run.attentionAdoption?.state !== 'reserved' ||
			Date.parse(run.attentionAdoption.expiresAt) > this.now().getTime()
		)
			return
		const identity = { adoptionId: run.attentionAdoption.adoptionId, adopter: run.attentionAdoption.adopter }
		const binding = { profileId: run.profileId, runId: run.id, revision: run.revision, ...identity }
		if (this.adoptionGrants.hasRedeemed(binding)) return
		this.rollbackAdoption(commands, this.db.forProfile(run.profileId), run, identity, 'expired')
		this.adoptionGrants.revoke({ profileId: run.profileId, runId: run.id, revision: run.revision, ...identity })
	}
	private rollbackReservedAdoptionsOnRestart(): void {
		for (const runtime of this.deps.profiles()) {
			const runDb = this.db.forProfile(runtime.profile.id)
			const commands = new ScheduleCommands(runDb.schedules, this.config.scheduledRuns.systemTargetsEnabled)
			let after: { createdAt: string; id: string } | null = null
			for (;;) {
				const page = runDb.schedules.listRecoverableRunsPage(after)
				if (page.length === 0) break
				for (const run of page) {
					after = { createdAt: run.createdAt, id: run.id }
					if (run.attentionAdoption?.state === 'reserved') commands.recoverAttentionAdoption(run.id)
				}
				if (page.length < 500) break
			}
		}
	}
	private captureProfile(profileId: string): ProfileRuntime {
		const runtime = this.deps.profiles().find(candidate => candidate.profile.id === profileId)
		if (!runtime) throw new Error('Scheduled profile is not registered')
		return runtime
	}
	private isAdmissionOpen(): boolean {
		return this.config.scheduledRuns.enabled && !this.stopped && !this.restoringStartup && this.deps.hasResidentLease()
	}
	private requireReporterCommand(): readonly [string, ...string[]] {
		const command = this.deps.reporterCommand
		if (!command || command.some(part => !isAbsolute(part)))
			throw new Error('Scheduled reporter command is not configured')
		return command
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
