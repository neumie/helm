// Motion tokens (docs/design-system.md §2.5): durations and easings, with today's values. Not theme tokens.

/** CSS motion tokens on `:root`. */
export const MOTION_TOKENS = {
	// The three steps (§2.5): leaving, state change, entering.
	'--motion-exit': '120ms',
	'--motion-state': '140ms',
	'--motion-enter': '150ms',
	// A large surface entering over the whole screen: Remote's navigation drawer and choice sheet (§2.5, §9 ruling 123).
	'--motion-enter-large': '180ms',
	// Live-status ambients, each specified where it lives (§2.5 sanctioned exceptions).
	'--motion-pulse': '1.6s', // the running-dot pulse (§2.5)
	'--motion-arrival': '1.4s', // the dock's arrival pulse and the terminal reveal pulse (§3.24, §9 ruling 70)
	'--motion-resting': '4.8s', // Signals' resting dot field (§3.25)
	'--motion-activity': '1s', // the activity indicator's rotation (§3.21)
	'--motion-activity-waiting': '0.9s', // its waiting bounce
	'--motion-activity-breathe': '1.8s', // its label breath and attention colour
	// Easings: ease-out for everything, linear only for countdown and progress bars, ease-in-out for ambients,
	// the large-surface curve only with --motion-enter-large.
	'--ease-out': 'ease-out',
	'--ease-linear': 'linear',
	'--ease-ambient': 'ease-in-out',
	// The large-surface entrance: leaves at once and settles softly (paired with --motion-enter-large).
	'--ease-enter-large': 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const satisfies Record<string, string>

/**
 * Motion that only script drives (Web Animations and inline transitions), sanctioned §2.5 exceptions: the tab drag
 * FLIP and settle (§3.18, §9 ruling 50) and the swipe-back settle curves (§3.10, §9 ruling 35). Generated into
 * `app/src/design-tokens.generated.ts` as numbers and strings.
 */
export const SCRIPT_MOTION_MS = {
	dragFlip: 160,
	dragSettle: 180,
	dragPark: 140, // a drag settling into Background
} as const

export const SCRIPT_EASINGS = {
	drag: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
	swipeCommit: 'cubic-bezier(0.16, 1, 0.3, 1)',
	swipeSpring: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const
