import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAX_SCHEDULED_DIAGNOSTIC_BYTES = 256 * 1024

/** Append structured supervisor-only diagnostics, retaining a bounded tail. */
export function appendScheduledDiagnostic(path: string, event: string, fields: Record<string, unknown> = {}): void {
	const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
	try {
		if (statSync(path).size <= MAX_SCHEDULED_DIAGNOSTIC_BYTES) return
		const bytes = readFileSync(path)
		const tail = bytes.subarray(Math.max(0, bytes.length - MAX_SCHEDULED_DIAGNOSTIC_BYTES))
		const firstNewline = tail.indexOf(0x0a)
		const retained = firstNewline < 0 ? tail : tail.subarray(firstNewline + 1)
		const temporary = `${path}.${process.pid}.tmp`
		writeFileSync(temporary, retained, { mode: 0o600 })
		renameSync(temporary, path)
	} catch {
		// Diagnostics are intentionally best-effort and never alter run lifecycle.
	}
}
