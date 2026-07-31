import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import helmBridgeModule from '../app/src/helm-bridge.ts'
import residencyModule from '../app/src/scheduled-residency.ts'
import type { HelmResult } from '../app/src/shared-helm.ts'

const { HelmBridge } = helmBridgeModule
const { ElectronResidencyController } = residencyModule

type Operation = 'issue' | 'heartbeat' | 'tick' | 'revoke'
type Call = { operation: Operation; capability: string; timeoutMs: number }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}

function ok<T>(data: T): HelmResult<T> {
	return { data }
}

function fixture(
	options: { tokens?: string[]; responses?: Partial<Record<Operation, Array<HelmResult<unknown>>>> } = {},
) {
	const calls: Call[] = []
	const timers: Array<() => void> = []
	const responses = new Map<Operation, Array<HelmResult<unknown>>>(
		Object.entries(options.responses ?? {}).map(([operation, values]) => [operation as Operation, [...(values ?? [])]]),
	)
	const tokens = [...(options.tokens ?? ['control-1'])]
	const controller = new ElectronResidencyController({
		loadControlToken: async () => {
			const token = tokens.shift()
			if (!token) throw new Error('missing control token')
			return token
		},
		request: async <T>(operation: Operation, capability: string, timeoutMs: number): Promise<HelmResult<T>> => {
			calls.push({ operation, capability, timeoutMs })
			const response = responses.get(operation)?.shift()
			if (!response) throw new Error(`unexpected ${operation}`)
			return response as HelmResult<T>
		},
		setTimer: (callback: () => void) => {
			timers.push(callback)
			return timers.length as unknown as ReturnType<typeof setTimeout>
		},
		clearTimer: () => {},
		heartbeatMs: 1,
		requestTimeoutMs: 7,
	})
	return { controller, calls, timers, responses }
}

async function flush(): Promise<void> {
	await Promise.resolve()
	await new Promise(resolve => setImmediate(resolve))
}

test('issues one control-authenticated lease then ticks it', async () => {
	const f = fixture({
		responses: { issue: [ok({ capability: 'lease-1', expiresAt: 1 })], tick: [ok({})] },
	})
	await f.controller.start()
	assert.deepEqual(
		f.calls.map(call => [call.operation, call.capability, call.timeoutMs]),
		[
			['issue', 'control-1', 7],
			['tick', 'lease-1', 7],
		],
	)
	assert.equal(f.timers.length, 1)
})

test('heartbeat and tick cycles never overlap', async () => {
	const delayed = deferred<HelmResult<unknown>>()
	const calls: Call[] = []
	const timers: Array<() => void> = []
	let heartbeatCount = 0
	const controller = new ElectronResidencyController({
		loadControlToken: async () => 'control-1',
		request: <T>(operation: Operation, capability: string, timeoutMs: number) => {
			calls.push({ operation, capability, timeoutMs })
			if (operation === 'issue') return Promise.resolve(ok({ capability: 'lease-1', expiresAt: 1 }) as HelmResult<T>)
			if (operation === 'tick') return Promise.resolve(ok({}) as HelmResult<T>)
			if (operation === 'heartbeat') {
				heartbeatCount += 1
				return delayed.promise as Promise<HelmResult<T>>
			}
			return Promise.resolve(ok({}) as HelmResult<T>)
		},
		setTimer: (callback: () => void) => {
			timers.push(callback)
			return timers.length as unknown as ReturnType<typeof setTimeout>
		},
		clearTimer: () => {},
		heartbeatMs: 1,
	})
	await controller.start()
	const cycleTimer = timers[0]
	assert.ok(cycleTimer)
	cycleTimer()
	cycleTimer()
	await flush()
	assert.equal(heartbeatCount, 1)
	delayed.resolve(ok({ capability: 'lease-1', expiresAt: 2 }))
	await flush()
	assert.equal(calls.filter(call => call.operation === 'tick').length, 2)
})

