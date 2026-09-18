import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteHost } from '../src/remote/host.js'
import { IMAGE_INPUT_HEADER, imageUploadEnvelopeSchema } from '../src/remote/image-input-protocol.js'
import type { RemoteSnapshot } from '../src/remote/protocol.js'
import { baselineJpeg } from './fixtures/remote-image-input.js'

test('actual Host upload returns the negotiated image ACK and valid envelope', async () => {
	const localToken = createScopedCapability()
	const browserToken = createScopedCapability()
	const enrollment = {
		id: randomUUID(),
		capabilityHash: hashScopedCapability(localToken),
		scopeId: null,
		generation: 1,
	}
	const origin = 'http://127.0.0.1:8491'
	const host = new RemoteHost({
		origin,
		enrollments: [enrollment],
		browserCapabilityHash: hashScopedCapability(browserToken),
	})
	const snapshot: RemoteSnapshot = {
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
		revision: 1,
		label: 'Upload ACK fixture',
		workspace: 'Fixture',
		model: 'Fixture vision',
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: false },
		question: null,
		messages: [],
		historyTruncated: false,
		imageInput: { version: 1, available: true },
	}
	assert.equal(
		(
			await host.local.request('/exchange', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${localToken}`,
					'X-Helm-Enrollment': enrollment.id,
					'Content-Type': 'application/json',
					[IMAGE_INPUT_HEADER]: '1',
				},
				body: JSON.stringify({ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] }),
			})
		).status,
		200,
	)
	const query = new URLSearchParams({
		hostEpoch: host.epoch,
		incarnation: snapshot.target.incarnation,
		scopeId: '',
		generation: '1',
	})
	const path = `/v1/sessions/${snapshot.target.sessionId}/images?${query}`
	const headers = {
		Host: new URL(origin).host,
		Origin: origin,
		Authorization: `Bearer ${browserToken}`,
		'X-Helm-Remote': '1',
		'Content-Type': 'image/jpeg',
		'Content-Length': String(baselineJpeg.length),
	}
	const refused = await host.browser.request(path, { method: 'POST', headers, body: baselineJpeg })
	assert.equal(refused.status, 403)
	assert.equal(refused.headers.get(IMAGE_INPUT_HEADER), null)
	const response = await host.browser.request(path, {
		method: 'POST',
		headers: { ...headers, [IMAGE_INPUT_HEADER]: '1' },
		body: baselineJpeg,
	})
	assert.equal(response.status, 201)
	assert.equal(response.headers.get(IMAGE_INPUT_HEADER), '1')
	const envelope = imageUploadEnvelopeSchema.parse(await response.json())
	assert.equal(envelope.hostEpoch, host.epoch)
	assert.equal(envelope.image.bytes, baselineJpeg.length)
	host.revoke()
})
