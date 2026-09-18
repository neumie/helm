import assert from 'node:assert/strict'
import test from 'node:test'
import freshnessModule from '../app/src/renderer/remote/subagent-freshness.js'
import type { RemoteSubagentFreshnessController as FreshnessController } from '../app/src/renderer/remote/subagent-freshness.js'
const { RemoteSubagentFreshnessController } = freshnessModule as {
	RemoteSubagentFreshnessController: typeof FreshnessController
}
import {
	type RemoteDetail,
	type RemoteDirectory,
	type RemoteTarget,
	remoteDetailSchema,
	remoteDirectorySchema,
} from '../src/remote/protocol.js'
import type { RemoteSubagentActivity } from '../src/remote/subagent-activity-protocol.js'

const ids = [
	'11111111-1111-7111-8111-111111111111',
	'22222222-2222-4222-8222-222222222222',
	'33333333-3333-4333-8333-333333333333',
]
const target = (sessionId = ids[0]): RemoteTarget => ({ sessionId, incarnation: ids[1], scopeId: null, generation: 1 })
const active: RemoteSubagentActivity = { availability: 'available', coverage: 'limited', active: true }
const idle: RemoteSubagentActivity = { availability: 'available', coverage: 'limited', active: false }
const summary = (t: RemoteTarget, revision: number, activity: RemoteSubagentActivity | undefined, ttl = 1000) => ({
	target: t,
	revision,
	label: 'Fixture',
	workspace: 'Fixture',
	model: null,
	activity: 'idle' as const,
	capabilities: { prompt: true, interrupt: true, answer: false },
	historyTruncated: false,
	connected: true,
	subagents: activity,
	subagentsFreshForMs: ttl,
})
const directory = (hostEpoch: string, sessions: ReturnType<typeof summary>[]): RemoteDirectory =>
	remoteDirectorySchema.parse({ protocol: 1, hostEpoch, overlayStamp: 'overlay', sessions })
const detail = (
	hostEpoch: string,
	t: RemoteTarget,
	revision: number,
	activity: RemoteSubagentActivity | undefined,
	ttl = 1000,
): RemoteDetail =>
	remoteDetailSchema.parse({
		protocol: 1,
		hostEpoch,
		resync: true,
		snapshot: { ...summary(t, revision, activity, ttl), question: null, messages: [] },
	})

class FakeClock {
	time = 0
	callbacks: Array<{ at: number; callback: () => void }> = []
	setTimeout = (callback: () => void, delay: number) => {
		const token = { at: this.time + delay, callback }
		this.callbacks.push(token)
		return token as unknown as ReturnType<typeof setTimeout>
	}
	clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
		const token = timer as unknown as { at: number; callback: () => void }
		this.callbacks = this.callbacks.filter(entry => entry !== token)
	}
	advance(ms: number) {
		this.time += ms
		const due = this.callbacks.filter(entry => entry.at <= this.time)
		this.callbacks = this.callbacks.filter(entry => entry.at > this.time)
		for (const entry of due) entry.callback()
	}
}

function makeController(clock = new FakeClock()) {
	return {
		clock,
		controller: new RemoteSubagentFreshnessController(() => clock.time, {
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
		}),
	}
}

test('accepts revision zero and binds exact host, target, revision, and activity', () => {
	const { controller } = makeController()
	const t = target()
	const host = ids[2]
	controller.replaceDirectory(directory(host, [summary(t, 0, active)]), 0)
	assert.deepEqual(controller.resolve(host, t, 0, true, active), active)
	assert.equal(controller.resolve(ids[1], t, 0, true, active).availability, 'unavailable')
	assert.equal(controller.resolve(host, t, 0, true, idle).availability, 'unavailable')
	assert.equal(controller.resolve(host, t, 1, true, active).availability, 'unavailable')
	assert.equal(controller.resolve(host, t, 0, false, active).availability, 'unavailable')
})

test('expires one owner without mutating during resolve and preserves a fresh peer', () => {
	const { clock, controller } = makeController()
	const host = ids[2]
	const a = target()
	const b = target(ids[1])
	let notifications = 0
	controller.subscribe(() => notifications++)
	controller.replaceDirectory(directory(host, [summary(a, 1, active, 100), summary(b, 1, idle, 500)]), 0)
	assert.equal(notifications, 1)
	clock.advance(150)
	assert.equal(controller.resolve(host, a, 1, true, active).availability, 'unavailable')
	assert.deepEqual(controller.resolve(host, b, 1, true, idle), idle)
	assert.equal(notifications, 2)
	clock.advance(350)
	assert.equal(notifications, 3)
	controller.dispose()
})

test('prunes departed directory owners and anti-regression baselines', () => {
	const { controller } = makeController()
	const host = ids[2]
	const a = target()
	const b = target(ids[1])
	controller.replaceDirectory(directory(host, [summary(a, 2, active), summary(b, 1, idle)]), 0)
	controller.replaceDirectory(directory(host, [summary(a, 2, undefined)]), 10)
	controller.replaceDirectory(directory(host, [summary(b, 0, active)]), 20)
	assert.equal(controller.resolve(host, b, 0, true, active).availability, 'available')
	assert.equal(controller.resolve(host, a, 2, true, active).availability, 'unavailable')
})

