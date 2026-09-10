import assert from 'node:assert/strict'
import test from 'node:test'
import qrcode from 'qrcode-generator'
import pairingModule from '../app/src/remote-pairing.ts'
import gateModule from '../app/src/session-ipc-gate.ts'
import type { RemoteControlResponse } from '../src/remote/control-client.ts'

const { RemotePairingController, requireRemotePairingSender } = pairingModule
const { createSessionIpcGate } = gateModule
const NOW = 1_800_000_000_000
const ORIGIN = 'https://remote.example.test'
const EPOCH = '0c262daa-5097-47f8-bc38-e604af2c94fe'
const ID = '5c8f4b1c-590c-49f3-a5ef-3e6c76422a5f'
const GRANT = {
	personalCurrentAndFuture: true,
	scopeIds: [],
	operations: { read: true, prompt: true, interrupt: true, answer: true },
}

function status(changed = false): RemoteControlResponse {
	return {
		status: 200,
		body: {
			protocol: 1,
			build: 'fixture',
			hostEpoch: changed ? ID : EPOCH,
			config: {
				protocol: 1,
				build: 'fixture',
				origin: changed ? 'https://replacement.example.test' : ORIGIN,
				port: 9784,
				browserHost: '127.0.0.1',
				piSessionRoots: [],
			},
			listeningPort: 9784,
		},
	}
}
function presentation(ttl = 120_000): RemoteControlResponse {
	return { status: 201, body: { code: 'ABC-123', qrCapability: 'a'.repeat(43), expiresAt: NOW + ttl, grant: GRANT } }
}
function controller(request: (path: string) => Promise<RemoteControlResponse>, readToken = () => 'a'.repeat(43)) {
	return new RemotePairingController({
		root: '/tmp/unused-native-pairing-fixture',
		now: () => NOW,
		readToken,
		request: (_socket, _token, path) => request(path),
	})
}
function admission() {
	let open = true
	let token = 'work:1'
	let destroyed = false
	const webContents = { mainFrame: {} }
	const win = { webContents, isDestroyed: () => destroyed }
	const event = { sender: webContents as unknown, senderFrame: webContents.mainFrame as unknown }
	const gate = createSessionIpcGate(candidate => open && candidate === token)
	const requireCurrent = () =>
		requireRemotePairingSender(
			event,
			'work:1',
			value => gate.require(value),
			() => win,
		)
	return {
		event,
		win,
		requireCurrent,
		isCurrent: () => {
			try {
				requireCurrent()
				return true
			} catch {
				return false
			}
		},
		close: () => {
			open = false
		},
		switchProfile: () => {
			token = 'other:2'
		},
		destroy: () => {
			destroyed = true
		},
		reload: () => {
			webContents.mainFrame = {}
		},
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}

test('real main admission rejects foreign contents, subframes, reloads, closed gates and stale profiles before effects', async () => {
	const valid = admission()
	assert.equal(valid.requireCurrent(), valid.win)
	const changes: Array<(access: ReturnType<typeof admission>) => void> = [
		access => {
			access.event.sender = {}
		},
		access => {
			access.event.senderFrame = {}
		},
		access => access.reload(),
		access => access.close(),
		access => access.switchProfile(),
		access => access.destroy(),
	]
	for (const change of changes) {
		const access = admission()
		change(access)
		let effects = 0
		const instance = controller(
			async () => {
				effects++
				return status()
			},
			() => {
				effects++
				return 'a'.repeat(43)
			},
		)
		await assert.rejects(
			instance.pair('Phone', access.isCurrent, async () => {
				effects++
				return true
			}),
		)
		assert.equal(effects, 0)
	}
})

test('confirmation and token-read boundaries recheck actual main admission', async () => {
	const access = admission()
	const approved = deferred<boolean>()
	const started = deferred<void>()
	let reads = 0
	let requests = 0
	const instance = controller(
		async () => {
			requests++
			return status()
		},
		() => {
			reads++
			return 'a'.repeat(43)
		},
	)
	const pending = instance.pair('Phone', access.isCurrent, () => {
		started.resolve()
		return approved.promise
	})
	await started.promise
	access.switchProfile()
	approved.resolve(true)
	await assert.rejects(pending)
	assert.equal(reads, 0)
	assert.equal(requests, 0)

	const second = admission()
	const afterRead = controller(
		async () => {
			requests++
			return status()
		},
		() => {
			second.reload()
			return 'a'.repeat(43)
		},
	)
	await assert.rejects(afterRead.pair('Phone', second.isCurrent, async () => true))
	assert.equal(requests, 0)
})

test('an actually dispatched pairing response cannot publish into a replacement main frame', async () => {
	const access = admission()
	const posted = deferred<void>()
	const response = deferred<RemoteControlResponse>()
	let posts = 0
	const instance = controller(async path => {
		if (path === '/status') return status()
		posts++
		posted.resolve()
		return response.promise
	})
	const pending = instance.pair('Phone', access.isCurrent, async () => true)
	await posted.promise
	access.reload()
	response.resolve(presentation())
	await assert.rejects(pending)
	assert.equal(posts, 1)
})

test('valid limited scoped devices remain manageable without leaking their scope ids', async () => {
	const instance = controller(async path =>
		path === '/status'
			? status()
			: {
					status: 200,
					body: {
						devices: [
							{
								id: ID,
								label: 'Read-only device',
								createdAt: NOW - 1000,
								expiresAt: NOW + 100000,
								revokedAt: null,
								grantRevision: 1,
								grant: {
									personalCurrentAndFuture: false,
									scopeIds: [EPOCH],
									operations: { read: true, prompt: false, interrupt: false, answer: false },
								},
							},
						],
					},
				},
	)
	const result = await instance.status(() => true)
	assert.equal(result.availability, 'available')
	assert.doesNotMatch(JSON.stringify(result), /scopeIds|grantRevision|credential|hostEpoch/)
})

test('host replacement after issuance never exposes a stale-origin QR', async () => {
	let replaced = false
	const instance = controller(async path => {
		if (path === '/status') return status(replaced)
		replaced = true
		return presentation()
	})
	await assert.rejects(
		instance.pair(
			'Phone',
			() => true,
			async () => true,
		),
		/changed/,
	)
})

test('pairing rejects malformed, expired, overlong and broadened issuance responses', async () => {
	const valid = presentation().body as Record<string, unknown>
	for (const body of [
		{ ...valid, code: 'BAD' },
		{ ...valid, expiresAt: NOW },
		{ ...valid, expiresAt: NOW + 180_000 },
		{ ...valid, grant: { ...GRANT, scopeIds: [EPOCH] } },
		{ ...valid, grant: { ...GRANT, operations: { ...GRANT.operations, answer: false } } },
		{ ...valid, operatorToken: 'must-not-cross' },
	]) {
		const instance = controller(async path => (path === '/status' ? status() : { status: 201, body }))
		await assert.rejects(
			instance.pair(
				'Phone',
				() => true,
				async () => true,
			),
			/invalid/,
		)
	}
})

test('generated QR keeps the four-module quiet zone required for camera scanning', async () => {
	const instance = controller(async path => (path === '/status' ? status() : presentation()))
	const result = await instance.pair(
		'Phone',
		() => true,
		async () => true,
	)
	assert.equal(result.kind, 'created')
	if (result.kind !== 'created') return
	const qr = qrcode(0, 'M')
	qr.addData(`${ORIGIN}/#pair=${'a'.repeat(43)}`, 'Byte')
	qr.make()
	const payload = result.presentation.qrDataUrl.split(',')[1]
	assert.ok(payload)
	const image = Buffer.from(payload, 'base64')
	assert.equal(image.subarray(0, 3).toString(), 'GIF')
	assert.equal(image.readUInt16LE(6), qr.getModuleCount() * 4 + 32)
	assert.equal(image.readUInt16LE(8), qr.getModuleCount() * 4 + 32)
})
