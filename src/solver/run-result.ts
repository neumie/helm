import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { profileRuntimeRoot } from '../profiles/runtime.js'
import { log } from '../util/logger.js'
import { type SolverResult, solverResultSchema } from './result-schema.js'

/** A result is a short JSON record; anything larger is not one. */
const RESULT_MAX_BYTES = 512 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * Where a solve run's agent writes its structured result: Helm's own profile
 * state (`profiles/<profileId>/runs/<itemId>/solver-result.json`), never the
 * target repository. Absolute, so an agent running in a worktree or the main
 * checkout can write it; per Item, so one run never sees another's result.
 */
export function runResultPath(profileId: string, itemId: string): string {
	if (!SAFE_ID.test(itemId)) throw new Error(`Unsafe Item id for a run directory: ${itemId}`)
	return join(profileRuntimeRoot(profileId), 'runs', itemId, 'solver-result.json')
}

/**
 * The run result file. The solver clears it before launching the agent (a
 * reused path may hold a previous attempt's result, which would read as a
 * false success), the Okena solver polls `exists()`, and the worker `read()`s
 * it once the agent is done.
 */
export class RunResultFile {
	constructor(readonly path: string) {}

	/** Create the run directory and drop any earlier attempt's result. */
	prepare(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
		this.clear()
	}

	clear(): void {
		rmSync(this.path, { force: true })
	}

	exists(): boolean {
		try {
			const descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
			closeSync(descriptor)
			return true
		} catch {
			return false
		}
	}

	/** Read + validate the result. Null if absent, not a plain file, oversized, or invalid. */
	read(): SolverResult | null {
		let descriptor: number | null = null
		try {
			descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
			const stat = fstatSync(descriptor)
			if (!stat.isFile()) throw new Error('not a regular file')
			if (stat.size > RESULT_MAX_BYTES) throw new Error(`larger than ${RESULT_MAX_BYTES} bytes`)
			const bytes = Buffer.alloc(RESULT_MAX_BYTES + 1)
			let length = 0
			while (length < bytes.length) {
				const count = readSync(descriptor, bytes, length, bytes.length - length, null)
				if (count === 0) break
				length += count
			}
			if (length > RESULT_MAX_BYTES) throw new Error(`larger than ${RESULT_MAX_BYTES} bytes`)
			return solverResultSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf-8')))
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('run-result', `Could not read ${this.path}`, err)
			return null
		} finally {
			if (descriptor !== null) closeSync(descriptor)
		}
	}
}
