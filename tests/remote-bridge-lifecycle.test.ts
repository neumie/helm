import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { QUESTION_CLOSED, QUESTION_OPEN } from '../packages/helm-ask-user-question/remote-answers.js'
import helmRemoteBridge from '../packages/helm-remote-bridge/index.js'
import { createScopedCapability } from '../src/auth/scoped-capability.js'
import type { RemoteSnapshot } from '../src/remote/protocol.js'

function json(response: ServerResponse, status: number, value: unknown) {
	response.writeHead(status, { 'Content-Type': 'application/json' })
	response.end(JSON.stringify(value))
}

function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolvePromise, reject) => {
		const chunks: Buffer[] = []
		request.on('data', (chunk: Buffer) => chunks.push(chunk))
		request.on('error', reject)
		request.on('end', () => {
			try {
				resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
			} catch (error) {
				reject(error)
			}
		})
	})
}

async function bridgeHarness(input: {
	exchange: (response: ServerResponse, count: number) => void
	holdRegistration?: boolean
}) {
	// Each harness models a separate Pi process; production never resets this latch.
	const policyKey = Symbol.for('helm.remote.manual-only.v1')
	const priorPolicy = Object.getOwnPropertyDescriptor(process, policyKey)
	Reflect.deleteProperty(process, policyKey)
	const root = mkdtempSync('/tmp/hr-lifecycle-')
	chmodSync(root, 0o700)
	const remote = join(root, '.helm', 'remote')
	mkdirSync(remote, { recursive: true, mode: 0o700 })
	chmodSync(remote, 0o700)
	const socketPath = join(remote, 'control.sock')
	const hostSocketPath = join(remote, 'host.sock')
	const capability = createScopedCapability()
	const bus = new EventEmitter()
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>()
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
	const exchanges: number[] = []
	const snapshots: RemoteSnapshot[] = []
	const exchangeEnrollmentIds: string[] = []
	const notifications: string[] = []
	let registrationRequests = 0
	let registrationAborts = 0
	const sessionId = randomUUID()
	const context = {
		mode: 'tui',
		cwd: root,
		model: undefined,
		ui: {
			notify(message: string) {
				notifications.push(message)
			},
		},
		get sessionManager() {
			return {
				getSessionId: () => sessionId,
				getLeafId: () => null,
				getEntry: () => undefined,
			}
		},
		isIdle: () => true,
		abort() {},
	}
	const route = (request: IncomingMessage, response: ServerResponse) => {
		void (async () => {
			const value = await body(request)
			if (request.url === '/bridge-register') {
				registrationRequests++
				if (input.holdRegistration) {
					response.on('close', () => {
						if (!response.writableEnded) registrationAborts++
					})
					return
				}
				json(response, 201, {
					protocol: 1,
					enrollmentId: randomUUID(),
					capability,
					scopeId: null,
					generation: 1,
					socketPath: hostSocketPath,
				})
				return
			}
			if (request.url === '/exchange') {
				exchanges.push(Date.now())
				snapshots.push(value.snapshot as RemoteSnapshot)
				if (typeof value.enrollmentId === 'string') exchangeEnrollmentIds.push(value.enrollmentId)
				input.exchange(response, exchanges.length)
				return
			}
			json(response, 404, { error: 'not_found' })
		})().catch(() => json(response, 500, { error: 'test_server' }))
	}
	const server = createServer(route)
	const exchangeServer = createServer(route)
	await new Promise<void>(resolvePromise => server.listen(socketPath, resolvePromise))
	await new Promise<void>(resolvePromise => exchangeServer.listen(hostSocketPath, resolvePromise))
	writeFileSync(join(remote, 'bridge-registration.json'), JSON.stringify({ protocol: 1, capability, socketPath }), {
		mode: 0o600,
	})
	const oldHome = process.env.HOME
	const oldSubagent = process.env.PI_SUBAGENT_CHILD
	process.env.HOME = root
	Reflect.deleteProperty(process.env, 'PI_SUBAGENT_CHILD')
	const pi = {
		events: {
			on(channel: string, handler: (value: unknown) => void) {
				bus.on(channel, handler)
				return () => bus.off(channel, handler)
			},
			emit(channel: string, value: unknown) {
				bus.emit(channel, value)
			},
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			const current = handlers.get(event) ?? []
			current.push(handler)
			handlers.set(event, current)
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, command.handler)
		},
		getSessionName: () => 'Lifecycle Pi',
		sendUserMessage() {},
	}
	helmRemoteBridge(pi as never)
	return {
		context,
		exchanges,
		snapshots,
		exchangeEnrollmentIds,
		notifications,
		get registrationRequests() {
			return registrationRequests
		},
		get registrationAborts() {
			return registrationAborts
		},
		bus,
		emit(event: string) {
			for (const handler of handlers.get(event) ?? []) handler({}, context)
		},
		async command(name: string, args = '') {
			const handler = commands.get(name)
			assert.ok(handler, `missing ${name} command`)
			await handler(args, context)
		},
		async until(predicate, description, timeout = 5000) {
			const deadline = Date.now() + timeout
			while (Date.now() < deadline) {
				if (predicate()) return
				await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
			}
			throw new Error(
				`timed out waiting for ${description}; registration=${registrationRequests}; exchanges=${exchanges.length}; startHandlers=${handlers.get('session_start')?.length ?? 0}`,
			)
		},
		async dispose() {
			for (const handler of handlers.get('session_shutdown') ?? []) handler({}, context)
			server.closeAllConnections()
			exchangeServer.closeAllConnections()
			await Promise.all([
				new Promise<void>(resolvePromise => server.close(() => resolvePromise())),
				new Promise<void>(resolvePromise => exchangeServer.close(() => resolvePromise())),
			])
			if (oldHome === undefined) Reflect.deleteProperty(process.env, 'HOME')
			else process.env.HOME = oldHome
			if (oldSubagent === undefined) Reflect.deleteProperty(process.env, 'PI_SUBAGENT_CHILD')
			else process.env.PI_SUBAGENT_CHILD = oldSubagent
			if (priorPolicy) Object.defineProperty(process, policyKey, priorPolicy)
			else Reflect.deleteProperty(process, policyKey)
			rmSync(root, { recursive: true, force: true })
		},
	}
}

