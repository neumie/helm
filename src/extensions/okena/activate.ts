import { execFile } from 'node:child_process'

/**
 * Bringing Okena's desktop app to the front (macOS), so the keys go to the pane Okena just focused.
 * Okena's own `focus_terminal` only orders the target window front inside Okena (gpui
 * `makeKeyAndOrderFront`); it never activates the app, so Helm (the active app when ⌘O is pressed)
 * keeps the keyboard until something activates Okena.
 *
 * Two strategies, best first, each reported in the result's `attempts`:
 *
 * 1. `appkit`: one JXA run (`osascript -l JavaScript`) through AppKit, no Automation permission and no
 *    System Events: it finds Okena's GUI as the LaunchServices-registered regular app whose executable is
 *    `okena` (a dev build runs as a bare `target/release/okena`, no bundle id; its `--headless` daemon
 *    and `--ai-proxy` are not registered apps), asks it to activate with the current active app's
 *    context (`activateFromApplication:options:`, macOS 14+ cooperative activation) and then plainly
 *    (`activateWithOptions:`), and checks that Okena really became active (the run loop is spun so
 *    `NSRunningApplication.active` updates) — a request macOS declines reads as `refused`, not success.
 *    ~0.2 s.
 * 2. `system-events`: System Events sets the process frontmost, targeted by the unix id strategy 1
 *    found (by name when it found none). Needs Automation (→ System Events) for whoever is responsible
 *    for Helm, and costs ~0.7 s warm, ~1.7 s when System Events has to launch first (it quits when idle).
 */

/** Helm's AppKit raise (strategy 1). `argv[0] === 'probe'` finds Okena and stops: nothing is activated. */
export const OKENA_APPKIT_RAISE_SCRIPT = `ObjC.import('AppKit')
function run(argv) {
	var apps = $.NSWorkspace.sharedWorkspace.runningApplications
	var target = null
	for (var i = 0; i < apps.count; i++) {
		var app = apps.objectAtIndex(i)
		var url = app.executableURL
		if (url.isNil() || Number(app.activationPolicy) !== 0) continue
		if (String(ObjC.unwrap(url.lastPathComponent)).toLowerCase() === 'okena') { target = app; break }
	}
	if (!target) return JSON.stringify({ outcome: 'not-running' })
	var pid = Number(target.processIdentifier)
	if (argv[0] === 'probe') return JSON.stringify({ outcome: 'probe', pid: pid, active: Boolean(target.active) })
	if (target.active) return JSON.stringify({ outcome: 'already-front', pid: pid })
	var settled = function () {
		for (var t = 0; t < 8; t++) {
			$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.025))
			if (target.active) return true
		}
		return false
	}
	var tried = []
	var front = $.NSWorkspace.sharedWorkspace.frontmostApplication
	if (!front.isNil() && typeof target.activateFromApplicationOptions === 'function') {
		tried.push('from-front')
		try { target.activateFromApplicationOptions(front, 1) } catch (e) {}
		if (settled()) return JSON.stringify({ outcome: 'raised', pid: pid, how: 'from-front' })
	}
	tried.push('activate')
	target.activateWithOptions(1)
	if (settled()) return JSON.stringify({ outcome: 'raised', pid: pid, how: 'activate' })
	return JSON.stringify({ outcome: 'refused', pid: pid, tried: tried })
}`

/** Strategy 2 by unix id (`argv[0]`): only that process, never another one named okena. */
export const OKENA_SYSTEM_EVENTS_BY_PID_SCRIPT = [
	'on run argv',
	'tell application "System Events" to set frontmost of (first process whose unix id is ((item 1 of argv) as integer)) to true',
	'end run',
] as const

/** Strategy 2 when strategy 1 named no pid (it failed or timed out): the process named "okena" (any case). */
export const OKENA_ACTIVATE_SCRIPT =
	'tell application "System Events" to set frontmost of first process whose name is "okena" to true'

/** Runs a command and resolves its stdout; rejects like `execFile` (the seam tests replace; never a shell). */
export type ExecFileRunner = (
	file: string,
	args: readonly string[],
	opts: { timeout: number },
) => Promise<{ stdout: string } | undefined>

const runExecFile: ExecFileRunner = (file, args, opts) =>
	new Promise((resolve, reject) => {
		execFile(file, [...args], { timeout: opts.timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(error, { stdout, stderr }))
			else resolve({ stdout })
		})
	})

