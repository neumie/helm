// Agent dock IPC: act can approve permissions and type replies into terminals, so
// every dock channel is gated on the current profile token AND the main window's
// renderer (agent-dock-main.ts registers them; main.ts supplies the gate). Also
// main's side of the hub wiring: its quarantine gates and terminal-close owner.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import dockMainModule from '../app/src/agent-dock-main.ts'
import runtimeModule from '../app/src/claude-remote/runtime.ts'

type DockMainModule = typeof import('../app/src/agent-dock-main.ts')
type RuntimeModule = typeof import('../app/src/claude-remote/runtime.ts')
const { createAgentDockMain } = dockMainModule as DockMainModule
const { HOOK_FILE, PRELOAD_FILE } = runtimeModule as RuntimeModule

const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')

const WINDOW = { id: 'main-window' }
const TOKEN = 'work:1'
const DENIED = {
	ok: false,
	outcome: { status: 'failed', detail: 'This window cannot answer for the current profile.' },
}

type Listener = (event: { sender: unknown }, ...args: unknown[]) => unknown

function dockIn(root: string, enabled: boolean) {
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
	})
	const channels = new Map<string, Listener>()
	dock.registerIpc({
		on: (channel, listener) => channels.set(channel, listener),
		handle: (channel, listener) => channels.set(channel, listener),
	})
	const call = (channel: string, sender: unknown, ...args: unknown[]) => {
		const listener = channels.get(channel)
		assert.ok(listener, channel)
		return listener({ sender }, ...args)
	}
	return { dock, channels, call }
}

test('agent dock IPC: the seven dock channels are registered and refuse a foreign window or a stale profile token', async () => {
	const root = mkdtempSync('/tmp/hcr-ipc-')
	const { dock, channels, call } = dockIn(root, true)
	try {
		assert.deepEqual([...channels.keys()].sort(), [
			'agent-dock:ack',
			'agent-dock:act',
			'agent-dock:message',
			'agent-dock:prompt',
			'agent-dock:reveal',
			'agent-dock:set-notify',
			'agent-dock:set-visible',
		])
		const request = { itemId: 1, rev: 1, action: { type: 'approve' } }
		for (const [sender, token] of [
			[{ id: 'other-window' }, TOKEN],
			[WINDOW, 'work:0'],
			[WINDOW, undefined],
		] as const) {
			assert.deepEqual(await call('agent-dock:act', sender, request, token), DENIED)
			assert.equal(await call('agent-dock:ack', sender, 1, token), false)
			assert.deepEqual(await call('agent-dock:prompt', sender, { session: 'p:t', text: 'hi' }, token), DENIED)
			assert.deepEqual(await call('agent-dock:message', sender, 'p:t', token), {
				ok: false,
				detail: 'This window cannot read for the current profile.',
			})
		}
		// Through the gate, the watcher decides (here: an invalid request, not the gate's refusal).
		const reached = (await call('agent-dock:act', WINDOW, { nope: true }, TOKEN)) as { outcome: { status: string } }
		assert.equal(reached.outcome.status, 'refused')
		const prompted = (await call('agent-dock:prompt', WINDOW, { nope: true }, TOKEN)) as { outcome: { status: string } }
		assert.equal(prompted.outcome.status, 'refused')
		const read = (await call('agent-dock:message', WINDOW, 'no such session', TOKEN)) as { ok: boolean }
		assert.equal(read.ok, false)
		for (const itemId of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])
			assert.equal(await call('agent-dock:ack', WINDOW, itemId, TOKEN), false, String(itemId))
	} finally {
		dock.stop()
		rmSync(root, { recursive: true, force: true })
	}
})

