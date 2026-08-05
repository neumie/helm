// Reboot-safe terminal workspace restoration (app/src/sessions.ts): a full
// machine restart kills dtach masters, but ordinary tabs remain durable
// logical workspaces. Startup recreates only their missing shells through the
// existing dtach -A path while preserving identity, order, groups, parked
// state, names, and snapshots. Unknown probes and run-owned scheduled sessions
// remain fail-closed; explicit close still deletes the workspace.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import * as sessionsModule from '../app/src/sessions.ts'

type SessionsModule = typeof import('../app/src/sessions.ts')
type PlannedSession = {
	sessionId: string
	title: string | null
	customName: string | null
	parked: boolean
	groupId: string | null
	agentRunning: boolean
	agentAttention: boolean
	placementEligible: boolean
	createdAt: string
	order?: number
}
type RestorePlan = { sessions: PlannedSession[]; keepSnapshotIds: ReadonlySet<string> }
const sessions = ((sessionsModule as { default?: SessionsModule }).default ?? sessionsModule) as SessionsModule
const { SessionRegistry } = sessions
const { planSessionRestore } = sessions as SessionsModule & {
	planSessionRestore(
		registry: InstanceType<typeof SessionRegistry>,
		scan: { live: Array<{ sessionId: string; createdAt: string }>; unknownIds: string[] },
	): RestorePlan
}

function registryFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-restart-')), 'sessions.json')
}

const scheduledOwnership = {
	profileId: 'work',
	runId: 'scheduled-run',
	revision: 1,
	adoptionId: '11111111-1111-4111-8111-111111111111',
	adopter: '22222222-2222-4222-8222-222222222222',
}

test('startup recreates missing ordinary workspaces without weakening unknown or run-owned fencing', () => {
	const registry = new SessionRegistry(registryFile())
	for (const id of ['live1111', 'missing1', 'parked1', 'unknown1']) registry.add(id)
	registry.setTitle('missing1', 'perf')
	registry.setCustomName('missing1', 'performance')
	registry.setParked('parked1', true)
	registry.setActivity('live1111', { agentRunning: true, agentAttention: true })
	registry.setActivity('missing1', { agentRunning: true, agentAttention: true })
	const group = registry.createGroup('Temp', ['missing1', 'parked1'])
	assert.ok(group)
	registry.setOrder(['missing1', 'live1111', 'parked1', 'unknown1'])
	assert.equal(registry.registerRunOwned('scheduled1', scheduledOwnership), true)

	const plan = planSessionRestore(registry, {
		live: [
			{ sessionId: 'live1111', createdAt: '2026-08-01T00:00:00.000Z' },
			// A live socket whose registry row was lost is re-adopted.
			{ sessionId: 'adopted1', createdAt: '2026-08-02T00:00:00.000Z' },
		],
		unknownIds: ['unknown1'],
	})

	assert.deepEqual(
		plan.sessions.map(session => session.sessionId),
		['missing1', 'live1111', 'parked1', 'adopted1'],
	)
	const missing = plan.sessions.find(session => session.sessionId === 'missing1')
	assert.deepEqual(missing, {
		sessionId: 'missing1',
		title: 'perf',
		customName: 'performance',
		parked: false,
		groupId: group.id,
		agentRunning: false,
		agentAttention: false,
		placementEligible: true,
		createdAt: registry.get('missing1')?.createdAt,
		order: 0,
	})
	assert.equal(plan.sessions.find(session => session.sessionId === 'live1111')?.agentRunning, true)
	assert.equal(plan.sessions.find(session => session.sessionId === 'parked1')?.parked, true)
	assert.equal(
		plan.sessions.some(session => session.sessionId === 'unknown1'),
		false,
	)
	assert.equal(
		plan.sessions.some(session => session.sessionId === 'scheduled1'),
		false,
	)
	assert.ok(registry.get('adopted1'), 'live sockets remain recoverable after registry-file loss')
	assert.deepEqual([...plan.keepSnapshotIds].sort(), [
		'adopted1',
		'live1111',
		'missing1',
		'parked1',
		'scheduled1',
		'unknown1',
	])
	assert.deepEqual(
		registry.getGroups().map(candidate => candidate.id),
		[group.id],
	)
})

test('explicit close removes a missing workspace and its final group before restart planning', () => {
	const registry = new SessionRegistry(registryFile())
	registry.add('closed11')
	const group = registry.createGroup('Temporary', ['closed11'])
	assert.ok(group)
	registry.remove('closed11')

	const plan = planSessionRestore(registry, { live: [], unknownIds: [] })
	assert.deepEqual(plan.sessions, [])
	assert.deepEqual([...plan.keepSnapshotIds], [])
	assert.deepEqual(registry.getGroups(), [])
})
