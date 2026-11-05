// Raising Okena's desktop app (macOS): the ordered strategies (AppKit via JXA, then System Events by
// unix id), osascript error mapping (-1743 Automation, Accessibility, timeouts, Okena gone), the JXA
// script's own choice of Okena's GUI (run here against a fake ObjC bridge), and the dock's raiser
// (one log line per raise, the permission fix said once). Never runs osascript.
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import okenaRaiseModule from '../app/src/agent-dock/okena-raise.ts'
import revealModule from '../app/src/agent-dock/reveal.ts'
import {
	type ExecFileRunner,
	OKENA_ACTIVATE_SCRIPT,
	OKENA_APPKIT_RAISE_SCRIPT,
	OKENA_SYSTEM_EVENTS_BY_PID_SCRIPT,
	type OkenaRaiseResult,
	activateOkenaApp,
	describeOkenaRaise,
	osascriptFailure,
	parseAppKitRaise,
	raiseOkenaApp,
} from '../src/extensions/okena/activate.js'

const { createOkenaRaiser } = okenaRaiseModule as typeof import('../app/src/agent-dock/okena-raise.ts')
const { REVEAL_TEXT } = revealModule as typeof import('../app/src/agent-dock/reveal.ts')

/** execFile's rejection for an osascript that printed an AppleScript error. */
const osascriptError = (stderr: string, extra: Record<string, unknown> = {}) =>
	Object.assign(new Error(`Command failed: osascript\n${stderr}`), {
		code: 1,
		killed: false,
		signal: null,
		stderr,
		...extra,
	})

const DENIED_AUTOMATION = '25:118: execution error: Not authorized to send Apple events to System Events. (-1743)'

/** A scripted runner: each call answers with the next reply (stdout, or a rejection). */
function fakeRun(replies: Array<string | Error>) {
	const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = []
	const run: ExecFileRunner = async (file, args, opts) => {
		calls.push({ file, args, timeout: opts.timeout })
		const reply = replies.shift()
		if (reply === undefined) throw new Error('unexpected osascript run')
		if (reply instanceof Error) throw reply
		return { stdout: reply }
	}
	return { run, calls }
}

const clock = () => {
	let t = 0
	return () => {
		t += 100
		return t
	}
}

test('raiseOkenaApp: AppKit first; when it raises, System Events is never asked', async () => {
	const { run, calls } = fakeRun(['{"outcome":"raised","pid":20211,"how":"from-front"}\n'])
	const result = await raiseOkenaApp({ platform: 'darwin', run, now: clock() })
	assert.deepEqual(result, {
		ok: true,
		via: 'appkit',
		pid: 20211,
		attempts: [{ via: 'appkit', outcome: 'raised', ms: 100, pid: 20211, how: 'from-front' }],
	})
	assert.deepEqual(calls, [
		{ file: 'osascript', args: ['-l', 'JavaScript', '-e', OKENA_APPKIT_RAISE_SCRIPT], timeout: 1_500 },
	])
	// Already in front: nothing more to do.
	const front = fakeRun(['{"outcome":"already-front","pid":20211}'])
	assert.equal((await raiseOkenaApp({ platform: 'darwin', run: front.run })).ok, true)
	assert.equal(front.calls.length, 1)
})

test('raiseOkenaApp: AppKit refused → System Events targets the exact pid AppKit found (not the name)', async () => {
	const { run, calls } = fakeRun(['{"outcome":"refused","pid":20211,"tried":["from-front","activate"]}', ''])
	const result = await raiseOkenaApp({ platform: 'darwin', run, now: clock(), systemEventsTimeoutMs: 3_000 })
	assert.deepEqual(result, {
		ok: true,
		via: 'system-events',
		pid: 20211,
		attempts: [
			{ via: 'appkit', outcome: 'refused', ms: 100, pid: 20211 },
			{ via: 'system-events', outcome: 'raised', ms: 100, pid: 20211 },
		],
	})
	assert.deepEqual(calls[1], {
		file: 'osascript',
		args: [...OKENA_SYSTEM_EVENTS_BY_PID_SCRIPT.flatMap(line => ['-e', line]), '20211'],
		timeout: 3_000,
	})
	assert.match(OKENA_SYSTEM_EVENTS_BY_PID_SCRIPT[1], /first process whose unix id is \(\(item 1 of argv\) as integer\)/)
})