test('a 401 heartbeat reissues control auth and ticks the replacement lease', async () => {
	const f = fixture({
		tokens: ['control-1', 'control-2'],
		responses: {
			issue: [ok({ capability: 'lease-1', expiresAt: 1 }), ok({ capability: 'lease-2', expiresAt: 2 })],
			tick: [ok({}), ok({})],
			heartbeat: [{ error: 'expired', status: 401 }],
		},
	})
	await f.controller.start()
	const heartbeatTimer = f.timers[0]
	assert.ok(heartbeatTimer)
	heartbeatTimer()
	await flush()
	assert.deepEqual(
		f.calls.map(call => [call.operation, call.capability]),
		[
			['issue', 'control-1'],
			['tick', 'lease-1'],
			['heartbeat', 'lease-1'],
			['issue', 'control-2'],
			['tick', 'lease-2'],
		],
	)
})

test('startup and restart network gaps stop ticks but retry fresh control-authenticated acquisition', async () => {
	const f = fixture({
		tokens: ['control-1', 'control-2', 'control-3'],
		responses: {
			issue: [
				{ error: 'daemon starting' },
				ok({ capability: 'lease-2', expiresAt: 2 }),
				ok({ capability: 'lease-3', expiresAt: 3 }),
			],
			tick: [ok({}), ok({})],
			heartbeat: [{ error: 'daemon restarting' }],
		},
	})
	await f.controller.start()
	assert.deepEqual(
		f.calls.map(call => call.operation),
		['issue'],
	)
	assert.equal(f.timers.length, 1)
	f.timers.shift()?.()
	await flush()
	assert.deepEqual(
		f.calls.map(call => call.operation),
		['issue', 'issue', 'tick'],
	)
	f.timers.shift()?.()
	await flush()
	assert.deepEqual(
		f.calls.map(call => call.operation),
		['issue', 'issue', 'tick', 'heartbeat'],
	)
	f.timers.shift()?.()
	await flush()
	assert.deepEqual(
		f.calls.map(call => call.operation),
		['issue', 'issue', 'tick', 'heartbeat', 'issue', 'tick'],
	)
})

test('a repeatedly expired lease stops future ticks rather than looping reissue', async () => {
	const f = fixture({
		tokens: ['control-1', 'control-2'],
		responses: {
			issue: [ok({ capability: 'lease-1', expiresAt: 1 }), ok({ capability: 'lease-2', expiresAt: 2 })],
			tick: [
				{ error: 'expired', status: 401 },
				{ error: 'expired again', status: 401 },
			],
			revoke: [ok({ revoked: true })],
		},
	})
	await f.controller.start()
	assert.equal(f.timers.length, 1, 'retry is delayed instead of looping in the current cycle')
	await f.controller.stop()
	assert.deepEqual(
		f.calls.map(call => [call.operation, call.capability]),
		[
			['issue', 'control-1'],
			['tick', 'lease-1'],
			['issue', 'control-2'],
			['tick', 'lease-2'],
			['revoke', 'lease-2'],
		],
	)
})

test('stop waits for an in-flight tick and revokes once without scheduling another cycle', async () => {
	const tick = deferred<HelmResult<unknown>>()
	const calls: Call[] = []
	const timers: Array<() => void> = []
	const controller = new ElectronResidencyController({
		loadControlToken: async () => 'control-1',
		request: <T>(operation: Operation, capability: string, timeoutMs: number) => {
			calls.push({ operation, capability, timeoutMs })
			if (operation === 'issue') return Promise.resolve(ok({ capability: 'lease-1', expiresAt: 1 }) as HelmResult<T>)
			if (operation === 'tick') return tick.promise as Promise<HelmResult<T>>
			return Promise.resolve(ok({ revoked: true }) as HelmResult<T>)
		},
		setTimer: (callback: () => void) => {
			timers.push(callback)
			return timers.length as unknown as ReturnType<typeof setTimeout>
		},
		clearTimer: () => {},
	})
	const started = controller.start()
	await flush()
	const stopped = controller.stop()
	tick.resolve(ok({}))
	await Promise.all([started, stopped])
	assert.deepEqual(
		calls.map(call => [call.operation, call.capability]),
		[
			['issue', 'control-1'],
			['tick', 'lease-1'],
			['revoke', 'lease-1'],
		],
	)
	assert.equal(timers.length, 0)
})