export type OkenaRaiseVia = 'appkit' | 'system-events'

/** One strategy's outcome. `denied`: macOS refused the Apple event (Automation or Accessibility). */
export type OkenaRaiseOutcome = 'raised' | 'already-front' | 'refused' | 'not-running' | 'denied' | 'timeout' | 'failed'

export interface OkenaRaiseAttempt {
	via: OkenaRaiseVia
	outcome: OkenaRaiseOutcome
	ms: number
	pid?: number
	/** AppKit: which request Okena answered (`from-front` or `activate`). */
	how?: string
	/** osascript's error number (e.g. -1743), when it printed one. */
	code?: number
	/** Which permission a `denied` needs. */
	permission?: 'automation' | 'accessibility'
	detail?: string
}

export type OkenaRaiseResult =
	| { ok: true; via: OkenaRaiseVia; pid?: number; attempts: OkenaRaiseAttempt[] }
	| {
			ok: false
			reason: 'unsupported' | 'not-running' | 'denied' | 'timeout' | 'failed'
			permission?: 'automation' | 'accessibility'
			attempts: OkenaRaiseAttempt[]
	  }

export interface OkenaRaiseOptions {
	platform?: NodeJS.Platform
	run?: ExecFileRunner
	now?: () => number
	/** Strategy 1's bound (osascript + AppKit + up to 2 × 200 ms of checking). */
	appKitTimeoutMs?: number
	/** Strategy 2's bound: System Events may have to launch first (~1.7 s seen). */
	systemEventsTimeoutMs?: number
}

const APPKIT_TIMEOUT_MS = 1_500
const SYSTEM_EVENTS_TIMEOUT_MS = 4_000

/** osascript's `execution error: … (-1743)` number, if any. */
function osascriptCode(text: string): number | undefined {
	const match = /\((-\d+)\)\s*$/m.exec(text)
	return match ? Number(match[1]) : undefined
}

/** A rejected osascript run as an attempt: timeout, permission, Okena gone, or a bare failure. */
export function osascriptFailure(via: OkenaRaiseVia, error: unknown, ms: number): OkenaRaiseAttempt {
	const failed = error as { killed?: boolean; signal?: string | null; stderr?: unknown; message?: unknown } | null
	const stderr = typeof failed?.stderr === 'string' ? failed.stderr : ''
	const message = typeof failed?.message === 'string' ? failed.message : String(error)
	const text = `${stderr}\n${message}`.trim()
	const detail = (stderr.trim() || message).split('\n').filter(Boolean).at(-1)?.slice(0, 300)
	if (failed?.killed || failed?.signal === 'SIGTERM' || /\bETIMEDOUT\b|timed out/i.test(message))
		return { via, outcome: 'timeout', ms, ...(detail ? { detail } : {}) }
	const code = osascriptCode(text)
	const base = { via, ms, ...(code === undefined ? {} : { code }), ...(detail ? { detail } : {}) }
	// errAEEventNotPermitted: Automation (Privacy & Security → Automation → … → System Events).
	if (code === -1743 || /not authori[sz]ed to send apple events/i.test(text))
		return { ...base, outcome: 'denied', permission: 'automation' }
	// errAEEventWouldRequireUserConsent / "assistive access": Accessibility.
	if (code === -1719 || code === -25211 || /assistive access|accessibility/i.test(text))
		return { ...base, outcome: 'denied', permission: 'accessibility' }
	// errAENoSuchObject / procNotFound: no such process (any more).
	if (code === -1728 || code === -600) return { ...base, outcome: 'not-running' }
	return { ...base, outcome: 'failed' }
}

/** Strategy 1's stdout (one JSON line) as an attempt; anything else is a failure. */
export function parseAppKitRaise(stdout: string, ms: number): OkenaRaiseAttempt {
	try {
		const said = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>
		const pid = Number.isSafeInteger(said.pid) && (said.pid as number) > 0 ? (said.pid as number) : undefined
		const how = typeof said.how === 'string' ? said.how : undefined
		const extra = { ...(pid ? { pid } : {}), ...(how ? { how } : {}) }
		switch (said.outcome) {
			case 'raised':
			case 'already-front':
			case 'refused':
			case 'not-running':
				return { via: 'appkit', outcome: said.outcome, ms, ...extra }
		}
	} catch {
		// Not our JSON: below.
	}
	return { via: 'appkit', outcome: 'failed', ms, detail: `unexpected output: ${stdout.trim().slice(0, 200)}` }
}

