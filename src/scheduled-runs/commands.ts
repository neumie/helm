import { validateScheduledReportSummary } from './prompt.js'
import { nextOccurrence, normalizeCadence } from './recurrence.js'
import type { CreateScheduledRunInput, ScheduleRecord, ScheduledRunRecord, ScheduledRunState } from './schema.js'
import { scheduleCreateSchema, scheduledRunDiagnosticSchema, scheduledRunReportSchema } from './schema.js'
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
	'quarantined',
])
const LAUNCHABLE_STATES = new Set<ScheduledRunState>(['admitted', 'preparing', 'launching'])
const TIMEOUTABLE_STATES = new Set<ScheduledRunState>(['admitted', 'preparing', 'launching', 'running'])
const TERMINAL_STATES = new Set<ScheduledRunState>([
	'closed_quiet',
	'cancelled',
	'timed_out',
	'failed',
	'interrupted',
	'session_lost',
	'skipped_overlap',
	'skipped_misfire',
	'skipped_profile_archived',
	'skipped_project_disabled',
	'skipped_capacity',
])

/** All schedule/run lifecycle changes go through this tenant-bound command seam. */
export class ScheduleCommands {
	constructor(private readonly store: ScheduleStore) {}
	create(input: unknown): ScheduleRecord {
		return this.store.create(this.prepareSchedule(input))
	}
	update(id: string, revision: number, input: unknown): ScheduleRecord {
		return this.store.update(id, revision, this.prepareSchedule(input))
	}
	enable(id: string, revision: number): ScheduleRecord {
		return this.store.setEnabled(id, revision, true)
	}
	disable(id: string, revision: number, reason = 'disabled'): ScheduleRecord {
		return this.store.setEnabled(id, revision, false, reason)
	}
	archive(id: string, revision: number): ScheduleRecord {
		return this.store.archive(id, revision)
	}

	/** Atomically advance cadence and claim the one durable occurrence for a slot. */
	claimOccurrence(
		scheduleId: string,
		expectedRevision: number,
		nextRunAt: string | null,
		input: CreateScheduledRunInput,
	): ScheduledRunRecord {
		return this.store.transaction(() => {
			const schedule = this.store.require(scheduleId)
			if (!schedule.enabled || schedule.archivedAt) throw new Error('Schedule is not enabled')
			if (schedule.revision !== expectedRevision) throw new ScheduleRevisionConflictError()
			if (input.scheduleId !== scheduleId || input.scheduleRevision !== expectedRevision)
				throw new Error('Occurrence does not match schedule revision')
			if (this.store.findRunBySlot(scheduleId, input.slotKey)) throw new Error('Occurrence already claimed')
			this.store.advanceNextRun(scheduleId, expectedRevision, nextRunAt)
			return this.store.createRun(input)
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
		if (!ACTIVE_STATES.has(run.state)) throw new Error('Only an active scheduled run can be cancelled')
		return this.transition(id, revision, [run.state], 'cancel_requested')
	}
	markCancelled(id: string, revision: number): ScheduledRunRecord {
		return this.transition(id, revision, ['cancel_requested'], 'cancelled', { closedAt: new Date().toISOString() })
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
	markTimedOut(id: string, revision: number): ScheduledRunRecord {
		const run = this.store.requireRun(id)
		if (!TIMEOUTABLE_STATES.has(run.state)) throw new Error('Only an unreported scheduled run can time out')
		return this.transition(id, revision, [run.state], 'timed_out', { closedAt: new Date().toISOString() })
	}
	/** First matching report wins; an identical retry is intentionally idempotent. */
	report(id: string, revision: number, kind: 'quiet' | 'needs_attention', summary: string): ScheduledRunRecord {
		// Normalize before schema validation and idempotency so terminal controls never reach persistence.
		const report = scheduledRunReportSchema.parse({ kind, summary: validateScheduledReportSummary(summary) })
		const run = this.store.requireRun(id)
		if (run.reportKind) {
			if (run.reportKind === report.kind && run.reportSummary === report.summary) return run
			throw new Error('Scheduled run already has a conflicting report')
		}
		if (run.revision !== revision) throw new ScheduleRevisionConflictError()
		if (run.state !== 'running') throw new Error('Only a running scheduled run can report')
		return this.store.transitionRun(id, revision, report.kind === 'quiet' ? 'reported_quiet' : 'needs_attention', {
			reportedAt: new Date().toISOString(),
			reportKind: report.kind,
			reportSummary: report.summary,
		})
	}
	beginClose(id: string, revision: number): ScheduledRunRecord {
		return this.transition(id, revision, ['reported_quiet'], 'closing')
	}
	closeQuiet(id: string, revision: number): ScheduledRunRecord {
		return this.transition(id, revision, ['closing'], 'closed_quiet', { closedAt: new Date().toISOString() })
	}
	markNotificationDelivered(id: string, revision: number): ScheduledRunRecord {
		return this.transition(id, revision, ['needs_attention'], 'needs_attention', {
			notificationDeliveredAt: new Date().toISOString(),
		})
	}
	isTerminal(run: ScheduledRunRecord): boolean {
		return TERMINAL_STATES.has(run.state)
	}
	private prepareSchedule(input: unknown) {
		const parsed = scheduleCreateSchema.parse(input)
		const recurrence = normalizeCadence({ kind: 'cron', expression: parsed.cron }, parsed.timezone)
		const next = nextOccurrence(recurrence.cron, recurrence.timezone, new Date())
		if (!next) throw new Error('Cron has no occurrence within the recurrence horizon')
		return { ...parsed, ...recurrence, nextRunAt: next.scheduledFor }
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
