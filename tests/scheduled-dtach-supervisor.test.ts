import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
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
const launcher: ProcessFingerprint = {
	pid: 422,
	processGroupId: 422,
	sessionId: 422,
	startedAt: 'Mon Jan  1 00:00:00 2030',
	executable: '/usr/bin/dtach',
}
const master: ProcessFingerprint = {
	pid: 523,
	processGroupId: 523,
	sessionId: 523,
	startedAt: 'Mon Jan  1 00:00:01 2030',
	executable: '/usr/bin/dtach',
}
const host: ProcessFingerprint = {
	pid: 524,
	processGroupId: 523,
	sessionId: 523,
	startedAt: 'Mon Jan  1 00:00:02 2030',
	executable: '/bin/sh',
}
const descendant: ProcessFingerprint = {
	pid: 525,
	processGroupId: 523,
	sessionId: 523,
	startedAt: 'Mon Jan  1 00:00:03 2030',
	executable: '/bin/sleep',
}

function readyDeps(getSocket: () => string) {
	return {
		inspectProcess: async (pid: number) => (pid === launcher.pid ? launcher : pid === master.pid ? master : null),
		inspectProcessCommand: async (pid: number) =>
			pid === master.pid ? `/usr/bin/dtach -n ${getSocket()} /host` : null,
		inspectGroup: async (group: number) =>
			group === master.processGroupId ? [master, host] : group === launcher.processGroupId ? [launcher] : [],
		findSocketHolders: async () => [master],
		findSocketDescriptorHolders: async () => [master],
	}
}

