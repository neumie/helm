import type { ScheduleRecord, ScheduledRunRecord } from './schema.js'

export interface ScheduledScheduleContract {
	id: string
	profileId: string
	revision: number
	name: string
	enabled: boolean
	target: { kind: 'project'; projectSlug: string } | { kind: 'system' }
	cron: string
	cadenceKind: ScheduleRecord['cadenceKind']
	timezone: string
	nextRunAt: string | null
	disabledReason: string | null
	archivedAt: string | null
	createdAt: string
	updatedAt: string
}

export interface ScheduledRunContract {
	id: string
	profileId: string
	scheduleId: string
	scheduleRevision: number
	scheduledFor: string
	localCivilSlot: string
	utcOffsetMinutes: number
	state: ScheduledRunRecord['state']
	revision: number
	reportKind: 'quiet' | 'needs_attention' | null
	reportSummary: string | null
	startedAt: string | null
	reportedAt: string | null
	closedAt: string | null
	missedCount: number
	missedMany: boolean
	sessionAvailability: 'available' | 'unavailable'
	terminalResolvedAt: string | null
	createdAt: string
	updatedAt: string
}

/** Safe dashboard/API projections. Prompt, capability hashes, sockets, PIDs, paths, and diagnostics stay server-only. */
export function toScheduledScheduleContract(schedule: ScheduleRecord): ScheduledScheduleContract {
	return {
		id: schedule.id,
		profileId: schedule.profileId,
		revision: schedule.revision,
		name: schedule.name,
		enabled: schedule.enabled,
		target:
			schedule.definition.target.kind === 'project'
				? { kind: 'project', projectSlug: schedule.definition.target.projectSlug }
				: { kind: 'system' },
		cron: schedule.cron,
		cadenceKind: schedule.cadenceKind,
		timezone: schedule.timezone,
		nextRunAt: schedule.nextRunAt,
		disabledReason: schedule.disabledReason,
		archivedAt: schedule.archivedAt,
		createdAt: schedule.createdAt,
		updatedAt: schedule.updatedAt,
	}
}

export function toScheduledRunContract(run: ScheduledRunRecord): ScheduledRunContract {
	return {
		id: run.id,
		profileId: run.profileId,
		scheduleId: run.scheduleId,
		scheduleRevision: run.scheduleRevision,
		scheduledFor: run.scheduledFor,
		localCivilSlot: run.localCivilSlot,
		utcOffsetMinutes: run.utcOffsetMinutes,
		state: run.state,
		revision: run.revision,
		reportKind: run.reportKind,
		reportSummary: run.reportSummary,
		startedAt: run.startedAt,
		reportedAt: run.reportedAt,
		closedAt: run.closedAt,
		missedCount: run.missedCount,
		missedMany: run.missedMany,
		sessionAvailability:
			run.state === 'needs_attention' &&
			run.terminalResolvedAt === null &&
			(run.attentionAdoption === null || run.attentionAdoption.state === 'rolled_back')
				? 'available'
				: 'unavailable',
		terminalResolvedAt: run.terminalResolvedAt,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
	}
}
