import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteHost } from '../src/remote/host.js'
import { type RemoteImageReference, remoteImageReferenceSchema } from '../src/remote/image-input-protocol.js'
import type { RemoteCommand, RemoteReceipt, RemoteSnapshot } from '../src/remote/protocol.js'
import { baselineJpeg } from './fixtures/remote-image-input.js'

const imageOrigin = 'http://127.0.0.1:8459'
const imageHeader = 'X-Helm-Image-Input'
function imageHostFixture() {
	const browserToken = createScopedCapability()
	const localToken = createScopedCapability()
	const enrollment = {
		id: randomUUID(),
		capabilityHash: hashScopedCapability(localToken),
		scopeId: null,
		generation: 1,
	}
	const host = new RemoteHost({
		origin: imageOrigin,
		browserCapabilityHash: hashScopedCapability(browserToken),
		enrollments: [enrollment],
	})
	const snapshot: RemoteSnapshot = {
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
		revision: 1,
		label: 'Image transport fixture',
		workspace: 'Fixture',
		model: 'Fixture vision model',
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: false },
		question: null,
		messages: [],
		historyTruncated: false,
	}
	const browserHeaders = {
		Host: new URL(imageOrigin).host,
		Origin: imageOrigin,
		Authorization: `Bearer ${browserToken}`,
		'X-Helm-Remote': '1',
	}
	const localHeaders = {
		Authorization: `Bearer ${localToken}`,
		'X-Helm-Enrollment': enrollment.id,
		'Content-Type': 'application/json',
	}
	const exchange = (available?: boolean, receipts: RemoteReceipt[] = [], opted = true) =>
		host.local.request('/exchange', {
			method: 'POST',
			headers: { ...localHeaders, ...(opted ? { [imageHeader]: '1' } : {}) },
			body: JSON.stringify({
				protocol: 1,
				enrollmentId: enrollment.id,
				snapshot: {
					...snapshot,
					revision: snapshot.revision++,
					...(available === undefined ? {} : { imageInput: { version: 1, available } }),
				},
				receipts,
			}),
		})
	const query = new URLSearchParams({
		hostEpoch: host.epoch,
		incarnation: snapshot.target.incarnation,
		scopeId: '',
		generation: '1',
	})
	const uploadPath = `/v1/sessions/${snapshot.target.sessionId}/images?${query}`
	const upload = (body: NonNullable<RequestInit['body']> = baselineJpeg, extra: Record<string, string> = {}) =>
		host.browser.request(uploadPath, {
			method: 'POST',
			headers: { ...browserHeaders, 'Content-Type': 'image/jpeg', [imageHeader]: '1', ...extra },
			body,
			duplex: 'half',
		} as RequestInit)
	const command = (images?: RemoteImageReference[], text = ''): RemoteCommand => ({
		protocol: 1,
		hostEpoch: host.epoch,
		commandId: randomUUID(),
		target: snapshot.target,
		operation: { kind: 'prompt', delivery: 'followUp', text, ...(images ? { images } : {}) },
	})
	const send = (value: RemoteCommand) =>
		host.browser.request('/v1/commands', {
			method: 'POST',
			headers: { ...browserHeaders, 'Content-Type': 'application/json', [imageHeader]: '1' },
			body: JSON.stringify(value),
		})
	const read = (value: RemoteCommand, image: RemoteImageReference) =>
		host.local.request('/image-input', {
			method: 'POST',
			headers: { ...localHeaders, [imageHeader]: '1' },
			body: JSON.stringify({
				protocol: 1,
				hostEpoch: host.epoch,
				target: value.target,
				commandId: value.commandId,
				image,
			}),
		})
	const ready = async () => {
		assert.equal((await exchange(undefined, [], false)).status, 200, 'legacy fixture registration works')
		const response = await exchange(true)
		assert.equal(response.status, 200, 'negotiated image snapshot accepted')
		assert.equal(response.headers.get(imageHeader), '1')
	}
	return { host, snapshot, browserHeaders, exchange, uploadPath, upload, command, send, read, ready }
}
async function uploadedReference(response: Response): Promise<RemoteImageReference> {
	assert.equal(response.status, 201)
	const envelope = (await response.json()) as { protocol: number; hostEpoch: string; image: unknown }
	assert.equal(envelope.protocol, 1)
	assert.equal(typeof envelope.hostEpoch, 'string')
	const reference = remoteImageReferenceSchema.parse(envelope.image)
	assert.equal(reference.sha256, createHash('sha256').update(baselineJpeg).digest('hex'))
	assert.equal(reference.bytes, baselineJpeg.length)
	assert.equal(reference.width, 192)
	assert.equal(reference.height, 192)
	return reference
}
function heldImageBody() {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined
	let signalRead: () => void = () => {}
	let releasePull: () => void = () => {}
	let pulls = 0
	let ended = false
	const started = new Promise<void>(resolve => {
		signalRead = resolve
	})
	const hold = new Promise<void>(resolve => {
		releasePull = resolve
	})
	const body = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value
			},
			pull(value) {
				pulls++
				value.enqueue(baselineJpeg.subarray(0, 32))
				signalRead()
				return hold
			},
		},
		{ highWaterMark: 0 },
	)
	const finish = () => {
		if (ended) return
		ended = true
		try {
			controller?.enqueue(baselineJpeg.subarray(32))
			controller?.close()
		} finally {
			releasePull()
		}
	}
	return { body, started, finish, pulls: () => pulls }
}

