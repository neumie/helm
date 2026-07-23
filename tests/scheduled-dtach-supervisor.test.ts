import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DtachSupervisor } from '../src/scheduled-runs/dtach-supervisor.js'
import { scheduledAgentEnvironment } from '../src/scheduled-runs/agent-host.js'
import { scheduledSessionId, scheduledSocketPath } from '../src/scheduled-runs/session-path.js'

const diagnostic = join(tmpdir(), 'helm-scheduled-supervisor-test.log')

test('supervisor launches exact dtach argv with a minimal environment and persists before readiness', async () => {
	const root = mkdtempSync('/tmp/hss-')
	const socket = scheduledSocketPath('work', scheduledSessionId('launch'), root)
	const spawned: { command?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {}
	const states: ('dead' | 'live')[] = ['dead', 'live']
	const persisted: number[] = []
	try {
		const environment = scheduledAgentEnvironment(
			{ daemonUrl: 'http://127.0.0.1:7474', runId: 'run-a', reportCapability: 'capability' },
			{ PATH: '/bin', ANTHROPIC_API_KEY: 'key', BUN_SECRET: 'never', NODE_OPTIONS: '--require evil' },
		)
		const supervisor = new DtachSupervisor({
			spawn: (command, args, options) => {
				spawned.command = command
				spawned.args = args
				spawned.env = options?.env
				return { pid: 422, once: () => undefined, unref: () => undefined }
			},
			probe: async () => states.shift() ?? 'live',
		})
		await supervisor.launch({
			profileId: 'work', socketPath: socket, dtachBinary: '/usr/bin/dtach', hostCommand: '/usr/bin/node', hostArgs: ['/host', '/descriptor'],
			cwd: root, env: environment, diagnosticPath: diagnostic,
			onSpawned: identity => void persisted.push(identity.pid),
		})
		assert.deepEqual(spawned.args, ['-n', socket, '/usr/bin/node', '/host', '/descriptor'])
		assert.equal(spawned.command, '/usr/bin/dtach')
		assert.equal(spawned.env?.BUN_SECRET, undefined)
		assert.equal(spawned.env?.NODE_OPTIONS, undefined)
		assert.equal(spawned.env?.HELM_SCHEDULED_REPORT_CAPABILITY, 'capability')
		assert.deepEqual(persisted, [422])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('supervisor TERM then KILLs a verified group, but never destroys unknown or mismatched identity', async () => {
	const signals: NodeJS.Signals[] = []
	const identity = { pid: 91, processGroupId: 91, startedAt: '2030-01-01T00:00:00.000Z', executable: 'dtach' }
	let probes: ('live' | 'dead')[] = ['live', 'live', 'dead']
	const supervisor = new DtachSupervisor({
		probe: async () => probes.shift() ?? 'dead', sleep: async () => new Promise(resolve => setTimeout(resolve, 2)), 
		signalGroup: (_group, signal) => signals.push(signal), verifyIdentity: async () => true,
	})
	assert.equal(await supervisor.teardown('/tmp/absent.sock', identity, diagnostic, 1), 'closed')
	assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
	const unknownSignals: NodeJS.Signals[] = []
	const quarantined = new DtachSupervisor({
		probe: async () => 'unknown', signalGroup: (_group, signal) => unknownSignals.push(signal),
	})
	assert.equal(await quarantined.teardown('/tmp/unknown.sock', identity, diagnostic), 'quarantined')
	assert.deepEqual(unknownSignals, [])
})