test('raiseOkenaApp: AppKit failed or timed out without a pid → System Events by name; Okena not running stops early', async () => {
	const timedOut = Object.assign(new Error('Command failed: osascript'), {
		killed: true,
		signal: 'SIGTERM',
		stderr: '',
	})
	const { run, calls } = fakeRun([timedOut, ''])
	const result = await raiseOkenaApp({ platform: 'darwin', run, now: clock() })
	assert.equal(result.ok, true)
	assert.deepEqual(
		result.attempts.map(a => [a.via, a.outcome]),
		[
			['appkit', 'timeout'],
			['system-events', 'raised'],
		],
	)
	assert.deepEqual(calls[1]?.args, ['-e', OKENA_ACTIVATE_SCRIPT])
	assert.equal(calls[1]?.timeout, 4_000)

	// Garbage on stdout is a failure, not success: System Events still gets its turn.
	const garbage = fakeRun(['hello', ''])
	const fromGarbage = await raiseOkenaApp({ platform: 'darwin', run: garbage.run })
	assert.equal(fromGarbage.ok && fromGarbage.via, 'system-events')
	assert.equal(fromGarbage.attempts[0]?.outcome, 'failed')

	// No Okena GUI among the registered apps: nothing to raise, System Events not asked.
	const none = fakeRun(['{"outcome":"not-running"}'])
	assert.deepEqual(await raiseOkenaApp({ platform: 'darwin', run: none.run, now: clock() }), {
		ok: false,
		reason: 'not-running',
		attempts: [{ via: 'appkit', outcome: 'not-running', ms: 100 }],
	})
	assert.equal(none.calls.length, 1)
})

test('raiseOkenaApp: -1743 from System Events reads as denied Automation; never throws; not macOS runs nothing', async () => {
	const { run } = fakeRun(['{"outcome":"refused","pid":7}', osascriptError(DENIED_AUTOMATION)])
	const result = await raiseOkenaApp({ platform: 'darwin', run, now: clock() })
	assert.equal(result.ok, false)
	assert.deepEqual(!result.ok && { reason: result.reason, permission: result.permission }, {
		reason: 'denied',
		permission: 'automation',
	})
	assert.deepEqual(result.attempts[1], {
		via: 'system-events',
		outcome: 'denied',
		ms: 100,
		code: -1743,
		permission: 'automation',
		detail: DENIED_AUTOMATION,
	})
	const timeout = fakeRun(['{"outcome":"refused","pid":7}', Object.assign(new Error('x'), { killed: true })])
	const timedOut = await raiseOkenaApp({ platform: 'darwin', run: timeout.run })
	assert.equal(!timedOut.ok && timedOut.reason, 'timeout')
	// Okena quit between the two strategies: System Events' -1719 "Invalid index" is "gone", not a denial.
	const quit = fakeRun([
		'{"outcome":"refused","pid":7}',
		osascriptError(
			'execution error: System Events got an error: Can’t get process 1 whose unix id = 7. Invalid index. (-1719)',
		),
	])
	const quitResult = await raiseOkenaApp({ platform: 'darwin', run: quit.run })
	assert.deepEqual(!quitResult.ok && { reason: quitResult.reason, permission: quitResult.permission }, {
		reason: 'not-running',
		permission: undefined,
	})
	const nothing = fakeRun([])
	assert.deepEqual(await raiseOkenaApp({ platform: 'linux', run: nothing.run }), {
		ok: false,
		reason: 'unsupported',
		attempts: [],
	})
	assert.equal(nothing.calls.length, 0)
})

test('osascriptFailure: error numbers and words map to Automation, Accessibility, gone or a bare failure', () => {
	const at = (stderr: string) => osascriptFailure('system-events', osascriptError(stderr), 5)
	assert.equal(at(DENIED_AUTOMATION).permission, 'automation')
	assert.equal(at('execution error: Not authorised to send Apple events to System Events.').permission, 'automation')
	assert.deepEqual(
		[at('execution error: osascript is not allowed assistive access. (-1719)'), at('… (-25211)')].map(a => [
			a.outcome,
			a.permission,
		]),
		[
			['denied', 'accessibility'],
			['denied', 'accessibility'],
		],
	)
	assert.equal(at('execution error: System Events got an error: Can’t get process 1. (-1728)').outcome, 'not-running')
	// System Events' real answer for a pid (or name) that matches nothing is -1719 "Invalid index":
	// Okena gone, never an Accessibility denial (that would put the wrong fix in the footer).
	assert.deepEqual(
		at(
			'40:88: execution error: System Events got an error: Can’t get process 1 whose unix id = 999999. Invalid index. (-1719)',
		),
		{
			via: 'system-events',
			outcome: 'not-running',
			ms: 5,
			code: -1719,
			detail:
				'40:88: execution error: System Events got an error: Can’t get process 1 whose unix id = 999999. Invalid index. (-1719)',
		},
	)
	assert.deepEqual(at('execution error: something else (-2700)'), {
		via: 'system-events',
		outcome: 'failed',
		ms: 5,
		code: -2700,
		detail: 'execution error: something else (-2700)',
	})
	assert.equal(osascriptFailure('appkit', new Error('spawn osascript ETIMEDOUT'), 1).outcome, 'timeout')
	assert.equal(parseAppKitRaise('{"outcome":"raised","pid":-3}', 1).pid, undefined)
})

