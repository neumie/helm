import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error -- app modules load as CommonJS objects under the root tsx test runner.
import transportModule from '../app/src/renderer/remote/transport.js'
import { IMAGE_INPUT_HEADER } from '../src/remote/image-input-protocol.js'
import type { RemoteDirectory, RemoteTarget } from '../src/remote/protocol.js'
import { baselineJpeg } from './fixtures/remote-image-input.js'

type TransportModule = typeof import('../app/src/renderer/remote/transport.js')
const { createRemoteTransport } = transportModule as TransportModule
const hostEpoch = '10000000-0000-4000-8000-000000000000'
const target: RemoteTarget = {
	sessionId: '10000000-0000-4000-8000-000000000001',
	incarnation: '20000000-0000-4000-8000-000000000001',
	scopeId: null,
	generation: 1,
}
const directory: RemoteDirectory = {
	protocol: 1,
	hostEpoch,
	overlayStamp: 'fixture',
	sessions: [
		{
			target,
			revision: 1,
			label: 'Fixture',
			workspace: 'Fixture',
			model: null,
			activity: 'idle',
			connected: true,
			capabilities: { prompt: true, interrupt: true, answer: false },
			historyTruncated: false,
			imageInput: { version: 1, available: true },
		},
	],
}

function json(value: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'Content-Type': 'application/json', ...headers },
	})
}

test('directory and upload image support require independent response ACKs', async () => {
	const original = globalThis.fetch
	try {
		globalThis.fetch = async () => json(directory)
		const transport = createRemoteTransport()
		const unacknowledged = await transport.directory(new AbortController().signal)
		assert.equal(unacknowledged.sessions[0]?.imageInput, undefined)
		globalThis.fetch = async () => json(directory, { [IMAGE_INPUT_HEADER]: '1' })
		const acknowledged = await transport.directory(new AbortController().signal)
		assert.equal(acknowledged.sessions[0]?.imageInput?.available, true)

		const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', baselineJpeg)).toString('hex')
		const envelope = {
			protocol: 1,
			hostEpoch,
			image: {
				handle: '30000000-0000-4000-8000-000000000001',
				sha256,
				mimeType: 'image/jpeg',
				bytes: baselineJpeg.length,
				width: 192,
				height: 192,
			},
		}
		globalThis.fetch = async (_input, init) => {
			assert.equal(new Headers(init?.headers).get(IMAGE_INPUT_HEADER), '1')
			assert.equal(init?.body instanceof Blob, true)
			return json(envelope)
		}
		const uploadImage = transport.uploadImage
		assert.ok(uploadImage)
		await assert.rejects(
			uploadImage(
				{ hostEpoch, target },
				new Blob([new Uint8Array(baselineJpeg)], { type: 'image/jpeg' }),
				new AbortController().signal,
			),
			/Image input negotiation unavailable/,
		)
		globalThis.fetch = async (_input, init) => {
			assert.equal(new Headers(init?.headers).get(IMAGE_INPUT_HEADER), '1')
			return json(envelope, { [IMAGE_INPUT_HEADER]: '1' })
		}
		assert.deepEqual(
			await uploadImage(
				{ hostEpoch, target },
				new Blob([new Uint8Array(baselineJpeg)], { type: 'image/jpeg' }),
				new AbortController().signal,
			),
			envelope,
		)
	} finally {
		globalThis.fetch = original
	}
})
