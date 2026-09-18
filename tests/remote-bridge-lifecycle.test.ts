import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { QUESTION_ANSWER, QUESTION_CLOSED, QUESTION_OPEN } from '../packages/helm-ask-user-question/remote-answers.js'
import helmRemoteBridge from '../packages/helm-remote-bridge/index.js'
import { createScopedCapability } from '../src/auth/scoped-capability.js'
import { type HistoryDescriptor, type HistoryResult, historyResultSchema } from '../src/remote/history-protocol.js'
import type { HistoryManager } from '../src/remote/history-reader.js'
import type { RemoteSnapshot } from '../src/remote/protocol.js'
import { baselineJpeg } from './fixtures/remote-image-input.js'

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
	exchange: (response: ServerResponse, count: number, snapshot: RemoteSnapshot, request: IncomingMessage) => void
	historyResult?: (response: ServerResponse, result: HistoryResult) => void
	imageInput?: (response: ServerResponse, value: Record<string, unknown>) => void
	sendUserMessage?: () => void
	holdRegistration?: boolean
	model?: { provider: string; id: string; input: Array<'text' | 'image'> }
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
	const receivedReceipts: unknown[] = []
	const exchangeEnrollmentIds: string[] = []
	const notifications: string[] = []
	let registrationRequests = 0
	let registrationAborts = 0
	let sessionId = randomUUID()
	let manager: HistoryManager = { getLeafId: () => null, getEntry: () => undefined }
	let managerReads = 0
	let effects = 0
	const sentMessages: Array<{ content: unknown; options: unknown }> = []
	const historyResults: HistoryResult[] = []
	let selectedModel = input.model
	const context = {
		mode: 'tui',
		cwd: root,
		get model() {
			return selectedModel
		},
		ui: {
			notify(message: string) {
				notifications.push(message)
			},
		},
		get sessionManager() {
			managerReads++
			return { ...manager, getSessionId: () => sessionId }
		},
		isIdle: () => true,
		abort() {
			effects++
		},
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
				if (Array.isArray(value.receipts)) receivedReceipts.push(...value.receipts)
				if (typeof value.enrollmentId === 'string') exchangeEnrollmentIds.push(value.enrollmentId)
				input.exchange(response, exchanges.length, snapshots[snapshots.length - 1], request)
				return
			}
			if (request.url === '/image-input') {
				if (input.imageInput) input.imageInput(response, value)
				else json(response, 409, { error: 'image_unavailable' })
				return
			}
			if (request.url === '/history-result') {
				const result = historyResultSchema.parse(value)
				historyResults.push(result)
				if (input.historyResult) input.historyResult(response, result)
				else json(response, 200, { ok: true })
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
	const isolatedKeys = [
		'OKENA_TERMINAL_ID',
		'HELM_REMOTE_TERMINAL_ID',
		'HELM_REMOTE_TERMINAL_REGISTRY',
		'HELM_REMOTE_DISABLE_AUTO',
	]
	const oldEnvironment = isolatedKeys.map(key => [key, process.env[key]] as const)
	for (const key of isolatedKeys) Reflect.deleteProperty(process.env, key)
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
				if (channel === QUESTION_ANSWER) effects++
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
		sendUserMessage(content: unknown, options: unknown) {
			effects++
			sentMessages.push({ content, options })
			input.sendUserMessage?.()
		},
	}
	helmRemoteBridge(pi as never)
	return {
		context,
		historyResults,
		sentMessages,
		get effects() {
			return effects
		},
		get managerReads() {
			return managerReads
		},
		setManager(value: HistoryManager, id = sessionId) {
			manager = value
			sessionId = id
		},
		setModel(value: typeof selectedModel) {
			selectedModel = value
		},
		exchanges,
		snapshots,
		receivedReceipts,
		exchangeEnrollmentIds,
		notifications,
		get registrationRequests() {
			return registrationRequests
		},
		get registrationAborts() {
			return registrationAborts
		},
		bus,
		emit(event: string, value: unknown = {}) {
			for (const handler of handlers.get(event) ?? []) handler(value, context)
		},
		async command(name: string, args = '') {
			const handler = commands.get(name)
			assert.ok(handler, `missing ${name} command`)
			await handler(args, context)
		},
		async until(predicate: () => boolean, description: string, timeout = 5000) {
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
			for (const [key, value] of oldEnvironment) {
				if (value === undefined) Reflect.deleteProperty(process.env, key)
				else process.env[key] = value
			}
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

test('actual bridge rejects image-only and captioned commands without invoking Pi', async t => {
	const hostEpoch = randomUUID()
	const imageIds = [randomUUID(), randomUUID()]
	const textId = randomUUID()
	let sendText = false
	let textSent = false
	const harness = await bridgeHarness({
		exchange(response, count, snapshot) {
			const operations =
				count === 2
					? imageIds.map((id, index) => ({ id, text: index === 0 ? '' : 'caption', image: true }))
					: sendText && !textSent
						? [{ id: textId, text: 'ordinary text', image: false }]
						: []
			if (operations.some(operation => !operation.image)) textSent = true
			json(response, 200, {
				protocol: 1,
				hostEpoch,
				commands: operations.map(operation => ({
					expiresAt: Date.now() + 10_000,
					command: {
						protocol: 1,
						hostEpoch,
						commandId: operation.id,
						target: snapshot.target,
						operation: {
							kind: 'prompt',
							text: operation.text,
							delivery: 'followUp',
							...(operation.image
								? {
										images: [
											{
												handle: randomUUID(),
												sha256: 'a'.repeat(64),
												mimeType: 'image/jpeg',
												bytes: 100,
												width: 1,
												height: 1,
											},
										],
									}
								: {}),
						},
					},
				})),
			})
		},
	})
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => harness.receivedReceipts.length >= 2, 'image rejections returned by the real bridge')
	assert.deepEqual(
		harness.receivedReceipts,
		imageIds.map(commandId => ({ commandId, status: 'rejected' })),
	)
	assert.equal(harness.effects, 0)
	sendText = true
	await harness.until(() => harness.effects === 1, 'ordinary text still invokes Pi')
	await harness.until(() => harness.receivedReceipts.length >= 3, 'text dispatch receipt')
	assert.deepEqual(harness.receivedReceipts[2], { commandId: textId, status: 'dispatched' })
	assert.equal(harness.effects, 1)
})

test('bridge delivers image-only and captioned JPEG bytes once through typed Pi content', async t => {
	const hostEpoch = randomUUID()
	const dimensions = { width: 192, height: 192 }
	const image = {
		handle: randomUUID(),
		sha256: createHash('sha256').update(baselineJpeg).digest('hex'),
		mimeType: 'image/jpeg' as const,
		bytes: baselineJpeg.length,
		...dimensions,
	}
	const commandIds = [randomUUID(), randomUUID()]
	let sent = false
	const harness = await bridgeHarness({
		model: { provider: 'fixture', id: 'vision', input: ['text', 'image'] },
		exchange(response, count, snapshot, request) {
			assert.equal(request.headers['x-helm-image-input'], '1')
			if (count === 1) assert.equal(snapshot.imageInput, undefined)
			else assert.deepEqual(snapshot.imageInput, { version: 1, available: true })
			response.setHeader('X-Helm-Image-Input', '1')
			const commands =
				count === 2 && !sent
					? commandIds.map((commandId, index) => ({
							expiresAt: Date.now() + 10_000,
							command: {
								protocol: 1,
								hostEpoch,
								commandId,
								target: snapshot.target,
								operation: {
									kind: 'prompt',
									text: index === 0 ? '' : 'caption',
									delivery: 'followUp',
									images: [image],
								},
							},
						}))
					: []
			if (commands.length) sent = true
			json(response, 200, { protocol: 1, hostEpoch, commands })
		},
		imageInput(response, value) {
			assert.deepEqual(value.image, image)
			response.writeHead(200, {
				'Content-Type': 'image/jpeg',
				'Content-Length': String(baselineJpeg.length),
				'X-Helm-Image-Input': '1',
			})
			response.end(baselineJpeg)
		},
	})
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => harness.sentMessages.length === 2, 'two typed image effects')
	await harness.until(() => harness.receivedReceipts.length >= 2, 'two image receipts')
	const encoded = baselineJpeg.toString('base64')
	assert.deepEqual(harness.sentMessages, [
		{
			content: [{ type: 'image', data: encoded, mimeType: 'image/jpeg' }],
			options: { deliverAs: 'followUp', expandPromptTemplates: false },
		},
		{
			content: [
				{ type: 'text', text: 'caption' },
				{ type: 'image', data: encoded, mimeType: 'image/jpeg' },
			],
			options: { deliverAs: 'followUp', expandPromptTemplates: false },
		},
	])
	assert.deepEqual(
		harness.receivedReceipts.slice(0, 2),
		commandIds.map(commandId => ({ commandId, status: 'dispatched' })),
	)
})

