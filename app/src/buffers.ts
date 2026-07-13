// Terminal buffer snapshots (main process only).
//
// dtach preserves the PROCESS, not the SCREEN: a reattached session renders
// nothing until the program produces new output, so every restored tab used to
// come back black. The renderer serializes each tab's xterm buffer (colors +
// scrollback tail, @xterm/addon-serialize) and main persists it here as
// <userData>/buffers/<sessionId>.bin; on reattach the snapshot is written into
// the fresh xterm BEFORE the live pty stream attaches, and the normal
// fit → syncPtySize WINCH nudge redraws the prompt/TUI in place under it.
//
// Ownership split: the renderer owns serialization (it has the Terminal), this
// module owns file IO (ipc channels buffer:save / buffer:read in main.ts).
// Snapshot lifetime is tied to the dtach session — killed session, deleted
// snapshot (grace expiry, explicit kill, dead-socket reap) — plus an orphan
// sweep at startup. Like sessions.ts this imports nothing from electron so the
// store is exercised headlessly by tests/helm-buffers.test.ts.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { isValidSessionId } from './sessions'

/**
 * Hard cap on a stored snapshot. The renderer targets ~200KB (it steps the
 * serialized scrollback down until the output fits); this is the main-process
 * backstop so a misbehaving renderer can't fill the disk through the IPC
 * channel. Oversized saves are rejected whole — truncating serialized VT
 * output would shear an escape sequence in half.
 */
export const MAX_SNAPSHOT_BYTES = 512_000

export class BufferStore {
	readonly #dir: string

	constructor(dir: string) {
		this.#dir = dir
	}

	/** Session ids feed file paths; reject anything that could traverse. */
	#file(sessionId: string): string {
		if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${String(sessionId)}`)
		return path.join(this.#dir, `${sessionId}.bin`)
	}

	/** Atomic write (tmp + rename) so a crash mid-save never leaves a sheared
	 *  snapshot to replay into a terminal. Returns false when rejected/failed. */
	save(sessionId: string, data: string): boolean {
		const file = this.#file(sessionId)
		if (Buffer.byteLength(data, 'utf8') > MAX_SNAPSHOT_BYTES) return false
		try {
			fs.mkdirSync(this.#dir, { recursive: true })
			const tmp = `${file}.tmp`
			fs.writeFileSync(tmp, data)
			fs.renameSync(tmp, file)
			return true
		} catch {
			return false // best-effort: a failed save degrades the next restore, nothing else
		}
	}

	/** Snapshot contents, or null (missing, invalid id, unreadable, oversized). */
	read(sessionId: string): string | null {
		let file: string
		try {
			file = this.#file(sessionId)
		} catch {
			return null
		}
		try {
			// A file over the cap can't have come from a sanctioned save — don't
			// replay it into a terminal, and don't keep it around either.
			if (fs.statSync(file).size > MAX_SNAPSHOT_BYTES) {
				fs.unlinkSync(file)
				return null
			}
			return fs.readFileSync(file, 'utf8')
		} catch {
			return null
		}
	}

	/** Drop a session's snapshot (and any crashed-write leftover). Idempotent. */
	remove(sessionId: string): void {
		let file: string
		try {
			file = this.#file(sessionId)
		} catch {
			return
		}
		for (const target of [file, `${file}.tmp`]) {
			try {
				fs.unlinkSync(target)
			} catch {
				// already gone
			}
		}
	}

	/**
	 * Startup sweep: delete snapshots whose session no longer exists (killed
	 * while the app wasn't running, GC'd dead socket). `keep` = live session
	 * ids plus parked registry ids — a parked session whose socket probed
	 * 'unknown' this launch keeps its snapshot for the next attempt. Also
	 * collects `.tmp` leftovers from a crashed atomic write. Returns removed ids.
	 */
	removeOrphans(keep: ReadonlySet<string>): string[] {
		let names: string[]
		try {
			names = fs.readdirSync(this.#dir)
		} catch {
			return [] // dir doesn't exist yet — nothing persisted
		}
		const removed: string[] = []
		for (const name of names) {
			if (name.endsWith('.bin.tmp')) {
				try {
					fs.unlinkSync(path.join(this.#dir, name))
				} catch {
					// already gone
				}
				continue
			}
			if (!name.endsWith('.bin')) continue
			const sessionId = name.slice(0, -'.bin'.length)
			if (isValidSessionId(sessionId) && keep.has(sessionId)) continue
			try {
				fs.unlinkSync(path.join(this.#dir, name))
				removed.push(sessionId)
			} catch {
				// already gone
			}
		}
		return removed
	}
}