/**
 * Raise the Okena desktop app: AppKit first, System Events (by unix id) when AppKit could not, each
 * bounded. Never throws; `attempts` says what each strategy did (for the log).
 */
export async function raiseOkenaApp(opts: OkenaRaiseOptions = {}): Promise<OkenaRaiseResult> {
	if ((opts.platform ?? process.platform) !== 'darwin') return { ok: false, reason: 'unsupported', attempts: [] }
	const run = opts.run ?? runExecFile
	const now = opts.now ?? Date.now
	const attempts: OkenaRaiseAttempt[] = []

	let started = now()
	let appKit: OkenaRaiseAttempt
	try {
		const out = await run('osascript', ['-l', 'JavaScript', '-e', OKENA_APPKIT_RAISE_SCRIPT], {
			timeout: opts.appKitTimeoutMs ?? APPKIT_TIMEOUT_MS,
		})
		appKit = parseAppKitRaise(out?.stdout ?? '', now() - started)
	} catch (error) {
		appKit = osascriptFailure('appkit', error, now() - started)
	}
	attempts.push(appKit)
	if (appKit.outcome === 'raised' || appKit.outcome === 'already-front')
		return { ok: true, via: 'appkit', ...(appKit.pid ? { pid: appKit.pid } : {}), attempts }
	// AppKit sees every registered app: no Okena GUI there means none for System Events either.
	if (appKit.outcome === 'not-running') return { ok: false, reason: 'not-running', attempts }

	started = now()
	let systemEvents: OkenaRaiseAttempt
	try {
		const args = appKit.pid
			? OKENA_SYSTEM_EVENTS_BY_PID_SCRIPT.flatMap(line => ['-e', line]).concat(String(appKit.pid))
			: ['-e', OKENA_ACTIVATE_SCRIPT]
		await run('osascript', args, { timeout: opts.systemEventsTimeoutMs ?? SYSTEM_EVENTS_TIMEOUT_MS })
		systemEvents = {
			via: 'system-events',
			outcome: 'raised',
			ms: now() - started,
			...(appKit.pid ? { pid: appKit.pid } : {}),
		}
	} catch (error) {
		systemEvents = osascriptFailure('system-events', error, now() - started)
	}
	attempts.push(systemEvents)
	if (systemEvents.outcome === 'raised')
		return { ok: true, via: 'system-events', ...(systemEvents.pid ? { pid: systemEvents.pid } : {}), attempts }
	const outcome = systemEvents.outcome
	const reason =
		outcome === 'denied' || outcome === 'not-running' || outcome === 'timeout' ? outcome : ('failed' as const)
	return { ok: false, reason, ...(systemEvents.permission ? { permission: systemEvents.permission } : {}), attempts }
}

/** One log line for a raise: `appkit raised pid 20211 (190 ms)` / `appkit refused (310 ms) → system-events denied -1743 (…)`. */
export function describeOkenaRaise(result: OkenaRaiseResult): string {
	if (!result.ok && result.reason === 'unsupported') return 'not macOS: not raised'
	return result.attempts
		.map(attempt =>
			[
				attempt.via,
				attempt.outcome,
				attempt.how ? `(${attempt.how})` : '',
				attempt.pid ? `pid ${attempt.pid}` : '',
				attempt.code !== undefined ? String(attempt.code) : '',
				attempt.detail && attempt.outcome !== 'raised' ? `“${attempt.detail}”` : '',
				`(${attempt.ms} ms)`,
			]
				.filter(Boolean)
				.join(' '),
		)
		.join(' → ')
}

/**
 * Best-effort raise of the Okena desktop app (macOS only; false elsewhere or when every strategy
 * failed or timed out). Never throws. `timeoutMs` bounds the System Events fallback.
 */
export async function activateOkenaApp(
	opts: { timeoutMs?: number; platform?: NodeJS.Platform; run?: ExecFileRunner } = {},
): Promise<boolean> {
	const result = await raiseOkenaApp({
		...(opts.platform ? { platform: opts.platform } : {}),
		...(opts.run ? { run: opts.run } : {}),
		...(opts.timeoutMs ? { systemEventsTimeoutMs: opts.timeoutMs } : {}),
	}).catch(() => null)
	return result?.ok === true
}
