// Agent dock "Show terminal": the reveal target a pane offers (Okena pane vs Helm terminal, nothing
// to show), main's Okena half (fresh layout read → `focus_terminal` → app raise; exact request bodies,
// never terminal input), its IPC channel behind the dock gate, and the app activator. Never talks to
// a live Okena or runs osascript.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import dockMainModule from '../app/src/agent-dock-main.ts'
import revealModule from '../app/src/agent-dock/reveal.ts'
import runtimeModule from '../app/src/claude-remote/runtime.ts'
import { OKENA_ACTIVATE_SCRIPT, activateOkenaApp } from '../src/extensions/okena/activate.js'
import { OkenaClient } from '../src/extensions/okena/client.js'

type RevealModule = typeof import('../app/src/agent-dock/reveal.ts')
type OkenaRevealClient = import('../app/src/agent-dock/reveal.ts').OkenaRevealClient
type DockSession = import('../app/src/agent-dock/model.ts').DockSession
const { dockRevealTarget, okenaFocusAction, parseRevealSession, revealLabel, revealOkenaTerminal, REVEAL_TEXT } =
	revealModule as RevealModule
const { createAgentDockMain } = dockMainModule as typeof import('../app/src/agent-dock-main.ts')
const { HOOK_FILE, PRELOAD_FILE } = runtimeModule as typeof import('../app/src/claude-remote/runtime.ts')

const session = (patch: Partial<DockSession>): DockSession =>
	({
		key: 'default:term-1',
		source: 'okena',
		profile: 'default',
		terminalId: 'term-1',
		projectId: 'proj-1',
		project: 'fix/service-date-and-people',
		name: 'service-date-and-people',
		status: 'idle',
		since: 0,
		observedAt: 0,
		subagents: 0,
		backgroundTasks: 0,
		backgroundShells: 0,
		queuedPrompts: 0,
		prLinks: [],
		hasTranscript: true,
		hooksAttached: true,
		channelAttached: false,
		...patch,
	}) as DockSession

/** Okena's `/v1/state` with the terminal as a layout pane of proj-1 (and a hook terminal named only). */
const okenaState = (layoutTerminal = 'term-1') => ({
	state_version: 3,
	claude_sessions: ['term-1'],
	projects: [
		{ id: 'proj-0', name: 'crane-rental', path: '/fixture/crane-rental', terminal_names: { 'term-hook': 'hook' } },
		{
			id: 'proj-1',
			name: 'fix/service-date-and-people',
			path: '/fixture/crane-rental-wt/sdp',
			layout: {
				type: 'split',
				children: [
					{ type: 'terminal', terminal_id: 'term-0' },
					{ type: 'tabs', active_tab: 0, children: [{ type: 'terminal', terminal_id: layoutTerminal }] },
				],
			},
		},
	],
})

/** A recording Okena double: what the reveal asked of it, in order. */
function fakeOkena(opts: { state?: unknown; stateError?: Error; actionError?: Error } = {}): {
	client: OkenaRevealClient
	calls: Array<{ call: string; profile?: string; payload?: unknown; opts?: unknown }>
} {
	const calls: Array<{ call: string; profile?: string; payload?: unknown; opts?: unknown }> = []
	const client = (profile?: string): OkenaRevealClient => ({
		forProfile(id) {
			calls.push({ call: 'forProfile', profile: id })
			return client(id)
		},
		async getStateJson(readOpts) {
			calls.push({ call: 'getStateJson', ...(profile ? { profile } : {}), opts: readOpts })
			if (opts.stateError) throw opts.stateError
			return opts.state ?? okenaState()
		},
		async action(payload, actionOpts) {
			calls.push({ call: 'action', ...(profile ? { profile } : {}), payload })
			assert.ok(actionOpts?.signal instanceof AbortSignal, 'the focus POST is bounded')
			if (opts.actionError) throw opts.actionError
			return null
		},
	})
	return { client: client(), calls }
}

