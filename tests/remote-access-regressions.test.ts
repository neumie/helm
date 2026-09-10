import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RemoteAccess, type RemoteDeviceGrant } from '../src/remote/access.js'

const grant: RemoteDeviceGrant = {
	personalCurrentAndFuture: true,
	scopeIds: [],
	operations: { read: true, prompt: true, interrupt: true, answer: true },
}

function pair(access: RemoteAccess, selectedGrant = grant, label = 'Phone') {
	const challenge = access.createPairing(label, selectedGrant)
	return access.redeem({ code: challenge.code })
}

test('a subsequent failed pairing never restores a revoked credential from stale disk state', () => {
	const root = mkdtempSync(join(tmpdir(), 'hra-revoke-'))
	const path = join(root, 'devices.json')
	let failing = false
	try {
		const access = new RemoteAccess(path, () => 1000, {
			persist: (temporary, content) => {
				if (failing) throw new Error('Injected disk failure')
				writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
			},
		})
		const device = pair(access)
		assert.ok(device)
		failing = true
		assert.equal(access.revoke(device.principal.deviceId), false)
		assert.equal(access.authenticate(device.credential), null)
		assert.equal(pair(access), null)
		assert.equal(access.authenticate(device.credential), null)
		failing = false
		assert.equal(access.revoke(device.principal.deviceId), true)
		assert.equal(new RemoteAccess(path, () => 1000).authenticate(device.credential), null)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('pairing reserves byte capacity for every admitted device to be durably revoked', () => {
	const root = mkdtempSync(join(tmpdir(), 'hra-capacity-'))
	const path = join(root, 'devices.json')
	const maximum = 128 * 1024
	const wideGrant = { ...grant, scopeIds: Array.from({ length: 64 }, () => randomUUID()) }
	try {
		const access = new RemoteAccess(path, () => 1000)
		for (let index = 0; index < 128; index++) {
			if (!pair(access, wideGrant, 'x')) break
		}
		const original = readFileSync(path, 'utf8')
		const document = JSON.parse(original) as {
			version: 1
			devices: Array<ReturnType<RemoteAccess['list']>[number] & { credentialHash: string }>
		}
		const exemplar = document.devices[0]
		assert.ok(exemplar)
		let unsafeCandidate: { grant: RemoteDeviceGrant; label: string } | undefined
		for (let count = 0; count <= 64; count++) {
			const selectedGrant = { ...grant, scopeIds: wideGrant.scopeIds.slice(0, count) }
			const candidate = { ...exemplar, id: randomUUID(), grant: selectedGrant, label: 'x' }
			const prospective = { ...document, devices: [...document.devices, candidate] }
			const bytes = Buffer.byteLength(`${JSON.stringify(prospective)}\n`)
			if (bytes > maximum) continue
			candidate.label = 'x'.repeat(1 + Math.min(79, maximum - bytes))
			const allRevoked = {
				...prospective,
				devices: prospective.devices.map(device => ({
					...device,
					revokedAt: Number.MAX_SAFE_INTEGER,
					grantRevision: device.grantRevision + 1,
				})),
			}
			if (Buffer.byteLength(`${JSON.stringify(allRevoked)}\n`) > maximum) {
				unsafeCandidate = { grant: selectedGrant, label: candidate.label }
				break
			}
		}
		assert.ok(unsafeCandidate, 'fixture must fit now but lack room for future revocations')
		assert.equal(pair(access, unsafeCandidate.grant, unsafeCandidate.label) === null, true)
		assert.equal(readFileSync(path, 'utf8'), original)
		for (const device of access.list()) assert.equal(access.revoke(device.id), true)
		const restored = new RemoteAccess(path, () => 1000)
		for (const device of document.devices) assert.equal(restored.principal(device.id), null)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