const exchangeOk = (response: ServerResponse) =>
	json(response, 200, { protocol: 1, hostEpoch: randomUUID(), commands: [] })

test('owner conflict retries use one unused grant with bounded exponential backoff', { timeout: 10_000 }, async t => {
	const hostEpoch = randomUUID()
	const harness = await bridgeHarness({
		exchange(response, count) {
			if (count <= 3) json(response, 409, { error: 'owner_conflict' })
			else json(response, 200, { protocol: 1, hostEpoch, commands: [] })
		},
	})
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => harness.exchanges.length === 4, 'three conflicts followed by a successful exchange', 9000)
	assert.equal(harness.registrationRequests, 1)
	assert.equal(new Set(harness.exchangeEnrollmentIds).size, 1)
	const intervals = harness.exchanges.slice(1).map((at, index) => at - harness.exchanges[index])
	assert.ok(intervals[0] >= 400, `first retry was not backed off: ${intervals[0]}ms`)
	assert.ok(intervals[1] >= 850, `second retry was not exponentially backed off: ${intervals[1]}ms`)
	assert.ok(intervals[2] >= 1_700, `third retry was not exponentially backed off: ${intervals[2]}ms`)
})

test('unresolved switch/fork fences reject tree completion, manual enrollment, and network recovery', async t => {
	for (const before of ['session_before_switch', 'session_before_fork'])
		await t.test(before, async subtest => {
			const harness = await bridgeHarness({ exchange: exchangeOk })
			subtest.after(() => harness.dispose())
			harness.emit('session_start')
			await harness.until(() => harness.exchanges.length === 1, 'initial exchange')
			harness.emit(before)
			await harness.command('helm-remote-connect', join('/tmp', 'does-not-matter.json'))
			harness.emit('session_tree')
			await new Promise(resolvePromise => setTimeout(resolvePromise, 700))
			assert.equal(harness.registrationRequests, 1)
			assert.equal(harness.exchanges.length, 1)
			assert.ok(harness.notifications.includes('Remote remains paused until a fresh Pi lifecycle.'))
		})
})

test('an unobserved cancellation does not fabricate a navigation fence', async t => {
	const harness = await bridgeHarness({ exchange: exchangeOk })
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => harness.exchanges.length === 1, 'initial exchange')
	// No before-navigation hook reached the bridge, as with a cancellation before Pi emits it.
	harness.emit('session_tree')
	await harness.until(() => harness.exchanges.length >= 2, 'continued observation without a fence')
	assert.equal(harness.registrationRequests, 1)
})

