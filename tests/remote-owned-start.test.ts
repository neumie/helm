import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
	holderPids,
	recoverOwnedRuntime,
	runtimePidsFromPs,
	type OwnedHostStatus,
	type OwnedStartInspection,
} from '../src/remote/owned-start.js'

function scratch(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync('/tmp/hr-owned-'))
	chmodSync(root, 0o700)
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return root
}

function clock(step = 200) {
	let time = 0
	return {
		now: () => time,
		sleep: async () => {
			time += step
		},
	}
}

function inspection(partial: Partial<OwnedStartInspection> = {}): OwnedStartInspection & { signals: number[] } {
	const signals: number[] = []
	return {
		signals,
		runtimePids: async () => [],
		holders: async () => [],
		signal(pid) {
			signals.push(pid)
		},
		alive: () => false,
		...partial,
	}
}

async function refusedSockets(root: string) {
	const script = join(root, 'sock.cjs')
	writeFileSync(
		script,
		`
const { createServer } = require('node:net')
const { chmodSync } = require('node:fs')
const { join } = require('node:path')
let ready = 0
for (const name of ['control.sock', 'host.sock']) {
  createServer().listen(join(process.argv[2], name), () => {
    chmodSync(join(process.argv[2], name), 0o600)
    if (++ready === 2) console.log('ready')
  })
}
`,
	)
	const { NODE_OPTIONS, ...environment } = process.env
	const child = spawn(process.execPath, [script, root], { stdio: ['ignore', 'pipe', 'inherit'], env: environment })
	await new Promise<void>((resolve, reject) => {
		child.stdout.on('data', chunk => String(chunk).includes('ready') && resolve())
		child.once('error', reject)
		child.once('exit', code => reject(new Error(`socket fixture exited early: ${code}`)))
	})
	child.kill('SIGKILL')
	await new Promise(resolve => child.once('exit', resolve))
	rmSync(script)
}

test('ps parsing keeps only another process whose argv is this runtime', () => {
	const runtime = '/Users/jakubneumann/Documents/code/neumie/helm/dist/remote/runtime.js'
	const output = [
		'11 /opt/homebrew/bin/node /tmp/other/runtime.js',
		`22 /opt/homebrew/bin/node ${runtime}`,
		'33 /bin/zsh',
		`44 note-about ${runtime}-notes`,
		`55 ${runtime}`,
	].join('\n')
	assert.deepEqual(runtimePidsFromPs(output, runtime, 55), [22])
})

test('lsof holder lines are pids and nothing else', () => {
	assert.deepEqual(holderPids('p42\nf12\np42\np7\n'), [42, 7])
})

test('a compatible host is reused without a signal or deleting the lock', async t => {
	const root = scratch(t)
	writeFileSync(join(root, 'runtime.lock'), '{"instanceId":"live"}', { mode: 0o600 })
	const inspect = inspection()
	assert.equal(
		await recoverOwnedRuntime({
			root,
			inspect,
			status: async () => 'compatible',
			sleep: async () => {},
			now: () => 0,
			deadlineMs: 1,
		}),
		'ready',
	)
	assert.deepEqual(inspect.signals, [])
	assert.equal(lstatSync(join(root, 'runtime.lock')).isFile(), true)
})

test('an abandoned private lock is removed only when no runtime and no holder remain', async t => {
	const root = scratch(t)
	writeFileSync(join(root, 'runtime.lock'), '{"instanceId":"gone"}', { mode: 0o600 })
	writeFileSync(join(root, 'devices.json'), '{"keep":true}', { mode: 0o600 })
	await refusedSockets(root)
	const inspect = inspection()
	assert.equal(
		await recoverOwnedRuntime({
			root,
			inspect,
			status: async () => 'absent',
			sleep: async () => {},
			now: () => 0,
			deadlineMs: 1,
		}),
		'cleared',
	)
	assert.equal(lstatSync(join(root, 'devices.json')).isFile(), true)
	for (const name of ['runtime.lock', 'control.sock', 'host.sock']) {
		assert.throws(() => lstatSync(join(root, name)))
	}
})

test('a starting runtime is never displaced just because its listener is not up yet', async t => {
	const root = scratch(t)
	writeFileSync(join(root, 'runtime.lock'), '{"instanceId":"starting"}', { mode: 0o600 })
	const identity = lstatSync(join(root, 'runtime.lock'))
	const inspect = inspection({ runtimePids: async () => [77] })
	const time = clock()
	await assert.rejects(
		recoverOwnedRuntime({
			root,
			inspect,
			status: async () => 'absent',
			...time,
			deadlineMs: 400,
		}),
		/refuse to replace it/,
	)
	assert.equal(lstatSync(join(root, 'runtime.lock')).ino, identity.ino)
	assert.deepEqual(inspect.signals, [])
})

test('an incompatible host is stopped only when it is the sole runtime holding the control socket', async t => {
	const root = scratch(t)
	writeFileSync(join(root, 'runtime.lock'), '{"instanceId":"old"}', { mode: 0o600 })
	let status: OwnedHostStatus = 'incompatible'
	let alive = true
	const inspect = inspection({
		runtimePids: async () => (alive ? [9] : []),
		holders: async path => (alive && path.endsWith('control.sock') ? [9] : []),
		signal(pid) {
			inspect.signals.push(pid)
			alive = false
		},
	})
	await refusedSockets(root)
	assert.equal(
		await recoverOwnedRuntime({
			root,
			inspect,
			status: async () => status,
			sleep: async () => {
				status = 'absent'
			},
			now: () => 0,
			deadlineMs: 1000,
		}),
		'cleared',
	)
	assert.deepEqual(inspect.signals, [9])
	assert.throws(() => lstatSync(join(root, 'runtime.lock')))
})

test('an unknown control-socket holder is neither signaled nor replaced', async t => {
	const root = scratch(t)
	writeFileSync(join(root, 'runtime.lock'), '{}', { mode: 0o600 })
	const inspect = inspection({
		runtimePids: async () => [9],
		holders: async () => [4],
	})
	const time = clock()
	await assert.rejects(
		recoverOwnedRuntime({
			root,
			inspect,
			status: async () => 'incompatible',
			...time,
			deadlineMs: 400,
		}),
		/refuse to replace it/,
	)
	assert.deepEqual(inspect.signals, [])
	assert.equal(lstatSync(join(root, 'runtime.lock')).isFile(), true)
})

test('a failed inspection or a non-private artifact never authorizes deletion', async t => {
	const root = scratch(t)
	writeFileSync(join(root, 'runtime.lock'), '{}', { mode: 0o644 })
	const failed = inspection({ holders: async () => null })
	const time = clock()
	await assert.rejects(
		recoverOwnedRuntime({
			root,
			inspect: failed,
			status: async () => 'absent',
			...time,
			deadlineMs: 400,
		}),
		/refuse to replace it/,
	)
	chmodSync(join(root, 'runtime.lock'), 0o600)
	symlinkSync('/etc/hosts', join(root, 'host.sock'))
	const later = clock()
	await assert.rejects(
		recoverOwnedRuntime({
			root,
			inspect: inspection(),
			status: async () => 'absent',
			...later,
			deadlineMs: 400,
		}),
		/refuse to replace it/,
	)
	assert.equal(lstatSync(join(root, 'runtime.lock')).isFile(), true)
	assert.equal(lstatSync(join(root, 'host.sock')).isSymbolicLink(), true)
})
