// Runtime wiring of "Claude in Helm terminals": the socket root must be private,
// and the preload a terminal is given is always there (a missing one breaks
// every Bun program in that terminal: "preload not found").
import assert from 'node:assert/strict'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import runtimeModule from '../app/src/claude-remote/runtime.ts'

type RuntimeModule = typeof import('../app/src/claude-remote/runtime.ts')
type ClaudeRemoteOptions = import('../app/src/claude-remote/runtime.ts').ClaudeRemoteOptions
const { assertPrivateDir, createClaudeRemote, dtachPush, HOOK_FILE, PRELOAD_FILE } = runtimeModule as RuntimeModule

function remoteIn(
	root: string,
	socketRoot = join(root, 's'),
	overrides: Partial<Pick<ClaudeRemoteOptions, 'writeAttached' | 'dtachSocket' | 'dtachBinary'>> = {},
) {
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
		...overrides,
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

// ---------------------------------------------------------------------------
// Reply delivery: the one place the dock types into a terminal
// ---------------------------------------------------------------------------

const REF = { profileId: 'work', terminalId: 't1' }
const PID = 4242
const CHUNKS = ['\u0015\u001b[200~hi\u001b[201~', '\r']

/** An idle primary with its lifeline open: the hub may type a reply (core.checkPrompt). */
function replyReady(remote: ReturnType<typeof createClaudeRemote>) {
	remote.hub.core.event(REF, PID, Date.now(), { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' })
	remote.hub.core.attached(REF, PID)
	return () => remote.hub.forProfile('helm:work').postClaudePrompt?.('t1', 'hi') as Promise<unknown>
}

/** `dtach` stand-ins, written once: `-p <socket>` appends stdin to `<socket>.pushed`, or fails with a stderr line. */
const STUBS = mkdtempSync('/tmp/hcr-dtach-')
const PUSH_DTACH = join(STUBS, 'dtach-push')
const FAILING_DTACH = join(STUBS, 'dtach-fail')
writeFileSync(PUSH_DTACH, '#!/bin/sh\n[ "$1" = -p ] || exit 2\ncat >> "$2.pushed"\n', { mode: 0o700 })
writeFileSync(FAILING_DTACH, "#!/bin/sh\necho 'dtach: no such session' >&2\nexit 1\n", { mode: 0o700 })
test.after(() => rmSync(STUBS, { recursive: true, force: true }))

test('deliver: an attached tab gets both chunks on its pty; dtach is never run', async () => {
	const root = mkdtempSync('/tmp/hcr-rt-')
	try {
		const written: string[] = []
		const remote = remoteIn(root, undefined, {
			writeAttached: (_ref, data) => {
				written.push(data)
				return true
			},
			dtachSocket: () => join(root, 'sock'),
			dtachBinary: () => PUSH_DTACH,
		})
		assert.deepEqual(await replyReady(remote)(), { delivery: 'pty', via: 'pty' })
		assert.deepEqual(written, CHUNKS)
		assert.equal(existsSync(join(root, 'sock.pushed')), false)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('deliver: a parked terminal gets both chunks through `dtach -p`', async () => {
	const root = mkdtempSync('/tmp/hcr-rt-')
	try {
		const remote = remoteIn(root, undefined, {
			dtachSocket: () => join(root, 'sock'),
			dtachBinary: () => PUSH_DTACH,
		})
		assert.deepEqual(await replyReady(remote)(), { delivery: 'pty', via: 'push' })
		assert.equal(readFileSync(join(root, 'sock.pushed'), 'utf8'), CHUNKS.join(''))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('deliver: a tab detaching between paste and Enter refuses; nothing is pushed instead', async () => {
	const root = mkdtempSync('/tmp/hcr-rt-')
	try {
		const attached = [true, false]
		const remote = remoteIn(root, undefined, {
			writeAttached: () => attached.shift() ?? false,
			dtachSocket: () => join(root, 'sock'),
			dtachBinary: () => PUSH_DTACH,
		})
		await assert.rejects(replyReady(remote)(), { message: 'The Helm tab detached while the reply was typed.' })
		assert.equal(existsSync(join(root, 'sock.pushed')), false)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('deliver: no dtach socket (unreachable or refused by main) or no dtach binary is a 409; nothing is pushed', async () => {
	const root = mkdtempSync('/tmp/hcr-rt-')
	try {
		const noSocket = remoteIn(root, undefined, { dtachSocket: () => null, dtachBinary: () => PUSH_DTACH })
		await assert.rejects(replyReady(noSocket)(), { status: 409, message: 'This terminal is not reachable.' })
		const noBinary = remoteIn(root, undefined, { dtachSocket: () => join(root, 'sock'), dtachBinary: () => null })
		await assert.rejects(replyReady(noBinary)(), { status: 409, message: 'This terminal is not reachable.' })
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('dtachPush: a failing dtach rejects with its stderr', async () => {
	await assert.rejects(dtachPush(FAILING_DTACH, join(STUBS, 'sock'), 'x'), /dtach -p exited 1: dtach: no such session/)
})