test('bridge rejects a partial image response without caption fallthrough', async t => {
	const hostEpoch = randomUUID()
	const commandId = randomUUID()
	const image = {
		handle: randomUUID(),
		sha256: createHash('sha256').update(baselineJpeg).digest('hex'),
		mimeType: 'image/jpeg' as const,
		bytes: baselineJpeg.length,
		width: 192,
		height: 192,
	}
	let sent = false
	const harness = await bridgeHarness({
		model: { provider: 'fixture', id: 'vision', input: ['text', 'image'] },
		exchange(response, count, snapshot) {
			response.setHeader('X-Helm-Image-Input', '1')
			const commands =
				count === 2 && !sent
					? [
							{
								expiresAt: Date.now() + 10_000,
								command: {
									protocol: 1,
									hostEpoch,
									commandId,
									target: snapshot.target,
									operation: { kind: 'prompt', text: 'must not send', delivery: 'followUp', images: [image] },
								},
							},
						]
					: []
			if (commands.length) sent = true
			json(response, 200, { protocol: 1, hostEpoch, commands })
		},
		imageInput(response) {
			response.writeHead(200, {
				'Content-Type': 'image/jpeg',
				'Content-Length': String(baselineJpeg.length),
				'X-Helm-Image-Input': '1',
			})
			response.end(baselineJpeg.subarray(0, baselineJpeg.length - 1))
		},
	})
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(
		() =>
			harness.receivedReceipts.some(
				receipt =>
					(receipt as { commandId?: string; status?: string }).commandId === commandId &&
					(receipt as { status?: string }).status === 'rejected',
			),
		'partial image rejection',
	)
	assert.equal(harness.effects, 0)
	assert.deepEqual(
		harness.receivedReceipts.find(
			receipt =>
				(receipt as { commandId?: string; status?: string }).commandId === commandId &&
				(receipt as { status?: string }).status === 'rejected',
		),
		{ commandId, status: 'rejected' },
	)
})

