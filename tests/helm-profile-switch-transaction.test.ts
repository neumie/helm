import assert from 'node:assert/strict'
import test from 'node:test'
import profileSwitchModule from '../app/src/profile-switch.ts'
import type { ProfileSwitchFence } from '../app/src/profile-switch.ts'

const { ProfileSwitchCoordinator } = profileSwitchModule
import type { HelmResult, ProfileActivationResult, ProfilesState } from '../app/src/shared-helm.ts'

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}

const work = (generation = 1): ProfilesState => ({
	version: 1,
	generation,
	activeProfileId: 'work',
	profiles: [{ id: 'work', name: 'Work', createdAt: '', enabledProjects: [], archivedAt: null }],
})
const other = (id: string, generation = 2): ProfilesState => ({
	...work(generation),
	activeProfileId: id,
	profiles: [work().profiles[0], { id, name: id, createdAt: '', enabledProjects: [], archivedAt: null }],
})

function fixture() {
	let state = work()
	let observation: ProfilesState | null = null
	let activation: HelmResult<ProfileActivationResult> = {
		data: { state: other('profile-aaaaaaaaaaaa'), applied: true },
	}
	const activationGate = deferred<HelmResult<ProfileActivationResult>>()
	let gateActivation = false
	let namespaceFailures = 0
	const events: string[] = []
	let latestFence: { ready: Deferred<void>; target: string; cancelled: boolean } | null = null
	const timers: Array<() => void> = []
	const coordinator = new ProfileSwitchCoordinator({
		currentState: () => state,
		listProfiles: async () => ({ data: state }),
		beginRunContextDrain: () => ({
			ok: true as const,
			drained: Promise.resolve(),
			release: () => events.push('release'),
		}),
		flushBuffers: async () => {
			events.push('flush')
		},
		beginFence: target => {
			events.push(`fence:${target}`)
			const ready = deferred<void>()
			const record = { ready, target, cancelled: false }
			latestFence = record
			return {
				epoch: events.length,
				ready: ready.promise,
				cancelIfCurrent: () => {
					record.cancelled = true
					events.push('cancel')
				},
				adoptObservedProfile: id => {
					record.target = id
					events.push(`adopt:${id}`)
				},
				invalidateIfCurrent: () => events.push('invalidate'),
				completeIfCurrent: () => events.push('complete-fence'),
				observeCoherently: async () => observation,
			} satisfies ProfileSwitchFence
		},
		advanceLocalGeneration: () => events.push('advance'),
		restorePrecommitGeneration: () => events.push('restore'),
		activateDaemon: async () => {
			events.push('activate')
			return gateActivation ? activationGate.promise : activation
		},
		installAuthoritativeState: next => {
			state = next
			events.push(`state:${next.activeProfileId}`)
		},
		closeSessionIpc: () => events.push('close-ipc'),
		flushOldRegistryBestEffort: () => events.push('registry'),
		detachOldClients: () => {
			events.push('detach')
		},
		installSessionNamespace: id => {
			events.push(`namespace:${id}`)
			if (namespaceFailures-- > 0) throw new Error('namespace unavailable')
		},
		openSessionIpc: () => events.push('open-ipc'),
		reloadOrCreateWindow: async () => {
			events.push('reload')
		},
		queueOrDeliverItem: id => events.push(`item:${id}`),
		refreshMenuBestEffort: () => events.push('menu'),
		log: () => events.push('log'),
		setTimer: callback => {
			timers.push(callback)
			return timers.length as unknown as ReturnType<typeof setTimeout>
		},
		clearTimer: () => {},
	})
	return {
		coordinator,
		events,
		get fence() {
			if (!latestFence) throw new Error('missing fence')
			return latestFence
		},
		set observation(value: ProfilesState | null) {
			observation = value
		},
		set activation(value: HelmResult<ProfileActivationResult>) {
			activation = value
		},
		set gateActivation(value: boolean) {
			gateActivation = value
		},
		set namespaceFailures(value: number) {
			namespaceFailures = value
		},
		resolveActivation(value: HelmResult<ProfileActivationResult>) {
			activationGate.resolve(value)
		},
		timers,
	}
}

async function spin(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
}

test('drain, flush, fence, generation and activation precede forward terminal installation', async () => {
	const f = fixture()
	f.observation = other('profile-aaaaaaaaaaaa')
	const pending = f.coordinator.switchTo('profile-aaaaaaaaaaaa', 'item-1')
	await spin()
	assert.deepEqual(f.events.slice(0, 4), ['flush', 'fence:profile-aaaaaaaaaaaa', 'advance', 'activate'])
	assert.equal(f.coordinator.isSwitching(), true)
	f.fence.ready.resolve()
	const result = await pending
	assert.equal(result.error, undefined)
	assert.deepEqual(f.events.slice(4), [
		'adopt:profile-aaaaaaaaaaaa',
		'state:profile-aaaaaaaaaaaa',
		'close-ipc',
		'registry',
		'detach',
		'namespace:profile-aaaaaaaaaaaa',
		'open-ipc',
		'reload',
		'menu',
		'item:item-1',
		'complete-fence',
		'release',
	])
})

