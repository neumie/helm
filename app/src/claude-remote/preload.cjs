// Helm "Claude in Helm terminals" preload. Helm main puts it into every new
// Helm terminal as BUN_OPTIONS="--preload=<this file>", so Bun runs it before
// any Bun program in that terminal. For the top-level interactive Claude Code
// session of the terminal it appends `--settings <hooks>` whose hooks report to
// Helm's hub over a private Unix socket. Every other program is left alone.
//
// Adapted from Okena's MIT-licensed Claude remote preload
// (contember/okena integrations/claude-code/okena-remote/preload.js @ ef25cc81,
// Copyright (c) 2026 Contember Limited; see THIRD_PARTY_NOTICES.md). Helm
// changes: Helm env gates, the subcommands added since Claude Code 2.1.301
// (`daemon`, `bg-pty-host`, `bg-spare`), no MCP channel, the HELM_CLAUDE_REMOTE_*
// variables removed from this process when it is a `claude` that does not get
// hooks, no hooks inside tmux/screen/zellij (the pane Helm would type into is not
// that claude), a one-line "no hooks" notice when the user's own --settings wins,
// and a lifeline: one connection to the hub held open for this claude's life
// (close-on-exec, so the kernel closes it on any exit, kill -9 included; the hub
// then ends the session and never types a reply into what is left in the pty).
//
// Plain CommonJS with no imports at load time: it runs inside every Bun program
// in the terminal, so it must never throw and never block.
'use strict'

// Entry module of the Bun-compiled `claude` binary.
const CLAUDE_ENTRY = '/$bunfs/root/cli'

const ENV_SOCKET = 'HELM_CLAUDE_REMOTE_SOCKET'
const ENV_TOKEN = 'HELM_CLAUDE_REMOTE_TOKEN'
const ENV_HOOK = 'HELM_CLAUDE_REMOTE_HOOK'
const ENV_NODE = 'HELM_CLAUDE_REMOTE_NODE'
const REMOTE_ENV = [ENV_SOCKET, ENV_TOKEN, ENV_HOOK, ENV_NODE]

// Flags that leave argv unchanged (Okena's list): no interactive session in this
// terminal (print mode, version, help, the modes that move the session elsewhere).
// `--settings` is separate: Claude accepts one, and the user's own wins.
const GUARDED_FLAGS = new Set([
	'-p',
	'--print',
	'-v',
	'--version',
	'-h',
	'--help',
	'--bg',
	'--background',
	'--desktop',
	'--cloud',
	'--environment',
	'--tmux',
])
const USER_SETTINGS_FLAG = '--settings'

// Short forms of guarded flags. Commander accepts them combined (`-cp`).
const GUARDED_SHORT_FLAGS = new Set(['p', 'v', 'h'])
// Short flags that take a value: in a cluster, the rest of the argument is that value.
const VALUE_SHORT_FLAGS = new Set(['d', 'n', 'r', 'w'])

// `claude --help` 2.1.301 (Okena) plus the 2.1.316 background-session subcommands.
const SUBCOMMANDS = new Set([
	'agents',
	'attach',
	'auth',
	'auto-mode',
	'bg-pty-host',
	'bg-spare',
	'daemon',
	'doctor',
	'gateway',
	'import',
	'install',
	'logs',
	'mcp',
	'plugin',
	'plugins',
	'purge',
	'respawn',
	'rm',
	'setup-token',
	'stop',
	'kill',
	'ultrareview',
	'update',
	'upgrade',
])

// Hook events that only report to Helm; `null` = event without a matcher.
const EVENT_HOOKS = [
	['SessionStart', null],
	['UserPromptSubmit', null],
	['PreToolUse', '*'],
	['PostToolUse', '*'],
	['PostToolUseFailure', '*'],
	['Stop', null],
	['StopFailure', null],
	['SessionEnd', null],
	['SubagentStart', null],
	['SubagentStop', null],
]

// The permission hook waits until Jakub answers from the dock, or the terminal
// answers and the hub releases it.
const PERMISSION_HOOK_TIMEOUT_SECS = 86400
const EVENT_HOOK_TIMEOUT_SECS = 10

