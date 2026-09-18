import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	FOOTER_INFORMATION_REQUEST as FQ,
	FOOTER_INFORMATION_READY as FR,
	INFORMATION_RETIRED_SOURCE_LIMIT,
	type InformationEventBus,
	RemoteInformationClient,
	SIDEBAR_INFORMATION_REQUEST as SQ,
	SIDEBAR_INFORMATION_READY as SR,
} from '../src/remote/information-client.js'

function required<T>(value: T | null | undefined): T {
	assert.ok(value !== null && value !== undefined)
	return value
}

class Bus implements InformationEventBus {
	listeners = new Map<string, Set<(data: unknown) => void>>()
	emissions: Array<{ channel: string; data: unknown }> = []
	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.listeners.get(channel) ?? new Set()
		this.listeners.set(channel, set)
		set.add(handler)
		return () => {
			set.delete(handler)
		}
	}
	emit(channel: string, data: unknown): void {
		this.emissions.push({ channel, data })
		for (const handler of this.listeners.get(channel) ?? []) handler(data)
	}
}
const sessionId = 'current-session'
const binding = (providerId = 'footer', sequence = 1) => ({
	version: 1,
	scope: 'session',
	sessionId,
	providerId,
	sequence,
})
const footer = (providerId = 'footer', sequence = 1) => ({
	...binding(providerId, sequence),
	available: true,
	cwd: 'workspace',
	trusted: false,
	sessionName: 'Current conversation',
	model: 'Model',
	thinking: 'high',
	inputTokens: 0,
	outputTokens: null,
	contextTokens: null,
	contextWindow: null,
	contextPercent: null,
	goalAvailable: false,
	goalPhase: null,
	omittedStatuses: null,
	omitted: 0,
})
const sidebar = (providerId = 'sidebar', sequence = 1) => ({
	...binding(providerId, sequence),
	omittedProviders: 0,
	sections: [
		{
			title: 'Jobs',
			scope: 'session',
			availability: 'available',
			coverage: 'limited',
			rows: [{ label: 'Running', value: 0 }],
			omitted: 0,
		},
	],
})
const ready = (getter: () => unknown, providerId = 'footer') => ({
	version: 1,
	scope: 'session',
	sessionId,
	providerId,
	readInformation: getter,
})
function harness() {
	const bus = new Bus()
	let current = true
	const client = new RemoteInformationClient(bus, sessionId, captured => current && captured === sessionId)
	return {
		bus,
		client,
		invalidate: () => {
			current = false
		},
		restoreGuard: () => {
			current = true
		},
	}
}

test('subscribes once per source, emits only exact requests, absent exporters are unsupported and late sources arrive', () => {
	const h = harness()
	assert.deepEqual(
		h.bus.emissions,
		[FQ, SQ].map(channel => ({ channel, data: { version: 1, sessionId } })),
	)
	assert.equal(h.bus.listeners.get(FR)?.size, 1)
	assert.equal(h.bus.listeners.get(SR)?.size, 1)
	assert.equal(h.client.read()?.footer.availability, 'unsupported')
	assert.equal(h.client.read()?.sidebar.availability, 'unsupported')
	h.bus.emit(
		SR,
		ready(() => sidebar(), 'sidebar'),
	)
	assert.equal(h.client.read()?.sidebar.sections[0].coverage, 'limited')
	assert.equal(h.client.read()?.sidebar.sections[0].rows[0].value, 0)
	for (let i = 0; i < 20; i++) h.client.read() // Transport sampling/reconnect never reconstructs this client.
	assert.equal(h.bus.emissions.filter(e => e.channel === FQ || e.channel === SQ).length, 2)
	const late = [...required(h.bus.listeners.get(FR))][0]
	h.client.dispose()
	h.client.dispose()
	let calls = 0
	late(
		ready(() => {
			calls++
			return footer()
		}),
	)
	assert.equal(calls, 0)
	assert.equal(h.client.read(), null)
	assert.equal(h.bus.listeners.get(FR)?.size, 0)
	assert.equal(h.bus.listeners.get(SR)?.size, 0)
})