test('actual current model loss without an event cancels old image work and requires unavailable ACK', async t => {
	const hostEpoch = randomUUID()
	const image = {
		handle: randomUUID(),
		sha256: createHash('sha256').update(baselineJpeg).digest('hex'),
		mimeType: 'image/jpeg' as const,
		bytes: baselineJpeg.length,
		width: 192,
		height: 192,
	}
	const oldId = randomUUID()
	const freshId = randomUUID()
	let oldSent = false
	let freshSent = false
	let reads = 0
	let firstClosed = false
	const harness = await bridgeHarness({
		model: { provider: 'fixture', id: 'vision', input: ['text', 'image'] },
		exchange(response, count, snapshot) {
			response.setHeader('X-Helm-Image-Input', '1')
			const commands = []
			if (count === 2 && !oldSent) {
				oldSent = true
				commands.push({
					expiresAt: Date.now() + 10_000,
					command: {
						protocol: 1,
						hostEpoch,
						commandId: oldId,
						target: snapshot.target,
						operation: { kind: 'prompt', text: 'old', delivery: 'followUp', images: [image] },
					},
				})
			} else if (oldSent && !freshSent && snapshot.imageInput?.available === true && firstClosed) {
				freshSent = true
				commands.push({
					expiresAt: Date.now() + 10_000,
					command: {
						protocol: 1,
						hostEpoch,
						commandId: freshId,
						target: snapshot.target,
						operation: { kind: 'prompt', text: 'fresh', delivery: 'followUp', images: [image] },
					},
				})
			}
			json(response, 200, { protocol: 1, hostEpoch, commands })
		},
		imageInput(response) {
			reads++
			if (reads === 1) {
				response.once('close', () => {
					firstClosed = true
				})
				return
			}
			response.writeHead(200, {
				'Content-Type': 'image/jpeg',
				'Content-Length': String(baselineJpeg.length),
				'X-Helm-Image-Input': '1',
			})
			response.end(baselineJpeg)
		},
	})
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => reads === 1, 'old image retrieval')
	const noImage = { provider: 'fixture', id: 'text', input: ['text'] as Array<'text' | 'image'> }
	harness.setModel(noImage)
	await harness.until(() => firstClosed, 'cancelled image socket')
	await harness.until(
		() =>
			harness.receivedReceipts.some(
				value =>
					(value as { commandId?: string; status?: string }).commandId === oldId &&
					(value as { status?: string }).status === 'rejected',
			),
		'old image rejection',
	)
	assert.equal(harness.effects, 0)
	const vision = { provider: 'fixture', id: 'vision-again', input: ['text', 'image'] as Array<'text' | 'image'> }
	harness.setModel(vision)
	await harness.until(
		() => harness.snapshots.some(snapshot => snapshot.imageInput?.available === false),
		'unavailable publication',
	)
	await harness.until(() => harness.effects === 1, 'fresh image after unavailable ACK')
	assert.equal(reads, 2)
	assert.equal(Array.isArray(harness.sentMessages[0]?.content), true)
	await harness.until(
		() =>
			harness.receivedReceipts.some(
				value =>
					(value as { commandId?: string; status?: string }).commandId === freshId &&
					(value as { status?: string }).status === 'dispatched',
			),
		'fresh image dispatch receipt',
	)
})