test('reveal target: an Okena pane in a layout, a Helm terminal, or nothing to show', () => {
	assert.deepEqual(dockRevealTarget(session({})), {
		kind: 'okena',
		session: 'default:term-1',
		profile: 'default',
		terminalId: 'term-1',
		projectId: 'proj-1',
	})
	assert.deepEqual(
		dockRevealTarget(
			session({
				key: 'helm:work:sess-1',
				source: 'helm',
				profile: 'helm:work',
				terminalId: 'sess-1',
				projectId: 'cwd:/x',
			}),
		),
		{ kind: 'helm', session: 'helm:work:sess-1', terminalId: 'sess-1' },
	)
	// A Helm terminal needs no Okena project.
	assert.equal(dockRevealTarget(session({ source: 'helm', projectId: undefined }))?.kind, 'helm')
	// Nothing to show: no session, no terminal id (either source), an Okena pane in no layout (hook/service terminal).
	assert.equal(dockRevealTarget(undefined), null)
	assert.equal(dockRevealTarget(session({ terminalId: '' })), null)
	assert.equal(dockRevealTarget(session({ source: 'helm', terminalId: '' })), null)
	assert.equal(dockRevealTarget(session({ projectId: undefined })), null)
	assert.equal(
		revealLabel({ kind: 'okena', session: 'p:t', profile: 'p', terminalId: 't', projectId: 'x' }),
		'Show in Okena',
	)
	assert.equal(revealLabel({ kind: 'helm', session: 'helm:p:t', terminalId: 't' }), 'Show terminal')
})

test('reveal: Okena focus_terminal body (as `okena term focus`, no window) and session keys', () => {
	assert.deepEqual(okenaFocusAction('proj-1', 'term-1'), {
		action: 'focus_terminal',
		project_id: 'proj-1',
		terminal_id: 'term-1',
	})
	assert.deepEqual(parseRevealSession('default:term-1'), { profile: 'default', terminalId: 'term-1' })
	// Okena profile ids may hold ':' (validate_profile_id forbids only / \ .. NUL); terminal ids never do.
	assert.deepEqual(parseRevealSession('práce:2:term-1'), { profile: 'práce:2', terminalId: 'term-1' })
	for (const bad of ['', 'no-colon', ':term-1', 'default:', 42, null, undefined, `p:${'t'.repeat(600)}`])
		assert.equal(parseRevealSession(bad), null, String(bad))
})

test('reveal (main): fresh layout read, then focus_terminal, then the app is raised', async () => {
	const { client, calls } = fakeOkena()
	let activations = 0
	const order: string[] = []
	const result = await revealOkenaTerminal('default:term-1', {
		client,
		activate: async () => {
			activations++
			order.push(`activate after ${calls.length} calls`)
			return true
		},
	})
	assert.deepEqual(result, { ok: true, activated: true })
	assert.deepEqual(
		calls.map(({ call, profile, payload }) => ({ call, profile, payload })),
		[
			{ call: 'forProfile', profile: 'default', payload: undefined },
			{ call: 'getStateJson', profile: 'default', payload: undefined },
			{
				call: 'action',
				profile: 'default',
				payload: { action: 'focus_terminal', project_id: 'proj-1', terminal_id: 'term-1' },
			},
		],
	)
	// Raised once, after the focus landed.
	assert.equal(activations, 1)
	assert.deepEqual(order, ['activate after 3 calls'])
})

test('reveal (main): the app could not be raised — still focused, said so', async () => {
	const { client } = fakeOkena()
	assert.deepEqual(await revealOkenaTerminal('default:term-1', { client, activate: async () => false }), {
		ok: true,
		activated: false,
	})
	const { client: throwing } = fakeOkena()
	assert.deepEqual(
		await revealOkenaTerminal('default:term-1', {
			client: throwing,
			activate: () => Promise.reject(new Error('osascript')),
		}),
		{ ok: true, activated: false },
	)
})

