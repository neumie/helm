import assert from 'node:assert/strict'
import test from 'node:test'
import remotePairingModule from '../app/src/remote-pairing.ts'
import type { RemoteControlResponse } from '../src/remote/control-client.ts'

const { RemotePairingController } = remotePairingModule
const NOW = 1_800_000_000_000
const ORIGIN = 'https://remote.example.test'
const DEVICE_ID = '5c8f4b1c-590c-49f3-a5ef-3e6c76422a5f'
const EPOCH = '0c262daa-5097-47f8-bc38-e604af2c94fe'

function grant() {
	return {
		personalCurrentAndFuture: true,
		scopeIds: [],
		operations: { read: true, prompt: true, interrupt: true, answer: true },
	}
}
function status(): RemoteControlResponse {
	return {
		status: 200,
		body: {
			protocol: 1,
			build: 'fixture',
			hostEpoch: EPOCH,
			config: {
				protocol: 1,
				build: 'fixture',
				origin: ORIGIN,
				port: 9784,
				browserHost: '127.0.0.1',
				piSessionRoots: [],
			},
			listeningPort: 9784,
		},
	}
}
function pairing(): RemoteControlResponse {
	return {
		status: 201,
		body: { code: 'ABC-123', qrCapability: 'a'.repeat(43), expiresAt: NOW + 120_000, grant: grant() },
	}
}
function device(): RemoteControlResponse {
	return {
		status: 200,
		body: {
			devices: [
				{
					id: DEVICE_ID,
					label: 'Phone',
					createdAt: NOW - 1,
					expiresAt: NOW + 1,
					revokedAt: null,
					grantRevision: 1,
					grant: grant(),
				},
			],
		},
	}
}

function fixture(request: (path: string) => Promise<RemoteControlResponse>) {
	let reads = 0
	const controller = new RemotePairingController({
		root: '/tmp/remote-pairing-test',
		now: () => NOW,
		readToken: () => {
			reads++
			return 'a'.repeat(43)
		},
		request: (_socket, _token, path) => request(path),
	})
	return { controller, reads: () => reads }
}

test('stale renderer or a cancelled native confirmation cannot read a token or issue pairing', async () => {
	const calls: string[] = []
	const stale = fixture(async path => {
		calls.push(path)
		return pairing()
	})
	await assert.rejects(
		stale.controller.pair(
			'Phone',
			() => false,
			async () => true,
		),
		/no longer current/,
	)
	assert.equal(stale.reads(), 0)
	assert.deepEqual(calls, [])

	const cancelled = fixture(async path => {
		calls.push(path)
		return pairing()
	})
	assert.deepEqual(
		await cancelled.controller.pair(
			'Phone',
			() => true,
			async () => false,
		),
		{ kind: 'cancelled' },
	)
	assert.equal(cancelled.reads(), 0)
	assert.deepEqual(calls, [])
})

test('controller validates only the fixed personal grant and safe projection before exposing a pairing code', async () => {
	const paths: string[] = []
	const { controller } = fixture(async path => {
		paths.push(path)
		if (path === '/status') return status()
		if (path === '/pair') return pairing()
		return device()
	})
	const result = await controller.pair(
		' Phone ',
		() => true,
		async () => true,
	)
	assert.equal(result.kind, 'created')
	if (result.kind === 'created') {
		assert.equal(result.presentation.code, 'ABC-123')
		assert.equal(result.presentation.origin, ORIGIN)
		assert.match(result.presentation.qrDataUrl, /^data:image\/gif;base64,/)
		assert.doesNotMatch(JSON.stringify(result.presentation), /operator|control\.sock|credential/i)
	}
	assert.deepEqual(paths, ['/status', '/pair', '/status'])
})

test('pairing is serialized and stale request completion cannot publish authority', async () => {
	let release!: () => void
	const waiting = new Promise<void>(resolve => {
		release = resolve
	})
	let current = true
	const { controller } = fixture(async path => {
		if (path === '/status') return status()
		await waiting
		return pairing()
	})
	const first = controller.pair(
		'Phone',
		() => current,
		async () => true,
	)
	await assert.rejects(
		controller.pair(
			'Tablet',
			() => true,
			async () => true,
		),
		/already in progress/,
	)
	current = false
	release()
	await assert.rejects(first, /no longer current/)
})

test('status projects devices without raw grants and revocation distinguishes missing from failed persistence', async () => {
	const { controller } = fixture(async path => {
		if (path === '/status') return status()
		if (path === '/devices') return device()
		return { status: 503, body: { error: 'revocation_persistence_failed' } }
	})
	const snapshot = await controller.status(() => true)
	assert.equal(snapshot.availability, 'available')
	if (snapshot.availability === 'available') {
		assert.deepEqual(snapshot.devices[0], {
			id: DEVICE_ID,
			label: 'Phone',
			createdAt: NOW - 1,
			expiresAt: NOW + 1,
			revokedAt: null,
			state: 'active',
		})
		assert.doesNotMatch(JSON.stringify(snapshot), /grant|credential|hostEpoch|socket/i)
	}
	await assert.rejects(
		controller.revoke(
			DEVICE_ID,
			() => true,
			async () => true,
		),
		/could not revoke/,
	)

	const missing = fixture(async path =>
		path === `/devices/${DEVICE_ID}/revoke` ? { status: 404, body: { error: 'not_found' } } : status(),
	)
	assert.deepEqual(
		await missing.controller.revoke(
			DEVICE_ID,
			() => true,
			async () => true,
		),
		{ kind: 'not-found' },
	)
})

test('invalid sender-shaped input and malformed Remote responses fail closed', async () => {
	const invalid = fixture(async () => ({
		status: 201,
		body: { code: 'BAD', qrCapability: 'x', expiresAt: NOW + 120_000, grant: grant() },
	}))
	await assert.rejects(
		invalid.controller.pair(
			'Phone',
			() => true,
			async () => true,
		),
		/unavailable/,
	)
	await assert.rejects(
		invalid.controller.revoke(
			'not-a-uuid',
			() => true,
			async () => true,
		),
		/Invalid Remote device/,
	)
})
