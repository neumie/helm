import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { loadOrCreateLocalControlToken, readLocalControlToken } from '../src/auth/local-control.js'
import { MAX_CONFIG_FILE_BYTES, readConfigFile, writeConfigFile } from '../src/config-file.js'
import { loadConfig } from '../src/config.js'
import { readPrivateHoldCapability } from '../src/knowledge/credentials.js'

function fixture(t: TestContext) {
	const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'helm-secrets-')))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	return root
}
const token = Buffer.alloc(32, 7).toString('base64url')

test('config roundtrip in a repository-style 0755 directory hardens every operation', t => {
	const root = fixture(t)
	fs.chmodSync(root, 0o755)
	const path = join(root, 'helm.config.json')
	const raw = JSON.stringify({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'p', apiToken: 'test-secret' },
		projects: [{ slug: 'p', repoPath: root }],
	})
	writeConfigFile(path, raw)
	assert.equal(readConfigFile(path), raw)
	assert.deepEqual(loadConfig(path).raw, JSON.parse(raw))
	fs.chmodSync(path, 0o644)
	assert.equal(readConfigFile(path), raw)
	assert.equal(fs.statSync(path).mode & 0o777, 0o600)
	fs.chmodSync(path, 0o644)
	const old = fs.statSync(path)
	writeConfigFile(path, '{}')
	assert.notEqual(fs.statSync(path).ino, old.ino)
	assert.equal(fs.statSync(path).mode & 0o777, 0o600)
	fs.unlinkSync(path)
	writeConfigFile(path, '{}')
	assert.equal(fs.statSync(path).mode & 0o777, 0o600)
})

test('post-start links and unsafe parents refuse config access without changing sentinel', t => {
	const root = fixture(t)
	const path = join(root, 'config.json')
	const sentinel = join(root, 'sentinel')
	fs.writeFileSync(sentinel, 'untouched', { mode: 0o644 })
	for (const link of [fs.symlinkSync, fs.linkSync]) {
		writeConfigFile(path, '{}')
		readConfigFile(path)
		fs.unlinkSync(path)
		link(sentinel, path)
		assert.throws(() => readConfigFile(path))
		assert.throws(() => writeConfigFile(path, 'overwrite'))
		assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched')
		assert.equal(fs.statSync(sentinel).mode & 0o777, 0o644)
		fs.unlinkSync(path)
	}
	const alias = join(root, 'alias')
	fs.symlinkSync(root, alias)
	assert.throws(() => writeConfigFile(join(alias, 'config.json'), '{}'))
	fs.chmodSync(root, 0o777)
	assert.throws(() => writeConfigFile(path, '{}'))
	fs.chmodSync(root, 0o700)
})

test('config rejects oversized, growing, substituted and malformed UTF8 bytes', t => {
	const root = fixture(t)
	const path = join(root, 'config.json')
	fs.writeFileSync(path, Buffer.alloc(MAX_CONFIG_FILE_BYTES + 1), { mode: 0o600 })
	assert.throws(() => readConfigFile(path), /too large/)
	assert.throws(() => writeConfigFile(path, 'é'.repeat(MAX_CONFIG_FILE_BYTES)), /too large/)
	fs.writeFileSync(path, Buffer.from([0xc3, 0x28]))
	assert.throws(() => readConfigFile(path))
	assert.throws(() => writeConfigFile(path, '\ud800'), /UTF-8/)
	for (const change of ['growth', 'replacement']) {
		fs.writeFileSync(path, '{}')
		const original = fs.readSync
		let changed = false
		const mock = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
			if (!changed) {
				changed = true
				if (change === 'growth') fs.appendFileSync(path, Buffer.alloc(MAX_CONFIG_FILE_BYTES))
				else {
					fs.unlinkSync(path)
					fs.writeFileSync(path, '[]', { mode: 0o600 })
				}
			}
			return Reflect.apply(original, fs, args)
		})
		syncBuiltinESMExports()
		try {
			assert.throws(() => readConfigFile(path), /too large|changed/)
		} finally {
			mock.mock.restore()
			syncBuiltinESMExports()
		}
	}
})

test('config accepts only verified Darwin /tmp and /var system aliases', { skip: process.platform !== 'darwin' }, t => {
	const root = fixture(t)
	const viaVar = root.startsWith('/private/var/') ? root.replace('/private/var/', '/var/') : undefined
	assert.ok(viaVar, 'macOS tmpdir fixture must live under /private/var')
	writeConfigFile(join(viaVar, 'config.json'), '{}')
	assert.equal(readConfigFile(join(viaVar, 'config.json')), '{}')
	const viaTmp = fs.mkdtempSync('/tmp/helm-secrets-')
	t.after(() => fs.rmSync(viaTmp, { recursive: true, force: true }))
	writeConfigFile(join(viaTmp, 'config.json'), '{}')
	assert.equal(readConfigFile(join(viaTmp, 'config.json')), '{}')
})

