import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteSubagentActivityClient } from '../src/remote/subagent-activity-client.js'
import {
	SUBAGENT_ACTIVITY_READY_EVENT,
	SUBAGENT_ACTIVITY_REQUEST_EVENT,
} from '../src/remote/subagent-activity-protocol.js'

const sessionId = '11111111-1111-7111-8111-111111111111'
const providerId = '22222222-2222-4222-8222-222222222222'
const frame = (active: boolean, sequence = 1) => ({
	binding: { version: 1, scope: 'session', sessionId, providerId, sequence },
	activity: { availability: 'available', coverage: 'limited', active },
})
const bus = () => {
	const handlers = new Map<string, (value: unknown) => void>()
	return {
		handlers,
		events: {
			on(channel: string, handler: (value: unknown) => void) {
				handlers.set(channel, handler)
				return () => handlers.delete(channel)
			},
			emit() {},
		},
	}
}

test('captures own data descriptors and invokes getter detached', () => {
	const { handlers, events } = bus()
	let requested = false
	let detached = false
	const eventBus = {
		...events,
		emit(channel: string) {
			if (channel === SUBAGENT_ACTIVITY_REQUEST_EVENT) requested = true
		},
	}
	const client = new RemoteSubagentActivityClient(eventBus, sessionId, () => true)
	assert.equal(requested, true)
	const capability = Object.create({ providerId, readActivity: () => frame(true) })
	Object.defineProperties(capability, {
		version: { value: 1 },
		scope: { value: 'session' },
		sessionId: { value: sessionId },
		providerId: { value: providerId },
		readActivity: {
			value: function (this: unknown) {
				detached = this === undefined
				return frame(true)
			},
		},
	})
	handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.(capability)
	assert.deepEqual(client.read().activity, frame(true).activity)
	assert.equal(detached, true)
	client.dispose()
})

test('foreign binding is unavailable and retirement remains observed', () => {
	const { handlers, events } = bus()
	const client = new RemoteSubagentActivityClient(events, sessionId, () => true)
	handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.({
		version: 1,
		scope: 'session',
		sessionId,
		providerId,
		readActivity: () => ({
			...frame(true),
			binding: { ...frame(true).binding, sessionId: '33333333-3333-4333-8333-333333333333' },
		}),
	})
	assert.equal(client.read().activity.availability, 'unavailable')
	client.dispose()
})

test('guard failure permanently retires and same source/getter is idempotent', () => {
	const { handlers, events } = bus()
	let current = true
	let calls = 0
	const getter = () => {
		calls++
		return frame(true)
	}
	const client = new RemoteSubagentActivityClient(events, sessionId, () => current)
	handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.({
		version: 1,
		scope: 'session',
		sessionId,
		providerId,
		readActivity: getter,
	})
	assert.equal(client.read().activity.availability, 'available')
	current = false
	assert.equal(client.read().activity.availability, 'unavailable')
	current = true
	handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.({
		version: 1,
		scope: 'session',
		sessionId,
		providerId,
		readActivity: getter,
	})
	assert.equal(client.read().activity.availability, 'unavailable')
	assert.equal(calls, 2)
	client.dispose()
})

test('transient malformed read preserves baseline and changed equal sequence is unavailable', () => {
	const { handlers, events } = bus()
	let value: unknown = frame(true)
	const getter = () => value
	const client = new RemoteSubagentActivityClient(events, sessionId, () => true)
	handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.({
		version: 1,
		scope: 'session',
		sessionId,
		providerId,
		readActivity: getter,
	})
	value = { malformed: true }
	assert.equal(client.read().activity.availability, 'unavailable')
	value = frame(true)
	assert.equal(client.read().activity.availability, 'available')
	value = frame(false)
	assert.equal(client.read().activity.availability, 'unavailable')
	client.dispose()
})

for (const phase of ['install', 'read', 'constructor'] as const) {
	for (const invalidate of ['dispose', 'current', 'compete'] as const) {
		if (phase === 'constructor' && invalidate === 'dispose') continue
		test(`descriptor reentrancy fences ${phase}: ${invalidate}`, () => {
			const { handlers, events } = bus()
			let current = true
			let armed = phase !== 'read'
			// biome-ignore lint/style/useConst: constructor callbacks intentionally run before assignment.
			let client: RemoteSubagentActivityClient | undefined
			const offer = {
				version: 1,
				scope: 'session',
				sessionId,
				providerId,
				readActivity: () =>
					new Proxy(frame(true), {
						getOwnPropertyDescriptor(object, key) {
							if (armed && key === 'activity') {
								armed = false
								if (invalidate === 'dispose' && client) client.dispose()
								else if (invalidate === 'compete') handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.(offer)
								else current = false
							}
							return Reflect.getOwnPropertyDescriptor(object, key)
						},
					}),
			}
			client = new RemoteSubagentActivityClient(
				{
					...events,
					emit() {
						if (phase === 'constructor') handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.(offer)
					},
				},
				sessionId,
				() => current,
			)
			if (phase !== 'constructor') handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.(offer)
			if (phase === 'read') armed = true
			assert.equal(client.read().activity.availability, 'unavailable')
			current = true
			assert.equal(client.read().activity.availability, 'unavailable')
			client.dispose()
		})
	}
}

