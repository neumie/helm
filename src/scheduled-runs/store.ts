import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
	type AttentionAdoption,
	type CreateScheduledRunInput,
	type ScheduleRecord,
	type ScheduledRunRecord,
	type ScheduledRunState,
	type ScheduledTerminalIntent,
	attentionAdoptionSchema,
	createScheduledRunSchema,
	schedulePersistenceSchema,
	scheduleRecordSchema,
	scheduledRunRecordSchema,
} from './schema.js'

export class ScheduleRevisionConflictError extends Error {
	constructor() {
		super('Scheduled run revision conflict')
		this.name = 'ScheduleRevisionConflictError'
	}
}

export interface ScheduledRunRecoveryCursor {
	createdAt: string
	id: string
}

function parseJson(value: unknown, field: string): unknown {
	if (typeof value !== 'string') throw new Error(`Scheduled row ${field} is not JSON`)
	try {
		return JSON.parse(value)
	} catch {
		throw new Error(`Scheduled row ${field} is invalid JSON`)
	}
}

export class ScheduleStore {
	constructor(
		private readonly db: Database.Database,
		private readonly profile: string | (() => string) = 'work',
	) {}
	private get profileId(): string {
		return typeof this.profile === 'function' ? this.profile() : this.profile
	}
	transaction<T>(fn: () => T): T {
		return this.db.transaction(fn)()
	}

	create(input: unknown): ScheduleRecord {
		const parsed = schedulePersistenceSchema.parse(input)
		const now = new Date().toISOString()
		const id = parsed.id ?? randomUUID()
		const definition = parsed.definition
		this.db
			.prepare(`INSERT INTO scheduled_schedules (
			id, profile_id, revision, name, enabled, target_kind, project_slug, definition, cron, cadence_kind, timezone, overlap_policy,
			next_run_at, created_at, updated_at, disabled_reason, archived_at, system_risk_acknowledged_at
		) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'skip', ?, ?, ?, NULL, NULL, ?)`)
			.run(
				id,
				this.profileId,
				parsed.name,
				Number(parsed.enabled),
				definition.target.kind,
				definition.target.kind === 'project' ? definition.target.projectSlug : null,
				JSON.stringify(definition),
				parsed.cron,
				parsed.cadenceKind,
				parsed.timezone,
				parsed.nextRunAt,
				now,
				now,
				definition.target.kind === 'system' ? now : null,
			)
		return this.require(id)
	}

	get(id: string): ScheduleRecord | null {
		const row = this.db
			.prepare('SELECT * FROM scheduled_schedules WHERE profile_id = ? AND id = ?')
			.get(this.profileId, id) as Record<string, unknown> | undefined
		return row ? this.toSchedule(row) : null
	}
	require(id: string): ScheduleRecord {
		const schedule = this.get(id)
		if (!schedule) throw new Error(`Scheduled definition not found: ${id}`)
		return schedule
	}
	list(): ScheduleRecord[] {
		return (
			this.db
				.prepare('SELECT * FROM scheduled_schedules WHERE profile_id = ? ORDER BY created_at DESC, id DESC')
				.all(this.profileId) as Record<string, unknown>[]
		).map(row => this.toSchedule(row))
	}
	listDue(before: string, limit = 50): ScheduleRecord[] {
		return (
			this.db
				.prepare(
					'SELECT * FROM scheduled_schedules WHERE profile_id = ? AND enabled = 1 AND archived_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC LIMIT ?',
				)
				.all(this.profileId, before, limit) as Record<string, unknown>[]
		).map(row => this.toSchedule(row))
	}