test('describeOkenaRaise: one log line, each strategy in order', () => {
	const result: OkenaRaiseResult = {
		ok: false,
		reason: 'denied',
		permission: 'automation',
		attempts: [
			{ via: 'appkit', outcome: 'refused', ms: 310, pid: 20211 },
			{
				via: 'system-events',
				outcome: 'denied',
				ms: 900,
				code: -1743,
				permission: 'automation',
				detail: 'nope (-1743)',
			},
		],
	}
	assert.equal(
		describeOkenaRaise(result),
		'appkit refused pid 20211 (310 ms) → system-events denied -1743 “nope (-1743)” (900 ms)',
	)
	assert.equal(
		describeOkenaRaise({
			ok: true,
			via: 'appkit',
			pid: 1,
			attempts: [{ via: 'appkit', outcome: 'raised', ms: 190, pid: 1, how: 'activate' }],
		}),
		'appkit raised (activate) pid 1 (190 ms)',
	)
})

test('activateOkenaApp: the boolean the item opener uses (same strategies, never throws)', async () => {
	const ok = fakeRun(['{"outcome":"raised","pid":1}'])
	assert.equal(await activateOkenaApp({ platform: 'darwin', run: ok.run }), true)
	const denied = fakeRun(['{"outcome":"refused","pid":1}', osascriptError(DENIED_AUTOMATION)])
	assert.equal(await activateOkenaApp({ platform: 'darwin', run: denied.run, timeoutMs: 2_000 }), false)
	assert.equal(denied.calls[1]?.timeout, 2_000)
	assert.equal(await activateOkenaApp({ platform: 'linux', run: fakeRun([]).run }), false)
})

/** The JXA script against a fake ObjC bridge: which app it picks and what it asks of it. */
function runAppKitScript(opts: {
	apps: Array<{ name: string | null; policy?: number; pid: number; active?: boolean }>
	/** Which requests make the target active: 'from-front', 'activate', or neither. */
	honours: Array<'from-front' | 'activate'>
	argv?: string[]
}) {
	const asked: string[] = []
	const wrap = (value: unknown) => ({ __v: value, isNil: () => value === null })
	const apps = opts.apps.map(spec => {
		const app = {
			executableURL: spec.name === null ? wrap(null) : { isNil: () => false, lastPathComponent: wrap(spec.name) },
			activationPolicy: String(spec.policy ?? 0),
			processIdentifier: spec.pid,
			active: spec.active ?? false,
			pending: false,
			activateFromApplicationOptions(front: { isNil(): boolean }, options: number) {
				asked.push(`from-front ${spec.pid} ${options} ${front.isNil() ? 'nil' : 'front'}`)
				if (opts.honours.includes('from-front')) app.pending = true
			},
			activateWithOptions(options: number) {
				asked.push(`activate ${spec.pid} ${options}`)
				if (opts.honours.includes('activate')) app.pending = true
			},
		}
		return app
	})
	let spins = 0
	const $ = {
		NSWorkspace: {
			sharedWorkspace: {
				runningApplications: { count: apps.length, objectAtIndex: (i: number) => apps[i] },
				frontmostApplication: { isNil: () => false },
			},
		},
		NSRunLoop: {
			currentRunLoop: {
				// Activation lands on a run-loop turn, like NSRunningApplication's KVO updates.
				runUntilDate: () => {
					spins++
					for (const app of apps) if (app.pending) app.active = true
				},
			},
		},
		NSDate: { dateWithTimeIntervalSinceNow: (s: number) => s },
	}
	const ObjC = { import: () => {}, unwrap: (v: { __v: unknown }) => v.__v }
	const context: Record<string, unknown> = { $, ObjC, JSON, String, Number, Boolean }
	runInNewContext(OKENA_APPKIT_RAISE_SCRIPT, context)
	const out = (context.run as (argv: string[]) => string)(opts.argv ?? [])
	return { out: JSON.parse(out) as Record<string, unknown>, asked, spins }
}

