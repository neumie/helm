// Daemon self-restart seam — how a config save applies itself.
//
// The daemon only reads helm.config.json at startup, so a saved change is
// invisible until the process restarts. Under launchd the plist has
// KeepAlive=true: a clean exit respawns the daemon with fresh config — a full,
// honest reload with no hot-reload complexity. The API routes use this module
// to decide whether a restart is safe (launchd-managed, no active runs) and to
// schedule the exit AFTER the HTTP response has flushed.
//
// Injectable (`DaemonControl`) so route tests exercise the decision logic
// without killing the test runner.

import { log } from '../util/logger.js'

export interface DaemonControl {
	/** True when launchd manages the process (KeepAlive respawns a clean exit). */
	isManaged(): boolean
	/** Trigger the exit. Production sends SIGTERM so index.ts's graceful shutdown runs. */
	exit(): void
	/** Delay before exit so the HTTP response flushes. Default RESTART_FLUSH_MS. */
	restartDelayMs?: number
}

/** Response-flush window before the scheduled exit fires. */
export const RESTART_FLUSH_MS = 300

/** Backstop: force the exit if the graceful shutdown path hangs. */
const HARD_EXIT_MS = 1000

/**
 * Launchd detection: `helm start` writes HELM_LAUNCHD=1 into the plist env;
 * the ppid check covers plists installed before that flag existed (LaunchAgents
 * run as direct children of launchd, PID 1 — `npm run dev` runs under npm/tsx).
 */
export function isManagedByLaunchd(): boolean {
	return process.env.HELM_LAUNCHD === '1' || process.ppid === 1
}

export const defaultDaemonControl: DaemonControl = {
	isManaged: isManagedByLaunchd,
	exit: () => {
		// SIGTERM runs index.ts's shutdown handler (poller/enricher/queue/watcher
		// stop + db.close), all synchronous; the hard exit only fires if that hangs.
		process.kill(process.pid, 'SIGTERM')
		setTimeout(() => process.exit(0), HARD_EXIT_MS).unref()
	},
}

/** Schedule the self-restart exit after the response-flush window. */
export function scheduleDaemonRestart(
	control: DaemonControl,
	reason = 'Config applied — restarting under launchd to reload it.',
): void {
	log.info('helm', reason)
	setTimeout(() => control.exit(), control.restartDelayMs ?? RESTART_FLUSH_MS).unref()
}