	update(id: string, expectedRevision: number, input: unknown): ScheduleRecord {
		const parsed = schedulePersistenceSchema.parse(input)
		const current = this.require(id)
		if (current.revision !== expectedRevision) throw new ScheduleRevisionConflictError()
		const now = new Date().toISOString()
		const definition = parsed.definition
		const result = this.db
			.prepare(
				'UPDATE scheduled_schedules SET revision = revision + 1, name = ?, enabled = ?, target_kind = ?, project_slug = ?, definition = ?, cron = ?, cadence_kind = ?, timezone = ?, next_run_at = ?, updated_at = ?, disabled_reason = NULL, archived_at = NULL, system_risk_acknowledged_at = ? WHERE profile_id = ? AND id = ? AND revision = ?',
			)
			.run(
				parsed.name,
				Number(parsed.enabled),
				definition.target.kind,
				definition.target.kind === 'project' ? definition.target.projectSlug : null,
				JSON.stringify(definition),
				parsed.cron,
				parsed.cadenceKind,
				parsed.timezone,
				parsed.nextRunAt,
				now,
				definition.target.kind === 'system' ? now : null,
				this.profileId,
				id,
				expectedRevision,
			)
		if (result.changes === 0) throw new ScheduleRevisionConflictError()
		return this.require(id)
	}
	setEnabled(id: string, expectedRevision: number, enabled: boolean, reason: string | null = null): ScheduleRecord {
		const now = new Date().toISOString()
		const result = this.db
			.prepare(
				'UPDATE scheduled_schedules SET revision = revision + 1, enabled = ?, disabled_reason = ?, updated_at = ? WHERE profile_id = ? AND id = ? AND revision = ? AND archived_at IS NULL',
			)
			.run(Number(enabled), enabled ? null : reason, now, this.profileId, id, expectedRevision)
		if (result.changes === 0) throw new ScheduleRevisionConflictError()
		return this.require(id)
	}
	archive(id: string, expectedRevision: number): ScheduleRecord {
		const now = new Date().toISOString()
		const result = this.db
			.prepare(
				"UPDATE scheduled_schedules SET revision = revision + 1, enabled = 0, disabled_reason = 'archived', archived_at = ?, updated_at = ? WHERE profile_id = ? AND id = ? AND revision = ? AND archived_at IS NULL",
			)
			.run(now, now, this.profileId, id, expectedRevision)
		if (result.changes === 0) throw new ScheduleRevisionConflictError()
		return this.require(id)
	}
	advanceNextRun(id: string, expectedRevision: number, nextRunAt: string | null): ScheduleRecord {
		const result = this.db
			.prepare(
				'UPDATE scheduled_schedules SET revision = revision + 1, next_run_at = ?, updated_at = ? WHERE profile_id = ? AND id = ? AND revision = ?',
			)
			.run(nextRunAt, new Date().toISOString(), this.profileId, id, expectedRevision)
		if (result.changes === 0) throw new ScheduleRevisionConflictError()
		return this.require(id)
	}