test('an older tree success cannot clear a newer overlapping navigation fence', async t => {
	const harness = await bridgeHarness({ exchange: exchangeOk })
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => harness.exchanges.length === 1, 'initial exchange')
	harness.emit('session_before_tree')
	harness.emit('session_before_tree')
	harness.emit('session_tree')
	await new Promise(resolvePromise => setTimeout(resolvePromise, 700))
	assert.equal(harness.registrationRequests, 1)
	assert.equal(harness.exchanges.length, 1)
	// A fresh lifecycle is the allowed recovery boundary; an older tree event is not.
	harness.emit('session_start')
	await harness.until(() => harness.registrationRequests === 2, 'fresh lifecycle registration')
})

test('explicit disconnect disables pending owner-conflict retries', async t => {
	const harness = await bridgeHarness({ exchange: response => json(response, 409, { error: 'owner_conflict' }) })
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => harness.exchanges.length === 1, 'first owner conflict')
	await harness.command('helm-remote-disconnect')
	await new Promise(resolvePromise => setTimeout(resolvePromise, 700))
	assert.equal(harness.registrationRequests, 1)
	assert.equal(harness.exchanges.length, 1)
	assert.ok(harness.notifications.includes('Remote disconnected'))
})

test('navigation aborts registration and shutdown removes question listeners', async t => {
	const harness = await bridgeHarness({ exchange: exchangeOk, holdRegistration: true })
	t.after(() => harness.dispose())
	assert.equal(harness.bus.listenerCount(QUESTION_OPEN), 1)
	assert.equal(harness.bus.listenerCount(QUESTION_CLOSED), 1)
	harness.emit('session_start')
	await harness.until(() => harness.registrationRequests === 1, 'outstanding registration request')
	harness.emit('session_before_tree')
	await harness.until(() => harness.registrationAborts === 1, 'navigation abort of registration')
	assert.equal(harness.registrationRequests, 1)
	harness.emit('session_shutdown')
	assert.equal(harness.bus.listenerCount(QUESTION_OPEN), 0)
	assert.equal(harness.bus.listenerCount(QUESTION_CLOSED), 0)
})

test('shutdown aborts an outstanding registration request', async t => {
	const harness = await bridgeHarness({ exchange: exchangeOk, holdRegistration: true })
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => harness.registrationRequests === 1, 'outstanding registration request')
	harness.emit('session_shutdown')
	await harness.until(() => harness.registrationAborts === 1, 'shutdown abort of registration')
	assert.equal(harness.bus.listenerCount(QUESTION_OPEN), 0)
	assert.equal(harness.bus.listenerCount(QUESTION_CLOSED), 0)
})

test('mocked public custom UI observation survives registration and host loss but not navigation', async t => {
	const hostEpoch = randomUUID()
	let rejectNext = false
	const harness = await bridgeHarness({
		exchange(response) {
			if (rejectNext) {
				rejectNext = false
				json(response, 401, { error: 'expired' })
			} else json(response, 200, { protocol: 1, hostEpoch, commands: [] })
		},
	})
	t.after(() => harness.dispose())
	harness.emit('session_start')
	harness.emit('ui_prompt_start')
	await harness.until(() => harness.snapshots.length > 0, 'initial waiting snapshot')
	assert.equal(harness.snapshots.at(-1)?.activity, 'waiting')
	assert.equal(harness.snapshots.at(-1)?.capabilities.prompt, false)
	assert.equal(harness.snapshots.at(-1)?.capabilities.answer, false)
	rejectNext = true
	await harness.until(
		() => harness.registrationRequests === 2 && harness.snapshots.length >= 3,
		'replaced waiting transport',
	)
	assert.equal(harness.snapshots.at(-1)?.activity, 'waiting')
	harness.emit('ui_prompt_end')
	await harness.until(() => harness.snapshots.at(-1)?.activity === 'idle', 'outermost prompt ended')
	harness.emit('session_before_tree')
	harness.emit('ui_prompt_start') // Late old-context UI must not reopen the fence.
	harness.bus.emit(QUESTION_OPEN, {
		requestId: randomUUID(),
		questions: [
			{
				question: 'Old dialog',
				header: 'Old',
				options: [
					{ label: 'First', description: 'First' },
					{ label: 'Second', description: 'Second' },
				],
			},
		],
	})
	harness.emit('session_tree')
	await harness.until(
		() => harness.registrationRequests === 3 && harness.snapshots.at(-1)?.activity === 'idle',
		'clean tree context',
	)
	assert.equal(harness.snapshots.at(-1)?.question, null)
	assert.equal(harness.snapshots.at(-1)?.capabilities.prompt, true)
})