test('async image terminal receipt survives replacement in an outstanding exchange batch', async t => {
	const hostEpoch = randomUUID()
	const commandId = randomUUID()
	const image = {
		handle: randomUUID(),
		sha256: createHash('sha256').update(baselineJpeg).digest('hex'),
		mimeType: 'image/jpeg' as const,
		bytes: baselineJpeg.length,
		width: 192,
		height: 192,
	}
	let imageResponse: ServerResponse | undefined
	let heldExchange: ServerResponse | undefined
	const harness = await bridgeHarness({
		model: { provider: 'fixture', id: 'vision', input: ['text', 'image'] },
		exchange(response, count, snapshot) {
			response.setHeader('X-Helm-Image-Input', '1')
			if (count === 3) {
				heldExchange = response
				return
			}
			json(response, 200, {
				protocol: 1,
				hostEpoch,
				commands:
					count === 2
						? [
								{
									expiresAt: Date.now() + 10_000,
									command: {
										protocol: 1,
										hostEpoch,
										commandId,
										target: snapshot.target,
										operation: { kind: 'prompt', text: 'caption', delivery: 'followUp', images: [image] },
									},
								},
							]
						: [],
			})
		},
		imageInput(response) {
			imageResponse = response
		},
	})
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => !!heldExchange && !!imageResponse, 'held receipt exchange and image retrieval')
	assert.ok(imageResponse)
	assert.ok(heldExchange)
	imageResponse.writeHead(200, {
		'Content-Type': 'image/jpeg',
		'Content-Length': String(baselineJpeg.length),
		'X-Helm-Image-Input': '1',
	})
	imageResponse.end(baselineJpeg)
	await harness.until(() => harness.effects === 1, 'image effect while receipt exchange is held')
	json(heldExchange, 200, { protocol: 1, hostEpoch, commands: [] })
	await harness.until(
		() =>
			harness.receivedReceipts.some(
				value =>
					(value as { commandId?: string; status?: string }).commandId === commandId &&
					(value as { status?: string }).status === 'dispatched',
			),
		'terminal replacement receipt',
	)
})