	createRun(input: CreateScheduledRunInput): ScheduledRunRecord {
		const parsed = createScheduledRunSchema.parse(input)
		this.require(parsed.scheduleId)
		const now = new Date().toISOString()
		const id = parsed.id ?? randomUUID()
		this.db
			.prepare(`INSERT INTO scheduled_runs (
			id, profile_id, schedule_id, schedule_revision, scheduled_for, local_civil_slot, utc_offset_minutes, slot_key, definition_snapshot, state, revision,
			session_id, socket_descriptor, report_token_hash, report_token_version, process_fingerprint, cwd, worktree_path, branch_name, run_dir,
			started_at, reported_at, closed_at, report_kind, report_summary, diagnostic_detail, notification_claimed_at, notification_delivered_at,
			missed_count, missed_many, cleanup_state, terminal_resolved_at, attention_adoption, pending_terminal_intent, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`)
			.run(
				id,
				this.profileId,
				parsed.scheduleId,
				parsed.scheduleRevision,
				parsed.scheduledFor,
				parsed.localCivilSlot,
				parsed.utcOffsetMinutes,
				parsed.slotKey,
				JSON.stringify(parsed.definitionSnapshot),
				parsed.state,
				parsed.sessionId,
				parsed.socketDescriptor,
				parsed.reportTokenHash,
				parsed.reportTokenVersion,
				parsed.processFingerprint,
				parsed.cwd,
				parsed.worktreePath,
				parsed.branchName,
				parsed.runDir,
				parsed.closedAt ?? null,
				parsed.missedCount,
				Number(parsed.missedMany),
				now,
				now,
			)
		return this.requireRun(id)
	}
	getRun(id: string): ScheduledRunRecord | null {
		const row = this.db
			.prepare('SELECT * FROM scheduled_runs WHERE profile_id = ? AND id = ?')
			.get(this.profileId, id) as Record<string, unknown> | undefined
		return row ? this.toRun(row) : null
	}
	requireRun(id: string): ScheduledRunRecord {
		const run = this.getRun(id)
		if (!run) throw new Error(`Scheduled run not found: ${id}`)
		return run
	}
	listRuns(scheduleId: string, limit = 50): ScheduledRunRecord[] {
		return (
			this.db
				.prepare(
					'SELECT * FROM scheduled_runs WHERE profile_id = ? AND schedule_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT ?',
				)
				.all(this.profileId, scheduleId, limit) as Record<string, unknown>[]
		).map(row => this.toRun(row))
	}
	/**
	 * Bounded tenant-local recovery page. Startup callers must continue until an
	 * empty page so every capacity-bearing run is accounted for before admission.
	 */
	listRecoverableRunsPage(after: ScheduledRunRecoveryCursor | null = null, limit = 500): ScheduledRunRecord[] {
		const cursorClause = after ? ' AND (created_at > ? OR (created_at = ? AND id > ?))' : ''
		const values = after ? [this.profileId, after.createdAt, after.createdAt, after.id, limit] : [this.profileId, limit]
		return (
			this.db
				.prepare(
					`SELECT * FROM scheduled_runs WHERE profile_id = ? AND state IN ('admitted','preparing','launching','running','reported_quiet','closing','needs_attention','cancel_requested','timeout_requested','quarantined')${cursorClause} ORDER BY created_at ASC, id ASC LIMIT ?`,
				)
				.all(...values) as Record<string, unknown>[]
		).map(row => this.toRun(row))
	}
	/** @deprecated Use the cursor-paged form for startup recovery. */
	listRecoverableRuns(limit = 500): ScheduledRunRecord[] {
		return this.listRecoverableRunsPage(null, limit)
	}
	listTerminalRuns(limit = 2_000): ScheduledRunRecord[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM scheduled_runs WHERE profile_id = ? AND state NOT IN ('admitted','preparing','launching','running','reported_quiet','closing','needs_attention','cancel_requested','timeout_requested','quarantined') ORDER BY closed_at ASC, id ASC LIMIT ?",
				)
				.all(this.profileId, limit) as Record<string, unknown>[]
		).map(row => this.toRun(row))
	}
	deleteRun(id: string): boolean {
		return (
			this.db.prepare('DELETE FROM scheduled_runs WHERE profile_id = ? AND id = ?').run(this.profileId, id).changes > 0
		)
	}
	countRecoverableRuns(): number {
		return Number(
			(
				this.db
					.prepare(
						"SELECT COUNT(*) AS count FROM scheduled_runs WHERE profile_id = ? AND state IN ('admitted','preparing','launching','running','reported_quiet','closing','needs_attention','cancel_requested','timeout_requested','quarantined')",
					)
					.get(this.profileId) as { count: number }
			).count,
		)
	}
	findActiveRun(scheduleId: string): ScheduledRunRecord | null {
		const row = this.db
			.prepare(
				"SELECT * FROM scheduled_runs WHERE profile_id = ? AND schedule_id = ? AND state IN ('admitted','preparing','launching','running','reported_quiet','closing','needs_attention','cancel_requested','timeout_requested','quarantined') LIMIT 1",
			)
			.get(this.profileId, scheduleId) as Record<string, unknown> | undefined
		return row ? this.toRun(row) : null
	}
	countAttentionRuns(): number {
		return Number(
			(
				this.db
					.prepare("SELECT COUNT(*) AS count FROM scheduled_runs WHERE profile_id = ? AND state = 'needs_attention'")
					.get(this.profileId) as { count: number }
			).count,
		)
	}
	/**
	 * Tenant-local candidates for the control-authenticated Electron notifier.
	 * A reserved/completed adoption or teardown intent owns the terminal already,
	 * so it must never produce another clickable adoption notification.
	 */
	listAttentionNotificationRuns(): ScheduledRunRecord[] {
		return (
			this.db
				.prepare(
					`SELECT * FROM scheduled_runs
					 WHERE profile_id = ? AND state = 'needs_attention' AND report_kind = 'needs_attention'
					   AND report_summary IS NOT NULL AND pending_terminal_intent IS NULL AND terminal_resolved_at IS NULL
					   AND (attention_adoption IS NULL OR (json_valid(attention_adoption) AND json_extract(attention_adoption, '$.state') = 'rolled_back'))
					   AND notification_delivered_at IS NULL
					 ORDER BY reported_at ASC, id ASC`,
				)
				.all(this.profileId) as Record<string, unknown>[]
		).map(row => this.toRun(row))
	}
	/**
	 * Atomically lease one delivery attempt. A process crash after this write
	 * cannot hide the notification forever: a later control client may claim it
	 * once the lease is stale. The lease predicate makes simultaneous claimers
	 * fail closed without advancing the lifecycle/adoption revision axis.
	 */
	claimAttentionNotification(
		id: string,
		expectedRevision: number,
		staleBefore: string,
		now: string,
	): ScheduledRunRecord {
		const result = this.db
			.prepare(
				`UPDATE scheduled_runs SET notification_claimed_at = ?, updated_at = ?
				 WHERE profile_id = ? AND id = ? AND revision = ?
				   AND state = 'needs_attention' AND report_kind = 'needs_attention' AND report_summary IS NOT NULL
				   AND pending_terminal_intent IS NULL AND terminal_resolved_at IS NULL
				   AND (attention_adoption IS NULL OR (json_valid(attention_adoption) AND json_extract(attention_adoption, '$.state') = 'rolled_back'))
				   AND notification_delivered_at IS NULL
				   AND (notification_claimed_at IS NULL OR notification_claimed_at <= ?)`,
			)
			.run(now, now, this.profileId, id, expectedRevision, staleBefore)
		if (result.changes === 0) throw new ScheduleRevisionConflictError()
		return this.requireRun(id)
	}
	/** Delivery is accepted only from the exact still-current lifecycle revision and active lease. */
	markAttentionNotificationDelivered(id: string, expectedRevision: number, now: string): ScheduledRunRecord {
		const result = this.db
			.prepare(
				`UPDATE scheduled_runs SET notification_delivered_at = ?, updated_at = ?
				 WHERE profile_id = ? AND id = ? AND revision = ?
				   AND state = 'needs_attention' AND report_kind = 'needs_attention' AND report_summary IS NOT NULL
				   AND pending_terminal_intent IS NULL AND terminal_resolved_at IS NULL
				   AND (attention_adoption IS NULL OR (json_valid(attention_adoption) AND json_extract(attention_adoption, '$.state') = 'rolled_back'))
				   AND notification_delivered_at IS NULL AND notification_claimed_at IS NOT NULL`,
			)
			.run(now, now, this.profileId, id, expectedRevision)
		if (result.changes === 0) throw new ScheduleRevisionConflictError()
		return this.requireRun(id)
	}
	/** Runtime identity is persisted separately from state before/after side effects. */
	updateRunRuntime(
		id: string,
		expectedRevision: number,
		fields: Pick<
			ScheduledRunRecord,
			'processFingerprint' | 'cwd' | 'worktreePath' | 'branchName' | 'runDir' | 'socketDescriptor'
		>,
	): ScheduledRunRecord {
		const result = this.db
			.prepare(
				'UPDATE scheduled_runs SET process_fingerprint = ?, cwd = ?, worktree_path = ?, branch_name = ?, run_dir = ?, socket_descriptor = ?, revision = revision + 1, updated_at = ? WHERE profile_id = ? AND id = ? AND revision = ?',
			)
			.run(
				fields.processFingerprint,
				fields.cwd,
				fields.worktreePath,
				fields.branchName,
				fields.runDir,
				fields.socketDescriptor,
				new Date().toISOString(),
				this.profileId,
				id,
				expectedRevision,
			)
		if (result.changes === 0) throw new ScheduleRevisionConflictError()
		return this.requireRun(id)
	}
	findRunBySlot(scheduleId: string, slotKey: string): ScheduledRunRecord | null {
		const row = this.db
			.prepare('SELECT * FROM scheduled_runs WHERE profile_id = ? AND schedule_id = ? AND slot_key = ?')
			.get(this.profileId, scheduleId, slotKey) as Record<string, unknown> | undefined
		return row ? this.toRun(row) : null
	}
	/**
	 * The only writer for the internal attention-adoption axis. The WHERE clause
	 * repeats the profile, attention state, report kind, unresolved status, and
	 * revision guards so a stale caller cannot take over a terminal handoff.
	 * Completion is the sole path that atomically resolves terminal ownership.
	 */
	updateAttentionAdoption(
		id: string,
		expectedRevision: number,
		adoption: AttentionAdoption,
		terminalResolvedAt: string | null = null,
		requireNoTerminalIntent = false,
	): ScheduledRunRecord {
		const parsed = attentionAdoptionSchema.parse(adoption)
		if (parsed.state !== 'completed' && terminalResolvedAt !== null)
			throw new Error('Only completed attention adoption may resolve a terminal')
		const result = this.db
			.prepare(
				`UPDATE scheduled_runs
				 SET attention_adoption = ?, terminal_resolved_at = ?, revision = revision + 1, updated_at = ?
				 WHERE profile_id = ? AND id = ? AND revision = ?
				   AND state = 'needs_attention' AND report_kind = 'needs_attention'
				   AND terminal_resolved_at IS NULL
				   AND (? = 0 OR pending_terminal_intent IS NULL)`,
			)
			.run(
				JSON.stringify(parsed),
				terminalResolvedAt,
				new Date().toISOString(),
				this.profileId,
				id,
				expectedRevision,
				requireNoTerminalIntent ? 1 : 0,
			)
		if (result.changes === 0) throw new ScheduleRevisionConflictError()
		return this.requireRun(id)
	}
	claimPendingTerminalIntent(
		id: string,
		expectedRevision: number,
		intent: ScheduledTerminalIntent,
	): ScheduledRunRecord {
		const current = this.requireRun(id)
		if (current.pendingTerminalIntent) {
			if (current.pendingTerminalIntent === intent) return current
			throw new Error('Scheduled run already has a conflicting terminal intent')
		}
		if (current.revision !== expectedRevision) throw new ScheduleRevisionConflictError()
		const result = this.db
			.prepare(
				'UPDATE scheduled_runs SET pending_terminal_intent = ?, revision = revision + 1, updated_at = ? WHERE profile_id = ? AND id = ? AND revision = ? AND pending_terminal_intent IS NULL',
			)
			.run(intent, new Date().toISOString(), this.profileId, id, expectedRevision)
		if (result.changes === 0) {
			const latest = this.requireRun(id)
			if (latest.pendingTerminalIntent === intent) return latest
			if (latest.pendingTerminalIntent) throw new Error('Scheduled run already has a conflicting terminal intent')
			throw new ScheduleRevisionConflictError()
		}
		return this.requireRun(id)
	}
	transitionRun(
		id: string,
		expectedRevision: number,
		state: ScheduledRunState,
		fields: Partial<
			Pick<
				ScheduledRunRecord,
				| 'startedAt'
				| 'reportedAt'
				| 'closedAt'
				| 'reportKind'
				| 'reportSummary'
				| 'diagnosticDetail'
				| 'notificationClaimedAt'
				| 'notificationDeliveredAt'
				| 'cleanupState'
				| 'pendingTerminalIntent'
			>
		> = {},
	): ScheduledRunRecord {
		const current = this.requireRun(id)
		if (current.revision !== expectedRevision) throw new ScheduleRevisionConflictError()
		const columns: Record<string, string> = {
			state: 'state',
			startedAt: 'started_at',
			reportedAt: 'reported_at',
			closedAt: 'closed_at',
			reportKind: 'report_kind',
			reportSummary: 'report_summary',
			diagnosticDetail: 'diagnostic_detail',
			notificationClaimedAt: 'notification_claimed_at',
			notificationDeliveredAt: 'notification_delivered_at',
			cleanupState: 'cleanup_state',
			pendingTerminalIntent: 'pending_terminal_intent',
		}
		const values: unknown[] = [state]
		const sets = ['state = ?', 'revision = revision + 1', 'updated_at = ?']
		values.push(new Date().toISOString())
		for (const [key, value] of Object.entries(fields)) {
			sets.push(`${columns[key]} = ?`)
			values.push(value)
		}
		values.push(this.profileId, id, expectedRevision)
		const result = this.db
			.prepare(`UPDATE scheduled_runs SET ${sets.join(', ')} WHERE profile_id = ? AND id = ? AND revision = ?`)
			.run(...values)
		if (result.changes === 0) throw new ScheduleRevisionConflictError()
		return this.requireRun(id)
	}

	private toSchedule(row: Record<string, unknown>): ScheduleRecord {
		return scheduleRecordSchema.parse({
			id: row.id,
			profileId: row.profile_id,
			revision: row.revision,
			name: row.name,
			enabled: Boolean(row.enabled),
			targetKind: row.target_kind,
			projectSlug: row.project_slug,
			definition: parseJson(row.definition, 'definition'),
			cron: row.cron,
			cadenceKind: row.cadence_kind,
			timezone: row.timezone,
			overlapPolicy: row.overlap_policy,
			nextRunAt: row.next_run_at,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			disabledReason: row.disabled_reason,
			archivedAt: row.archived_at,
			systemRiskAcknowledgedAt: row.system_risk_acknowledged_at,
		})
	}
	private toRun(row: Record<string, unknown>): ScheduledRunRecord {
		return scheduledRunRecordSchema.parse({
			id: row.id,
			profileId: row.profile_id,
			scheduleId: row.schedule_id,
			scheduleRevision: row.schedule_revision,
			scheduledFor: row.scheduled_for,
			localCivilSlot: row.local_civil_slot,
			utcOffsetMinutes: row.utc_offset_minutes,
			slotKey: row.slot_key,
			definitionSnapshot: parseJson(row.definition_snapshot, 'definition_snapshot'),
			state: row.state,
			revision: row.revision,
			sessionId: row.session_id,
			socketDescriptor: row.socket_descriptor,
			reportTokenHash: row.report_token_hash,
			reportTokenVersion: row.report_token_version,
			processFingerprint: row.process_fingerprint,
			cwd: row.cwd,
			worktreePath: row.worktree_path,
			branchName: row.branch_name,
			runDir: row.run_dir,
			startedAt: row.started_at,
			reportedAt: row.reported_at,
			closedAt: row.closed_at,
			reportKind: row.report_kind,
			reportSummary: row.report_summary,
			diagnosticDetail: row.diagnostic_detail,
			notificationClaimedAt: row.notification_claimed_at,
			notificationDeliveredAt: row.notification_delivered_at,
			missedCount: row.missed_count,
			missedMany: Boolean(row.missed_many),
			cleanupState: row.cleanup_state,
			terminalResolvedAt: row.terminal_resolved_at,
			attentionAdoption:
				row.attention_adoption === null ? null : parseJson(row.attention_adoption, 'attention_adoption'),
			pendingTerminalIntent: row.pending_terminal_intent,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		})
	}
}