test('agent dock IPC: off in this run, act says so (after the gate) and nothing else exists', async () => {
	const root = mkdtempSync('/tmp/hcr-ipc-')
	const { dock, call } = dockIn(root, false)
	try {
		assert.deepEqual(await call('agent-dock:act', { id: 'other-window' }, {}, TOKEN), DENIED)
		assert.deepEqual(await call('agent-dock:act', WINDOW, {}, TOKEN), {
			ok: false,
			outcome: { status: 'failed', detail: 'The agent dock is off in this run.' },
		})
		assert.equal(await call('agent-dock:ack', WINDOW, 1, TOKEN), false)
		assert.deepEqual(await call('agent-dock:prompt', WINDOW, {}, TOKEN), {
			ok: false,
			outcome: { status: 'failed', detail: 'The agent dock is off in this run.' },
		})
		assert.deepEqual(await call('agent-dock:message', WINDOW, 'p:t', TOKEN), {
			ok: false,
			detail: 'The agent dock is off in this run.',
		})
		call('agent-dock:set-visible', WINDOW, true, TOKEN)
		assert.deepEqual(dock.terminalEnvironment({ PATH: '/bin', HELM_CLAUDE_REMOTE_TOKEN: 'stale' }, 't1'), {
			PATH: '/bin',
		})
	} finally {
		dock.stop()
		rmSync(root, { recursive: true, force: true })
	}
})

test('main gates the dock channels on the session IPC gate and the main window; preload sends the profile token', () => {
	assert.match(main, /agentDock\.registerIpc\(ipcMain\)/)
	assert.match(
		main,
		/acceptsIpc: \(sender, profileToken\) => sessionIpcGate\.allows\(profileToken\) && sender === mainWindow\?\.webContents/,
	)
	for (const channel of ['setVisible', 'ack', 'act', 'prompt', 'message', 'reveal']) {
		const start = preload.indexOf(`AGENT_DOCK_CHANNELS.${channel},`)
		assert.notEqual(start, -1, channel)
		assert.ok(preload.slice(start, start + 120).includes('sessionProfileToken'), channel)
	}
})

test('main: a hub reply never reaches a quarantined session, attached (pty) or parked (dtach push)', () => {
	const start = main.indexOf('const agentDock = createAgentDockMain({')
	const wiring = main.slice(start, main.indexOf('\n})\n', start))
	const attached = wiring.slice(wiring.indexOf('writeAttached:'), wiring.indexOf('dtachSocket:'))
	assert.match(attached, /!ordinarySessionAllowed\(ref\.terminalId\)/)
	// writeAttached's false means "not attached" to deliver(), which then pushes: the push path needs its own gate.
	const parked = wiring.slice(wiring.indexOf('dtachSocket:'), wiring.indexOf('dtachBinary:'))
	assert.match(parked, /if \(!ordinarySessionAllowed\(ref\.terminalId, ref\.profileId\)\) return null/)
	assert.match(parked, /isSessionBusy\(ref\.terminalId\)\) return null/)
})

test('main: a terminal close reaches the hub under the profile that owned it, captured before the async kill or reap', () => {
	assert.match(
		main,
		/const claudeTerminalClosed = \(sessionId: string, profileId: string\) =>\s*agentDock\.terminalClosed\(\{ profileId, terminalId: sessionId \}\)/,
	)
	const calls = [...main.matchAll(/claudeTerminalClosed\((\w+), (\w+)\)/g)].map(match => match[2])
	assert.deepEqual(calls, ['profileId', 'owningProfile', 'profileId'])
	// Grace close: captured with its storage, when the finalizer is admitted.
	const grace = main.slice(
		main.indexOf('const graceCloser = new sessions.GraceCloser('),
		main.indexOf('function wrapWarmProcess'),
	)
	assert.ok(grace.indexOf('const profileId = sessionProfileId') < grace.indexOf('return () => {'))
	// Hard kill: captured before killSession resolves.
	const kill = main.slice(
		main.indexOf("ipcMain.on('pty:kill'"),
		main.indexOf("ipcMain.handle('session:close-with-grace'"),
	)
	assert.ok(kill.indexOf('const profileId = sessionProfileId') < kill.indexOf('sessions.killSession(sid).then('))
})
