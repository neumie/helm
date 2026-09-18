import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { type ServerResponse, createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { createScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAdmission } from '../src/remote/admission.js'
import { RemoteImageInputClient } from '../src/remote/image-input-client.js'
import type { RemoteImageReference } from '../src/remote/image-input-protocol.js'
import type { RemoteCommand, RemoteReceipt, RemoteTarget } from '../src/remote/protocol.js'
import { baselineJpeg } from './fixtures/remote-image-input.js'

const waitFor = async (predicate: () => boolean, description: string, timeout = 3_000) => {
	const deadline = Date.now() + timeout
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise(resolve => setTimeout(resolve, 5))
	}
	throw new Error(`timed out waiting for ${description}`)
}

function reference(): RemoteImageReference {
	return {
		handle: randomUUID(),
		sha256: createHash('sha256').update(baselineJpeg).digest('hex'),
		mimeType: 'image/jpeg',
		bytes: baselineJpeg.length,
		width: 192,
		height: 192,
	}
}

function prompt(target: RemoteTarget, hostEpoch: string, text: string, images?: RemoteImageReference[]): RemoteCommand {
	return {
		protocol: 1,
		hostEpoch,
		commandId: randomUUID(),
		target,
		operation: { kind: 'prompt', text, delivery: 'followUp', ...(images ? { images } : {}) },
	}
}

function sendImage(response: ServerResponse): void {
	response.writeHead(200, {
		'Content-Type': 'image/jpeg',
		'Content-Length': String(baselineJpeg.length),
		'X-Helm-Image-Input': '1',
	})
	response.end(baselineJpeg)
}

async function fixture(now: () => number = Date.now) {
	const root = mkdtempSync('/tmp/hr-img-client-')
	chmodSync(root, 0o700)
	const socketPath = join(root, 'i.sock')
	const pending: ServerResponse[] = []
	let reads = 0
	let activeReads = 0
	let maxActiveReads = 0
	const server = createServer((request, response) => {
		reads++
		activeReads++
		maxActiveReads = Math.max(maxActiveReads, activeReads)
		response.once('close', () => {
			activeReads--
		})
		request.resume()
		request.once('end', () => pending.push(response))
	})
	await new Promise<void>(resolve => server.listen(socketPath, resolve))
	const target: RemoteTarget = {
		sessionId: randomUUID(),
		incarnation: randomUUID(),
		scopeId: null,
		generation: 1,
	}
	const admission = new RemoteAdmission(target, 4096, now)
	const receipts: RemoteReceipt[] = []
	const invoked: string[] = []
	let current = true
	const client = new RemoteImageInputClient(
		{
			protocol: 1,
			enrollmentId: randomUUID(),
			capability: createScopedCapability(),
			scopeId: null,
			generation: 1,
			socketPath,
		},
		target,
		admission,
		{
			current: () => current,
			invoke: command => {
				invoked.push(command.commandId)
				return 'dispatched'
			},
			receipt: value => receipts.push(value),
		},
		now,
	)
	const hostEpoch = randomUUID()
	client.negotiate(hostEpoch, true)
	return {
		client,
		target,
		hostEpoch,
		pending,
		receipts,
		invoked,
		get reads() {
			return reads
		},
		get maxActiveReads() {
			return maxActiveReads
		},
		setCurrent(value: boolean) {
			current = value
		},
		async close() {
			client.dispose()
			admission.dispose()
			server.closeAllConnections()
			await new Promise<void>(resolve => server.close(() => resolve()))
			rmSync(root, { recursive: true, force: true })
		},
	}
}

test('coordinator keeps held image, duplicate, and queued text in one bounded FIFO lane', async t => {
	const f = await fixture()
	t.after(() => f.close())
	const image = prompt(f.target, f.hostEpoch, 'image', [reference()])
	assert.equal(f.client.submit(image, Date.now() + 10_000).status, 'pending')
	assert.equal(f.client.submit(structuredClone(image), Date.now() + 10_000).status, 'pending')
	const queued = Array.from({ length: 8 }, (_, index) => prompt(f.target, f.hostEpoch, `text-${index}`))
	for (const command of queued) assert.equal(f.client.submit(command, Date.now() + 10_000).status, 'pending')
	const overflow = prompt(f.target, f.hostEpoch, 'overflow')
	assert.equal(f.client.submit(overflow, Date.now() + 10_000).status, 'rejected')
	await waitFor(() => f.pending.length === 1, 'one held retrieval')
	assert.equal(f.reads, 1, 'duplicate pending command must not retrieve again')
	assert.equal(f.invoked.length, 0, 'queued text must not overtake held image')
	const held = f.pending.shift()
	assert.ok(held)
	sendImage(held)
	await waitFor(() => f.invoked.length === 9, 'image and eight queued text invocations')
	assert.deepEqual(f.invoked, [image.commandId, ...queued.map(command => command.commandId)])
	assert.equal(f.invoked.includes(overflow.commandId), false)
})

test('coordinator uses at most two reads and preserves order for a successful multi-image prompt', async t => {
	const f = await fixture()
	t.after(() => f.close())
	const command = prompt(f.target, f.hostEpoch, 'four', [reference(), reference(), reference(), reference()])
	assert.equal(f.client.submit(command, Date.now() + 10_000).status, 'pending')
	await waitFor(() => f.pending.length === 2, 'first two reads')
	assert.equal(f.maxActiveReads, 2)
	for (const response of f.pending.splice(0)) sendImage(response)
	await waitFor(() => f.pending.length === 2, 'second two reads')
	assert.equal(f.maxActiveReads, 2)
	for (const response of f.pending.splice(0)) sendImage(response)
	await waitFor(() => f.invoked.length === 1, 'multi-image dispatch')
	assert.deepEqual(f.invoked, [command.commandId])
	assert.ok(f.receipts.some(value => value.commandId === command.commandId && value.status === 'dispatched'))
})

test('coordinator rechecks aggregate deadline and current support after retrieval', async t => {
	let now = 0
	const f = await fixture(() => now)
	t.after(() => f.close())
	const expired = prompt(f.target, f.hostEpoch, 'expired', [reference()])
	assert.equal(f.client.submit(expired, 9_000).status, 'pending')
	await waitFor(() => f.pending.length === 1, 'deadline read')
	now = 3_000
	const deadlineResponse = f.pending.shift()
	assert.ok(deadlineResponse)
	sendImage(deadlineResponse)
	await waitFor(
		() => f.receipts.some(value => value.commandId === expired.commandId && value.status === 'rejected'),
		'deadline rejection',
	)
	assert.deepEqual(f.invoked, [])

	now = 3_001
	const stale = prompt(f.target, f.hostEpoch, 'stale', [reference()])
	assert.equal(f.client.submit(stale, 12_000).status, 'pending')
	await waitFor(() => f.pending.length === 1, 'current-support read')
	f.setCurrent(false)
	const staleResponse = f.pending.shift()
	assert.ok(staleResponse)
	sendImage(staleResponse)
	await waitFor(
		() => f.receipts.some(value => value.commandId === stale.commandId && value.status === 'rejected'),
		'current-support rejection',
	)
	assert.deepEqual(f.invoked, [])
})
