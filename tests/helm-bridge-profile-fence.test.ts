import assert from 'node:assert/strict'
import test from 'node:test'
import helmBridgeModule from '../app/src/helm-bridge.ts'
type HelmBridgeModule = typeof import('../app/src/helm-bridge.ts')
const { HelmBridge, scheduledProfileTokenMatches } = helmBridgeModule as HelmBridgeModule

test('scheduled renderer requests are bound to the captured profile token', () => {
	assert.equal(scheduledProfileTokenMatches('work', 'work:3'), true)
	assert.equal(scheduledProfileTokenMatches('profile-aaaaaaaaaaaa', 'profile-aaaaaaaaaaaa:9'), true)
	assert.equal(scheduledProfileTokenMatches('work', 'profile-aaaaaaaaaaaa:9'), false)
	assert.equal(scheduledProfileTokenMatches('work', 'workaround:3'), false)
})
import type { DaemonStatus, DashboardItem, HelmResult, HelmSnapshot, ProfilesDocument } from '../app/src/shared-helm.ts'

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}

const target = 'profile-aaaaaaaaaaaa'
function status(profileId = target, generation = 2): DaemonStatus {
	return {
		protocolVersion: 33,
		buildId: 'test',
		uptime: 1,
		queue: { paused: false, pending: 0, active: 0, maxConcurrency: 1, activeTasks: [] },
		projects: [],
		pollInterval: 60,
		profile: { id: profileId, name: profileId, createdAt: '', enabledProjects: [], archivedAt: null },
		profileGeneration: generation,
	}
}
function profiles(profileId = target, generation = 2): ProfilesDocument {
	return { version: 1, generation, activeProfileId: profileId, profiles: [], configuredProjects: [] }
}

function bridgeFixture() {
	const requests = new Map<string, Array<Deferred<HelmResult<unknown>>>>()
	const publications: Array<{ profileId: string | undefined; itemIds: string[] | null }> = []
	const timers: Array<() => void> = []
	const request = <T>(method: 'GET' | 'POST' | 'PUT', path: string): Promise<HelmResult<T>> => {
		const queue = requests.get(`${method} ${path}`)
		if (!queue?.length) throw new Error(`Unexpected request ${method} ${path}`)
		const next = queue.shift()
		if (!next) throw new Error(`Request queue emptied unexpectedly for ${method} ${path}`)
		return next.promise as Promise<HelmResult<T>>
	}
	const push = <T>(method: 'GET' | 'POST' | 'PUT', path: string, value: HelmResult<T>): void => {
		const entry = deferred<HelmResult<unknown>>()
		entry.resolve(value)
		const key = `${method} ${path}`
		requests.set(key, [...(requests.get(key) ?? []), entry])
	}
	const hold = <T>(method: 'GET' | 'POST' | 'PUT', path: string): Deferred<HelmResult<T>> => {
		const entry = deferred<HelmResult<T>>()
		const key = `${method} ${path}`
		requests.set(key, [...(requests.get(key) ?? []), entry as Deferred<HelmResult<unknown>>])
		return entry
	}
	const bridge = new HelmBridge('http://daemon.test', () => true, {
		request,
		windows: () => [
			{
				webContents: {
					isDestroyed: () => false,
					send: (_channel: string, snapshot: HelmSnapshot) =>
						publications.push({
							profileId: snapshot.status?.profile?.id,
							itemIds:
								snapshot.items
									?.map((item: DashboardItem) => item.profileId)
									.filter((id: string | undefined): id is string => id !== undefined) ?? null,
						}),
				},
			},
		],
		setTimer: (callback: () => void) => {
			timers.push(callback)
			return timers.length as unknown as ReturnType<typeof setTimeout>
		},
		clearTimer: () => {},
	})
	return { bridge, push, hold, publications, timers }
}

async function spin(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
}
function coherent(f: ReturnType<typeof bridgeFixture>, profileId = target): void {
	f.push('GET', '/status', { data: status(profileId) })
	f.push('GET', '/items', { data: [] as DashboardItem[] })
	f.push('GET', '/profiles', { data: profiles(profileId) })
	f.push('POST', '/daemon/restart', { error: 'not managed' })
	f.push('GET', '/config', { data: null })
}

test('fence readiness follows coherent target snapshot publication, including delayed config', async () => {
	const f = bridgeFixture()
	const config = f.hold('GET', '/config')
	f.push('GET', '/status', { data: status() })
	f.push('GET', '/items', { data: [] })
	f.push('GET', '/profiles', { data: profiles() })
	f.push('POST', '/daemon/restart', { error: 'not managed' })
	const fence = f.bridge.beginProfileSwitch(target)
	let ready = false
	void fence.ready.then(() => {
		ready = true
	})
	await spin()
	assert.equal(ready, false)
	assert.equal(f.publications.at(-1)?.profileId, undefined)
	config.resolve({ data: null })
	await fence.ready
	assert.deepEqual(f.publications.at(-1), { profileId: target, itemIds: [] })
	assert.equal(f.bridge.getSnapshot().status?.profile?.id, target)
})

test('B to C invalidation suppresses a delayed B profile/config publication and readiness', async () => {
	const f = bridgeFixture()
	const delayedProfiles = f.hold<ProfilesDocument>('GET', '/profiles')
	f.push('GET', '/status', { data: status(target) })
	f.push('GET', '/items', { data: [] })
	const b = f.bridge.beginProfileSwitch(target)
	await spin()
	b.invalidateIfCurrent()
	delayedProfiles.resolve({ data: profiles(target) })
	await spin()
	assert.equal(
		f.publications.some(entry => entry.profileId === target),
		false,
	)
	let settled = false
	void b.ready.then(() => {
		settled = true
	})
	await spin()
	assert.equal(settled, false)

	coherent(f, 'profile-cccccccccccc')
	const c = f.bridge.beginProfileSwitch('profile-cccccccccccc')
	await c.ready
	assert.deepEqual(f.publications.at(-1), { profileId: 'profile-cccccccccccc', itemIds: [] })
})

test('observed-profile adoption replaces readiness and never publishes the old target', async () => {
	const f = bridgeFixture()
	const delayedProfiles = f.hold<ProfilesDocument>('GET', '/profiles')
	f.push('GET', '/status', { data: status(target) })
	f.push('GET', '/items', { data: [] })
	const fence = f.bridge.beginProfileSwitch(target)
	await spin()
	fence.adoptObservedProfile('profile-cccccccccccc')
	delayedProfiles.resolve({ data: profiles(target) })
	await spin()
	assert.equal(
		f.publications.some(entry => entry.profileId === target),
		false,
	)
	coherent(f, 'profile-cccccccccccc')
	// The first poll was still releasing when adoption kicked it; explicitly
	// drive its owned retry to model the bridge's non-overlapping poller.
	f.timers.at(-1)?.()
	await fence.ready
	assert.equal(f.bridge.getSnapshot().status?.profile?.id, 'profile-cccccccccccc')
})

test('stop during protocol restart prevents a later config/publication continuation', async () => {
	const f = bridgeFixture()
	const restart = f.hold('POST', '/daemon/restart')
	f.push('GET', '/status', { data: status() })
	f.push('GET', '/items', { data: [] })
	f.push('GET', '/profiles', { data: profiles() })
	f.bridge.beginProfileSwitch(target)
	await spin()
	f.bridge.stop()
	restart.resolve({ error: 'not managed' })
	await spin()
	assert.equal(
		f.publications.some(entry => entry.profileId === target),
		false,
	)
})