test('captures each ready descriptor once; ignores accessors, prototypes, arrays, throwing proxies, oversized and wrong identities', () => {
	const h = harness()
	let effects = 0
	let calls = 0
	const getter = () => {
		calls++
		return footer()
	}
	const data = ready(getter)
	const counts = new Map<PropertyKey, number>()
	const candidate = new Proxy(data, {
		getOwnPropertyDescriptor(target, key) {
			counts.set(key, (counts.get(key) ?? 0) + 1)
			return Reflect.getOwnPropertyDescriptor(target, key)
		},
		get() {
			effects++
			throw Error('no property access')
		},
		ownKeys() {
			effects++
			throw Error('no enumeration')
		},
	})
	const accessor = { ...data }
	Object.defineProperty(accessor, 'readInformation', {
		get() {
			effects++
			return getter
		},
	})
	for (const bad of [
		null,
		[],
		{},
		Object.create(data),
		accessor,
		{ ...data, version: 2 },
		{ ...data, scope: 'process' },
		{ ...data, sessionId: 'other' },
		{ ...data, providerId: 'x'.repeat(129) },
		{ ...data, providerId: '\u001b' },
		new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw Error('private')
				},
			},
		),
	])
		h.bus.emit(FR, bad)
	assert.equal(calls, 0)
	assert.equal(effects, 0)
	h.bus.emit(FR, candidate)
	assert.equal(calls, 1)
	assert.deepEqual([...counts.values()], [1, 1, 1, 1, 1])
	assert.equal(h.client.read()?.footer.availability, 'available')
	assert.equal(effects, 0)
	assert.doesNotMatch(JSON.stringify(h.client.read()), /providerId|readInformation|sequence|current-session/)
	h.client.dispose()
})

for (const violation of ['regression', 'same-sequence-change'] as const)
	test(`first admission retains ${violation} baseline across repeated ready and disconnected sampling`, () => {
		const h = harness()
		let value = footer('footer', 5)
		let calls = 0
		const capability = ready(() => {
			calls++
			return value
		})
		h.bus.emit(FR, capability)
		assert.equal(calls, 1)
		value = violation === 'regression' ? footer('footer', 4) : { ...value, inputTokens: 3 }
		h.bus.emit(FR, capability)
		assert.equal(calls, 1) // announcement never resets baseline
		assert.equal(h.client.read()?.footer.availability, 'unavailable')
		value = footer('footer', 6)
		assert.equal(h.client.read()?.footer.availability, 'unavailable') // replay violation stays fenced
		h.client.dispose()
	})

test('same sequence/content and advancing sequence with unchanged content are allowed; safe outputs are detached', () => {
	const h = harness()
	let value = footer()
	h.bus.emit(
		FR,
		ready(() => value),
	)
	const first = required(h.client.read())
	required(first.footer.fields).model = 'Consumer mutation'
	assert.equal(h.client.read()?.footer.fields?.model, 'Model')
	value = footer('footer', Number.MAX_SAFE_INTEGER)
	assert.equal(h.client.read()?.footer.availability, 'available')
	value = footer('footer', 0)
	assert.equal(h.client.read()?.footer.availability, 'unavailable')
	h.client.dispose()
})

test('malformed and thrown reads clear display without retiring source or erasing baseline; null alone retires', () => {
	const h = harness()
	let mode = 'valid'
	let value: unknown = footer('footer', 7)
	const cap = ready(() => {
		if (mode === 'throw') throw Error('/private/error')
		return value
	})
	h.bus.emit(FR, cap)
	for (const bad of [{}, { ...footer(), sessionId: 'other' }, { ...footer(), providerId: 'other' }, undefined]) {
		value = bad
		assert.equal(h.client.read()?.footer.availability, 'unavailable')
		value = footer('footer', 7)
		assert.equal(h.client.read()?.footer.availability, 'available')
	}
	mode = 'throw'
	assert.equal(h.client.read()?.footer.availability, 'unavailable')
	mode = 'valid'
	value = footer('footer', 6)
	assert.equal(h.client.read()?.footer.availability, 'unavailable')
	value = null
	assert.equal(h.client.read()?.footer.availability, 'unavailable')
	value = footer('footer', 8)
	h.bus.emit(FR, cap)
	assert.equal(h.client.read()?.footer.availability, 'unavailable')
	h.bus.emit(
		FR,
		ready(() => footer('replacement'), 'replacement'),
	)
	assert.equal(h.client.read()?.footer.availability, 'available')
	h.client.dispose()
})

test('well-formed but unavailable/throwing candidate is unavailable, not healthy empty or disposal; healthy sibling survives', () => {
	for (const getter of [
		() => ({}),
		() => {
			throw Error('private')
		},
		() => ({ ...footer(), available: false }),
	]) {
		const h = harness()
		h.bus.emit(FR, ready(getter))
		h.bus.emit(
			SR,
			ready(() => sidebar(), 'sidebar'),
		)
		assert.equal(h.client.read()?.footer.availability, 'unavailable')
		assert.equal(h.client.read()?.sidebar.availability, 'available')
		h.client.dispose()
	}
	const h = harness()
	h.bus.emit(
		FR,
		ready(() => footer()),
	)
	h.bus.emit(
		SR,
		ready(() => {
			throw Error('sidebar')
		}, 'sidebar'),
	)
	assert.equal(h.client.read()?.footer.availability, 'available')
	h.client.dispose()
})