test('Host image bytes require delivery and survive exact image-only command correlation', async () => {
	const f = imageHostFixture()
	try {
		await f.ready()
		const reference = await uploadedReference(await f.upload())
		const command = f.command([reference])
		assert.equal((await f.send(command)).status, 202)
		assert.notEqual((await f.read(command, reference)).status, 200, 'undelivered command cannot read')
		const delivery = (await (await f.exchange(true)).json()) as { commands: Array<{ command: RemoteCommand }> }
		assert.deepEqual(
			delivery.commands.map(entry => entry.command),
			[command],
		)
		const response = await f.read(command, reference)
		assert.equal(response.status, 200)
		assert.equal(response.headers.get('Content-Type'), 'image/jpeg')
		assert.equal(response.headers.get('Content-Length'), String(baselineJpeg.length))
		assert.equal(response.headers.get('Cache-Control'), 'no-store')
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), baselineJpeg)
		const publicRead = await f.host.browser.request(
			`/v1/sessions/${f.snapshot.target.sessionId}/images/${reference.handle}`,
			{
				headers: f.browserHeaders,
			},
		)
		assert.equal(publicRead.status, 404, 'no public image retrieval')
	} finally {
		f.host.revoke()
	}
})

test('Host duplicate image command keeps its receipt after support loss and byte cleanup', async () => {
	const f = imageHostFixture()
	try {
		await f.ready()
		const reference = await uploadedReference(await f.upload())
		const command = f.command([reference], 'Caption stays paired')
		assert.equal((await f.send(command)).status, 202)
		assert.equal((await f.exchange(true)).status, 200)
		const receipt: RemoteReceipt = { commandId: command.commandId, status: 'dispatched' }
		assert.equal((await f.exchange(false, [receipt])).status, 200)
		assert.notEqual((await f.read(command, reference)).status, 200)
		const duplicate = await f.send(command)
		assert.equal(duplicate.status, 200)
		assert.deepEqual(await duplicate.json(), receipt)
		const changed = { ...command, operation: { ...command.operation, text: 'Different caption' } }
		assert.equal((await f.send(changed as RemoteCommand)).status, 409)
	} finally {
		f.host.revoke()
	}
})

test('Host image reference binding is all-before-any and cannot deliver caption alone', async () => {
	const f = imageHostFixture()
	try {
		await f.ready()
		const reference = await uploadedReference(await f.upload())
		const missing = { ...reference, handle: randomUUID() }
		assert.notEqual((await f.send(f.command([reference, missing], 'Must not send alone'))).status, 202)
		const good = f.command([reference], 'Whole bundle')
		assert.equal((await f.send(good)).status, 202, 'failed bind left the good handle staged')
		const delivered = (await (await f.exchange(true)).json()) as { commands: Array<{ command: RemoteCommand }> }
		assert.deepEqual(
			delivered.commands.map(entry => entry.command),
			[good],
		)
	} finally {
		f.host.revoke()
	}
})

test('Host image upload rejects unauthorized and wrong-origin bodies before reading', async () => {
	const f = imageHostFixture()
	const first = heldImageBody()
	const second = heldImageBody()
	try {
		assert.equal((await f.upload(first.body, { Authorization: 'Bearer invalid' })).status, 401)
		assert.equal(first.pulls(), 0)
		assert.equal((await f.upload(second.body, { Origin: 'https://invalid.example' })).status, 403)
		assert.equal(second.pulls(), 0)
	} finally {
		first.finish()
		second.finish()
		f.host.revoke()
	}
})

test('Host rapid support off-on retires an admitted upload rather than reviving it', { timeout: 15_000 }, async () => {
	const f = imageHostFixture()
	const held = heldImageBody()
	try {
		await f.ready()
		const pending = f.upload(held.body, { 'Content-Length': String(baselineJpeg.length) })
		await held.started
		assert.equal((await f.exchange(false)).status, 200)
		assert.equal((await f.exchange(true)).status, 200)
		held.finish()
		assert.notEqual((await pending).status, 201, 'old reservation cannot regain support authority')
		for (let index = 0; index < 8; index++)
			await uploadedReference(await f.upload(baselineJpeg, { 'Content-Length': String(baselineJpeg.length) }))
	} finally {
		held.finish()
		f.host.revoke()
	}
})

test('Host negotiates image projection without changing legacy text delivery', async () => {
	const f = imageHostFixture()
	try {
		await f.ready()
		const legacy = await f.host.browser.request('/v1/sessions', { headers: f.browserHeaders })
		assert.equal(legacy.status, 200)
		const legacyBody = (await legacy.json()) as { sessions: Array<Record<string, unknown>> }
		assert.equal(legacyBody.sessions.length, 1)
		assert.equal(Object.hasOwn(legacyBody.sessions[0], 'imageInput'), false)
		const current = await f.host.browser.request('/v1/sessions', {
			headers: { ...f.browserHeaders, [imageHeader]: '1' },
		})
		assert.equal(current.headers.get(imageHeader), '1')
		const currentBody = (await current.json()) as { sessions: Array<Record<string, unknown>> }
		assert.equal(currentBody.sessions.length, 1)
		assert.deepEqual(currentBody.sessions[0].imageInput, { version: 1, available: true })
		const text = f.command(undefined, 'Ordinary text')
		assert.equal((await f.send(text)).status, 202)
		const delivery = (await (await f.exchange(true)).json()) as { commands: Array<{ command: RemoteCommand }> }
		assert.deepEqual(
			delivery.commands.map(entry => entry.command),
			[text],
		)
	} finally {
		f.host.revoke()
	}
})