test('matching and unattributable malformed offers are observed; foreign offers never invoke descriptors beyond identity', () => {
	for (const malformed of [{}, { version: 1, scope: 'session', sessionId, providerId }]) {
		const { handlers, events } = bus()
		const client = new RemoteSubagentActivityClient(events, sessionId, () => true)
		handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.(malformed)
		assert.equal(client.read().activity.availability, 'unavailable')
		client.dispose()
	}
	const { handlers, events } = bus()
	const client = new RemoteSubagentActivityClient(events, sessionId, () => true)
	handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.(
		new Proxy(
			{ sessionId: providerId },
			{
				getOwnPropertyDescriptor(object, key) {
					assert.equal(key, 'sessionId')
					return Reflect.getOwnPropertyDescriptor(object, key)
				},
			},
		),
	)
	assert.equal(client.read().activity.availability, 'unsupported')
	client.dispose()
})

test('sixteen retired providers remain non-replayable and exhaustion latches unavailable', () => {
	const { handlers, events } = bus()
	const client = new RemoteSubagentActivityClient(events, sessionId, () => true)
	for (let index = 0; index < 17; index++) {
		const id = `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`
		handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.({
			version: 1,
			scope: 'session',
			sessionId,
			providerId: id,
			readActivity: () => null,
		})
	}
	handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.({
		version: 1,
		scope: 'session',
		sessionId,
		providerId,
		readActivity: () => frame(true),
	})
	assert.equal(client.read().activity.availability, 'unavailable')
	client.dispose()
})

test('same captured getter is idempotent; competing getter or provider permanently conflicts', () => {
	for (const foreignProvider of [false, true]) {
		const { handlers, events } = bus()
		const client = new RemoteSubagentActivityClient(events, sessionId, () => true)
		let calls = 0
		const offer = {
			version: 1,
			scope: 'session',
			sessionId,
			providerId,
			readActivity: () => {
				calls++
				return frame(false)
			},
		}
		handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.(offer)
		handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.(offer)
		assert.equal(calls, 1)
		assert.deepEqual(client.read().activity, frame(false).activity)
		handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.({
			...offer,
			providerId: foreignProvider ? sessionId : providerId,
			readActivity: () => frame(true),
		})
		assert.equal(client.read().activity.availability, 'unavailable')
		client.dispose()
	}
})

test('otherwise-valid inherited frame fields are rejected', () => {
	for (const property of ['binding', 'activity']) {
		const { handlers, events } = bus()
		const client = new RemoteSubagentActivityClient(events, sessionId, () => true)
		const valid = frame(true)
		const inherited = Object.create(valid)
		Object.defineProperty(inherited, property === 'binding' ? 'activity' : 'binding', {
			value: property === 'binding' ? valid.activity : valid.binding,
		})
		handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.({
			version: 1,
			scope: 'session',
			sessionId,
			providerId,
			readActivity: () => inherited,
		})
		assert.equal(client.read().activity.availability, 'unavailable')
		client.dispose()
	}
})

test('read retirement is persistent and regressing sequence cannot replay after a bad read', () => {
	for (const retired of [false, true]) {
		const { handlers, events } = bus()
		let value: unknown = frame(true, 10)
		const client = new RemoteSubagentActivityClient(events, sessionId, () => true)
		handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.({
			version: 1,
			scope: 'session',
			sessionId,
			providerId,
			readActivity: () => value,
		})
		value = retired ? null : {}
		assert.equal(client.read().activity.availability, 'unavailable')
		value = frame(true, 9)
		assert.equal(client.read().activity.availability, 'unavailable')
		value = frame(true, 11)
		assert.equal(client.read().activity.availability, 'unavailable')
		client.dispose()
	}
})

test('capability and frame accessors are never invoked', () => {
	for (const location of ['offer', 'frame', 'binding', 'activity']) {
		const { handlers, events } = bus()
		const client = new RemoteSubagentActivityClient(events, sessionId, () => true)
		const value = frame(true)
		const offer = { version: 1, scope: 'session', sessionId, providerId, readActivity: () => value }
		const object =
			location === 'offer'
				? offer
				: location === 'frame'
					? value
					: location === 'binding'
						? value.binding
						: value.activity
		const key =
			location === 'offer'
				? 'readActivity'
				: location === 'frame'
					? 'binding'
					: location === 'binding'
						? 'sequence'
						: 'active'
		Object.defineProperty(object, key, {
			get() {
				assert.fail('Accessor invoked')
			},
		})
		handlers.get(SUBAGENT_ACTIVITY_READY_EVENT)?.(offer)
		assert.equal(client.read().activity.availability, 'unavailable')
		client.dispose()
	}
})
