import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { type RemoteRuntime, startRemoteRuntime } from '../src/remote/runtime.js'

// Fault injection is confined to this Node test process. The builtin mutations
// are restored before cleanup and synced back to ESM callers on every path.
for (const replaceLock of [false, true]) {
	test(`partial initial lock write closes its descriptor and ${replaceLock ? 'preserves a replacement' : 'removes only its own incomplete lock'}`, async () => {
		const root = fs.realpathSync(fs.mkdtempSync('/tmp/hr-lock-write-'))
		const lockPath = join(root, 'runtime.lock')
		const write = fs.writeFileSync
		let injected = false
		let descriptor: number | undefined
		fs.writeFileSync = (...args: Parameters<typeof fs.writeFileSync>) => {
			const [path] = args
			if (!injected && typeof path === 'number' && fs.existsSync(lockPath)) {
				const opened = fs.fstatSync(path)
				const named = fs.lstatSync(lockPath)
				if (opened.dev === named.dev && opened.ino === named.ino) {
					injected = true
					descriptor = path
					write(path, '{"protocol":', 'utf8')
					assert.ok(fs.fstatSync(path).size > 0, 'The failure must follow a real partial write')
					if (replaceLock) {
						fs.renameSync(lockPath, join(root, 'displaced-owned-lock'))
						write(lockPath, 'replacement lock bytes', { mode: 0o600 })
					}
					throw Object.assign(new Error('injected partial lock write'), { code: 'EIO' })
				}
			}
			return write(...args)
		}
		syncBuiltinESMExports()
		try {
			await assert.rejects(
				startRemoteRuntime({
					root,
					origin: 'https://remote.example',
					port: 0,
					assetsDirectory: join(root, 'unreached-assets'),
					piSessionRoots: [],
				}),
				{ code: 'EIO', message: 'injected partial lock write' },
			)
			assert.equal(injected, true)
			assert.notEqual(descriptor, undefined)
			assert.throws(() => fs.fstatSync(descriptor as number), { code: 'EBADF' })
			if (replaceLock) assert.equal(fs.readFileSync(lockPath, 'utf8'), 'replacement lock bytes')
			else assert.equal(fs.existsSync(lockPath), false)
			assert.equal(fs.existsSync(join(root, 'operator-token')), false, 'No authority is minted after failed lock write')
			assert.equal(fs.existsSync(join(root, 'control.sock')), false)
		} finally {
			fs.writeFileSync = write
			syncBuiltinESMExports()
			fs.rmSync(root, { recursive: true, force: true })
		}
	})
}

test('discovery cleanup uses creator identity when replacement occurs inside the publication rename', async () => {
	const root = fs.realpathSync(fs.mkdtempSync('/tmp/hr-publish-'))
	const assets = join(root, 'assets')
	fs.mkdirSync(assets, { mode: 0o700 })
	for (const name of ['index.html', 'remote.js', 'remote.css']) fs.writeFileSync(join(assets, name), '')
	const discovery = join(root, 'bridge-registration.json')
	const rename = fs.renameSync
	let replaced = false
	let runtime: RemoteRuntime | undefined
	fs.renameSync = (...args: Parameters<typeof fs.renameSync>) => {
		rename(...args)
		if (!replaced && args[1] === discovery) {
			replaced = true
			// This runs before writePrivate returns, not in the later lifecycle hook.
			const created = fs.lstatSync(discovery)
			rename(discovery, join(root, 'displaced-owned-discovery'))
			fs.writeFileSync(discovery, 'foreign discovery bytes', { mode: 0o600 })
			assert.notEqual(fs.lstatSync(discovery).ino, created.ino)
		}
	}
	syncBuiltinESMExports()
	try {
		runtime = await startRemoteRuntime({
			root,
			origin: 'https://remote.example',
			port: 0,
			assetsDirectory: assets,
			piSessionRoots: [],
		})
		assert.equal(replaced, true)
		await runtime.stop()
		runtime = undefined
		assert.equal(fs.readFileSync(discovery, 'utf8'), 'foreign discovery bytes')
		assert.equal(fs.existsSync(join(root, 'runtime.lock')), false)
		assert.equal(fs.existsSync(join(root, 'control.sock')), false)
	} finally {
		fs.renameSync = rename
		syncBuiltinESMExports()
		try {
			await runtime?.stop()
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	}
})