test('same-revision unavailable can recover only to the prior available signature', () => {
	const { controller } = makeController()
	const host = ids[2]
	const t = target()
	controller.replaceDetail(detail(host, t, 4, active), 0)
	controller.replaceDetail(
		detail(host, t, 4, { availability: 'unavailable', coverage: 'unavailable', active: null }),
		10,
	)
	assert.equal(controller.resolve(host, t, 4, true, active).availability, 'unavailable')
	controller.replaceDetail(detail(host, t, 4, active), 20)
	assert.deepEqual(controller.resolve(host, t, 4, true, active), active)
	controller.replaceDetail(detail(host, t, 4, idle), 30)
	assert.equal(controller.resolve(host, t, 4, true, idle).availability, 'unavailable')
})

test('detail remains one owner and publishes retirement once', () => {
	const { controller } = makeController()
	const host = ids[2]
	const a = target()
	const b = target(ids[1])
	let notifications = 0
	controller.subscribe(() => notifications++)
	controller.replaceDetail(detail(host, a, 1, active), 0)
	controller.replaceDetail(detail(host, b, 1, idle), 0)
	assert.equal(controller.resolve(host, a, 1, true, active).availability, 'unavailable')
	assert.deepEqual(controller.resolve(host, b, 1, true, idle), idle)
	controller.retire()
	controller.retire()
	assert.equal(notifications, 3)
})

for (const evidence of ['missing', 'unavailable', 'aged', 'disconnected'] as const) {
	test(`higher ${evidence} evidence advances high-water without a lease`, () => {
		const { controller, clock } = makeController()
		const t = target()
		const host = ids[2]
		controller.replaceDetail(detail(host, t, 4, active), 0)
		const next = detail(
			host,
			t,
			5,
			evidence === 'missing'
				? undefined
				: evidence === 'unavailable'
					? { availability: 'unavailable', coverage: 'unavailable', active: null }
					: active,
		)
		if (evidence === 'disconnected') next.snapshot.connected = false
		if (evidence === 'aged') clock.time = 2000
		controller.replaceDetail(next, 0)
		controller.retire()
		controller.replaceDetail(detail(host, t, 4, active), clock.time)
		assert.equal(controller.resolve(host, t, 4, true, active).availability, 'unavailable')
		controller.replaceDetail(detail(host, t, 5, active), clock.time)
		assert.deepEqual(controller.resolve(host, t, 5, true, active), active)
		controller.dispose()
	})
}

test('suspended timers plus aged equal response publish exactly one expiry; renewals do not publish', () => {
	const { controller, clock } = makeController()
	const t = target()
	const host = ids[2]
	let notifications = 0
	controller.subscribe(() => notifications++)
	controller.replaceDetail(detail(host, t, 0, active, 100), 0)
	controller.replaceDetail(detail(host, t, 1, active, 100), 10)
	assert.equal(notifications, 1)
	clock.time = 200
	assert.equal(controller.resolve(host, t, 1, true, active).availability, 'unavailable')
	assert.equal(notifications, 1)
	controller.replaceDetail(detail(host, t, 1, active, 100), 10)
	assert.equal(notifications, 2)
	assert.equal(clock.callbacks.length, 0)
	controller.dispose()
})

for (const count of [2, 65]) {
	test(`ambiguous directory ${count} clears lease without a winner`, () => {
		const { controller } = makeController()
		const row = summary(target(), 0, active)
		controller.replaceDirectory(directory(ids[2], [row]), 0)
		const ambiguous: RemoteDirectory = {
			protocol: 1,
			hostEpoch: ids[2],
			overlayStamp: 'fixture',
			sessions: Array.from({ length: count }, () => row),
		}
		controller.replaceDirectory(ambiguous, 1)
		assert.equal(controller.resolve(ids[2], target(), 0, true, active).availability, 'unavailable')
		controller.dispose()
	})
}

for (const kind of ['detail', 'directory'] as const) {
	test(`${kind} publishes equal fresh recovery after an unrelated expired resolve`, () => {
		const { controller, clock } = makeController()
		const t = target()
		const host = ids[2]
		let notifications = 0
		controller.subscribe(() => notifications++)
		const receive = (start: number) =>
			kind === 'detail'
				? controller.replaceDetail(detail(host, t, 0, active, 100), start)
				: controller.replaceDirectory(directory(host, [summary(t, 0, active, 100)]), start)
		receive(0)
		clock.time = 200
		assert.equal(controller.resolve(host, t, 0, true, active).availability, 'unavailable')
		assert.equal(notifications, 1)
		receive(200)
		assert.equal(notifications, 2)
		assert.deepEqual(controller.resolve(host, t, 0, true, active), active)
		receive(201)
		assert.equal(notifications, 2)
		assert.equal(clock.callbacks.length, 1)
		controller.dispose()
	})
}