function shellQuote(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`
}

function clusterHas(cluster, set) {
	for (const flag of cluster) {
		if (set.has(flag)) return true
		if (VALUE_SHORT_FLAGS.has(flag)) return false
	}
	return false
}

function flagName(arg) {
	return arg.startsWith('--') ? arg.split('=', 1)[0] : arg
}

function isGuardedFlag(arg) {
	if (GUARDED_FLAGS.has(flagName(arg))) return true
	if (/^-[A-Za-z]{2,}/.test(arg)) return clusterHas(arg.slice(1), GUARDED_SHORT_FLAGS)
	return false
}

function hooksSettings(node, hook) {
	const base = `${shellQuote(node)} ${shellQuote(hook)}`
	const hooks = {
		PermissionRequest: [
			{
				matcher: '*',
				hooks: [{ type: 'command', command: `${base} permission`, timeout: PERMISSION_HOOK_TIMEOUT_SECS }],
			},
		],
	}
	for (const [event, matcher] of EVENT_HOOKS) {
		const entry = {
			hooks: [{ type: 'command', command: `${base} event`, async: true, timeout: EVENT_HOOK_TIMEOUT_SECS }],
		}
		hooks[event] = [matcher === null ? entry : { matcher, ...entry }]
	}
	return { hooks }
}

/**
 * What the preload does for this process (pure; exported for tests).
 * - `{action: 'inject', argv}`: the top-level interactive `claude` of a Helm terminal.
 * - `{action: 'skip', inClaude, reason, degraded?}`: leave argv alone. `inClaude` means
 *   this process is the `claude` binary, so the HELM_CLAUDE_REMOTE_* variables are
 *   removed from it and none of its children can ever report. `degraded` is set only
 *   when this is the terminal's interactive session but the user's own --settings won.
 */
function helmClaudePlan(argv, env, execPath) {
	const inClaude = argv[1] === CLAUDE_ENTRY && String(execPath).includes('claude')
	if (!inClaude) return { action: 'skip', inClaude: false, reason: 'not claude' }
	if (!env[ENV_SOCKET] || !env[ENV_TOKEN] || !env[ENV_HOOK] || !env[ENV_NODE])
		return { action: 'skip', inClaude, reason: 'not a Helm terminal' }
	if (env.OKENA_TERMINAL_ID) return { action: 'skip', inClaude, reason: 'Okena terminal' }
	// Inherited from a parent Claude Code: a nested, forked, background or workflow session.
	if (env.CLAUDECODE) return { action: 'skip', inClaude, reason: 'started by Claude Code' }
	// Inside a multiplexer the Helm pty shows whichever pane is active, not this claude.
	if (env.TMUX || env.STY || env.ZELLIJ) return { action: 'skip', inClaude, reason: 'terminal multiplexer' }

	const separator = argv.indexOf('--', 2)
	const optionsEnd = separator === -1 ? argv.length : separator
	const userArgs = argv.slice(2, optionsEnd)
	if (userArgs.some(isGuardedFlag)) return { action: 'skip', inClaude, reason: 'not interactive' }
	// Option values are not told apart from positionals (`--model opus mcp`), so any
	// subcommand name counts. A false match only skips the injection.
	if (userArgs.some(arg => SUBCOMMANDS.has(arg))) return { action: 'skip', inClaude, reason: 'subcommand' }
	if (userArgs.some(arg => flagName(arg) === USER_SETTINGS_FLAG))
		return { action: 'skip', inClaude, reason: 'user --settings', degraded: 'user_settings' }

	const added = ['--settings', JSON.stringify(hooksSettings(env[ENV_NODE], env[ENV_HOOK]))]
	return { action: 'inject', argv: [...argv.slice(0, optionsEnd), ...added, ...argv.slice(optionsEnd)] }
}

/** One fire-and-forget line to the hub: this terminal's session runs without hooks. */
function reportDegraded(env, reason) {
	try {
		const net = require('node:net')
		const socket = net.createConnection(env[ENV_SOCKET])
		socket.on('error', () => {})
		socket.setTimeout(2000, () => socket.destroy())
		socket.end(
			`${JSON.stringify({ v: 1, t: 'degraded', token: env[ENV_TOKEN], pid: process.pid, reason, cwd: process.cwd() })}\n`,
		)
		socket.unref?.()
	} catch {
		// Never break claude over a notice.
	}
}

const LIFELINE_RETRY_MIN_MS = 500
const LIFELINE_RETRY_MAX_MS = 10_000

/**
 * Holds `{"t":"attach"}` open to the hub for this process's life, reconnecting (unref'd
 * timers, so it never keeps claude alive) when Helm restarts. Never throws.
 */
function holdLifeline(socketPath, token, pid) {
	let delay = LIFELINE_RETRY_MIN_MS
	const retry = () => {
		const timer = setTimeout(connect, delay)
		timer.unref?.()
		delay = Math.min(delay * 2, LIFELINE_RETRY_MAX_MS)
	}
	const connect = () => {
		try {
			const net = require('node:net')
			const socket = net.createConnection(socketPath)
			let closed = false
			socket.on('connect', () => {
				delay = LIFELINE_RETRY_MIN_MS
				socket.write(`${JSON.stringify({ v: 1, t: 'attach', token, pid })}\n`)
			})
			socket.on('data', () => {})
			socket.on('error', () => {})
			socket.on('close', () => {
				if (closed) return
				closed = true
				retry()
			})
			socket.unref?.()
		} catch {
			retry()
		}
	}
	connect()
}

function run() {
	try {
		const plan = helmClaudePlan(process.argv, process.env, process.execPath)
		if (plan.action === 'inject') {
			process.argv.splice(0, process.argv.length, ...plan.argv)
			holdLifeline(process.env[ENV_SOCKET], process.env[ENV_TOKEN], process.pid)
			if (process.env.HELM_CLAUDE_REMOTE_DEBUG === '1')
				process.stderr.write(`helm-claude-remote: argv ${JSON.stringify(process.argv)}\n`)
			return
		}
		if (!plan.inClaude) return
		if (plan.degraded && process.env[ENV_SOCKET] && process.env[ENV_TOKEN]) reportDegraded(process.env, plan.degraded)
		for (const key of REMOTE_ENV) delete process.env[key]
	} catch {
		// A failing preload would break every Bun program in the terminal.
	}
}

if (typeof module !== 'undefined')
	module.exports = { helmClaudePlan, hooksSettings, holdLifeline, CLAUDE_ENTRY, REMOTE_ENV, SUBCOMMANDS }
// Under Bun's --preload this file is the preload itself; Node tests only require it.
if (typeof Bun !== 'undefined') run()
