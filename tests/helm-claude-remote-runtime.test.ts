// Runtime wiring of "Claude in Helm terminals": the socket root must be private,
// and the preload a terminal is given is always there (a missing one breaks
// every Bun program in that terminal: "preload not found").
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import runtimeModule from '../app/src/claude-remote/runtime.ts'

type RuntimeModule = typeof import('../app/src/claude-remote/runtime.ts')
const { assertPrivateDir, createClaudeRemote, HOOK_FILE, PRELOAD_FILE } = runtimeModule as RuntimeModule

function remoteIn(root: string, socketRoot = join(root, 's')) {
	const dist = join(root, 'dist')
	mkdirSync(dist, { recursive: true })
	writeFileSync(join(dist, PRELOAD_FILE), '// preload\n')
	writeFileSync(join(dist, HOOK_FILE), '// hook\n')
	return createClaudeRemote({
		socketRoot,
		distDir: dist,
		userDataDir: join(root, 'ud'),
		agentDockDir: join(root, 'ud', 'agent-dock'),
		electronPath: process.execPath,
		activeProfileId: () => 'work',
		writeAttached: () => false,
		dtachSocket: () => null,
		dtachBinary: () => null,
		log: () => {},
	})
}

test('a deleted preload is rewritten before a terminal is given it', async () => {
	const root = mkdtempSync('/tmp/hcr-rt-')
	try {
		const remote = remoteIn(root)
		assert.ok(remote.runtime)
		const preload = remote.runtime.preloadPath
		unlinkSync(preload)
		const env = remote.environment({ PATH: '/bin' }, { profileId: 'work', terminalId: 't1' })
		assert.equal(env.BUN_OPTIONS, `--preload=${preload}`)
		assert.ok(existsSync(preload), 'rewritten')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('socket root: a symlink or a non-private directory keeps the hub off and terminals hookless', async () => {
	const root = mkdtempSync('/tmp/hcr-rt-')
	try {
		const real = join(root, 'real')
		mkdirSync(real, { mode: 0o700 })
		const link = join(root, 'link')
		symlinkSync(real, link)
		assert.throws(() => assertPrivateDir(link), /not a directory/)
		chmodSync(real, 0o755)
		assert.throws(() => assertPrivateDir(real), /not private/)
		chmodSync(real, 0o700)
		assertPrivateDir(real)

		const remote = remoteIn(root, link)
		assert.equal(remote.runtime, null)
		assert.equal(await remote.start(), false)
		const env = remote.environment(
			{ PATH: '/bin', HELM_CLAUDE_REMOTE_TOKEN: 'stale' },
			{ profileId: 'work', terminalId: 't' },
		)
		assert.deepEqual(env, { PATH: '/bin' })
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