test('AppKit script: picks the regular app whose executable is okena (any case), not other or background apps', () => {
	const apps = [
		{ name: null, pid: 1 },
		{ name: 'okena', policy: 2, pid: 3485 }, // a prohibited (background) okena never takes the keys
		{ name: 'Electron', pid: 26311, active: true },
		{ name: 'Okena', pid: 20211 },
		{ name: 'okena', pid: 99999 },
	]
	assert.deepEqual(runAppKitScript({ apps, honours: [], argv: ['probe'] }), {
		out: { outcome: 'probe', pid: 20211, active: false },
		asked: [],
		spins: 0,
	})
	assert.deepEqual(runAppKitScript({ apps: [{ name: 'Electron', pid: 2 }], honours: ['activate'] }).out, {
		outcome: 'not-running',
	})
	assert.deepEqual(runAppKitScript({ apps: [{ name: 'okena', pid: 5, active: true }], honours: [] }).out, {
		outcome: 'already-front',
		pid: 5,
	})
})

test('AppKit script: asks with the front app’s activation context first, then plainly, and checks Okena became active', () => {
	const apps = [{ name: 'okena', pid: 20211 }]
	const fromFront = runAppKitScript({ apps, honours: ['from-front'] })
	assert.deepEqual(fromFront.out, { outcome: 'raised', pid: 20211, how: 'from-front' })
	assert.deepEqual(fromFront.asked, ['from-front 20211 1 front'])
	assert.equal(fromFront.spins, 1)

	const plain = runAppKitScript({ apps, honours: ['activate'] })
	assert.deepEqual(plain.out, { outcome: 'raised', pid: 20211, how: 'activate' })
	assert.deepEqual(plain.asked, ['from-front 20211 1 front', 'activate 20211 1'])

	// macOS declined both (cooperative activation): refused, after a bounded wait, never claimed raised.
	const declined = runAppKitScript({ apps, honours: [] })
	assert.deepEqual(declined.out, { outcome: 'refused', pid: 20211, tried: ['from-front', 'activate'] })
	assert.equal(declined.spins, 16)
})

test('the dock raiser: logs every raise, says the permission fix once per run, plain afterwards', async () => {
	const lines: string[] = []
	const denied: OkenaRaiseResult = {
		ok: false,
		reason: 'denied',
		permission: 'automation',
		attempts: [{ via: 'system-events', outcome: 'denied', ms: 1, code: -1743, permission: 'automation' }],
	}
	const results: OkenaRaiseResult[] = [
		denied,
		denied,
		{ ok: true, via: 'appkit', attempts: [{ via: 'appkit', outcome: 'raised', ms: 1 }] },
	]
	const raise = createOkenaRaiser({
		raise: async () => results.shift() as OkenaRaiseResult,
		describe: describeOkenaRaise,
		log: line => lines.push(line),
	})
	assert.deepEqual(await raise(), { raised: false, note: REVEAL_TEXT.needsAutomation })
	assert.equal(await raise(), false)
	assert.equal(await raise(), true)
	assert.deepEqual(lines, [
		'raise Okena: system-events denied -1743 (1 ms)',
		'raise Okena: system-events denied -1743 (1 ms)',
		'raise Okena: appkit raised (1 ms)',
	])
	assert.match(
		REVEAL_TEXT.needsAutomation,
		/System Settings → Privacy & Security → Automation → Helm .* → System Events/,
	)

	const accessibility = createOkenaRaiser({
		raise: async () => ({ ...denied, permission: 'accessibility' }),
		describe: describeOkenaRaise,
		log: () => {},
	})
	assert.deepEqual(await accessibility(), { raised: false, note: REVEAL_TEXT.needsAccessibility })

	const throwing = createOkenaRaiser({
		raise: async () => {
			throw new Error('spawn failed')
		},
		describe: describeOkenaRaise,
		log: line => lines.push(line),
	})
	assert.equal(await throwing(), false)
	assert.equal(lines.at(-1), 'raise Okena: spawn failed')
})
