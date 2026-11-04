import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The AppleScript that brings Okena's desktop app to the front: System Events makes the process
 * named "okena" (any case; a dev build runs as a bare `target/release/okena` with no bundle id, so
 * `open -b com.contember.okena` would miss it) frontmost. Okena's own `focus_terminal` only orders
 * the target window front inside Okena (gpui `makeKeyAndOrderFront`), it never activates the app.
 */
export const OKENA_ACTIVATE_SCRIPT =
	'tell application "System Events" to set frontmost of first process whose name is "okena" to true'

/** Runs a command; the seam tests replace (never a shell). */
export type ExecFileRunner = (file: string, args: readonly string[], opts: { timeout: number }) => Promise<unknown>

const runExecFile: ExecFileRunner = (file, args, opts) => execFileAsync(file, [...args], opts)

/**
 * Best-effort raise of the Okena desktop app (macOS only; false elsewhere or when it fails or times
 * out). Never throws.
 */
export async function activateOkenaApp(
	opts: { timeoutMs?: number; platform?: NodeJS.Platform; run?: ExecFileRunner } = {},
): Promise<boolean> {
	if ((opts.platform ?? process.platform) !== 'darwin') return false
	try {
		await (opts.run ?? runExecFile)('osascript', ['-e', OKENA_ACTIVATE_SCRIPT], { timeout: opts.timeoutMs ?? 500 })
		return true
	} catch {
		return false
	}
}