for (const previous of ['valid', 'malformed', 'throws'] as const)
	test(`competing valid source cannot replace ${previous} owner without reliable null`, () => {
		const h = harness()
		let mode = 'valid'
		h.bus.emit(
			FR,
			ready(() => {
				if (mode === 'throws') throw Error('private')
				return mode === 'malformed' ? {} : footer()
			}),
		)
		mode = previous
		h.bus.emit(
			FR,
			ready(() => footer('new'), 'new'),
		)
		assert.equal(h.client.read()?.footer.availability, 'unavailable')
		mode = 'valid'
		assert.equal(h.client.read()?.footer.availability, 'unavailable')
		h.client.dispose()
	})

test('same ID cannot swap its getter; malformed competitor does not hide a healthy source', () => {
	const h = harness()
	h.bus.emit(
		FR,
		ready(() => footer()),
	)
	h.bus.emit(
		FR,
		ready(() => ({}), 'bad'),
	)
	assert.equal(h.client.read()?.footer.availability, 'available')
	h.bus.emit(
		FR,
		ready(() => footer()),
	)
	assert.equal(h.client.read()?.footer.availability, 'unavailable')
	h.client.dispose()
})

test('replacement probes old getter exactly once and requires null; retired IDs cannot resurrect and limit fails closed', () => {
	const h = harness()
	let live = true
	let oldCalls = 0
	const original = ready(() => {
		oldCalls++
		return live ? footer() : null
	})
	h.bus.emit(FR, original)
	live = false
	let retireCurrent = () => {}
	for (let i = 0; i < INFORMATION_RETIRED_SOURCE_LIMIT; i++) {
		retireCurrent()
		let active = true
		const id = `replacement-${i}`
		h.bus.emit(
			FR,
			ready(() => (active ? footer(id) : null), id),
		)
		assert.equal(h.client.read()?.footer.availability, 'available')
		retireCurrent = () => {
			active = false
		}
	}
	assert.equal(oldCalls, 2)
	live = true
	h.bus.emit(FR, original)
	assert.equal(oldCalls, 2)
	retireCurrent()
	h.bus.emit(
		FR,
		ready(() => footer('overflow'), 'overflow'),
	)
	assert.equal(h.client.read()?.footer.availability, 'unavailable')
	h.bus.emit(
		SR,
		ready(() => sidebar(), 'sidebar'),
	)
	assert.equal(h.client.read()?.sidebar.availability, 'available')
	h.client.dispose()
})

test('already-null candidates are retired too, without evicting current source', () => {
	const h = harness()
	h.bus.emit(
		FR,
		ready(() => footer()),
	)
	h.bus.emit(
		FR,
		ready(() => null, 'late'),
	)
	let calls = 0
	h.bus.emit(
		FR,
		ready(() => {
			calls++
			return footer('late')
		}, 'late'),
	)
	assert.equal(calls, 0)
	assert.equal(h.client.read()?.footer.availability, 'available')
	h.client.dispose()
})

test('current-session/lifecycle guard loss before or during callbacks permanently retires all subscriptions', () => {
	for (const boundary of ['before', 'candidate', 'read', 'projection'] as const) {
		const h = harness()
		let calls = 0
		if (boundary === 'before') h.invalidate()
		h.bus.emit(
			FR,
			ready(() => {
				calls++
				if (boundary === 'candidate' || (boundary === 'read' && calls === 2)) h.invalidate()
				return boundary === 'projection'
					? new Proxy(footer(), {
							getOwnPropertyDescriptor(target, key) {
								if (key === 'model') h.invalidate()
								return Reflect.getOwnPropertyDescriptor(target, key)
							},
						})
					: footer()
			}),
		)
		assert.equal(h.client.read(), null, boundary)
		h.restoreGuard()
		assert.equal(h.client.read(), null)
		assert.equal(h.bus.listeners.get(FR)?.size, 0)
		assert.equal(h.bus.listeners.get(SR)?.size, 0)
		if (boundary === 'before') assert.equal(calls, 0)
	}
})

test('disposal inside a getter fences its result and does not call the other source', () => {
	const h = harness()
	let dispose = false
	let sidebarCalls = 0
	h.bus.emit(
		FR,
		ready(() => {
			if (dispose) h.client.dispose()
			return footer()
		}),
	)
	h.bus.emit(
		SR,
		ready(() => {
			sidebarCalls++
			return sidebar()
		}, 'sidebar'),
	)
	dispose = true
	assert.equal(h.client.read(), null)
	assert.equal(sidebarCalls, 1)
})

test('reentrant ready and reads fail closed without recursion or arrival-order election', () => {
	for (const action of ['ready', 'read'] as const) {
		const h = harness()
		let reenter = false
		let calls = 0
		h.bus.emit(
			FR,
			ready(() => {
				calls++
				if (reenter) {
					if (action === 'ready')
						h.bus.emit(
							FR,
							ready(() => footer('nested'), 'nested'),
						)
					else h.client.read()
				}
				return footer()
			}),
		)
		reenter = true
		assert.equal(h.client.read()?.footer.availability, 'unavailable')
		assert.equal(calls, 2)
		h.client.dispose()
	}
})