test('attestLiveSession verifies the exact persisted dtach master without side effects', async () => {
	const root = mkdtempSync('/tmp/hsa-')
	const sessionId = scheduledSessionId('attest')
	const socket = scheduledSocketPath('work', sessionId, root)
	let sideEffects = 0
	try {
		const supervisor = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => 'live',
			spawn: () => {
				sideEffects++
				return { pid: launcher.pid, once: () => undefined }
			},
			signalGroup: () => sideEffects++,
			unlink: async () => void sideEffects++,
		})
		const result = await supervisor.attestLiveSession('work', sessionId, { ...master, socketHolder: master }, root)
		assert.deepEqual(result, {
			state: 'verified',
			socketPath: socket,
			identity: { ...master, socketHolder: master },
		})
		assert.equal(sideEffects, 0)

		const mismatch = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => 'live',
			inspectProcessCommand: async () => `/usr/bin/dtach -n ${socket}-other /host`,
		})
		assert.deepEqual(await mismatch.attestLiveSession('work', sessionId, { ...master, socketHolder: master }, root), {
			state: 'mismatch',
		})

		const inherited = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => 'live',
			findSocketDescriptorHolders: async () => [master, host],
		})
		assert.equal(
			(await inherited.attestLiveSession('work', sessionId, { ...master, socketHolder: master }, root)).state,
			'verified',
		)

		const replacement = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => 'live',
			findSocketDescriptorHolders: async () => [{ ...master, pid: master.pid + 100 }],
		})
		assert.deepEqual(
			await replacement.attestLiveSession('work', sessionId, { ...master, socketHolder: master }, root),
			{ state: 'mismatch' },
		)

		let descriptorChecks = 0
		const lateReplacement = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => 'live',
			findSocketDescriptorHolders: async () => {
				descriptorChecks++
				return descriptorChecks === 1 ? [master] : [{ ...master, pid: master.pid + 100 }]
			},
		})
		assert.deepEqual(
			await lateReplacement.attestLiveSession('work', sessionId, { ...master, socketHolder: master }, root),
			{ state: 'mismatch' },
		)

		const executableSwap = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => 'live',
			inspectProcess: async () => ({ ...master, executable: '/tmp/attacker/dtach' }),
		})
		assert.deepEqual(
			await executableSwap.attestLiveSession('work', sessionId, { ...master, socketHolder: master }, root),
			{ state: 'mismatch' },
		)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('supervisor persists the daemonized master rather than its zero-exit launcher', async () => {
	const root = mkdtempSync('/tmp/hss-')
	const sessionId = scheduledSessionId('launch')
	const socket = scheduledSocketPath('work', sessionId, root)
	const spawned: { args?: string[] } = {}
	const states: ('dead' | 'live')[] = ['dead', 'live']
	const persisted: number[] = []
	const removed: string[] = []
	try {
		const supervisor = new DtachSupervisor({
			...readyDeps(() => spawned.args?.[1] ?? socket),
			probe: async () => states.shift() ?? 'live',
			unlink: async path => void removed.push(path),
			spawn: (_command, args) => {
				spawned.args = args
				return { pid: launcher.pid, once: () => undefined, unref: () => undefined }
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
		assert.deepEqual(persisted, [master.pid, master.pid])
		assert.equal(identity.pid, master.pid)
		assert.notEqual(identity.pid, launcher.pid)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('teardown accepts later same-owned-group descendants and kills TERM-ignoring groups', async () => {
	const signals: NodeJS.Signals[] = []
	const identity = { ...master, socketHolder: master, groupMembers: [master, host] }
	let calls = 0
	const supervisor = new DtachSupervisor({
		inspectOwnership: async () => (++calls < 4 ? 'verified' : 'dead'),
		signalGroup: (_group, signal) => void signals.push(signal),
		sleep: async () => {},
		unlink: async () => {},
		inspectGroup: async () => [master, host, descendant],
	})
	assert.equal(
		await supervisor.teardown('work', scheduledSessionId('term-ignore'), identity, diagnostic, 0, '/tmp'),
		'closed',
	)
	assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('PID reuse, unknown state, and mismatched ownership quarantine without signal or unlink', async () => {
	const signals: NodeJS.Signals[] = []
	const identity = { ...master, socketHolder: master }
	for (const state of ['mismatch', 'unknown'] as const) {
		const supervisor = new DtachSupervisor({
			inspectOwnership: async () => state,
			signalGroup: (_g, sig) => void signals.push(sig),
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

test('onSpawned failure cleans up the discovered master instead of returning an orphan', async () => {
	const root = mkdtempSync('/tmp/hsc-')
	const sessionId = scheduledSessionId('callback-failure')
	const socket = scheduledSocketPath('work', sessionId, root)
	const signals: NodeJS.Signals[] = []
	let ownershipCalls = 0
	try {
		let probeCalls = 0
		const supervisor = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => (++probeCalls === 1 ? 'dead' : 'live'),
			spawn: () => ({ pid: launcher.pid, once: () => undefined, unref: () => {} }),
			inspectOwnership: async () => (++ownershipCalls === 1 ? 'verified' : 'dead'),
			signalGroup: (_group, signal) => void signals.push(signal),
			sleep: async () => {},
			unlink: async () => {},
		})
		await assert.rejects(
			supervisor.launch({
				profileId: 'work',
				sessionId,
				socketRoot: root,
				dtachBinary: 'dtach',
				hostCommand: 'node',
				hostArgs: [],
				cwd: root,
				env: {},
				diagnosticPath: diagnostic,
				onSpawned: () => {
					throw new Error('persistence failed')
				},
			}),
			/persistence failed/,
		)
		assert.deepEqual(signals, ['SIGTERM'])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('readiness timeout cleans up a still-owned bootstrap launcher', async () => {
	const root = mkdtempSync('/tmp/hst-')
	const sessionId = scheduledSessionId('timeout')
	const signals: NodeJS.Signals[] = []
	try {
		const supervisor = new DtachSupervisor({
			inspectProcess: async () => launcher,
			probe: async () => 'dead',
			spawn: () => ({ pid: launcher.pid, once: () => undefined, unref: () => {} }),
			signalGroup: (_group, signal) => void signals.push(signal),
			sleep: async () => {},
		})
		await assert.rejects(
			supervisor.launch({
				profileId: 'work',
				sessionId,
				socketRoot: root,
				dtachBinary: 'dtach',
				hostCommand: 'node',
				hostArgs: [],
				cwd: root,
				env: {},
				diagnosticPath: diagnostic,
				onSpawned: () => {},
				readinessTimeoutMs: 0,
			}),
			/did not become ready/,
		)
		assert.deepEqual(signals, ['SIGTERM'])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('exited launcher with a dead probe rediscovers and tears down its daemon master', async () => {
	const root = mkdtempSync('/tmp/hsf-')
	const sessionId = scheduledSessionId('exited-launcher')
	const socket = scheduledSocketPath('work', sessionId, root)
	const signals: NodeJS.Signals[] = []
	let launcherInspections = 0
	try {
		const supervisor = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => 'dead',
			inspectProcess: async pid => {
				if (pid === launcher.pid) return ++launcherInspections === 1 ? launcher : null
				return pid === master.pid ? master : null
			},
			inspectOwnership: async () => (signals.length ? 'dead' : 'verified'),
			spawn: () => ({ pid: launcher.pid, once: () => undefined, unref: () => {} }),
			signalGroup: (_group, signal) => void signals.push(signal),
			sleep: async () => {},
			unlink: async () => {},
		})
		await assert.rejects(
			supervisor.launch({
				profileId: 'work',
				sessionId,
				socketRoot: root,
				dtachBinary: 'dtach',
				hostCommand: 'node',
				hostArgs: [],
				cwd: root,
				env: {},
				diagnosticPath: diagnostic,
				onSpawned: () => {},
				readinessTimeoutMs: 0,
			}),
			/did not become ready/,
		)
		assert.equal(launcherInspections, 1)
		assert.deepEqual(signals, ['SIGTERM'])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('unknown cleanup probe quarantines a rediscovered master through the typed callback', async () => {
	const root = mkdtempSync('/tmp/hsq-')
	const sessionId = scheduledSessionId('unknown-cleanup')
	const socket = scheduledSocketPath('work', sessionId, root)
	const signals: NodeJS.Signals[] = []
	const quarantines: unknown[] = []
	try {
		let probes = 0
		const supervisor = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => (++probes === 1 ? 'dead' : 'unknown'),
			spawn: () => ({ pid: launcher.pid, once: () => undefined, unref: () => {} }),
			signalGroup: (_group, signal) => void signals.push(signal),
			sleep: async () => {},
		})
		await assert.rejects(
			supervisor.launch({
				profileId: 'work',
				sessionId,
				socketRoot: root,
				dtachBinary: 'dtach',
				hostCommand: 'node',
				hostArgs: [],
				cwd: root,
				env: {},
				diagnosticPath: diagnostic,
				onSpawned: () => {},
				onQuarantined: value => void quarantines.push(value),
				readinessTimeoutMs: 0,
			}),
			/did not become ready/,
		)
		assert.deepEqual(signals, [])
		assert.deepEqual(quarantines, [
			{ state: 'quarantined', reason: 'master_teardown_unverified', identity: { ...master, socketHolder: master } },
		])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('mismatched rediscovered master is quarantined without signaling its process group', async () => {
	const root = mkdtempSync('/tmp/hsm-')
	const sessionId = scheduledSessionId('mismatch-cleanup')
	const socket = scheduledSocketPath('work', sessionId, root)
	const signals: NodeJS.Signals[] = []
	const quarantines: unknown[] = []
	try {
		const supervisor = new DtachSupervisor({
			...readyDeps(() => socket),
			probe: async () => 'dead',
			inspectOwnership: async () => 'mismatch',
			spawn: () => ({ pid: launcher.pid, once: () => undefined, unref: () => {} }),
			signalGroup: (_group, signal) => void signals.push(signal),
			sleep: async () => {},
		})
		await assert.rejects(
			supervisor.launch({
				profileId: 'work',
				sessionId,
				socketRoot: root,
				dtachBinary: 'dtach',
				hostCommand: 'node',
				hostArgs: [],
				cwd: root,
				env: {},
				diagnosticPath: diagnostic,
				onSpawned: () => {},
				onQuarantined: value => void quarantines.push(value),
				readinessTimeoutMs: 0,
			}),
			/did not become ready/,
		)
		assert.deepEqual(signals, [])
		assert.deepEqual(quarantines, [
			{ state: 'quarantined', reason: 'master_teardown_unverified', identity: { ...master, socketHolder: master } },
		])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('launch races socket readiness with asynchronous spawn error', async () => {
	const root = mkdtempSync('/tmp/hse-')
	try {
		let errorListener: ((error: unknown) => void) | undefined
		const supervisor = new DtachSupervisor({
			inspectProcess: async () => launcher,
			probe: async () => 'dead',
			spawn: () => ({
				pid: launcher.pid,
				unref: () => {},
				once: (event, listener) => {
					if (event === 'error') errorListener = listener
				},
			}),
			signalGroup: () => {},
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
		await new Promise(resolve => setTimeout(resolve, 10))
		assert.ok(errorListener)
		errorListener(new Error('spawn failed'))
		await assert.rejects(launching, /spawn failed/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test(
	'real dtach discovers its daemon master and closes a late TERM-ignoring descendant',
	{ timeout: 15_000 },
	async t => {
		if (
			!existsSync('/opt/homebrew/bin/dtach') &&
			!existsSync('/usr/local/bin/dtach') &&
			!existsSync('/usr/bin/dtach')
		) {
			t.skip('dtach is unavailable')
			return
		}
		const root = mkdtempSync('/tmp/hsd-')
		const dtachBinary = existsSync('/opt/homebrew/bin/dtach')
			? '/opt/homebrew/bin/dtach'
			: existsSync('/usr/local/bin/dtach')
				? '/usr/local/bin/dtach'
				: '/usr/bin/dtach'
		const sessionId = scheduledSessionId(`real-${Date.now()}`)
		let launcherPid: number | undefined
		let identity: ProcessFingerprint | undefined
		try {
			const supervisor = new DtachSupervisor({
				spawn: (command, args, options) => {
					const child = nodeSpawn(command, args, options)
					launcherPid = child.pid
					return child
				},
			})
			const ready = await supervisor.launch({
				profileId: 'work',
				sessionId,
				socketRoot: root,
				dtachBinary,
				hostCommand: '/bin/sh',
				hostArgs: ['-c', "sleep 0.2; (trap '' TERM; sleep 30) & wait"],
				cwd: root,
				env: process.env,
				diagnosticPath: diagnostic,
				onSpawned: () => {},
				readinessTimeoutMs: 5_000,
			})
			identity = ready
			assert.ok(launcherPid)
			assert.notEqual(ready.pid, launcherPid)
			assert.equal(ready.socketHolder?.pid, ready.pid)
			assert.equal((await supervisor.attestLiveSession('work', sessionId, ready, root)).state, 'verified')
			await new Promise(resolve => setTimeout(resolve, 350))
			assert.equal(await supervisor.teardown('work', sessionId, ready, diagnostic, 100, root), 'closed')
			identity = undefined
		} finally {
			if (identity) {
				await new DtachSupervisor().teardown('work', sessionId, identity, diagnostic, 100, root).catch(() => {})
			}
			rmSync(root, { recursive: true, force: true })
		}
	},
)

test('derived launch namespace cannot be redirected by a profile symlink', async () => {
	const root = mkdtempSync('/tmp/hsl-')
	const outside = mkdtempSync('/tmp/hso-')
	try {
		symlinkSync(outside, join(root, 'work'))
		const supervisor = new DtachSupervisor({})
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
