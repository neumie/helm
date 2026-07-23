import { lstat, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ScheduledRunRecord } from './schema.js'
import type { ScheduleStore } from './store.js'

export const MAX_RETAINED_RUNS_PER_PROFILE = 2_000
export const MAX_RETAINED_RUNS_PER_SCHEDULE = 200
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const WORKSPACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** A bounded retention decision; attention and active rows are never candidates. */
export function terminalRunsToPrune(store: ScheduleStore, now = new Date()): ScheduledRunRecord[] {
	const terminal = store.listTerminalRuns(MAX_RETAINED_RUNS_PER_PROFILE + 500)
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

/**
 * Delete only a real run directory below the captured profile scheduled root.
 * Symlinks are never followed. DB removal is intentionally separate so a failed
 * filesystem cleanup retains the record for a later bounded pass.
 */
export async function removeRetainedRunDirectory(
	profileRoot: string,
	run: ScheduledRunRecord,
	now = new Date(),
): Promise<boolean> {
	if (!run.runDir || run.state === 'needs_attention' || !run.closedAt) return false
	if (Date.parse(run.closedAt) > now.getTime() - WORKSPACE_RETENTION_MS) return false
	const root = resolve(profileRoot, 'scheduled-runs')
	const candidate = resolve(run.runDir)
	const rel = relative(root, candidate)
	if (!isAbsolute(root) || rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
	try {
		const stat = await lstat(candidate)
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false
		await rm(candidate, { recursive: true, force: false, maxRetries: 1 })
		return true
	} catch {
		return false
	}
}
