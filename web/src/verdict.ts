import type { AssessmentVerdict, DashboardTone } from './api'

/** Display metadata for a pre-solve intent verdict, shared by the list + detail. */
export const VERDICT_META: Record<AssessmentVerdict, { label: string; tone: DashboardTone; icon: string }> = {
	clear: { label: 'Clear', tone: 'green', icon: '✓' },
	needs_clarification: { label: 'Needs info', tone: 'amber', icon: '?' },
	human_decision: { label: 'Decision', tone: 'blue', icon: '◆' },
	not_code: { label: 'Not code', tone: 'gray', icon: '–' },
	security: { label: 'Security', tone: 'red', icon: '⚠' },
}

export const TONE_COLOR: Record<DashboardTone, string> = {
	gray: 'var(--text-3)',
	blue: 'var(--blue)',
	green: 'var(--green)',
	amber: 'var(--amber)',
	red: 'var(--red)',
}

export const TONE_DIM: Record<DashboardTone, string> = {
	gray: 'var(--bg-3)',
	blue: 'var(--blue-dim)',
	green: 'var(--green-dim)',
	amber: 'var(--amber-dim)',
	red: 'var(--red-dim)',
}
