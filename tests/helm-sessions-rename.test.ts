// Manual rename pin (app/src/sessions.ts SessionRegistry.customName): the
// pinned tab name must round-trip a kill/relaunch cycle as a field SEPARATE
// from lastTitle (OSC tracking), clear on empty commit, stay backward
// compatible with pre-customName registry JSON — and registry metadata must
// survive an 'unknown' liveness probe (prune-on-unknown was the production
// metadata-loss path: a live Jul 11 session restored as "zsh" two days later
// because one probe timeout dropped its entry). CJS default-import pattern
// per the helm test convention.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import sessionsModule from '../app/src/sessions.ts'

type SessionsModule = typeof import('../app/src/sessions.ts')
const { SessionRegistry, scanSessions } = sessionsModule as SessionsModule

function tempRegistryFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-rename-')), 'sessions.json')
}

test('customName round-trips a relaunch, separate from lastTitle', () => {
	const file = tempRegistryFile()
	const first = new SessionRegistry(file)
	first.add('aaaa1111')
	first.setTitle('aaaa1111', 'zsh') // live OSC keeps tracking underneath the pin
	first.setCustomName('aaaa1111', 'deploy watch')
	first.setTitle('aaaa1111', 'vim') // later OSC must not disturb the pin
	first.flush()

	const second = new SessionRegistry(file)
	assert.equal(second.get('aaaa1111')?.customName, 'deploy watch')
	assert.equal(second.get('aaaa1111')?.lastTitle, 'vim')
})

test('empty/null commit clears the pin and the key disappears from the JSON', () => {
	const file = tempRegistryFile()
	const registry = new SessionRegistry(file)
	registry.add('bbbb2222')
	registry.setCustomName('bbbb2222', 'scratch')
	registry.setCustomName('bbbb2222', '   ') // whitespace-only = clear
	registry.flush()
	assert.equal(registry.get('bbbb2222')?.customName, undefined)
	assert.ok(!fs.readFileSync(file, 'utf8').includes('customName'), 'cleared pin must not linger in the JSON')

	registry.setCustomName('bbbb2222', 'again')
	registry.setCustomName('bbbb2222', null)
	registry.flush()
	assert.equal(new SessionRegistry(file).get('bbbb2222')?.customName, undefined)
})

test('pre-customName registry JSON loads unchanged (backward compat)', () => {
	const file = tempRegistryFile()
	fs.writeFileSync(
		file,
		JSON.stringify({ cccc3333: { createdAt: '2026-07-01T00:00:00.000Z', lastTitle: 'okena', parked: true } }),
	)
	const registry = new SessionRegistry(file)
	assert.equal(registry.get('cccc3333')?.lastTitle, 'okena')
	assert.equal(registry.get('cccc3333')?.customName, undefined)
	assert.equal(registry.get('cccc3333')?.parked, true)
})

test('setCustomName ignores unknown sessions; prune drops the pin with the session', () => {
	const file = tempRegistryFile()
	const registry = new SessionRegistry(file)
	registry.setCustomName('missing1', 'ghost') // no throw, no entry created
	assert.equal(registry.get('missing1'), undefined)

	registry.add('dddd4444')
	registry.setCustomName('dddd4444', 'gone soon')
	registry.prune(new Set())
	assert.equal(registry.get('dddd4444'), undefined)
})

test('scanSessions: unknown-probe sockets are retained, not restorable — prune keeps their metadata', async () => {
	// Over-cap socket dir: node EINVALs the connect while dtach could still be
	// serving the path — the probe reads 'unknown'. The scan must surface these
	// as retained ids so sessions:list prunes with live ∪ unknown.
	const longDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-rename-')), 'x'.repeat(90))
	fs.mkdirSync(longDir, { recursive: true })
	fs.writeFileSync(path.join(longDir, 'eeee5555.sock'), '')
	const prev = process.env.HELM_SOCKET_DIR ?? ''
	process.env.HELM_SOCKET_DIR = longDir
	try {
		const scan = await scanSessions()
		assert.deepEqual(scan.live, [])
		assert.deepEqual(scan.unknownIds, ['eeee5555'])
		assert.ok(fs.existsSync(path.join(longDir, 'eeee5555.sock')), 'unknown probe must never unlink')

		// The sessions:list retention rule: live ∪ unknown keeps the metadata.
		const registry = new SessionRegistry(tempRegistryFile())
		registry.add('eeee5555')
		registry.setTitle('eeee5555', 'buildbox')
		registry.setCustomName('eeee5555', 'deploy watch')
		registry.prune(new Set([...scan.live.map(s => s.sessionId), ...scan.unknownIds]))
		assert.equal(registry.get('eeee5555')?.lastTitle, 'buildbox')
		assert.equal(registry.get('eeee5555')?.customName, 'deploy watch')
	} finally {
		process.env.HELM_SOCKET_DIR = prev
	}
})

test('scanSessions: crash-leftover sockets are dead — unlinked and not retained', async () => {
	// A dead socket (file exists, nobody serves it → ECONNREFUSED) is GC'd and
	// must NOT appear in unknownIds; a normal-length dir keeps probes definitive.
	// True crash shape (per helm-sessions-reap.test.ts): a listener SIGKILLed
	// mid-flight leaves the file behind — a graceful close would unlink it.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-rn-'))
	const sock = path.join(dir, 'ffff6666.sock')
	const { spawn } = await import('node:child_process')
	const child = spawn(process.execPath, [
		'-e',
		`const net = require('net'); net.createServer().listen(${JSON.stringify(sock)}, () => { process.kill(process.pid, 'SIGKILL') })`,
	])
	await new Promise<void>(resolve => child.once('exit', () => resolve()))
	assert.ok(fs.existsSync(sock), 'SIGKILL leaves the socket file (the crash-leftover shape)')
	const prev = process.env.HELM_SOCKET_DIR ?? ''
	process.env.HELM_SOCKET_DIR = dir
	try {
		const scan = await scanSessions()
		assert.deepEqual(scan.live, [])
		assert.deepEqual(scan.unknownIds, [])
		assert.ok(!fs.existsSync(sock), "dead socket file is GC'd by the scan")
	} finally {
		process.env.HELM_SOCKET_DIR = prev
	}
})

test('a live session is re-adopted after corrupt registry loss, then rename and order persist', () => {
	const file = tempRegistryFile()
	fs.writeFileSync(file, '') // prior non-atomic write was interrupted after truncate
	const registry = new SessionRegistry(file)
	assert.equal(registry.get('eeee5555'), undefined)

	registry.ensure('eeee5555', '2026-07-14T09:00:00.000Z')
	registry.setCustomName('eeee5555', 'production shell')
	registry.setOrder(['eeee5555'])
	registry.flush()

	const restored = new SessionRegistry(file)
	assert.equal(restored.get('eeee5555')?.customName, 'production shell')
	assert.equal(restored.get('eeee5555')?.order, 0)
	assert.equal(restored.get('eeee5555')?.createdAt, '2026-07-14T09:00:00.000Z')
})
