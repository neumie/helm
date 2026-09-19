import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteHost } from '../src/remote/host.js'
import type { RemoteSnapshot } from '../src/remote/protocol.js'
import { baselineJpeg } from './fixtures/remote-image-input.js'

/**
 * Pi names its sessions with UUIDv7 (`019fb332-5646-76e8-ba91-...`), while `randomUUID()`
 * produces v4. Every fixture in this suite used v4, so a version-restricted route pattern
 * matched in tests and missed every real session.
 */
const PI_SESSION_ID = '019fb332-5646-76e8-ba91-6c3354501d50'

async function uploadTo(sessionId: string) {
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
		target: { sessionId, incarnation: randomUUID(), scopeId: null, generation: 1 },
		revision: 1,
		label: 'Pi session identity fixture',
		workspace: 'Fixture',
		model: 'anthropic/claude-opus-5',
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: false },
		question: null,
		messages: [],
		historyTruncated: false,
		imageInput: { version: 1, available: true },
	}
	const exchange = await host.local.request('/exchange', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${localToken}`,
			'X-Helm-Enrollment': enrollment.id,
			'Content-Type': 'application/json',
			'X-Helm-Image-Input': '1',
		},
		body: JSON.stringify({ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] }),
	})
	assert.equal(exchange.status, 200)
	const query = new URLSearchParams({
		hostEpoch: host.epoch,
		incarnation: snapshot.target.incarnation,
		scopeId: '',
		generation: '1',
	})
	const response = await host.browser.request(`/v1/sessions/${sessionId}/images?${query}`, {
		method: 'POST',
		headers: {
			Host: new URL(origin).host,
			Origin: origin,
			Authorization: `Bearer ${browserToken}`,
			'X-Helm-Remote': '1',
			'X-Helm-Image-Input': '1',
			'Content-Type': 'image/jpeg',
			'Content-Length': String(baselineJpeg.length),
		},
		body: baselineJpeg,
	})
	host.revoke()
	return response.status
}

test('an image uploads to a session named the way Pi names them, not only the way tests do', async () => {
	// A v4 id is what every existing fixture mints, and it has always worked.
	assert.equal(await uploadTo(randomUUID()), 201)
	// A v7 id is what every real Pi session has. Before the route pattern accepted it,
	// the upload was classified as JSON and refused as CSRF with 403.
	assert.equal(await uploadTo(PI_SESSION_ID), 201)
})

test('every RFC 9562 version is accepted, and a malformed identifier still is not', async () => {
	for (const version of ['1', '2', '3', '4', '5', '6', '7', '8'])
		assert.equal(await uploadTo(`019fb332-5646-${version}6e8-ba91-6c3354501d50`), 201, `version ${version} was refused`)
	// An identifier that is not a UUID at all never reaches the route's own validation:
	// the classifier refuses to treat it as a binary upload, so the JSON content type
	// rule rejects it first. Refused earlier is still refused.
	assert.equal(await uploadTo('019fb332-5646-06e8-ba91-6c3354501d50'), 403)
	assert.equal(await uploadTo('019fb332-5646-76e8-ca91-6c3354501d50'), 403)
})