test('credential formats roundtrip and reject weakened parents, links and oversized bytes', async t => {
	const root = fixture(t)
	const path = join(root, 'token')
	assert.equal(await loadOrCreateLocalControlToken(path), await readLocalControlToken(path))
	for (const [read, value] of [
		[readLocalControlToken, token],
		[readPrivateHoldCapability, `cap_test.${token}`],
	] as const) {
		fs.writeFileSync(path, value, { mode: 0o600 })
		await read(path)
		fs.chmodSync(root, 0o755)
		await assert.rejects(() => read(path))
		fs.chmodSync(root, 0o700)
		fs.chmodSync(path, 0o644)
		await assert.rejects(() => read(path))
		fs.chmodSync(path, 0o600)
		const linked = join(root, 'linked')
		fs.linkSync(path, linked)
		await assert.rejects(() => read(path))
		fs.unlinkSync(linked)
		fs.symlinkSync(path, linked)
		await assert.rejects(() => read(linked))
		fs.unlinkSync(linked)
		fs.writeFileSync(path, 'x'.repeat(257))
		await assert.rejects(() => read(path))
		fs.writeFileSync(path, Buffer.from([0xff]))
		await assert.rejects(() => read(path))
	}
})

test('credential actual-byte cap rejects growth after fstat on the same descriptor', async t => {
	const root = fixture(t)
	const path = join(root, 'token')
	const original = fsp.open
	const mock = t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
		const handle = await original(...args)
		if (args[0] === path) {
			const read = handle.read.bind(handle)
			let changed = false
			t.mock.method(handle, 'read', (...readArgs: Parameters<typeof handle.read>) => {
				if (!changed) {
					changed = true
					fs.appendFileSync(path, 'x'.repeat(257))
				}
				return Reflect.apply(read, handle, readArgs)
			})
		}
		return handle
	})
	syncBuiltinESMExports()
	try {
		fs.writeFileSync(path, token, { mode: 0o600 })
		await assert.rejects(() => readLocalControlToken(path), /oversized/)
		fs.writeFileSync(path, `cap_test.${token}`)
		await assert.rejects(() => readPrivateHoldCapability(path), /oversized/)
	} finally {
		mock.mock.restore()
		syncBuiltinESMExports()
	}
})

test('FIFO credential/config reads reject in a bounded disposable subprocess without a writer', t => {
	const root = fixture(t)
	const path = join(root, 'fifo')
	const fifo = spawnSync('mkfifo', ['-m', '600', path], { timeout: 5000 })
	assert.equal(fifo.status, 0, fifo.stderr?.toString())
	for (const [module, name] of [
		['../src/auth/local-control.ts', 'readLocalControlToken'],
		['../src/knowledge/credentials.ts', 'readPrivateHoldCapability'],
		['../src/config-file.ts', 'readConfigFile'],
	]) {
		const source = `const m = await import(${JSON.stringify(new URL(module, import.meta.url).href)}); try { await m[${JSON.stringify(name)}](${JSON.stringify(path)}); process.exitCode = 2 } catch { process.exitCode = 0 }`
		const child = spawnSync(
			process.execPath,
			['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', source],
			{ timeout: 15000, encoding: 'utf8' },
		)
		assert.equal(child.error, undefined)
		assert.equal(child.status, 0, child.stderr)
	}
})

test('config write refuses destination substitution at publication and cleans only its temporary', t => {
	const root = fixture(t)
	const path = join(root, 'config.json')
	const sentinel = join(root, 'sentinel')
	fs.writeFileSync(sentinel, 'preserve', { mode: 0o600 })
	for (const replacement of ['hardlink', 'symlink', 'regular']) {
		writeConfigFile(path, '{}')
		const original = fs.fsyncSync
		const mock = t.mock.method(fs, 'fsyncSync', fd => {
			original(fd)
			fs.unlinkSync(path)
			if (replacement === 'hardlink') fs.linkSync(sentinel, path)
			else if (replacement === 'symlink') fs.symlinkSync(sentinel, path)
			else fs.writeFileSync(path, 'replacement', { mode: 0o600 })
		})
		syncBuiltinESMExports()
		try {
			assert.throws(() => writeConfigFile(path, 'secret'))
		} finally {
			mock.mock.restore()
			syncBuiltinESMExports()
		}
		assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve')
		assert.equal(fs.readFileSync(path, 'utf8'), replacement === 'regular' ? 'replacement' : 'preserve')
		assert.deepEqual(fs.readdirSync(root).sort(), ['config.json', 'sentinel'])
		fs.unlinkSync(path)
	}
})

test('config refuses foreign descriptor ownership before reading or chmod', t => {
	const root = fixture(t)
	const path = join(root, 'config.json')
	fs.writeFileSync(path, '{}', { mode: 0o644 })
	const original = fs.fstatSync
	const mock = t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
		const stat = Reflect.apply(original, fs, args)
		return Object.assign(stat, { uid: (process.getuid?.() ?? 0) + 1 })
	})
	syncBuiltinESMExports()
	try {
		assert.throws(() => readConfigFile(path), /owned/)
	} finally {
		mock.mock.restore()
		syncBuiltinESMExports()
	}
	assert.equal(fs.statSync(path).mode & 0o777, 0o644)
})
