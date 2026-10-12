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
	version: 2,
	generation,
	activeProfileId: 'work',
	profiles: [{ id: 'work', name: 'Work', createdAt: '', enabledProjects: [], knowledgeBindings: [], archivedAt: null }],
})
const other = (id: string, generation = 2): ProfilesState => ({
	...work(generation),
	activeProfileId: id,
	profiles: [
		work().profiles[0],
		{ id, name: id, createdAt: '', enabledProjects: [], knowledgeBindings: [], archivedAt: null },
	],
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
	let reloadFailures = 0
	let fenceFailures = 0
	let generationFailures = 0
	let drainCount = 0
	const events: string[] = []
	let latestFence: { ready: Deferred<void>; target: string; cancelled: boolean } | null = null
	const timers: Array<() => void> = []
	const coordinator = new ProfileSwitchCoordinator({
		currentState: () => state,
		listProfiles: async () => ({ data: state }),
		beginRunContextDrain: () => {
			drainCount++
			return {
				ok: true as const,
				drained: Promise.resolve(),
				release: () => events.push('release'),
			}
		},
		flushBuffers: async () => {
			events.push('flush')
		},
		beginFence: target => {
			events.push(`fence:${target}`)
			if (fenceFailures-- > 0) throw new Error('fence unavailable')
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
		advanceLocalGeneration: () => {
			if (generationFailures-- > 0) throw new Error('generation unavailable')
			events.push('advance')
		},
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
			if (reloadFailures-- > 0) throw new Error('renderer reload unavailable')
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
		get drainCount() {
			return drainCount
		},
		set fenceFailures(value: number) {
			fenceFailures = value
		},
		set generationFailures(value: number) {
			generationFailures = value
		},
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
		set reloadFailures(value: number) {
			reloadFailures = value
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

test('failed renderer reload retries forward and settles after the replacement load succeeds', async () => {
	const f = fixture()
	f.observation = other('profile-aaaaaaaaaaaa')
	f.reloadFailures = 1
	const pending = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	f.fence.ready.resolve()
	await spin()
	assert.equal(f.events.filter(event => event === 'reload').length, 1)
	assert.ok(f.events.includes('close-ipc'))
	const retry = f.timers.at(-1)
	assert.ok(retry)
	retry?.()
	assert.equal((await pending).error, undefined)
	assert.equal(f.events.filter(event => event === 'reload').length, 2)
	assert.equal(f.events.filter(event => event === 'open-ipc').length, 2)
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

for (const activationFails of [false, true]) {
	test(`unknown switch superseded by cached Work completes forward (activation error: ${activationFails})`, async () => {
		const f = fixture()
		f.activation = { error: 'first response lost' }
		const first = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
		await spin()
		const oldFence = f.fence
		const staleTimers = [...f.timers]
		assert.ok(f.events.includes('close-ipc'))

		f.observation = work()
		f.activation = activationFails ? { error: 'successor response lost' } : { data: { state: work(), applied: true } }
		const second = f.coordinator.switchTo('work', 'work-item')
		assert.match((await first).error ?? '', /superseded/)
		assert.equal(f.coordinator.pendingOperation(), second)
		await spin()
		await spin()
		assert.notEqual(f.fence, oldFence)
		assert.equal(f.drainCount, 1)
		assert.equal(f.events.filter(event => event === 'flush').length, 1)
		assert.equal(f.events.filter(event => event === 'release').length, 0)
		assert.ok(f.events.includes('namespace:work'))
		assert.ok(f.events.includes('reload'))
		assert.equal(f.coordinator.isSwitching(), true)
		assert.ok(!f.events.includes('complete-fence'))

		oldFence.ready.resolve()
		for (const timer of staleTimers) timer()
		await spin()
		assert.equal(f.coordinator.pendingOperation(), second)
		f.fence.ready.resolve()
		assert.equal((await second).error, undefined)
		assert.ok(!f.events.includes('restore'))
		assert.ok(!f.events.includes('cancel'))
		assert.deepEqual(f.events.slice(-4), ['menu', 'item:work-item', 'complete-fence', 'release'])
		assert.equal(f.events.filter(event => event === 'release').length, 1)
		assert.equal(f.coordinator.pendingOperation(), null)
	})
}

test('inherited exact-old activation failure reconciles forward instead of restoring an advanced token', async () => {
	const f = fixture()
	f.activation = { error: 'response lost' }
	const first = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	f.observation = work()
	const second = f.coordinator.switchTo('profile-bbbbbbbbbbbb', 'b-item')
	assert.match((await first).error ?? '', /superseded/)
	await spin()
	f.fence.ready.resolve()
	assert.match((await second).error ?? '', /resolved to work/)
	assert.ok(f.events.includes('namespace:work'))
	assert.ok(f.events.includes('reload'))
	assert.ok(f.events.includes('complete-fence'))
	assert.ok(!f.events.includes('restore'))
	assert.ok(!f.events.includes('item:b-item'))
})

test('cached Work successor adopts a coherently observed third identity without target Item delivery', async () => {
	const f = fixture()
	const first = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	f.observation = other('profile-cccccccccccc', 3)
	f.activation = { error: 'response lost' }
	const second = f.coordinator.switchTo('work', 'work-item')
	assert.match((await first).error ?? '', /superseded/)
	await spin()
	f.fence.ready.resolve()
	assert.match((await second).error ?? '', /resolved to profile-cccccccccccc/)
	assert.ok(f.events.includes('namespace:profile-cccccccccccc'))
	assert.ok(f.events.includes('complete-fence'))
	assert.ok(!f.events.includes('restore'))
	assert.ok(!f.events.includes('item:work-item'))
})

test('successor fresh-fence failure retains uncertainty and its lease until retry commits forward', async () => {
	const f = fixture()
	const first = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	f.fenceFailures = 1
	const second = f.coordinator.switchTo('work')
	assert.match((await first).error ?? '', /superseded/)
	await spin()
	assert.equal(f.coordinator.pendingOperation(), second)
	assert.equal(f.events.filter(event => event === 'activate').length, 1)
	assert.ok(!f.events.includes('release'))
	assert.ok(!f.events.includes('open-ipc'))
	assert.ok(!f.events.includes('cancel'))
	assert.equal(f.drainCount, 1)
	f.observation = work()
	const retry = f.timers.at(-2)
	assert.ok(retry)
	retry()
	await spin()
	f.fence.ready.resolve()
	assert.equal((await second).error, undefined)
	assert.equal(f.events.filter(event => event === 'activate').length, 2)
	assert.equal(f.events.filter(event => event === 'flush').length, 1)
	assert.equal(f.events.filter(event => event === 'release').length, 1)
	assert.ok(f.events.includes('complete-fence'))
})

test('rejected competitors never own the admitted operation promise', async () => {
	const f = fixture()
	f.gateActivation = true
	const first = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	assert.equal(f.coordinator.pendingOperation(), first)
	const rejected = await f.coordinator.switchTo('work')
	assert.match(rejected.error ?? '', /already in progress/)
	assert.equal(f.coordinator.pendingOperation(), first)
	await spin()
	f.resolveActivation({ error: 'timeout' })
	await spin()
	assert.equal(f.coordinator.pendingOperation(), first)
	f.coordinator.stop()
	assert.equal((await first).error, 'Helm is shutting down.')
	assert.equal(f.coordinator.pendingOperation(), null)
})

test('successor local token failure invalidates its partial fence and retries without another drain', async () => {
	const f = fixture()
	const first = f.coordinator.switchTo('profile-aaaaaaaaaaaa')
	await spin()
	f.generationFailures = 1
	const second = f.coordinator.switchTo('work')
	assert.match((await first).error ?? '', /superseded/)
	await spin()
	const partialFence = f.fence
	assert.equal(f.events.filter(event => event === 'invalidate').length, 2)
	assert.equal(f.events.filter(event => event === 'activate').length, 1)
	assert.ok(!f.events.includes('release'))
	assert.ok(!f.events.includes('open-ipc'))
	assert.equal(f.coordinator.pendingOperation(), second)
	f.observation = work()
	const retry = f.timers.at(-2)
	assert.ok(retry)
	retry()
	await spin()
	assert.notEqual(f.fence, partialFence)
	f.fence.ready.resolve()
	assert.equal((await second).error, undefined)
	assert.equal(f.drainCount, 1)
	assert.equal(f.events.filter(event => event === 'advance').length, 2)
	assert.equal(f.events.filter(event => event === 'release').length, 1)
})
