// The Helm Claude preload's gate is a pure function of (argv, env, execPath).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type Socket, createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { helmClaudePlan, hooksSettings, holdLifeline, CLAUDE_ENTRY, REMOTE_ENV } =
	require('../app/src/claude-remote/preload.cjs') as {
		holdLifeline(socketPath: string, token: string, pid: number): void
		helmClaudePlan(
			argv: string[],
			env: Record<string, string | undefined>,
			execPath: string,
		): { action: 'inject'; argv: string[] } | { action: 'skip'; inClaude: boolean; reason: string; degraded?: string }
		hooksSettings(node: string, hook: string): { hooks: Record<string, Array<Record<string, unknown>>> }
		CLAUDE_ENTRY: string
		REMOTE_ENV: string[]
	}

const EXEC = '/Users/j/.local/share/claude/versions/2.1.316'
const ENV = {
	HELM_CLAUDE_REMOTE_SOCKET: '/tmp/helm-501/claude-remote.sock',
	HELM_CLAUDE_REMOTE_TOKEN: 'v1.work.abc.mac',
	HELM_CLAUDE_REMOTE_HOOK: '/tmp/helm-501/claude-remote/hook-client.cjs',
	HELM_CLAUDE_REMOTE_NODE: '/opt/homebrew/bin/node',
}
const argv = (...args: string[]) => [EXEC, CLAUDE_ENTRY, ...args]

test('the top-level interactive claude of a Helm terminal gets --settings hooks before any --', () => {
	const plan = helmClaudePlan(argv('--model', 'opus', '--', 'hello'), ENV, EXEC)
	assert.equal(plan.action, 'inject')
	if (plan.action !== 'inject') return
	const at = plan.argv.indexOf('--settings')
	assert.deepEqual(plan.argv.slice(0, 4), argv('--model', 'opus'))
	assert.equal(at, 4)
	assert.deepEqual(plan.argv.slice(at + 2), ['--', 'hello'])
	const settings = JSON.parse(plan.argv[at + 1] as string)
	assert.deepEqual(settings, hooksSettings(ENV.HELM_CLAUDE_REMOTE_NODE, ENV.HELM_CLAUDE_REMOTE_HOOK))
	const permission = settings.hooks.PermissionRequest[0]
	assert.equal(permission.matcher, '*')
	assert.equal(permission.hooks[0].timeout, 86400)
	assert.equal(permission.hooks[0].async, undefined)
	assert.equal(
		permission.hooks[0].command,
		"'/opt/homebrew/bin/node' '/tmp/helm-501/claude-remote/hook-client.cjs' permission",
	)
	for (const event of [
		'SessionStart',
		'UserPromptSubmit',
		'PreToolUse',
		'PostToolUse',
		'PostToolUseFailure',
		'Stop',
		'StopFailure',
		'SessionEnd',
		'SubagentStart',
		'SubagentStop',
	]) {
		const entry = settings.hooks[event][0]
		assert.equal(entry.hooks[0].async, true, event)
		assert.equal(entry.hooks[0].timeout, 10, event)
		assert.match(entry.hooks[0].command, / event$/)
	}
	// No secret on the command line: the hook reads the token from its inherited env.
	assert.doesNotMatch(plan.argv.join(' '), /v1\.work/)
})

test('other Bun programs are left alone and keep their env', () => {
	const plan = helmClaudePlan(['/opt/homebrew/bin/bun', '/repo/script.ts'], ENV, '/opt/homebrew/bin/bun')
	assert.deepEqual(plan, { action: 'skip', inClaude: false, reason: 'not claude' })
	assert.equal(helmClaudePlan(argv(), ENV, '/opt/homebrew/bin/bun').action, 'skip')
})

