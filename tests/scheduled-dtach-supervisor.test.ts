import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
	DtachSupervisor,
	type ProcessFingerprint,
	identityMatchesCandidate,
} from '../src/scheduled-runs/dtach-supervisor.js'
import { scheduledSessionId, scheduledSocketPath } from '../src/scheduled-runs/session-path.js'

const diagnostic = join(tmpdir(), 'helm-scheduled-supervisor-test.log')
const leader: ProcessFingerprint = {
	pid: 422,
	processGroupId: 422,
	startedAt: 'Mon Jan  1 00:00:00 2030',
	executable: '/usr/bin/dtach',
}
const host: ProcessFingerprint = {
	pid: 423,
	processGroupId: 422,
	startedAt: 'Mon Jan  1 00:00:01 2030',
	executable: '/usr/bin/node',
}

const readyDeps = () => ({
	inspectProcess: async () => leader,
	inspectGroup: async () => [leader, host],
	findSocketHolders: async () => [leader],
})

test('supervisor derives its path, removes only a dead expected stale socket, and persists ready identity', async () => {
	const root = mkdtempSync('/tmp/hss-')
	const sessionId = scheduledSessionId('launch')
	const socket = scheduledSocketPath('work', sessionId, root)
	const spawned: { args?: string[] } = {}
	const states: ('dead' | 'live')[] = ['dead', 'live']
	const persisted: number[] = []
	const removed: string[] = []
	try {
		const supervisor = new DtachSupervisor({
			...readyDeps(),
			probe: async () => states.shift() ?? 'live',
			unlink: async path => {
				removed.push(path)
			},
			spawn: (_command, args) => {
				spawned.args = args
				return { pid: 422, once: () => undefined, unref: () => undefined }
			},
		})
		const identity = await supervisor.launch({
			profileId: 'work',
			sessionId,
			socketRoot: root,
			dtachBinary: '/usr/bin/dtach',
			hostCommand: '/usr/bin/node',
			hostArgs: ['/host'],
			cwd: root,
			env: {},
			diagnosticPath: diagnostic,
			onSpawned: item => void persisted.push(item.pid),
			onReady: item => void persisted.push(item.socketHolder?.pid ?? 0),
		})
		assert.deepEqual(spawned.args, ['-n', socket, '/usr/bin/node', '/host'])
		assert.deepEqual(removed, [socket])
		assert.deepEqual(persisted, [422, 422])
		assert.equal(identity.groupMembers?.length, 2)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('teardown kills TERM-ignoring verified descendants even after socket disappearance', async () => {
	const signals: NodeJS.Signals[] = []
	const identity = { ...leader, socketHolder: leader, groupMembers: [leader, host] }
	let calls = 0
	const supervisor = new DtachSupervisor({
		inspectOwnership: async () => (++calls < 4 ? 'verified' : 'dead'),
		signalGroup: (_group, signal) => signals.push(signal),
		sleep: async () => {},
		unlink: async () => {},
	})
	assert.equal(
		await supervisor.teardown('work', scheduledSessionId('term-ignore'), identity, diagnostic, 0, '/tmp'),
		'closed',
	)
	assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('PID reuse, unknown state, and mismatched ownership quarantine without signal or unlink', async () => {
	const signals: NodeJS.Signals[] = []
	const identity = { ...leader, socketHolder: leader, groupMembers: [leader] }
	for (const state of ['mismatch', 'unknown'] as const) {
		const supervisor = new DtachSupervisor({
			inspectOwnership: async () => state,
			signalGroup: (_g, sig) => signals.push(sig),
			unlink: async () => assert.fail('must not unlink'),
		})
		assert.equal(
			await supervisor.teardown('work', scheduledSessionId(`reuse-${state}`), identity, diagnostic, 1, '/tmp'),
			'quarantined',
		)
	}
	assert.deepEqual(signals, [])
	assert.equal(identityMatchesCandidate(identity, { ...identity, startedAt: 'different' }), false)
})

test('launch races socket readiness with asynchronous spawn error', async () => {
	const root = mkdtempSync('/tmp/hse-')
	try {
		let errorListener: ((error: unknown) => void) | undefined
		let probes = 0
		const supervisor = new DtachSupervisor({
			...readyDeps(),
			probe: async () => (++probes === 1 ? 'dead' : new Promise(() => {})),
			spawn: () => ({
				pid: 422,
				unref: () => {},
				once: (event, listener) => {
					if (event === 'error') errorListener = listener
					if (event === 'exit') return undefined
				},
			}),
		})
		const launching = supervisor.launch({
			profileId: 'work',
			sessionId: scheduledSessionId('spawn-error'),
			socketRoot: root,
			dtachBinary: 'dtach',
			hostCommand: 'node',
			hostArgs: [],
			cwd: root,
			env: {},
			diagnosticPath: diagnostic,
			onSpawned: () => {},
		})
		await new Promise(resolve => setImmediate(resolve))
		const rejected = assert.rejects(launching, /spawn failed/)
		errorListener?.(new Error('spawn failed'))
		await rejected
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('derived launch namespace cannot be redirected by a profile symlink', async () => {
	const root = mkdtempSync('/tmp/hsl-')
	const outside = mkdtempSync('/tmp/hso-')
	try {
		symlinkSync(outside, join(root, 'work'))
		const supervisor = new DtachSupervisor({ ...readyDeps() })
		await assert.rejects(
			supervisor.launch({
				profileId: 'work',
				sessionId: scheduledSessionId('escape'),
				socketRoot: root,
				dtachBinary: 'dtach',
				hostCommand: 'node',
				hostArgs: [],
				cwd: root,
				env: {},
				diagnosticPath: diagnostic,
				onSpawned: () => {},
			}),
			/real directory|owner-private|symlink/,
		)
	} finally {
		rmSync(root, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	}
})
