import type { ScheduledRunRecord, ScheduledRunState } from './schema.js'
import type { ScheduleStore } from './store.js'

export const MAX_RETAINED_RUNS_PER_PROFILE = 2_000
export const MAX_RETAINED_RUNS_PER_SCHEDULE = 200
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Exhaustive lifecycle classification shared by commands and retention. */
const SCHEDULED_RUN_TERMINAL_STATES: Record<ScheduledRunState, boolean> = {
	admitted: false,
	preparing: false,
	launching: false,
	running: false,
	reported_quiet: false,
	closing: false,
	closed_quiet: true,
	needs_attention: false,
	cancel_requested: false,
	timeout_requested: false,
	cancelled: true,
	timed_out: true,
	failed: true,
	interrupted: true,
	quarantined: false,
	session_lost: true,
	skipped_overlap: true,
	skipped_misfire: true,
	skipped_profile_archived: true,
	skipped_project_disabled: true,
	skipped_capacity: true,
}

export function isScheduledRunTerminalState(state: ScheduledRunState): boolean {
	return SCHEDULED_RUN_TERMINAL_STATES[state]
}

export type ScheduledWorkspaceCleanupResult =
	| { status: 'deleted' | 'absent' }
	| { status: 'retained'; reason: 'disabled' | 'unsafe' | 'failed' }

export interface ScheduledWorkspaceCleaner {
	cleanup(request: {
		profileId: string
		profileRoot: string
		runId: string
		expectedRunDir: string
		closedAt: string
	}): Promise<ScheduledWorkspaceCleanupResult>
}

/**
 * Filesystem cleanup is intentionally disabled until a descriptor-pinned cleaner
 * can safely reclaim same-uid agent workspaces without pathname races.
 */
export const defaultScheduledWorkspaceCleaner: ScheduledWorkspaceCleaner = {
	async cleanup(): Promise<ScheduledWorkspaceCleanupResult> {
		return { status: 'retained', reason: 'disabled' }
	},
}

/** A bounded retention decision; attention and active rows are never candidates. */
export function terminalRunsToPrune(store: ScheduleStore, now = new Date()): ScheduledRunRecord[] {
	const terminal = store
		.listTerminalRuns(MAX_RETAINED_RUNS_PER_PROFILE + 500)
		.filter(run => isScheduledRunTerminalState(run.state))
	const perSchedule = new Map<string, number>()
	const remove = new Set<string>()
	for (const run of [...terminal].reverse()) {
		const count = (perSchedule.get(run.scheduleId) ?? 0) + 1
		perSchedule.set(run.scheduleId, count)
		if (count > MAX_RETAINED_RUNS_PER_SCHEDULE) remove.add(run.id)
	}
	const cutoff = now.getTime() - TERMINAL_RETENTION_MS
	for (const run of terminal) if (run.closedAt && Date.parse(run.closedAt) < cutoff) remove.add(run.id)
	for (const run of terminal.slice(0, Math.max(0, terminal.length - MAX_RETAINED_RUNS_PER_PROFILE))) remove.add(run.id)
	return terminal.filter(run => remove.has(run.id))
}
