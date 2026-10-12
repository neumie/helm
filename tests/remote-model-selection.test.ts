import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAccess } from '../src/remote/access.js'
import { RemoteHost } from '../src/remote/host.js'
import { REMOTE_PROTOCOL, type RemoteModel, type RemoteReceipt, type RemoteSnapshot } from '../src/remote/protocol.js'

const OPUS: RemoteModel = { provider: 'anthropic', id: 'claude-opus-5', label: 'Opus 5', image: true }
const TEXT_ONLY: RemoteModel = { provider: 'openai-codex', id: 'gpt-6-astra', label: 'GPT-6 Astra', image: false }

function scratch(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync('/tmp/hr-model-'))
	chmodSync(root, 0o700)
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return root
}

// null, not undefined: an explicit undefined would silently fall back to the default
// and the "bridge lists nothing" case would quietly test the opposite of its name.
async function fixture(
	t: { after(fn: () => void): void },
	models: RemoteModel[] | null = [OPUS, TEXT_ONLY],
	now = Date.now,
) {
	const localToken = createScopedCapability()
	let enrollment = {
		id: randomUUID(),
		capabilityHash: hashScopedCapability(localToken),
		scopeId: null,
		generation: 1,
	}
	const origin = 'https://remote.example'
	const access = new RemoteAccess(join(scratch(t), 'devices.json'), now)
	const host = new RemoteHost({ origin, enrollments: [enrollment], access, now })
	t.after(() => host.revoke())
	const snapshot: RemoteSnapshot = {
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
		revision: 1,
		label: 'Model selection fixture',
		workspace: 'Fixture',
		model: 'openai-codex/gpt-6-astra',
		...(models ? { models } : {}),
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: false },
		question: null,
		messages: [],
		historyTruncated: false,
	}
	const exchange = (receipts: RemoteReceipt[] = []) =>
		host.local.request('/exchange', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${localToken}`,
				'X-Helm-Enrollment': enrollment.id,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts }),
		})
	assert.equal((await exchange()).status, 200)

	function device(prompt: boolean) {
		const pairing = access.createPairing('fixture', {
			personalCurrentAndFuture: true,
			scopeIds: [],
			operations: { read: true, prompt, interrupt: true, answer: prompt },
		})
		const value = access.redeem({ qrCapability: pairing.qrCapability })
		assert.ok(value)
		return value.credential
	}
	const choose = (credential: string, model: { provider: string; id: string }) =>
		host.browser.request('/v1/commands', {
			method: 'POST',
			headers: {
				Host: 'remote.example',
				Origin: origin,
				Cookie: `__Host-helm-remote=${credential}`,
				'Content-Type': 'application/json',
				'X-Helm-Remote': '1',
			},
			body: JSON.stringify({
				protocol: REMOTE_PROTOCOL,
				hostEpoch: host.epoch,
				commandId: randomUUID(),
				target: snapshot.target,
				operation: { kind: 'model', provider: model.provider, id: model.id },
			}),
		})
	const replaceOwner = () => {
		enrollment = { ...enrollment, id: randomUUID() }
		host.issueEnrollment(enrollment)
		snapshot.target = { ...snapshot.target, incarnation: randomUUID() }
	}
	return { host, snapshot, device, choose, exchange, access, replaceOwner }
}

test('a listed model is accepted and an unlisted one is never dispatched', async t => {
	const f = await fixture(t)
	const credential = f.device(true)
	assert.equal((await f.choose(credential, { provider: OPUS.provider, id: OPUS.id })).status, 202)
	// Naming a model nobody offered must not reach Pi, whatever the device claims.
	assert.equal((await f.choose(credential, { provider: 'anthropic', id: 'not-offered' })).status, 409)
	assert.equal((await f.choose(credential, { provider: 'other', id: OPUS.id })).status, 409)
})

test('choosing a model needs the authority to direct the conversation, not merely to stop it', async t => {
	const f = await fixture(t)
	// This device may read and interrupt, but may not prompt.
	const readOnly = f.device(false)
	assert.equal((await f.choose(readOnly, { provider: OPUS.provider, id: OPUS.id })).status, 403)
})

test('a bridge that never listed models offers no selection at all', async t => {
	const f = await fixture(t, null)
	const credential = f.device(true)
	assert.equal((await f.choose(credential, { provider: OPUS.provider, id: OPUS.id })).status, 409)
})

for (const boundary of ['live', 'expired', 'revoked', 'replacement'] as const) {
	test(`delayed model refusal after dispatched receipt: ${boundary}`, async t => {
		let now = Date.now()
		const f = await fixture(t, [OPUS], () => now)
		const credential = f.device(true)
		const response = await f.choose(credential, OPUS)
		assert.equal(response.status, 202)
		const initial = (await response.json()) as RemoteReceipt
		await f.exchange() // Deliver before accepting its initial dispatch receipt.
		await f.exchange([{ commandId: initial.commandId, status: 'dispatched' }])
		if (boundary === 'expired') now += 10_001
		if (boundary === 'revoked') {
			const principal = f.access.authenticate(credential)
			assert.ok(principal)
			f.access.revoke(principal.deviceId)
		}
		if (boundary === 'replacement') {
			now += 30_000
			f.replaceOwner()
		}
		await f.exchange([{ commandId: initial.commandId, status: 'rejected' }])
		// Inspect current owner state to cover revoked devices without restoring their authority.
		const sessions = (
			f.host as unknown as { sessions: Map<string, { commands: Map<string, { receipt: RemoteReceipt }> }> }
		).sessions
		const entry = [...sessions.values()][0]?.commands.get(initial.commandId)
		if (boundary === 'replacement') assert.equal(entry, undefined)
		else assert.equal(entry?.receipt.status, boundary === 'live' ? 'rejected' : 'dispatched')
	})
}

test('model diagnostic dedup is attached only to bounded current owners', async t => {
	let now = Date.now()
	const f = await fixture(t, [OPUS], () => now)
	const credential = f.device(true)
	for (let index = 0; index < 80; index++) {
		now += 30_000
		f.replaceOwner()
		assert.equal((await f.exchange()).status, 200)
		assert.equal(
			(
				await f.host.browser.request(`/v1/sessions/${f.snapshot.target.sessionId}`, {
					headers: { Host: 'remote.example', Cookie: `__Host-helm-remote=${credential}` },
				})
			).status,
			200,
		)
	}
	assert.equal('modelListReported' in f.host, false)
	const sessions = (f.host as unknown as { sessions: Map<string, { modelListReported?: Set<string> }> }).sessions
	assert.equal(sessions.size, 1)
	for (const session of sessions.values()) assert.equal(session.modelListReported?.size, 1)
	f.host.revoke()
	assert.equal(sessions.size, 0)
})