test('only an activation error plus exact-old observation restores the precommit token', async () => {
	const f = fixture()
	f.observation = work()
	f.activation = { error: 'network response lost' }
	const result = await f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	assert.equal(result.error, 'network response lost')
	assert.deepEqual(f.events, [
		'flush',
		'fence:profile-aaaaaaaaaaaa',
		'advance',
		'activate',
		'restore',
		'cancel',
		'open-ipc',
		'release',
	])
})

test('a coherent third profile reconciles forward and never rolls generation back', async () => {
	const f = fixture()
	f.observation = other('profile-bbbbbbbbbbbb', 3)
	f.activation = { error: 'lost response' }
	const pending = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	f.fence.ready.resolve()
	const result = await pending
	assert.match(result.error ?? '', /profile-bbbbbbbbbbbb/)
	assert.ok(f.events.includes('state:profile-bbbbbbbbbbbb'))
	assert.ok(!f.events.includes('restore'))
})

test('activation response loss still commits when the target is coherently observed', async () => {
	const f = fixture()
	f.observation = other('profile-aaaaaaaaaaaa')
	f.activation = { error: 'response lost after commit' }
	const pending = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	f.fence.ready.resolve()
	assert.equal((await pending).error, undefined)
	assert.ok(!f.events.includes('restore'))
})

test('the old id with a changed daemon generation reconciles forward rather than rolling back', async () => {
	const f = fixture()
	f.observation = work(2)
	f.activation = { error: 'response lost' }
	const pending = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	f.fence.ready.resolve()
	assert.match((await pending).error ?? '', /work/)
	assert.ok(f.events.includes('state:work'))
	assert.ok(!f.events.includes('restore'))
})

test('successful POST followed by unknown then exact-old reconciles forward without restoring generation', async () => {
	const f = fixture()
	f.observation = null
	const pending = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	assert.ok(f.events.includes('close-ipc'))
	f.observation = work()
	const probe = f.timers.at(-2)
	assert.ok(probe)
	probe?.()
	await spin()
	f.fence.ready.resolve()
	assert.match((await pending).error ?? '', /resolved to work/)
	assert.ok(!f.events.includes('restore'))
	assert.ok(f.events.includes('open-ipc'))
})

test('cached no-op installs the authoritative daemon generation', async () => {
	const f = fixture()
	f.observation = work(2)
	const result = await f.coordinator.switchTo('work')
	assert.equal(result.error, undefined)
	assert.ok(f.events.includes('state:work'))
	assert.ok(!f.events.includes('activate'))
})

test('third-profile reconciliation never delivers a target-qualified Item', async () => {
	const f = fixture()
	f.observation = other('profile-bbbbbbbbbbbb', 3)
	const pending = f.coordinator.switchTo('profile-aaaaaaaaaaaa', 'item-for-a')
	await spin()
	f.fence.ready.resolve()
	await pending
	assert.ok(!f.events.includes('item:item-for-a'))
})

test('shutdown clears unknown admission work and prevents a later probe from acting', async () => {
	const f = fixture()
	f.observation = null
	const pending = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	assert.ok(f.events.includes('close-ipc'))
	f.coordinator.stop()
	assert.equal((await pending).error, 'Helm is shutting down.')
	const events = [...f.events]
	for (const timer of f.timers) timer()
	await spin()
	assert.deepEqual(f.events, events)
})

test('critical namespace failure keeps admission closed and retries forward without another activation', async () => {
	const f = fixture()
	f.observation = other('profile-aaaaaaaaaaaa')
	f.namespaceFailures = 1
	const pending = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	f.fence.ready.resolve()
	await spin()
	assert.equal(f.events.filter(event => event === 'activate').length, 1)
	assert.ok(f.events.includes('log'))
	const retry = f.timers.at(-1)
	assert.ok(retry)
	retry?.()
	assert.equal((await pending).error, undefined)
	assert.ok(f.events.filter(event => event === 'close-ipc').length >= 2)
})

test('same unknown target coalesces and an explicit target supersedes without stale rollback', async () => {
	const f = fixture()
	f.gateActivation = true
	const first = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	const same = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	assert.equal(first, same)
	await spin()
	f.resolveActivation({ error: 'timeout' })
	await spin()
	assert.equal(f.coordinator.isSwitching(), true)
	f.observation = other('profile-bbbbbbbbbbbb', 3)
	const second = f.coordinator.switchTo('profile-bbbbbbbbbbbb')
	assert.match((await first).error ?? '', /superseded/)
	await spin()
	f.fence.ready.resolve()
	const result = await second
	assert.equal(result.error, undefined)
	assert.ok(!f.events.includes('restore'))
})