test('reveal (main): gone, unreachable, refused focus, Helm keys and junk never focus or raise anything', async () => {
	const never = async () => {
		throw new Error('must not raise Okena')
	}
	// Only a hook terminal by that id (terminal_names, not a layout pane), or no terminal at all: gone.
	for (const key of ['default:term-hook', 'default:term-9']) {
		const { client, calls } = fakeOkena()
		assert.deepEqual(await revealOkenaTerminal(key, { client, activate: never }), {
			ok: false,
			detail: REVEAL_TEXT.gone,
		})
		assert.equal(calls.filter(call => call.call === 'action').length, 0, key)
	}
	const down = fakeOkena({ stateError: new Error('connect ECONNREFUSED 127.0.0.1:19100') })
	assert.deepEqual(await revealOkenaTerminal('default:term-1', { client: down.client, activate: never }), {
		ok: false,
		detail: 'Okena is unreachable: connect ECONNREFUSED 127.0.0.1:19100',
	})
	assert.equal(down.calls.filter(call => call.call === 'action').length, 0)
	const malformed = fakeOkena({ state: { projects: 'nope' } })
	const parsed = await revealOkenaTerminal('default:term-1', { client: malformed.client, activate: never })
	assert.equal(parsed.ok, false)
	assert.match((parsed as { detail: string }).detail, /^Okena is unreachable: invalid \/v1\/state/)
	const refused = fakeOkena({ actionError: new Error('Okena action failed (400): terminal not found: term-1') })
	assert.deepEqual(await revealOkenaTerminal('default:term-1', { client: refused.client, activate: never }), {
		ok: false,
		detail: 'Okena did not focus the terminal: Okena action failed (400): terminal not found: term-1',
	})
	for (const key of ['helm:work:sess-1', 'junk', 7]) {
		const { client, calls } = fakeOkena()
		const result = await revealOkenaTerminal(key, { client, activate: never })
		assert.equal(result.ok, false, String(key))
		assert.deepEqual(calls, [], String(key))
	}
})

test('reveal (main) through the real OkenaClient: GET /v1/state then the exact POST /v1/actions body', async () => {
	const root = mkdtempSync(join(tmpdir(), 'hr-'))
	const socketPath = join(root, 'okena.sock')
	const baseDir = join(root, 'config')
	mkdirSync(join(baseDir, 'profiles', 'default'), { recursive: true })
	writeFileSync(join(baseDir, 'profiles.json'), JSON.stringify({ last_used: 'default' }))
	writeFileSync(join(baseDir, 'profiles', 'default', 'cli.json'), JSON.stringify({ token: 'tok', token_id: 'id' }))
	writeFileSync(
		join(baseDir, 'profiles', 'default', 'remote.json'),
		JSON.stringify({ pid: process.pid, port: 1, local_endpoint: { kind: 'unix_socket', path: socketPath } }),
	)
	const requests: Array<{ method?: string; url?: string; body: string; authorization?: string }> = []
	const server: Server = createServer((request, response) => {
		let body = ''
		request.setEncoding('utf8')
		request.on('data', chunk => {
			body += chunk
		})
		request.on('end', () => {
			requests.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization })
			response.writeHead(200, { 'Content-Type': 'application/json' })
			response.end(request.url === '/v1/state' ? JSON.stringify(okenaState()) : 'null')
		})
	})
	await new Promise<void>(resolve => server.listen(socketPath, resolve))
	try {
		const result = await revealOkenaTerminal('default:term-1', {
			client: new OkenaClient(baseDir),
			activate: async () => true,
		})
		assert.deepEqual(result, { ok: true, activated: true })
		assert.deepEqual(
			requests.map(({ method, url }) => `${method} ${url}`),
			['GET /v1/state', 'POST /v1/actions'],
		)
		assert.ok(requests.every(request => request.authorization === 'Bearer tok'))
		assert.deepEqual(JSON.parse(requests[1]?.body ?? ''), {
			action: 'focus_terminal',
			project_id: 'proj-1',
			terminal_id: 'term-1',
		})
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()))
		rmSync(root, { recursive: true, force: true })
	}
})

const WINDOW = { id: 'main-window' }
const TOKEN = 'work:1'

