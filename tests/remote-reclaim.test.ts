import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { RUNTIME_ARTIFACTS, reclaimDeadRuntime, socketAnswered } from '../src/remote/reclaim.js'

function scratch(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync('/tmp/hr-reclaim-'))
	chmodSync(root, 0o700)
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return root
}

/**
 * Emulate the real failure rather than a hand-made imitation of it: a runtime that owns
 * its lock and both sockets is killed outright, so the kernel leaves the files behind
 * exactly as they are found after a crash.
 */
async function leaveCrashedArtifacts(root: string) {
	const source = `
		const { createServer } = require('node:net')
		const { chmodSync, writeFileSync } = require('node:fs')
		const { join } = require('node:path')
		const root = process.argv[2]
		writeFileSync(join(root, 'runtime.lock'), JSON.stringify({ instanceId: 'gone' }), { mode: 0o600 })
		let ready = 0
		for (const name of ['control.sock', 'host.sock']) {
			const path = join(root, name)
			createServer().listen(path, () => {
				chmodSync(path, 0o600)
				if (++ready === 2) console.log('ready')
			})
		}
	`
	// A file rather than -e, and a clean environment: the parent's loader must not
	// decide how this fixture is parsed.
	const script = join(root, 'crash-fixture.cjs')
	writeFileSync(script, source)
	const { NODE_OPTIONS, ...environment } = process.env
	const child = spawn(process.execPath, [script, root], { stdio: ['ignore', 'pipe', 'inherit'], env: environment })
	await new Promise<void>((resolve, reject) => {
		child.stdout.on('data', chunk => String(chunk).includes('ready') && resolve())
		child.once('error', reject)
		child.once('exit', code => reject(new Error(`crash fixture exited early: ${code}`)))
	})
	child.kill('SIGKILL')
	await new Promise(resolve => child.once('exit', resolve))
	rmSync(script)
}

async function listening(path: string) {
	const server = createServer(socket => socket.end())
	await new Promise<void>(resolve => server.listen(path, resolve))
	return () => new Promise<void>(resolve => server.close(() => resolve()))
}

test('a refused socket is dead, an answered one is not, and neither guess is made on error', async t => {
	const root = scratch(t)
	const path = join(root, 'live.sock')
	const close = await listening(path)
	assert.equal(await socketAnswered(path), true)
	await close()
	// The socket file outlives the listener; only the refusal proves nobody is home.
	assert.equal(await socketAnswered(path), false)
	assert.equal(await socketAnswered(join(root, 'never-existed.sock')), false)
})

test('a crashed runtime is reclaimed once, preserved as evidence, and lets the restart through', async t => {
	const root = scratch(t)
	await leaveCrashedArtifacts(root)
	for (const name of RUNTIME_ARTIFACTS) assert.equal(existsSync(join(root, name)), true)

	assert.equal(await reclaimDeadRuntime(root, () => new Date('2026-09-19T11:00:00Z')), true)
	for (const name of RUNTIME_ARTIFACTS) assert.equal(existsSync(join(root, name)), false, `${name} still blocks start`)
	// Nothing is destroyed: a lock that turns out to matter stays recoverable.
	const preserved = readdirSync(root).filter(name => name.endsWith('-reclaimed'))
	assert.deepEqual(preserved, ['recovery-2026-09-19T11-00-00-000Z-reclaimed'])
	assert.deepEqual(readdirSync(join(root, preserved[0] as string)).sort(), [
		'control.sock',
		'host.sock',
		'runtime.lock',
	])
	// A second pass has nothing left to claim, so a refusal cannot become a loop.
	assert.equal(await reclaimDeadRuntime(root), false)
})

test('a live runtime always wins, however stale its lock looks', async t => {
	const root = scratch(t)
	writeFileSync(join(root, 'runtime.lock'), '{}', { mode: 0o600 })
	const close = await listening(join(root, 'control.sock'))
	assert.equal(await reclaimDeadRuntime(root), false)
	assert.equal(existsSync(join(root, 'runtime.lock')), true)
	await close()

	// Still refused while the other socket answers.
	const other = await listening(join(root, 'host.sock'))
	assert.equal(await reclaimDeadRuntime(root), false)
	assert.equal(existsSync(join(root, 'runtime.lock')), true)
	await other()
})

test('artifacts that are not provably ours are never reclaimed', async t => {
	const root = scratch(t)
	await leaveCrashedArtifacts(root)
	chmodSync(join(root, 'runtime.lock'), 0o644)
	assert.equal(await reclaimDeadRuntime(root), false)
	assert.equal(existsSync(join(root, 'runtime.lock')), true)

	chmodSync(join(root, 'runtime.lock'), 0o600)
	rmSync(join(root, 'host.sock'))
	symlinkSync('/etc/hosts', join(root, 'host.sock'))
	assert.equal(await reclaimDeadRuntime(root), false)
	assert.equal(existsSync(join(root, 'runtime.lock')), true)
	assert.equal(
		readdirSync(root).some(name => name.endsWith('-reclaimed')),
		false,
	)
})
