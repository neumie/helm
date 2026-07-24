import { ATTENTION_ADOPTION_GRANT_TTL_MS, type AttentionAdoptionGrantManager } from './adoption-grants.js'
import { validateScheduledReportSummary } from './prompt.js'
import { nextOccurrence, normalizeCadence } from './recurrence.js'
import { isScheduledRunTerminalState } from './retention.js'
import { ATTENTION_NOTIFICATION_CLAIM_LEASE_MS } from './schema.js'
import type {
	AttentionAdoptionIdentity,
	AttentionAdoptionRollbackReason,
	CreateScheduledRunInput,
	ScheduleRecord,
	ScheduledRunRecord,
	ScheduledRunState,
	ScheduledTerminalIntent,
} from './schema.js'
import {
	attentionAdoptionIdentitySchema,
	scheduleCreateSchema,
	scheduledRunDiagnosticSchema,
	scheduledRunReportSchema,
} from './schema.js'
import { ScheduleRevisionConflictError, type ScheduleStore } from './store.js'

const ACTIVE_STATES = new Set<ScheduledRunState>([
	'admitted',
	'preparing',
	'launching',
	'running',
	'reported_quiet',
	'closing',
	'needs_attention',
	'cancel_requested',
	'timeout_requested',
	'quarantined',
])
const LAUNCHABLE_STATES = new Set<ScheduledRunState>(['admitted', 'preparing', 'launching'])
const CANCELLABLE_STATES = new Set<ScheduledRunState>([
	'admitted',
	'preparing',
	'launching',
	'running',
	'needs_attention',
	'cancel_requested',
	'quarantined',
])
const TIMEOUTABLE_STATES = new Set<ScheduledRunState>(['admitted', 'preparing', 'launching', 'running'])
/** Stable, bounded persisted explanation for a rollout-disabled system target. */
export const SYSTEM_TARGETS_DISABLED_REASON = 'system_targets_disabled'

/** All schedule/run lifecycle changes go through this tenant-bound command seam. */
export class ScheduleCommands {
	constructor(
		private readonly store: ScheduleStore,
		private readonly systemTargetsEnabled = false,
	) {}
	create(input: unknown): ScheduleRecord {
		const schedule = this.prepareSchedule(input)
		this.assertSystemTargetAllowed(schedule)
		return this.store.create(schedule)
	}
	update(id: string, revision: number, input: unknown): ScheduleRecord {
		const schedule = this.prepareSchedule(input)
		this.assertSystemTargetAllowed(schedule)
		return this.store.update(id, revision, schedule)
	}
	enable(id: string, revision: number): ScheduleRecord {
		this.assertSystemTargetAllowed(this.store.require(id))
		return this.store.setEnabled(id, revision, true)
	}
	disable(id: string, revision: number, reason = 'disabled'): ScheduleRecord {
		return this.store.setEnabled(id, revision, false, reason)
	}
	archive(id: string, revision: number): ScheduleRecord {
		return this.store.archive(id, revision)
	}