function dockWith(root: string, reveal: { client: OkenaRevealClient; activate(): Promise<boolean> }, enabled = true) {
	const dist = join(root, 'dist')
	mkdirSync(dist, { recursive: true })
	writeFileSync(join(dist, PRELOAD_FILE), '// preload\n')
	writeFileSync(join(dist, HOOK_FILE), '// hook\n')
	const dock = createAgentDockMain({
		enabled,
		socketRoot: join(root, 's'),
		distDir: dist,
		userDataDir: join(root, 'ud'),
		electronPath: process.execPath,
		activeProfileId: () => 'work',
		writeAttached: () => false,
		dtachSocket: () => null,
		dtachBinary: () => null,
		terminalName: () => undefined,
		publish: () => {},
		isFocused: () => false,
		acceptsIpc: (sender, profileToken) => sender === WINDOW && profileToken === TOKEN,
		reveal,
	})
	const channels = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
	dock.registerIpc({
		on: (channel, listener) => channels.set(channel, listener),
		handle: (channel, listener) => channels.set(channel, listener),
	})
	return { dock, channels }
}

test('agent-dock:reveal IPC: behind the dock gate, focuses the exact Okena pane and raises the app', async () => {
	const root = mkdtempSync('/tmp/hcr-reveal-')
	const { client, calls } = fakeOkena()
	let activations = 0
	const { dock, channels } = dockWith(root, {
		client,
		activate: async () => {
			activations++
			return true
		},
	})
	try {
		const reveal = channels.get('agent-dock:reveal')
		assert.ok(reveal, 'agent-dock:reveal is registered')
		// A foreign window or a stale profile token: refused before Okena is touched.
		for (const [sender, token] of [
			[{ id: 'other-window' }, TOKEN],
			[WINDOW, 'work:0'],
			[WINDOW, undefined],
		] as const)
			assert.deepEqual(await reveal({ sender }, 'default:term-1', token), {
				ok: false,
				detail: 'This window cannot show terminals for the current profile.',
			})
		assert.deepEqual(calls, [])
		assert.equal(activations, 0)

		assert.deepEqual(await reveal({ sender: WINDOW }, 'default:term-1', TOKEN), { ok: true, activated: true })
		assert.deepEqual(
			calls.filter(call => call.call === 'action').map(call => call.payload),
			[{ action: 'focus_terminal', project_id: 'proj-1', terminal_id: 'term-1' }],
		)
		assert.equal(activations, 1)
		// Through the gate, a session Okena no longer shows: the quiet note's words, nothing raised.
		assert.deepEqual(await reveal({ sender: WINDOW }, 'default:term-9', TOKEN), {
			ok: false,
			detail: REVEAL_TEXT.gone,
		})
		assert.equal(activations, 1)
	} finally {
		dock.stop()
		rmSync(root, { recursive: true, force: true })
	}
})

test('agent-dock:reveal IPC: off in this run, it says so after the gate', async () => {
	const root = mkdtempSync('/tmp/hcr-reveal-')
	const { client, calls } = fakeOkena()
	const { dock, channels } = dockWith(root, { client, activate: async () => true }, false)
	try {
		assert.deepEqual(await channels.get('agent-dock:reveal')?.({ sender: WINDOW }, 'default:term-1', TOKEN), {
			ok: false,
			detail: 'The agent dock is off in this run.',
		})
		assert.deepEqual(calls, [])
	} finally {
		dock.stop()
		rmSync(root, { recursive: true, force: true })
	}
})

test('activateOkenaApp: System Events raises the process named okena (macOS only, bounded, never throws)', async () => {
	const runs: Array<{ file: string; args: readonly string[]; timeout: number }> = []
	assert.equal(
		await activateOkenaApp({
			platform: 'darwin',
			timeoutMs: 2_000,
			run: async (file, args, opts) => {
				runs.push({ file, args, timeout: opts.timeout })
			},
		}),
		true,
	)
	assert.deepEqual(runs, [{ file: 'osascript', args: ['-e', OKENA_ACTIVATE_SCRIPT], timeout: 2_000 }])
	assert.match(OKENA_ACTIVATE_SCRIPT, /set frontmost of first process whose name is "okena" to true/)
	assert.equal(
		await activateOkenaApp({
			platform: 'darwin',
			run: async () => {
				throw new Error('not authorized to send Apple events to System Events')
			},
		}),
		false,
	)
	assert.equal(
		await activateOkenaApp({
			platform: 'linux',
			run: async () => {
				throw new Error('must not run')
			},
		}),
		false,
	)
})