test('failed token loading and repeated start/stop calls are inert and idempotent', async () => {
	let loads = 0
	let calls = 0
	const controller = new ElectronResidencyController({
		loadControlToken: async () => {
			loads += 1
			throw new Error('private token failure')
		},
		request: async <T>(): Promise<HelmResult<T>> => {
			calls += 1
			return { data: {} as T }
		},
	})
	const first = controller.start()
	const second = controller.start()
	assert.strictEqual(first, second)
	await first
	const stopped = controller.stop()
	assert.strictEqual(stopped, controller.stop())
	await stopped
	assert.equal(loads, 1)
	assert.equal(calls, 0)
})

test('HelmBridge keeps control auth on issue and sends only resident capability afterward', async () => {
	const calls: Array<{
		method: string
		path: string
		body: unknown
		timeoutMs: number | undefined
		headers: Record<string, string> | undefined
	}> = []
	const bridge = new HelmBridge('http://127.0.0.1:7474', () => true, {
		request: async <T>(
			method: 'GET' | 'POST' | 'PUT',
			path: string,
			body: unknown,
			timeoutMs: number | undefined,
			headers: Record<string, string> | undefined,
		): Promise<HelmResult<T>> => {
			calls.push({ method, path, body, timeoutMs, headers })
			return { data: {} as T }
		},
	})
	await bridge.scheduledResidentLease('issue', 'control-secret', 7)
	await bridge.scheduledResidentLease('heartbeat', 'lease-secret', 7)
	assert.deepEqual(calls, [
		{
			method: 'POST',
			path: '/scheduled-runs/lease',
			body: undefined,
			timeoutMs: 7,
			headers: { Authorization: 'Bearer control-secret' },
		},
		{
			method: 'POST',
			path: '/scheduled-runs/lease/heartbeat',
			body: { capability: 'lease-secret' },
			timeoutMs: 7,
			headers: undefined,
		},
	])
})

test('resident lifecycle stays main-only and quits only after existing guards', () => {
	const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
	const bridge = readFileSync(new URL('../app/src/helm-bridge.ts', import.meta.url), 'utf8')
	const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
	const shared = readFileSync(new URL('../app/src/shared-helm.ts', import.meta.url), 'utf8')
	assert.ok(main.indexOf('helmBridge.start()') < main.indexOf('scheduledResidency.start()'))
	assert.match(main, /if \(!screenshotPath && !profileSwitchAttestationMode\) void scheduledResidency\.start\(\)/)
	const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('will-quit'"))
	assert.ok(quit.indexOf('terminalTransferMain?.isBusy()') < quit.indexOf('scheduledResidency.stop()'))
	assert.ok(quit.indexOf('runContextWindows.hasDirtyWindows()') < quit.indexOf('scheduledResidency.stop()'))
	assert.match(quit, /event\.preventDefault\(\)[\s\S]*scheduledResidency\.stop\(\)[\s\S]*app\.quit\(\)/)
	assert.match(bridge, /scheduledResidentLease/)
	assert.match(bridge, /Authorization: `Bearer \$\{capability\}`/)
	assert.doesNotMatch(bridge.slice(bridge.indexOf('registerIpc')), /scheduledResidentLease/)
	assert.doesNotMatch(preload, /scheduledResident|resident lease/i)
	assert.doesNotMatch(shared, /scheduledResident|resident lease/i)
})