test('new async receipt survives a failed exchange after pending was acknowledged', async t => {
	const hostEpoch = randomUUID()
	const commandId = randomUUID()
	const image = {
		handle: randomUUID(),
		sha256: createHash('sha256').update(baselineJpeg).digest('hex'),
		mimeType: 'image/jpeg' as const,
		bytes: baselineJpeg.length,
		width: 192,
		height: 192,
	}
	let imageResponse: ServerResponse | undefined
	let failedExchange: ServerResponse | undefined
	const harness = await bridgeHarness({
		model: { provider: 'fixture', id: 'vision', input: ['text', 'image'] },
		exchange(response, count, snapshot) {
			response.setHeader('X-Helm-Image-Input', '1')
			if (count === 4) {
				failedExchange = response
				return
			}
			json(response, 200, {
				protocol: 1,
				hostEpoch,
				commands:
					count === 2
						? [
								{
									expiresAt: Date.now() + 10_000,
									command: {
										protocol: 1,
										hostEpoch,
										commandId,
										target: snapshot.target,
										operation: { kind: 'prompt', text: '', delivery: 'followUp', images: [image] },
									},
								},
							]
						: [],
			})
		},
		imageInput(response) {
			imageResponse = response
		},
	})
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => !!failedExchange && !!imageResponse, 'empty failed exchange after pending ACK')
	assert.ok(imageResponse)
	assert.ok(failedExchange)
	imageResponse.writeHead(200, {
		'Content-Type': 'image/jpeg',
		'Content-Length': String(baselineJpeg.length),
		'X-Helm-Image-Input': '1',
	})
	imageResponse.end(baselineJpeg)
	await harness.until(() => harness.effects === 1, 'new terminal receipt during failed exchange')
	json(failedExchange, 500, { error: 'fixture_failure' })
	await harness.until(
		() =>
			harness.receivedReceipts.some(
				value =>
					(value as { commandId?: string; status?: string }).commandId === commandId &&
					(value as { status?: string }).status === 'dispatched',
			),
		'new terminal receipt retried after failed exchange',
	)
})

test('authorized Interrupt cancels only uninvoked image lane while polling stays responsive', async t => {
	const hostEpoch = randomUUID()
	const immediateId = randomUUID()
	const imageId = randomUUID()
	const queuedId = randomUUID()
	const interruptId = randomUUID()
	const image = {
		handle: randomUUID(),
		sha256: createHash('sha256').update(baselineJpeg).digest('hex'),
		mimeType: 'image/jpeg' as const,
		bytes: baselineJpeg.length,
		width: 192,
		height: 192,
	}
	let imageClosed = false
	const harness = await bridgeHarness({
		model: { provider: 'fixture', id: 'vision', input: ['text', 'image'] },
		exchange(response, count, snapshot) {
			response.setHeader('X-Helm-Image-Input', '1')
			const make = (commandId: string, operation: Record<string, unknown>) => ({
				expiresAt: Date.now() + 10_000,
				command: { protocol: 1, hostEpoch, commandId, target: snapshot.target, operation },
			})
			json(response, 200, {
				protocol: 1,
				hostEpoch,
				commands:
					count === 2
						? [
								make(immediateId, { kind: 'prompt', text: 'already invoked', delivery: 'followUp' }),
								make(imageId, { kind: 'prompt', text: 'held image', delivery: 'followUp', images: [image] }),
								make(queuedId, { kind: 'prompt', text: 'queued behind image', delivery: 'followUp' }),
							]
						: count === 3
							? [make(interruptId, { kind: 'interrupt' })]
							: [],
			})
		},
		imageInput(response) {
			response.once('close', () => {
				imageClosed = true
			})
		},
		sendUserMessage() {
			throw new Error('ambiguous synthetic Pi effect')
		},
	})
	t.after(() => harness.dispose())
	harness.emit('session_start')
	await harness.until(() => harness.exchanges.length >= 3, 'poll while image retrieval remains held')
	await harness.until(() => imageClosed, 'Interrupt cancellation of active image request')
	await harness.until(
		() =>
			[imageId, queuedId].every(commandId =>
				harness.receivedReceipts.some(
					value =>
						(value as { commandId?: string; status?: string }).commandId === commandId &&
						(value as { status?: string }).status === 'rejected',
				),
			),
		'uninvoked prompt rejections',
	)
	assert.deepEqual(
		harness.sentMessages.map(value => value.content),
		['already invoked'],
	)
	assert.equal(harness.effects, 2, 'one Pi message plus one authorized abort')
	const immediateStatuses = harness.receivedReceipts
		.filter(value => (value as { commandId?: string }).commandId === immediateId)
		.map(value => (value as { status?: string }).status)
	assert.ok(immediateStatuses.includes('unknown'))
	assert.equal(immediateStatuses.includes('rejected'), false)
	await new Promise(resolve => setTimeout(resolve, 600))
	assert.deepEqual(
		harness.sentMessages.map(value => value.content),
		['already invoked'],
		'cancelled queue must not restart',
	)
})

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

