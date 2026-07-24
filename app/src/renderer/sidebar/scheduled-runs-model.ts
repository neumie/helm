import type { ScheduledRun } from '../../shared-helm'

/** Mirrors the daemon's five-field/no-alias input shape before submit. */
export function isFiveFieldCron(value: string): boolean {
	return value.trim().split(/\s+/).length === 5 && !value.includes('@')
}

/** The server remains authoritative; this is only immediate field feedback. */
export function isIanaTimezone(value: string): boolean {
	try {
		Intl.DateTimeFormat(undefined, { timeZone: value })
		return value.includes('/') || value === 'UTC'
	} catch {
		return false
	}
}

export function scheduledRunStateLabel(state: ScheduledRun['state']): string {
	return state.replaceAll('_', ' ')
}

const CANCELLABLE_STATES = new Set<ScheduledRun['state']>([
	'admitted',
	'preparing',
	'launching',
	'running',
	'needs_attention',
	'cancel_requested',
	'quarantined',
])

/** Mirrors ScheduleCommands' public cancellation guard for action visibility. */
export function canCancelScheduledRun(state: ScheduledRun['state']): boolean {
	return CANCELLABLE_STATES.has(state)
}
