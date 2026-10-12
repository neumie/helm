import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error -- app modules load as CommonJS under the root tsx runner.
import transportModule from '../app/src/renderer/remote/transport.js'
import type * as TransportExports from '../app/src/renderer/remote/transport.js'
import type { RemoteCommand } from '../src/remote/protocol.js'

const { createRemoteTransport, RemoteAccessError } = transportModule as typeof TransportExports

for (const text of ['界'.repeat(9000), '\\'.repeat(16384), '\u0001'.repeat(5000)]) {
	test(`serialized oversize is known-unsent with zero requests (${text.charCodeAt(0)})`, async () => {
		const original = globalThis.fetch
		let requests = 0
		globalThis.fetch = async () => {
			requests++
			throw new Error('Must not fetch')
		}
		try {
			const command: RemoteCommand = {
				protocol: 1,
				commandId: '30000000-0000-4000-8000-000000000001',
				hostEpoch: '10000000-0000-4000-8000-000000000000',
				target: {
					sessionId: '10000000-0000-4000-8000-000000000001',
					incarnation: '20000000-0000-4000-8000-000000000001',
					scopeId: null,
					generation: 1,
				},
				operation: { kind: 'prompt', text, delivery: 'steer' },
			}
			await assert.rejects(
				createRemoteTransport().send(command, new AbortController().signal),
				error => error instanceof RemoteAccessError && error.status === 413,
			)
			assert.equal(requests, 0)
		} finally {
			globalThis.fetch = original
		}
	})
}