function descriptorFor(snapshot: RemoteSnapshot, hostEpoch: string): HistoryDescriptor {
	return {
		requestId: randomUUID(),
		principalKey: 'fixture-device',
		expiresAt: Date.now() + 4000,
		request: {
			version: 1,
			hostEpoch,
			target: snapshot.target,
			viewId: randomUUID(),
			sequence: 0,
			action: { kind: 'open' },
		},
	}
}
const singleEntry = (text: string, id = '00000001'): HistoryManager => ({
	getLeafId: () => id,
	getEntry: input =>
		input === id ? { id, parentId: null, type: 'message', message: { role: 'user', content: text } } : undefined,
})
function required<T>(value: T | undefined | null): T {
	assert.ok(value !== undefined && value !== null)
	return value
}

test('production bridge negotiates header, tolerates old host, retries separate results without repeating traversal or effects', async t => {
	const hostEpoch = randomUUID()
	let descriptor: HistoryDescriptor | undefined
	let attempts = 0
	let acknowledged = false
	const harness = await bridgeHarness({
		exchange(response, count, snapshot, request) {
			assert.equal(request.headers['x-helm-history'], '1')
			if (count === 1) {
				// old host has no descriptor field; live operation continues
				json(response, 200, { protocol: 1, hostEpoch, commands: [] })
				return
			}
			descriptor ??= descriptorFor(snapshot, hostEpoch)
			json(response, 200, {
				protocol: 1,
				hostEpoch,
				commands: [],
				...(!acknowledged ? { historyRead: descriptor } : {}),
			})
		},
		historyResult(response) {
			attempts++
			if (attempts === 1)
				response.destroy() // lost ACK: same descriptor must safely retry
			else {
				acknowledged = true
				json(response, 200, { ok: true })
			}
		},
	})
	t.after(() => harness.dispose())
	let lookups = 0
	const manager = singleEntry('Canonical')
	harness.setManager({
		...manager,
		getEntry(id) {
			lookups++
			return manager.getEntry(id)
		},
	})
	assert.equal(harness.exchanges.length, 0) // no factory-time connection
	harness.emit('session_start')
	await harness.until(() => attempts === 2, 'retried history result')
	assert.deepEqual(harness.historyResults[1], harness.historyResults[0])
	assert.equal(lookups, 2) // one initial live observation plus one history slice, not a repeated walk
	assert.equal(harness.effects, 0)
	assert.equal(harness.registrationRequests, 1)
	assert.equal(required(harness.historyResults[0].page).records.length, 1)
	assert.equal(required(harness.snapshots.at(-1)).messages[0].id, '00000001')
	assert.ok(harness.managerReads >= 3)
})

test('production result POST is single-flight without blocking exchange; every lifecycle boundary aborts it', async t => {
	for (const boundary of [
		'session_before_tree',
		'session_before_switch',
		'session_before_fork',
		'session_shutdown',
		'disconnect',
	])
		await t.test(boundary, async sub => {
			const hostEpoch = randomUUID()
			let held: ServerResponse | undefined
			let descriptor: HistoryDescriptor | undefined
			let aborted = false
			const harness = await bridgeHarness({
				exchange(response, _count, snapshot) {
					descriptor ??= descriptorFor(snapshot, hostEpoch)
					json(response, 200, { protocol: 1, hostEpoch, commands: [], historyRead: descriptor })
				},
				historyResult(response) {
					held = response
					response.on('close', () => {
						if (!response.writableEnded) aborted = true
					})
				},
			})
			sub.after(() => harness.dispose())
			harness.setManager(singleEntry('Read only'))
			harness.emit('session_start')
			await harness.until(() => harness.exchanges.length >= 2, 'exchange while result ACK is pending')
			assert.equal(harness.historyResults.length, 1)
			if (boundary === 'disconnect') await harness.command('helm-remote-disconnect')
			else harness.emit(boundary)
			await harness.until(() => aborted, 'result socket abort')
			const reads = harness.managerReads
			const exchanges = harness.exchanges.length
			json(required(held), 200, { ok: true }) // late settlement must not restart old work
			await new Promise(resolve => setTimeout(resolve, 600))
			assert.equal(harness.managerReads, reads)
			assert.equal(harness.exchanges.length, exchanges)
			assert.equal(harness.historyResults.length, 1)
			assert.equal(harness.effects, 0)
		})
})

