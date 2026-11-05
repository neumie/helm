// Agent dock tick intervals (watcher.ts schedules them; reduce.ts derives its
// observation gap from the slowest one, so a relaxed cadence never breaks an
// idle/busy stretch it merely observed less often).

/** Some agent is active (agentDockActive), whatever the window or the push channel does. */
export const ACTIVE_INTERVAL_MS = 1_000
/** Nothing active, no healthy push channel, dock shown and Helm focused. */
export const FOCUSED_INTERVAL_MS = 1_500
/** Nothing active, no healthy push channel, dock shown but Helm unfocused. */
export const UNFOCUSED_INTERVAL_MS = 5_000
/** Nothing active, no healthy push channel, dock hidden. */
export const BACKGROUND_INTERVAL_MS = 5_000
/**
 * Nothing active and every source pushes its changes (Okena's /v1/stream connected and
 * every Okena Claude pane reporting a lifecycle, Helm's hub in process): a slow
 * reconciliation for what no push carries (an agent Okena only finds dead when it reads
 * the session, a background task's end in the JSONL, transcript sweeps).
 */
export const RECONCILE_INTERVAL_MS = 15_000
/** The longest the watcher waits between two ticks (a tick's own reads come on top). */
export const SLOWEST_INTERVAL_MS = Math.max(
	ACTIVE_INTERVAL_MS,
	FOCUSED_INTERVAL_MS,
	UNFOCUSED_INTERVAL_MS,
	BACKGROUND_INTERVAL_MS,
	RECONCILE_INTERVAL_MS,
)
