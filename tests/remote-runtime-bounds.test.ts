import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAccess, type RemoteDeviceGrant } from '../src/remote/access.js'
import { RemoteHost } from '../src/remote/host.js'
import {
	REMOTE_MAX_OWNERS,
	REMOTE_PROTOCOL,
	type RemoteSnapshot,
	remoteDirectorySchema,
} from '../src/remote/protocol.js'
import { configureRemoteRuntime, readRemoteRuntimeSetup, startRemoteRuntime } from '../src/remote/runtime.js'

const origin = 'https://remote.example'
const fullGrant: RemoteDeviceGrant = {
	personalCurrentAndFuture: true,
	scopeIds: [],
	operations: { read: true, prompt: true, interrupt: true, answer: true },
}

function privateRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix))
	chmodSync(root, 0o700)
	return root
}
function snapshot(sessionId = randomUUID(), incarnation = randomUUID()): RemoteSnapshot {
	return {
		target: { sessionId, incarnation, scopeId: null, generation: 1 },
		revision: 1,
		label: 'Bounded Pi',
		workspace: 'workspace',
		model: null,
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: true },
		question: null,
		messages: [],
		historyTruncated: false,
	}
}
function localExchange(host: RemoteHost, enrollment: { id: string; capability: string }, value: RemoteSnapshot) {
	return host.local.request('/exchange', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${enrollment.capability}`,
			'X-Helm-Enrollment': enrollment.id,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ protocol: REMOTE_PROTOCOL, enrollmentId: enrollment.id, snapshot: value, receipts: [] }),
	})
}
function headers(credential: string) {
	return {
		Host: 'remote.example',
		Origin: origin,
		'Content-Type': 'application/json',
		'X-Helm-Remote': '1',
		Cookie: `__Host-helm-remote=${credential}`,
	}
}
function pair(access: RemoteAccess, grant = fullGrant) {
	const challenge = access.createPairing('Bounded device', grant)
	const paired = access.redeem({ code: challenge.code })
	assert.ok(paired)
	return paired
}
function issue(host: RemoteHost, sessionId?: string, expiresAt?: number) {
	const capability = createScopedCapability()
	const enrollment = { id: randomUUID(), capability }
	host.issueEnrollment({
		id: enrollment.id,
		capabilityHash: hashScopedCapability(capability),
		scopeId: null,
		generation: 1,
		sessionId,
		expiresAt,
	})
	return enrollment
}

// This crosses the real browser transport schema rather than only inspecting the host map.
test('directory wire capacity matches admission, stale owners reclaim under pressure, and live owners are never evicted', async () => {
	let now = 1_000
	const browser = createScopedCapability()
	const host = new RemoteHost({ origin, browserCapabilityHash: hashScopedCapability(browser), now: () => now })
	const current: Array<{ enrollment: { id: string; capability: string }; value: RemoteSnapshot }> = []
	for (let index = 0; index < 17; index++) {
		const enrollment = issue(host)
		const value = snapshot()
		assert.equal((await localExchange(host, enrollment, value)).status, 200)
		current.push({ enrollment, value })
	}
	const directory = await (
		await host.browser.request('/v1/sessions', {
			headers: { Host: 'remote.example', Authorization: `Bearer ${browser}` },
		})
	).json()
	assert.equal(remoteDirectorySchema.parse(directory).sessions.length, 17)

	// More than one lifetime of distinct owners is admitted only after every prior
	// observation has crossed the injected stale boundary.
	now += 5_001
	for (let index = 0; index < REMOTE_MAX_OWNERS + 2; index++) {
		const enrollment = issue(host)
		assert.equal((await localExchange(host, enrollment, snapshot())).status, 200)
		now += 5_001
	}

	const liveNow = 2_000_000
	const full = new RemoteHost({
		origin,
		browserCapabilityHash: hashScopedCapability(createScopedCapability()),
		now: () => liveNow,
	})
	for (let index = 0; index < REMOTE_MAX_OWNERS; index++) {
		const enrollment = issue(full)
		assert.equal((await localExchange(full, enrollment, snapshot())).status, 200)
	}
	assert.throws(() => issue(full), /enrollment unavailable/)
})

test('retired incarnation pressure occurs before TTL expiry, preserving device isolation and delivered uncertainty', async () => {
	const root = privateRoot('hr-retired-')
	let now = 1_000
	try {
		const access = new RemoteAccess(join(root, 'devices.json'), () => now)
		const firstDevice = pair(access)
		const secondDevice = pair(access)
		const host = new RemoteHost({ origin, access, now: () => now })
		const sessionIds = Array.from({ length: 32 }, () => randomUUID())
		const records: Array<{ target: RemoteSnapshot['target']; commandId: string }> = []
		for (let batch = 0; batch < 3; batch++) {
			for (const [index, sessionId] of sessionIds.entries()) {
				const enrollment = issue(host, sessionId)
				const value = snapshot(sessionId)
				assert.equal((await localExchange(host, enrollment, value)).status, 200)
				const commandId = randomUUID()
				assert.equal(
					(
						await host.browser.request('/v1/commands', {
							method: 'POST',
							headers: headers(firstDevice.credential),
							body: JSON.stringify({
								protocol: 1,
								hostEpoch: host.epoch,
								commandId,
								target: value.target,
								operation: { kind: 'prompt', text: 'receipt', delivery: 'steer' },
							}),
						})
					).status,
					202,
				)
				if (index % 2 === 0) assert.equal((await localExchange(host, enrollment, value)).status, 200)
				records.push({ target: value.target, commandId })
			}
			now += 5_001
		}
		// Issue reclaims only the already-stale owners, retiring the last batch.
		issue(host)
		assert.ok(now < 60_000, 'no retired record can have reached its 60-second TTL')
		const receipt = (record: (typeof records)[number], credential: string) =>
			host.browser.request(
				`/v1/commands/${record.commandId}?${new URLSearchParams({ hostEpoch: host.epoch, sessionId: record.target.sessionId, incarnation: record.target.incarnation })}`,
				{ headers: headers(credential) },
			)
		for (const [index, record] of records.entries()) {
			const response = await receipt(record, firstDevice.credential)
			assert.equal(response.status, index < 32 ? 409 : 200, 'exact global 64-incarnation boundary')
			if (index >= 32) assert.equal((await response.json()).status, index % 2 === 0 ? 'unknown' : 'rejected')
		}
		const latest = records.at(-1)
		assert.ok(latest)
		assert.equal((await receipt(latest, secondDevice.credential)).status, 409)
		now += 60_001
		assert.equal((await receipt(latest, firstDevice.credential)).status, 409)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

for (const [label, ownerCount, commandsPerOwner, retainedOwners, retainedPerOwner] of [
	['per-incarnation', 1, 40, 1, 32],
	['global-receipt', 17, 32, 16, 32],
] as const)
	test(`retired ${label} cap is exact before TTL expiry`, async () => {
		const root = privateRoot('hr-receipt-cap-')
		let now = 1_000
		try {
			const access = new RemoteAccess(join(root, 'devices.json'), () => now)
			const devices = Array.from({ length: 8 }, () => pair(access))
			const host = new RemoteHost({ origin, access, now: () => now })
			const owners: Array<{ value: RemoteSnapshot; ids: string[]; credential: string }> = []
			for (let owner = 0; owner < ownerCount; owner++) {
				const enrollment = issue(host)
				const value = snapshot()
				const credential = devices[owner % devices.length]?.credential
				assert.ok(credential)
				assert.equal((await localExchange(host, enrollment, value)).status, 200)
				const ids: string[] = []
				for (let index = 0; index < commandsPerOwner; index++) {
					const commandId = randomUUID()
					ids.push(commandId)
					assert.equal(
						(
							await host.browser.request('/v1/commands', {
								method: 'POST',
								headers: headers(credential),
								body: JSON.stringify({
									protocol: 1,
									hostEpoch: host.epoch,
									commandId,
									target: value.target,
									operation: { kind: 'prompt', text: 'bounded', delivery: 'steer' },
								}),
							})
						).status,
						202,
					)
					assert.equal((await localExchange(host, enrollment, value)).status, 200)
					assert.equal(
						(
							await host.local.request('/exchange', {
								method: 'POST',
								headers: {
									Authorization: `Bearer ${enrollment.capability}`,
									'X-Helm-Enrollment': enrollment.id,
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									protocol: 1,
									enrollmentId: enrollment.id,
									snapshot: value,
									receipts: [{ commandId, status: 'dispatched' }],
								}),
							})
						).status,
						200,
					)
				}
				owners.push({ value, ids, credential })
			}
			now += 5_001
			issue(host)
			assert.ok(now < 60_000)
			let retained = 0
			for (const [owner, record] of owners.entries())
				for (const [index, id] of record.ids.entries()) {
					const response = await host.browser.request(
						`/v1/commands/${id}?${new URLSearchParams({ hostEpoch: host.epoch, sessionId: record.value.target.sessionId, incarnation: record.value.target.incarnation })}`,
						{ headers: headers(record.credential) },
					)
					const present = owner >= ownerCount - retainedOwners && index < retainedPerOwner
					assert.equal(response.status, present ? 200 : 409)
					if (present) {
						retained++
						assert.equal((await response.json()).status, 'dispatched')
					}
				}
			assert.equal(retained, retainedOwners * retainedPerOwner)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

test('directory and detail project current device authority without mutating the Pi snapshot', async () => {
	const root = privateRoot('hr-projection-')
	try {
		const access = new RemoteAccess(join(root, 'devices.json'))
		const full = pair(access)
		const readOnly = pair(access, {
			...fullGrant,
			operations: { read: true, prompt: false, interrupt: false, answer: false },
		})
		const host = new RemoteHost({ origin, access })
		const enrollment = issue(host)
		const value = snapshot()
		value.question = {
			requestId: randomUUID(),
			questions: [
				{
					question: 'Keep this evidence?',
					header: 'Choice',
					options: [
						{ label: 'Yes', description: 'Keep' },
						{ label: 'No', description: 'Remove' },
					],
				},
			],
		}
		const immutable = structuredClone(value)
		assert.equal((await localExchange(host, enrollment, value)).status, 200)
		const directory = await (
			await host.browser.request('/v1/sessions', { headers: headers(readOnly.credential) })
		).json()
		assert.deepEqual(directory.sessions[0].capabilities, { prompt: false, interrupt: false, answer: false })
		const detail = await (
			await host.browser.request(`/v1/sessions/${value.target.sessionId}`, { headers: headers(readOnly.credential) })
		).json()
		assert.deepEqual(detail.snapshot.capabilities, { prompt: false, interrupt: false, answer: false })
		const allowed = await (await host.browser.request('/v1/sessions', { headers: headers(full.credential) })).json()
		assert.deepEqual(allowed.sessions[0].capabilities, { prompt: true, interrupt: true, answer: true })
		const fullDetail = await (
			await host.browser.request(`/v1/sessions/${value.target.sessionId}`, { headers: headers(full.credential) })
		).json()
		assert.deepEqual(detail.snapshot.question, fullDetail.snapshot.question)
		assert.deepEqual(detail.snapshot.question, value.question)
		assert.equal(detail.snapshot.revision, fullDetail.snapshot.revision)
		assert.deepEqual(fullDetail.snapshot.capabilities, { prompt: true, interrupt: true, answer: true })
		assert.equal(
			(
				await host.browser.request('/v1/commands', {
					method: 'POST',
					headers: headers(readOnly.credential),
					body: JSON.stringify({
						protocol: 1,
						hostEpoch: host.epoch,
						commandId: randomUUID(),
						target: value.target,
						operation: { kind: 'answer', requestId: value.question.requestId, answers: [{ option: 0 }] },
					}),
				})
			).status,
			403,
		)
		assert.deepEqual(value, immutable)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('body-await fences revoked devices and expired unused grants at the final authority boundary', async () => {
	const root = privateRoot('hr-body-await-')
	let now = 1_000
	try {
		const access = new RemoteAccess(join(root, 'devices.json'), () => now)
		const paired = pair(access)
		const host = new RemoteHost({ origin, access, now: () => now })
		const enrollment = issue(host)
		const value = snapshot()
		assert.equal((await localExchange(host, enrollment, value)).status, 200)
		let releaseBrowser!: () => void
		const browserBody = new ReadableStream<Uint8Array>({
			start(controller) {
				releaseBrowser = () => {
					controller.enqueue(
						Buffer.from(
							JSON.stringify({
								protocol: REMOTE_PROTOCOL,
								hostEpoch: host.epoch,
								commandId: randomUUID(),
								target: value.target,
								operation: { kind: 'prompt', text: 'late', delivery: 'steer' },
							}),
						),
					)
					controller.close()
				}
			},
		})
		const pendingBrowser = host.browser.fetch(
			new Request(`${origin}/v1/commands`, {
				method: 'POST',
				headers: headers(paired.credential),
				body: browserBody,
				duplex: 'half',
			} as RequestInit),
		)
		assert.equal(access.revoke(paired.principal.deviceId), true)
		releaseBrowser()
		assert.equal((await pendingBrowser).status, 401)

		const unused = issue(host, undefined, now + 1)
		let releaseLocal!: () => void
		const localBody = new ReadableStream<Uint8Array>({
			start(controller) {
				releaseLocal = () => {
					controller.enqueue(
						Buffer.from(
							JSON.stringify({
								protocol: REMOTE_PROTOCOL,
								enrollmentId: unused.id,
								snapshot: snapshot(),
								receipts: [],
							}),
						),
					)
					controller.close()
				}
			},
		})
		const pendingLocal = host.local.fetch(
			new Request('http://local/exchange', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${unused.capability}`,
					'X-Helm-Enrollment': unused.id,
					'Content-Type': 'application/json',
				},
				body: localBody,
				duplex: 'half',
			} as RequestInit),
		)
		now += 30_001
		releaseLocal()
		assert.equal((await pendingLocal).status, 403)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('prospective setup/runtime limits preserve readable state, setup CLI repairs invalid documents, and invalid startup owns no lock', async () => {
	const root = privateRoot('hr-runtime-bounds-')
	try {
		const valid = configureRemoteRuntime({ root, origin, piSessionRoots: [join(root, 'sessions')] })
		assert.throws(
			() =>
				configureRemoteRuntime({
					root,
					origin,
					piSessionRoots: Array.from({ length: 9 }, (_, i) => join(root, `root-${i}`)),
				}),
			/invalid|too large/,
		)
		assert.deepEqual(readRemoteRuntimeSetup(root), { origin: valid.origin, piSessionRoots: valid.piSessionRoots })
		assert.throws(
			() =>
				configureRemoteRuntime({
					root,
					origin,
					piSessionRoots: Array.from({ length: 8 }, (_, i) => join(root, `${i}-${'x'.repeat(1200)}`)),
				}),
			/invalid|too large/,
		)
		assert.deepEqual(readRemoteRuntimeSetup(root), { origin: valid.origin, piSessionRoots: valid.piSessionRoots })

		writeFileSync(
			join(root, 'runtime-setup.json'),
			JSON.stringify({ origin, piSessionRoots: Array.from({ length: 9 }, (_, i) => join(root, `bad-${i}`)) }),
			{ mode: 0o600 },
		)
		execFileSync(
			process.execPath,
			['dist/remote/runtime.js', 'setup', '--origin', origin, '--pi-root', join(root, 'repaired')],
			{
				cwd: resolve('.'),
				env: { ...process.env, HELM_REMOTE_ROOT: root },
			},
		)
		assert.deepEqual(readRemoteRuntimeSetup(root).piSessionRoots, [join(root, 'repaired')])
		await assert.rejects(
			startRemoteRuntime({
				root,
				origin,
				assetsDirectory: root,
				piSessionRoots: Array.from({ length: 9 }, (_, i) => join(root, `runtime-${i}`)),
			}),
			/invalid|too large/,
		)
		assert.equal(existsSync(join(root, 'runtime.lock')), false)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('runtime cleanup deletes only discovery identity published by this invocation', async () => {
	const root = privateRoot('hr-runtime-discovery-')
	const assets = privateRoot('hr-runtime-assets-')
	const discovery = join(root, 'bridge-registration.json')
	for (const file of ['index.html', 'remote.js', 'remote.css']) writeFileSync(join(assets, file), '')
	try {
		const replaceDiscovery = (content: string) => {
			const temporary = join(root, `replacement-${randomUUID()}`)
			writeFileSync(temporary, content, { mode: 0o600 })
			renameSync(temporary, discovery)
		}
		replaceDiscovery('pre-existing')
		await assert.rejects(
			startRemoteRuntime({ root, origin, assetsDirectory: join(assets, 'missing'), port: 0, piSessionRoots: [] }),
		)
		assert.equal(readFileSync(discovery, 'utf8'), 'pre-existing')

		await assert.rejects(
			startRemoteRuntime({
				root,
				origin,
				assetsDirectory: assets,
				port: 0,
				piSessionRoots: [],
				lifecycle: {
					afterDiscoveryPublished() {
						replaceDiscovery('replacement-during-start')
						throw new Error('stop after controlled replacement')
					},
				},
			}),
			/stop after controlled replacement/,
		)
		assert.equal(readFileSync(discovery, 'utf8'), 'replacement-during-start')
		rmSync(discovery)
		const runtime = await startRemoteRuntime({
			root,
			origin,
			assetsDirectory: assets,
			port: 0,
			piSessionRoots: [],
			lifecycle: { beforeDiscoveryCleanup: () => replaceDiscovery('replacement-during-stop') },
		})
		await runtime.stop()
		assert.equal(readFileSync(discovery, 'utf8'), 'replacement-during-stop')
		assert.equal(existsSync(join(root, 'runtime.lock')), false)
	} finally {
		rmSync(root, { recursive: true, force: true })
		rmSync(assets, { recursive: true, force: true })
	}
})