test('claude skips (and loses the Helm variables) outside a Helm terminal, in Okena, and under another Claude', () => {
	const cases: Array<[Record<string, string | undefined>, string]> = [
		[{}, 'not a Helm terminal'],
		[{ ...ENV, HELM_CLAUDE_REMOTE_TOKEN: undefined }, 'not a Helm terminal'],
		[{ ...ENV, OKENA_TERMINAL_ID: 't1' }, 'Okena terminal'],
		// Nested from a Bash tool, a fork, a workflow/background session under `claude daemon`.
		[{ ...ENV, CLAUDECODE: '1' }, 'started by Claude Code'],
		// Inside tmux/screen/zellij the Helm pty shows the active pane, not this claude.
		[{ ...ENV, TMUX: '/tmp/tmux-501/default,1,0' }, 'terminal multiplexer'],
		[{ ...ENV, STY: '123.pts' }, 'terminal multiplexer'],
		[{ ...ENV, ZELLIJ: '0' }, 'terminal multiplexer'],
	]
	for (const [env, reason] of cases) {
		const plan = helmClaudePlan(argv(), env, EXEC)
		assert.equal(plan.action, 'skip')
		if (plan.action === 'skip') {
			assert.equal(plan.reason, reason)
			assert.equal(plan.inClaude, true)
			assert.equal(plan.degraded, undefined)
		}
	}
	assert.deepEqual(REMOTE_ENV, Object.keys(ENV))
})

test('print, version, help, background modes and subcommands skip, also as clusters', () => {
	for (const args of [
		['-p', 'hi'],
		['--print', 'hi'],
		['-cp', 'hi'],
		['--version'],
		['-v'],
		['--help'],
		['--bg'],
		['--background'],
		['--tmux'],
		['mcp', 'list'],
		['daemon', 'run'],
		['bg-pty-host'],
		['bg-spare'],
		['--model', 'opus', 'doctor'],
	]) {
		const plan = helmClaudePlan(argv(...args), ENV, EXEC)
		assert.equal(plan.action, 'skip', args.join(' '))
	}
	// A value cluster ends at a value flag: `-dp` is `--debug p`, still interactive.
	assert.equal(helmClaudePlan(argv('-dp'), ENV, EXEC).action, 'inject')
	// Flags after `--` are the prompt, not options.
	assert.equal(helmClaudePlan(argv('--', '-p'), ENV, EXEC).action, 'inject')
	assert.equal(helmClaudePlan(argv('--permission-mode', 'plan', '--resume', 'abc'), ENV, EXEC).action, 'inject')
})

test("the user's own --settings wins: no injection, a degraded (no hooks) notice", () => {
	for (const args of [['--settings', '/x.json'], ['--settings={}']]) {
		const plan = helmClaudePlan(argv(...args), ENV, EXEC)
		assert.equal(plan.action, 'skip')
		if (plan.action === 'skip') assert.equal(plan.degraded, 'user_settings')
	}
	// --setting-sources is a different flag.
	assert.equal(helmClaudePlan(argv('--setting-sources', 'local'), ENV, EXEC).action, 'inject')
})

test('lifeline: one attach line held open, reconnected after the hub goes away', async () => {
	const dir = mkdtempSync('/tmp/hcr-life-')
	const path = join(dir, 'hub.sock')
	const lines: string[] = []
	const sockets: Socket[] = []
	const listen = () => {
		const server = createServer(socket => {
			sockets.push(socket)
			socket.setEncoding('utf8')
			socket.on('data', chunk => lines.push(String(chunk).trim()))
		})
		return new Promise<typeof server>(resolve => server.listen(path, () => resolve(server)))
	}
	const wait = async (probe: () => boolean) => {
		for (let i = 0; i < 100 && !probe(); i++) await new Promise(resolve => setTimeout(resolve, 50))
		assert.ok(probe())
	}
	let server = await listen()
	try {
		holdLifeline(path, 'v1.work.t.mac', 4242)
		await wait(() => lines.length === 1)
		assert.deepEqual(JSON.parse(lines[0] as string), { v: 1, t: 'attach', token: 'v1.work.t.mac', pid: 4242 })
		// Helm restarts: the connection drops, the preload attaches to the next hub.
		for (const socket of sockets) socket.destroy()
		await new Promise<void>(resolve => server.close(() => resolve()))
		server = await listen()
		await wait(() => lines.length === 2)
		assert.equal(JSON.parse(lines[1] as string).t, 'attach')
	} finally {
		for (const socket of sockets) socket.destroy()
		await new Promise<void>(resolve => server.close(() => resolve()))
		rmSync(dir, { recursive: true, force: true })
	}
})