test('production bridge fences delayed descriptors by current manager and changed host epoch', async t => {
	for (const changed of ['manager', 'epoch'])
		await t.test(changed, async sub => {
			const hostEpoch = randomUUID()
			let held: ServerResponse | undefined
			let descriptor: HistoryDescriptor | undefined
			const harness = await bridgeHarness({
				exchange(response, count, snapshot) {
					if (count === 1) json(response, 200, { protocol: 1, hostEpoch, commands: [] })
					else {
						held = response
						descriptor = descriptorFor(snapshot, hostEpoch)
					}
				},
			})
			sub.after(() => harness.dispose())
			harness.setManager(singleEntry('Old owner'))
			harness.emit('session_start')
			await harness.until(() => held !== undefined, 'delayed exchange')
			if (changed === 'manager') harness.setManager(singleEntry('Replacement'), randomUUID())
			json(required(held), 200, {
				protocol: 1,
				hostEpoch: changed === 'epoch' ? randomUUID() : hostEpoch,
				commands: [],
				historyRead: descriptor,
			})
			await new Promise(resolve => setTimeout(resolve, 200))
			assert.equal(harness.historyResults.length, 0)
			assert.equal(harness.effects, 0)
		})
})

test('production bridge reacquires stored payload after event preview retirement and never anchors the preview', async t => {
	const hostEpoch = randomUUID()
	let requested = false
	let descriptor: HistoryDescriptor | undefined
	const harness = await bridgeHarness({
		exchange(response, _count, snapshot) {
			if (requested) descriptor ??= descriptorFor(snapshot, hostEpoch)
			json(response, 200, { protocol: 1, hostEpoch, commands: [], ...(descriptor ? { historyRead: descriptor } : {}) })
		},
	})
	t.after(() => harness.dispose())
	harness.setManager(singleEntry('Previous'))
	harness.emit('session_start')
	await harness.until(() => harness.exchanges.length === 1, 'initial canonical snapshot')
	harness.emit('message_update', {
		message: { role: 'assistant', content: [{ type: 'text', text: 'Unstored preview' }] },
	})
	await harness.until(
		() => harness.snapshots.at(-1)?.messages.some(m => m.id === 'current') === true,
		'preview observation',
	)
	harness.emit('message_end', {
		message: { role: 'assistant', content: [{ type: 'text', text: 'Original before replacement' }] },
	})
	await harness.until(
		() => harness.snapshots.at(-1)?.messages.every(m => m.id !== 'current') === true,
		'preview retirement',
	)
	assert.deepEqual(
		required(harness.snapshots.at(-1)).messages.map(m => m.id),
		['00000001'],
	)
	harness.setManager(singleEntry('Stored replacement', '00000002'))
	requested = true
	await harness.until(() => harness.historyResults.length > 0, 'canonical result from reacquired manager')
	const page = required(harness.historyResults[0].page)
	assert.equal(page.records[0].kind, 'message')
	if (page.records[0].kind === 'message') {
		assert.equal(page.records[0].message.id, '00000002')
		assert.equal(page.records[0].message.text, 'Stored replacement')
	}
	assert.equal(harness.effects, 0)
})

test('production bridge rejects oversized/truncated ACKs and retries after result deadline without stopping live observation', async t => {
	for (const failure of ['oversize', 'truncated', 'timeout'])
		await t.test(failure, async sub => {
			const hostEpoch = randomUUID()
			let descriptor: HistoryDescriptor | undefined
			let posts = 0
			const harness = await bridgeHarness({
				exchange(response, _count, snapshot) {
					descriptor ??= descriptorFor(snapshot, hostEpoch)
					json(response, 200, { protocol: 1, hostEpoch, commands: [], historyRead: descriptor })
				},
				historyResult(response) {
					posts++
					if (posts > 1) {
						json(response, 200, { ok: true })
						return
					}
					if (failure === 'oversize') {
						response.writeHead(200)
						response.end('x'.repeat(4097))
					}
					if (failure === 'truncated') {
						response.writeHead(200, { 'Content-Length': '100' })
						response.end('{}')
					}
					// Timeout deliberately leaves the socket open until the production 2s deadline.
				},
			})
			sub.after(() => harness.dispose())
			harness.setManager(singleEntry('Safe retry'))
			harness.emit('session_start')
			await harness.until(() => posts >= 2, `${failure} result retry`, 4500)
			assert.deepEqual(harness.historyResults[0], harness.historyResults[1])
			assert.ok(harness.exchanges.length >= 2)
			assert.equal(harness.effects, 0)
			assert.equal(harness.registrationRequests, 1)
		})
})