	/**
	 * Atomically advance cadence and classify an occurrence before the active-run
	 * unique index can reject it. A skipped overlap is durable terminal history,
	 * not a failed admission attempt, so the cadence always progresses once.
	 */
	claimOccurrence(
		scheduleId: string,
		expectedRevision: number,
		nextRunAt: string | null,
		input: CreateScheduledRunInput,
	): ScheduledRunRecord {
		return this.claim(scheduleId, expectedRevision, nextRunAt, input, true)
	}
	/** Manual runs share overlap policy but deliberately do not move recurrence cadence. */
	claimManualOccurrence(
		scheduleId: string,
		expectedRevision: number,
		input: CreateScheduledRunInput,
	): ScheduledRunRecord {
		return this.claim(scheduleId, expectedRevision, null, input, false)
	}
	/**
	 * A stale persisted system schedule must not remain due after the rollout flag
	 * is disabled. Advance its cadence, disable it, and persist the terminal slot
	 * in one transaction so a restart cannot spin on the same occurrence.
	 */
	disableSystemTargetAndCloseOccurrence(
		scheduleId: string,
		expectedRevision: number,
		nextRunAt: string | null,
		input: CreateScheduledRunInput,
	): ScheduledRunRecord {
		return this.store.transaction(() => {
			const schedule = this.store.require(scheduleId)
			if (!schedule.enabled || schedule.archivedAt) throw new Error('Schedule is not enabled')
			if (schedule.revision !== expectedRevision) throw new ScheduleRevisionConflictError()
			if (schedule.definition.target.kind !== 'system') throw new Error('Schedule is not a system target')
			if (this.systemTargetsEnabled) throw new Error('System scheduled targets are enabled')
			if (input.scheduleId !== scheduleId || input.scheduleRevision !== expectedRevision)
				throw new Error('Occurrence does not match schedule revision')
			if (this.store.findRunBySlot(scheduleId, input.slotKey)) throw new Error('Occurrence already claimed')
			const advanced = this.store.advanceNextRun(scheduleId, expectedRevision, nextRunAt)
			this.store.setEnabled(advanced.id, advanced.revision, false, SYSTEM_TARGETS_DISABLED_REASON)
			return this.store.createRun({
				...input,
				state: 'skipped_system_targets_disabled',
				closedAt: new Date().toISOString(),
			})
		})
	}
	beginPreparing(id: string, revision: number): ScheduledRunRecord {
		return this.transition(id, revision, ['admitted'], 'preparing')
	}
	beginLaunching(id: string, revision: number): ScheduledRunRecord {
		return this.transition(id, revision, ['preparing'], 'launching')
	}
	markRunning(id: string, revision: number): ScheduledRunRecord {
		return this.transition(id, revision, ['launching'], 'running', { startedAt: new Date().toISOString() })
	}
	/** Persist filesystem/session identity before launch and master identity at readiness. */
	recordRuntime(
		id: string,
		revision: number,
		fields: Pick<
			ScheduledRunRecord,
			'processFingerprint' | 'cwd' | 'worktreePath' | 'branchName' | 'runDir' | 'socketDescriptor'
		>,
	): ScheduledRunRecord {
		return this.store.updateRunRuntime(id, revision, fields)
	}
	markInterrupted(id: string, revision: number, detail: string | null = null): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (!LAUNCHABLE_STATES.has(run.state) && run.state !== 'running') throw new Error('Run cannot be interrupted')
		return this.transition(id, revision, [run.state], 'interrupted', {
			closedAt: new Date().toISOString(),
			diagnosticDetail: scheduledRunDiagnosticSchema.parse(detail),
		})
	}
	markQuarantined(id: string, revision: number, detail: string | null = null): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (!ACTIVE_STATES.has(run.state)) throw new Error('Run cannot be quarantined')
		return this.transition(id, revision, [run.state], 'quarantined', {
			diagnosticDetail: scheduledRunDiagnosticSchema.parse(detail),
		})
	}
	requestCancel(id: string, revision: number): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (run.attentionAdoption?.state === 'reserved')
			throw new Error('Scheduled run attention adoption is actively reserved')
		if (run.pendingTerminalIntent && run.pendingTerminalIntent !== 'cancel')
			throw new Error('Scheduled run already has a conflicting terminal intent')
		if (!CANCELLABLE_STATES.has(run.state)) throw new Error('Only an active scheduled run can be cancelled')
		const claimed = this.claimTerminalIntent(id, revision, 'cancel')
		if (claimed.state === 'cancel_requested' || claimed.state === 'quarantined') return claimed
		return this.transition(claimed.id, claimed.revision, [claimed.state], 'cancel_requested')
	}
	markCancelled(id: string, revision: number): ScheduledRunRecord {
		return this.resolveTerminalIntent(id, revision, ['cancel_requested', 'quarantined'], 'cancelled', 'cancel')
	}
	markSessionLost(id: string, revision: number, detail: string): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (run.pendingTerminalIntent) throw new Error('Scheduled run has a pending terminal intent')
		return this.transition(id, revision, ['quarantined'], 'session_lost', {
			closedAt: new Date().toISOString(),
			diagnosticDetail: scheduledRunDiagnosticSchema.parse(detail),
		})
	}
	markFailed(id: string, revision: number, detail: string | null = null): ScheduledRunRecord {
		const diagnosticDetail = scheduledRunDiagnosticSchema.parse(detail)
		const run = this.store.requireRun(id)
		if (!LAUNCHABLE_STATES.has(run.state) && run.state !== 'running' && run.state !== 'closing')
			throw new Error('Run cannot fail from its current state')
		return this.transition(id, revision, [run.state], 'failed', {
			closedAt: new Date().toISOString(),
			diagnosticDetail,
		})
	}
	/** First durable timeout intent wins before ownership-sensitive teardown. */
	requestTimeout(id: string, revision: number): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (run.pendingTerminalIntent && run.pendingTerminalIntent !== 'timeout')
			throw new Error('Scheduled run already has a conflicting terminal intent')
		if (run.state === 'quarantined' && run.pendingTerminalIntent === 'timeout') return run
		if (run.state !== 'timeout_requested' && !TIMEOUTABLE_STATES.has(run.state))
			throw new Error('Only an unreported scheduled run can time out')
		const claimed = this.claimTerminalIntent(id, revision, 'timeout')
		if (claimed.state === 'timeout_requested') return claimed
		return this.transition(claimed.id, claimed.revision, [claimed.state], 'timeout_requested')
	}
	markTimedOut(id: string, revision: number): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (run.pendingTerminalIntent !== 'timeout') throw new Error('Only an unreported scheduled run can time out')
		return this.resolveTerminalIntent(id, revision, ['timeout_requested', 'quarantined'], 'timed_out', 'timeout')
	}
	/** First matching report wins; an identical retry is intentionally idempotent. */
	report(id: string, revision: number, kind: 'quiet' | 'needs_attention', summary: string): ScheduledRunRecord {
		// Normalize before schema validation and idempotency so terminal controls never reach persistence.
		const report = scheduledRunReportSchema.parse({ kind, summary: validateScheduledReportSummary(summary) })
		// Quiet intent and report evidence are one crash-safe write boundary. A process
		// death between the two statements rolls the transaction back instead of
		// leaving a capacity-bearing running row with only half the report protocol.
		return this.store.transaction(() => {
			const run = this.store.requireRun(id)
			if (run.reportKind) {
				if (run.reportKind === report.kind && run.reportSummary === report.summary) return run
				throw new Error('Scheduled run already has a conflicting report')
			}
			if (run.revision !== revision) throw new ScheduleRevisionConflictError()
			if (run.state !== 'running') throw new Error('Only a running scheduled run can report')
			if (run.pendingTerminalIntent && !(report.kind === 'quiet' && run.pendingTerminalIntent === 'quiet'))
				throw new Error('Scheduled run already has a conflicting terminal intent')
			const claimed = report.kind === 'quiet' ? this.claimTerminalIntent(id, revision, 'quiet') : run
			return this.store.transitionRun(
				id,
				claimed.revision,
				report.kind === 'quiet' ? 'reported_quiet' : 'needs_attention',
				{
					reportedAt: new Date().toISOString(),
					reportKind: report.kind,
					reportSummary: report.summary,
				},
			)
		})
	}
	/** Materialize pre-migration request-state meaning before quarantine can erase it. */
	materializeTerminalIntent(id: string, revision: number): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (run.pendingTerminalIntent) return run
		let intent: ScheduledTerminalIntent | null = null
		if (run.state === 'reported_quiet' || run.state === 'closing') intent = 'quiet'
		else if (run.state === 'cancel_requested') intent = 'cancel'
		else if (run.state === 'timeout_requested') intent = 'timeout'
		return intent ? this.claimTerminalIntent(id, revision, intent) : run
	}
	beginClose(id: string, revision: number): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		const recoveringPartialQuiet = run.state === 'running' && run.pendingTerminalIntent === 'quiet'
		if (!recoveringPartialQuiet && !['reported_quiet', 'closing', 'quarantined'].includes(run.state))
			throw new Error('Only a quiet reported run can close')
		const claimed = this.claimTerminalIntent(id, revision, 'quiet')
		if (claimed.state === 'closing' || claimed.state === 'quarantined') return claimed
		return this.transition(claimed.id, claimed.revision, ['running', 'reported_quiet'], 'closing')
	}
	closeQuiet(id: string, revision: number): ScheduledRunRecord {
		return this.resolveTerminalIntent(id, revision, ['closing', 'quarantined'], 'closed_quiet', 'quiet')
	}
	/** Claim a bounded native-notification delivery lease for an unresolved attention run. */
	claimAttentionNotification(id: string, revision: number, now = new Date()): ScheduledRunRecord {
		const claimedAt = now.toISOString()
		const staleBefore = new Date(now.getTime() - ATTENTION_NOTIFICATION_CLAIM_LEASE_MS).toISOString()
		return this.store.claimAttentionNotification(id, revision, staleBefore, claimedAt)
	}
	/** Mark delivery only after the native notification has successfully been shown. */
	markNotificationDelivered(id: string, revision: number, now = new Date()): ScheduledRunRecord {
		return this.store.markAttentionNotificationDelivered(id, revision, now.toISOString())
	}
	/** A same-identity retry is safe; every other existing adoption fails closed. */
	reserveAttentionAdoption(id: string, revision: number, identity: AttentionAdoptionIdentity): ScheduledRunRecord {
		const parsed = attentionAdoptionIdentitySchema.parse(identity)
		const run = this.store.requireRun(id)
		if (run.attentionAdoption?.state === 'reserved' || run.attentionAdoption?.state === 'completed') {
			if (sameAdoptionIdentity(run.attentionAdoption, parsed)) return run
			throw new Error('Scheduled run attention adoption belongs to another attempt')
		}
		if (run.attentionAdoption?.state === 'rolled_back' && sameAdoptionIdentity(run.attentionAdoption, parsed))
			throw new Error('A rolled-back attention adoption requires a new identity')
		this.assertAttentionAdoptable(run)
		if (run.revision !== revision) throw new ScheduleRevisionConflictError()
		const reservedAt = new Date()
		return this.store.updateAttentionAdoption(
			id,
			revision,
			{
				state: 'reserved',
				...parsed,
				reservedAt: reservedAt.toISOString(),
				expiresAt: new Date(reservedAt.getTime() + ATTENTION_ADOPTION_GRANT_TTL_MS).toISOString(),
			},
			null,
			true,
		)
	}
	/**
	 * Completion means Electron has already durably registered ownership of the
	 * scheduled session. It atomically resolves the daemon terminal; Electron
	 * later owns close and teardown finalization.
	 */
	completeAttentionAdoption(
		id: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
		grants: AttentionAdoptionGrantManager,
		ownershipRegistered: true,
	): ScheduledRunRecord {
		if (ownershipRegistered !== true)
			throw new Error('Electron scheduled-session ownership must be durably registered before completion')
		const parsed = attentionAdoptionIdentitySchema.parse(identity)
		const run = this.store.requireRun(id)
		if (run.attentionAdoption?.state === 'completed' && sameAdoptionIdentity(run.attentionAdoption, parsed)) return run
		this.assertAttentionAdoptable(run)
		if (run.attentionAdoption?.state !== 'reserved' || !sameAdoptionIdentity(run.attentionAdoption, parsed))
			throw new Error('Scheduled run attention adoption reservation does not match')
		if (run.revision !== revision) throw new ScheduleRevisionConflictError()
		const grantBinding = { profileId: run.profileId, runId: run.id, revision, ...parsed }
		if (!grants.hasRedeemed(grantBinding)) throw new Error('Scheduled run attention adoption grant was not redeemed')
		const completedAt = new Date().toISOString()
		const completed = this.store.updateAttentionAdoption(
			id,
			revision,
			{
				state: 'completed',
				...parsed,
				reservedAt: run.attentionAdoption.reservedAt,
				expiresAt: run.attentionAdoption.expiresAt,
				completedAt,
			},
			completedAt,
		)
		grants.revoke(grantBinding)
		return completed
	}
	/** Rollback releases a reservation without resolving the daemon terminal. */
	rollbackAttentionAdoption(
		id: string,
		revision: number,
		identity: AttentionAdoptionIdentity,
		reason: AttentionAdoptionRollbackReason,
	): ScheduledRunRecord {
		const parsed = attentionAdoptionIdentitySchema.parse(identity)
		const run = this.store.requireRun(id)
		if (
			run.attentionAdoption?.state === 'rolled_back' &&
			sameAdoptionIdentity(run.attentionAdoption, parsed) &&
			run.attentionAdoption.reason === reason
		)
			return run
		if (run.terminalResolvedAt !== null || run.attentionAdoption?.state === 'completed')
			throw new Error('Scheduled run terminal is already resolved')
		if (run.state !== 'needs_attention' || run.reportKind !== 'needs_attention')
			throw new Error('Only an unresolved attention-reported scheduled run can roll back adoption')
		if (run.attentionAdoption?.state !== 'reserved' || !sameAdoptionIdentity(run.attentionAdoption, parsed))
			throw new Error('Scheduled run attention adoption reservation does not match')
		if (run.revision !== revision) throw new ScheduleRevisionConflictError()
		return this.store.updateAttentionAdoption(id, revision, {
			state: 'rolled_back',
			...parsed,
			reservedAt: run.attentionAdoption.reservedAt,
			expiresAt: run.attentionAdoption.expiresAt,
			rolledBackAt: new Date().toISOString(),
			reason,
		})
	}
	/** Startup recovery only releases an incomplete reservation. */
	recoverAttentionAdoption(id: string): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (run.attentionAdoption?.state !== 'reserved') return run
		return this.rollbackAttentionAdoption(
			run.id,
			run.revision,
			{ adoptionId: run.attentionAdoption.adoptionId, adopter: run.attentionAdoption.adopter },
			'restart',
		)
	}
	isTerminal(run: ScheduledRunRecord): boolean {
		return isScheduledRunTerminalState(run.state)
	}
	private assertAttentionAdoptable(run: ScheduledRunRecord): void {
		if (run.state !== 'needs_attention' || run.reportKind !== 'needs_attention')
			throw new Error('Only an attention-reported scheduled run can be adopted')
		if (run.pendingTerminalIntent !== null) throw new Error('Scheduled run already has a terminal teardown intent')
		if (run.terminalResolvedAt !== null) throw new Error('Scheduled run terminal is already resolved')
	}
	private claimTerminalIntent(id: string, revision: number, intent: ScheduledTerminalIntent): ScheduledRunRecord {
		return this.store.claimPendingTerminalIntent(id, revision, intent)
	}
	private resolveTerminalIntent(
		id: string,
		revision: number,
		allowed: ScheduledRunState[],
		next: ScheduledRunState,
		intent: ScheduledTerminalIntent,
	): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (run.pendingTerminalIntent !== intent)
			throw new Error('Scheduled run does not have the required pending terminal intent')
		return this.transition(id, revision, allowed, next, {
			closedAt: new Date().toISOString(),
			pendingTerminalIntent: null,
		})
	}
	private claim(
		scheduleId: string,
		expectedRevision: number,
		nextRunAt: string | null,
		input: CreateScheduledRunInput,
		advanceCadence: boolean,
	): ScheduledRunRecord {
		return this.store.transaction(() => {
			const schedule = this.store.require(scheduleId)
			if (!schedule.enabled || schedule.archivedAt) throw new Error('Schedule is not enabled')
			if (schedule.revision !== expectedRevision) throw new ScheduleRevisionConflictError()
			if (input.scheduleId !== scheduleId || input.scheduleRevision !== expectedRevision)
				throw new Error('Occurrence does not match schedule revision')
			if (this.store.findRunBySlot(scheduleId, input.slotKey)) throw new Error('Occurrence already claimed')
			const overlap = this.store.findActiveRun(scheduleId)
			if (advanceCadence) this.store.advanceNextRun(scheduleId, expectedRevision, nextRunAt)
			return this.store.createRun(
				overlap ? { ...input, state: 'skipped_overlap', closedAt: new Date().toISOString() } : input,
			)
		})
	}
	private prepareSchedule(input: unknown) {
		const parsed = scheduleCreateSchema.parse(input)
		const recurrence = normalizeCadence({ kind: 'cron', expression: parsed.cron }, parsed.timezone)
		const next = nextOccurrence(recurrence.cron, recurrence.timezone, new Date())
		if (!next) throw new Error('Cron has no occurrence within the recurrence horizon')
		return { ...parsed, ...recurrence, nextRunAt: next.scheduledFor }
	}
	private assertSystemTargetAllowed(schedule: { definition: ScheduleRecord['definition'] }): void {
		if (!this.systemTargetsEnabled && schedule.definition.target.kind === 'system')
			throw new Error('System scheduled targets are disabled')
	}
	private transition(
		id: string,
		revision: number,
		allowed: ScheduledRunState[],
		next: ScheduledRunState,
		fields = {},
	): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (run.revision !== revision) throw new ScheduleRevisionConflictError()
		if (!allowed.includes(run.state)) throw new Error(`Invalid scheduled run transition: ${run.state} -> ${next}`)
		return this.store.transitionRun(id, revision, next, fields)
	}
}

function sameAdoptionIdentity(
	adoption: { adoptionId: string; adopter: string },
	identity: AttentionAdoptionIdentity,
): boolean {
	return adoption.adoptionId === identity.adoptionId && adoption.adopter === identity.adopter
}
