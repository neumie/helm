import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import accessModule from '../app/src/run-context-access.ts'
import bridgeModule from '../app/src/run-context-bridge.ts'
import precommitModule from '../app/src/run-context-switch-precommit.ts'

const { RunContextAccess } = accessModule
const { RunContextBridgeOperations } = bridgeModule
const { prepareRunContextProfileSwitch } = precommitModule

type Deferred<T> = {
	promise: Promise<T>
	resolve(value: T): void
	reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

async function settles(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([promise.then(() => true), Promise.resolve(false)])
}

const document = { version: 1 as const, blocks: [], markdown: '' }

type RunContextOperation = 'load' | 'save' | 'reset'

function runOperation(
	access: InstanceType<typeof RunContextAccess>,
	bridge: InstanceType<typeof RunContextBridgeOperations>,
	operation: RunContextOperation,
) {
	return access.runForEditor(1, itemId => {
		if (operation === 'load') return bridge.load(itemId, 'token')
		if (operation === 'save') return bridge.save(itemId, 1, document, 'token')
		return bridge.reset(itemId, 1, 'token')
	})
}

const preload = readFileSync(new URL('../app/src/preload-run-context.ts', import.meta.url), 'utf8')
const windowManager = readFileSync(new URL('../app/src/run-context-window.ts', import.meta.url), 'utf8')
const editor = readFileSync(new URL('../app/src/renderer/run-context/RunContextEditor.tsx', import.meta.url), 'utf8')

test('run-context preload exposes only the narrow editor capability set', () => {
	assert.match(preload, /contextBridge\.exposeInMainWorld\('runContextEditor'/)
	for (const channel of [
		'run-context:load',
		'run-context:save',
		'run-context:reset',
		'run-context:dirty',
		'run-context:close',
		'run-context:cancel-close',
	]) {
		assert.match(preload, new RegExp(channel))
	}
	for (const forbidden of ['window.helm', 'pty:', 'session:', 'daemon:config', 'shell:']) {
		assert.doesNotMatch(preload, new RegExp(forbidden.replace(':', '\\:')))
	}
	assert.match(preload, /ipcRenderer\.sendSync\('config:get'\)/)
	assert.match(preload, /run-context:load', sessionProfileToken/)
	assert.match(preload, /run-context:save', revision, document, sessionProfileToken/)
	assert.match(preload, /run-context:reset', revision, sessionProfileToken/)
	assert.doesNotMatch(preload, /getDaemonUrl|daemonUrl/)
})

test('deferred load/save/reset requests each hold the precommit drain until settled', async () => {
	for (const operation of ['load', 'save', 'reset'] as const) {
		for (const outcome of ['resolve', 'reject'] as const) {
			const access = new RunContextAccess()
			access.registerEditor(1, 'item-a', () => false)
			const request = deferred<{ data: Record<string, never> }>()
			let requests = 0
			const bridge = new RunContextBridgeOperations({
				acceptsProfileToken: () => true,
				request: async () => {
					requests += 1
					return request.promise as never
				},
				kick: () => {},
			})
			const admitted = runOperation(access, bridge, operation)
			await Promise.resolve()
			assert.equal(requests, 1, `${operation} reached the bridge before drain`)
			const drain = access.beginProfileSwitchDrain(
				() => false,
				() => {},
			)
			assert.equal(drain.ok, true, operation)
			if (!drain.ok) throw new Error('unreachable')
			assert.equal(await settles(drain.drained), false, `${operation} drain must wait for its admitted request`)
			if (outcome === 'resolve') request.resolve({ data: {} })
			else request.reject(new Error(`${operation} failed`))
			await admitted.catch(() => undefined)
			await drain.drained
		}
	}
})

test('precommit starts daemon activation only after each admitted request drains', async () => {
	for (const operation of ['load', 'save', 'reset'] as const) {
		const access = new RunContextAccess()
		access.registerEditor(1, 'item-a', () => false)
		const request = deferred<{ data: Record<string, never> }>()
		const bridge = new RunContextBridgeOperations({
			acceptsProfileToken: () => true,
			request: async () => request.promise as never,
			kick: () => {},
		})
		void runOperation(access, bridge, operation)
		await Promise.resolve()
		let activated = false
		const switching = (async () => {
			const result = await prepareRunContextProfileSwitch({
				beginDrain: () =>
					access.beginProfileSwitchDrain(
						() => false,
						() => {},
					),
				flushBuffers: async () => {},
				beginBridgeFence: () => Promise.resolve(),
				advanceGeneration: () => {},
			})
			if (!result.ok) throw new Error('unexpected dirty refusal')
			activated = true // the daemon activation call follows this production precommit boundary
			result.release()
		})()
		await Promise.resolve()
		assert.equal(activated, false, `${operation} must block daemon activation`)
		request.resolve({ data: {} })
		await switching
		assert.equal(activated, true)
	}
})

test('drain closes admission, includes just-admitted work, and rejects open/load/save/reset without dispatch', async () => {
	const access = new RunContextAccess()
	access.registerEditor(1, 'item-a', () => false)
	let calls = 0
	const first = access.runForEditor(1, async () => {
		calls += 1
	})
	const drain = access.beginProfileSwitchDrain(
		() => false,
		() => {},
	)
	assert.equal(drain.ok, true)
	await first
	if (!drain.ok) throw new Error('unreachable')
	await drain.drained
	let bridgeRequests = 0
	const bridge = new RunContextBridgeOperations({
		acceptsProfileToken: () => true,
		request: async () => {
			bridgeRequests += 1
			return { data: {} } as never
		},
		kick: () => {},
	})
	for (const request of [
		() => access.assertAdmissionOpen(),
		() => runOperation(access, bridge, 'load'),
		() => runOperation(access, bridge, 'save'),
		() => runOperation(access, bridge, 'reset'),
	]) {
		assert.throws(request, /Profile is switching/)
	}
	assert.equal(calls, 1)
	assert.equal(bridgeRequests, 0)
	drain.release()
})

test('dirty refusal has zero close, flush, fence, generation, or activation effects', async () => {
	let closes = 0
	let flushes = 0
	let fences = 0
	let generations = 0
	let activations = 0
	const access = new RunContextAccess()
	const result = await prepareRunContextProfileSwitch({
		beginDrain: () =>
			access.beginProfileSwitchDrain(
				() => true,
				() => {
					closes += 1
				},
			),
		flushBuffers: async () => {
			flushes += 1
		},
		beginBridgeFence: () => {
			fences += 1
			return Promise.resolve()
		},
		advanceGeneration: () => {
			generations += 1
		},
	})
	if (result.ok) activations += 1
	assert.deepEqual(
		{ closes, flushes, fences, generations, activations },
		{ closes: 0, flushes: 0, fences: 0, generations: 0, activations: 0 },
	)
	assert.equal(result.ok, false)
	access.assertAdmissionOpen()
})

test('sender binding dispatches only the registered Item and rejects unknown or destroyed senders first', async () => {
	const access = new RunContextAccess()
	let destroyed = false
	access.registerEditor(1, 'item-a', () => false)
	access.registerEditor(2, 'item-b', () => destroyed)
	const dispatched: string[] = []
	await access.runForEditor(1, async itemId => void dispatched.push(itemId))
	await access.runForEditor(2, async itemId => void dispatched.push(itemId))
	assert.deepEqual(dispatched, ['item-a', 'item-b'])
	assert.throws(() => access.runForEditor(3, async itemId => void dispatched.push(itemId)), /not registered/)
	destroyed = true
	assert.throws(() => access.runForEditor(2, async itemId => void dispatched.push(itemId)), /not registered/)
	assert.deepEqual(dispatched, ['item-a', 'item-b'])
})

test('a stale drain release cannot reopen admission during a later switch', () => {
	const access = new RunContextAccess()
	const first = access.beginProfileSwitchDrain(
		() => false,
		() => {},
	)
	assert.equal(first.ok, true)
	if (!first.ok) throw new Error('unreachable')
	const second = access.beginProfileSwitchDrain(
		() => false,
		() => {},
	)
	assert.equal(second.ok, true)
	if (!second.ok) throw new Error('unreachable')
	first.release()
	assert.throws(() => access.assertAdmissionOpen(), /Profile is switching/)
	second.release()
	access.assertAdmissionOpen()
})

test('unexpected precommit failures release only their own admission lease', async () => {
	for (const phase of ['flush', 'fence'] as const) {
		const access = new RunContextAccess()
		const failed = await prepareRunContextProfileSwitch({
			beginDrain: () =>
				access.beginProfileSwitchDrain(
					() => false,
					() => {},
				),
			flushBuffers: async () => {
				if (phase === 'flush') throw new Error('flush failed')
			},
			beginBridgeFence: () => {
				if (phase === 'fence') throw new Error('fence failed')
				return Promise.resolve()
			},
			advanceGeneration: () => assert.fail('must not advance'),
		})
		assert.equal(failed.ok, false, phase)
		access.assertAdmissionOpen()
	}
})

test('bridge token checks reject stale pre-dispatch and post-await requests; stale writes never kick', async () => {
	for (const operation of ['load', 'save', 'reset'] as const) {
		const valid = false
		let requests = 0
		let kicks = 0
		const bridge = new RunContextBridgeOperations({
			acceptsProfileToken: () => valid,
			request: async () => {
				requests += 1
				return { data: {} } as never
			},
			kick: () => {
				kicks += 1
			},
		})
		const result =
			operation === 'load'
				? await bridge.load('item-a', 'old')
				: operation === 'save'
					? await bridge.save('item-a', 1, { version: 1, blocks: [], markdown: '' }, 'old')
					: await bridge.reset('item-a', 1, 'old')
		assert.equal(result.status, 409)
		assert.equal(requests, 0)
		assert.equal(kicks, 0)
	}

	for (const operation of ['load', 'save', 'reset'] as const) {
		let valid = true
		let kicks = 0
		const response = deferred<{ data: Record<string, never> }>()
		const bridge = new RunContextBridgeOperations({
			acceptsProfileToken: () => valid,
			request: async () => response.promise as never,
			kick: () => {
				kicks += 1
			},
		})
		const pending =
			operation === 'load'
				? bridge.load('item-a', 'token')
				: operation === 'save'
					? bridge.save('item-a', 1, { version: 1, blocks: [], markdown: '' }, 'token')
					: bridge.reset('item-a', 1, 'token')
		valid = false
		response.resolve({ data: {} })
		assert.equal((await pending).status, 409, operation)
		assert.equal(kicks, 0, `${operation} stale completion must not kick`)
	}
})

test('valid save/reset kick exactly once and daemon errors do not kick', async () => {
	for (const operation of ['save', 'reset'] as const) {
		let kicks = 0
		const bridge = new RunContextBridgeOperations({
			acceptsProfileToken: () => true,
			request: async () => ({ data: {} }) as never,
			kick: () => {
				kicks += 1
			},
		})
		if (operation === 'save') await bridge.save('item-a', 1, { version: 1, blocks: [], markdown: '' }, 'token')
		else await bridge.reset('item-a', 1, 'token')
		assert.equal(kicks, 1)
	}
	let kicks = 0
	const failed = new RunContextBridgeOperations({
		acceptsProfileToken: () => true,
		request: async () => ({ error: 'daemon failed', status: 500 }),
		kick: () => {
			kicks += 1
		},
	})
	await failed.save('item-a', 1, { version: 1, blocks: [], markdown: '' }, 'token')
	assert.equal(kicks, 0)
})

test('run-context editor freezes one consistent document during writes', () => {
	assert.match(editor, /const blocks = editor\.document/)
	assert.match(editor, /blocksToMarkdownLossy\(blocks\)/)
	assert.match(editor, /editable=\{!locked && busy === null\}/)
})

test('run-context editor omits metadata rows and names source files clearly', () => {
	assert.doesNotMatch(editor, /loaded\.source\.metadata/)
	assert.match(editor, />Source attachments</)
})

test('a clean run-context editor refreshes lifecycle lock state when focus returns without replacing edits', () => {
	assert.match(editor, /window\.addEventListener\('focus', refreshOnFocus\)/)
	assert.match(editor, /dirtyRef\.current = true[\s\S]*setDirty\(true\)/)
	assert.match(editor, /if \(!active \|\| dirtyRef\.current \|\| result\.error !== undefined\) return/)
	assert.match(editor, /result\.data\.item\.status !== loaded\.item\.status/)
})

test('run-context BrowserWindow keeps renderer privileges disabled', () => {
	assert.match(windowManager, /contextIsolation:\s*true/)
	assert.match(windowManager, /nodeIntegration:\s*false/)
	assert.match(windowManager, /sandbox:\s*true/)
	assert.match(windowManager, /setWindowOpenHandler/)
	assert.match(windowManager, /will-navigate/)
	assert.match(windowManager, /this\.byItem\.get\(id\)/)
	assert.match(windowManager, /existing\.window\.focus\(\)/)
})