test('sidebar callback changing footer source cannot disclose earlier footer data in the same aggregate read', () => {
	const h = harness()
	h.bus.emit(
		FR,
		ready(() => footer()),
	)
	let conflict = false
	h.bus.emit(
		SR,
		ready(() => {
			if (conflict)
				h.bus.emit(
					FR,
					ready(() => footer('other'), 'other'),
				)
			return sidebar()
		}, 'sidebar'),
	)
	conflict = true
	const value = required(h.client.read())
	assert.equal(value.footer.availability, 'unavailable')
	assert.equal(value.sidebar.availability, 'available')
	h.client.dispose()
})

test('invalid session or throwing guard performs no event work; subscription failure isolates other source', () => {
	for (const id of ['', 'x'.repeat(1025), 'bad\ud800']) {
		const bus = new Bus()
		const client = new RemoteInformationClient(bus, id, () => true)
		assert.equal(client.read(), null)
		assert.equal(bus.emissions.length, 0)
		assert.equal(bus.listeners.size, 0)
	}
	const bus = new Bus()
	const invalid = new RemoteInformationClient(bus, sessionId, () => {
		throw Error('guard')
	})
	assert.equal(invalid.read(), null)
	assert.equal(bus.emissions.length, 0)
	const broken: InformationEventBus = {
		on(channel, handler) {
			if (channel === FR) throw Error('subscribe')
			return bus.on(channel, handler)
		},
		emit: (channel, data) => bus.emit(channel, data),
	}
	const client = new RemoteInformationClient(broken, sessionId, () => true)
	bus.emit(
		SR,
		ready(() => sidebar(), 'sidebar'),
	)
	assert.equal(client.read()?.footer.availability, 'unavailable')
	assert.equal(client.read()?.sidebar.availability, 'available')
	client.dispose()
})

test('capability calls never expose internal arbitration state as their receiver', () => {
	const h = harness()
	let live = true
	const receivers: unknown[] = []
	const getter = function (this: unknown) {
		receivers.push(this)
		return live ? footer() : null
	}
	h.bus.emit(FR, ready(getter))
	h.client.read()
	live = false
	h.bus.emit(
		FR,
		ready(() => footer('replacement'), 'replacement'),
	)
	assert.deepEqual(receivers, [undefined, undefined, undefined])
	h.client.dispose()
})

test('candidate admission and descriptor reentrancy cannot elect a nested winner', () => {
	for (const boundary of ['getter', 'descriptor'] as const) {
		const h = harness()
		let nestedCalls = 0
		const nested = () =>
			h.bus.emit(
				FR,
				ready(() => {
					nestedCalls++
					return footer('nested')
				}, 'nested'),
			)
		const payload = ready(() => {
			if (boundary === 'getter') nested()
			return footer()
		})
		h.bus.emit(
			FR,
			boundary === 'descriptor'
				? new Proxy(payload, {
						getOwnPropertyDescriptor(target, key) {
							if (key === 'version') nested()
							return Reflect.getOwnPropertyDescriptor(target, key)
						},
					})
				: payload,
		)
		assert.equal(h.client.read()?.footer.availability, 'unavailable')
		assert.equal(nestedCalls, 0)
		h.client.dispose()
	}
})

test('sidebar admission signature rejects changed content at the first sequence and leaves footer available', () => {
	const h = harness()
	let value = sidebar('sidebar', 9)
	const cap = ready(() => value, 'sidebar')
	h.bus.emit(SR, cap)
	h.bus.emit(
		FR,
		ready(() => footer()),
	)
	value = { ...value, omittedProviders: 1 }
	h.bus.emit(SR, cap)
	assert.equal(h.client.read()?.sidebar.availability, 'unavailable')
	assert.equal(h.client.read()?.footer.availability, 'available')
	h.client.dispose()
})

test('subscription-time invalidation and throwing cleanup still fence late callbacks', () => {
	const bus = new Bus()
	let current = true
	let unsubscribed = 0
	let late: ((data: unknown) => void) | undefined
	const events: InformationEventBus = {
		on(_channel, handler) {
			late = handler
			current = false
			handler(ready(() => footer()))
			return () => {
				unsubscribed++
				throw Error('cleanup failure')
			}
		},
		emit: (channel, data) => bus.emit(channel, data),
	}
	const client = new RemoteInformationClient(events, sessionId, () => current)
	assert.equal(client.read(), null)
	assert.equal(unsubscribed, 1)
	current = true
	let calls = 0
	required(late)(
		ready(() => {
			calls++
			return footer()
		}),
	)
	assert.equal(calls, 0)
	assert.equal(bus.emissions.length, 0)
})
