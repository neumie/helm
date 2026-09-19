import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAccess } from '../src/remote/access.js'
import { RemoteHost } from '../src/remote/host.js'
import { REMOTE_PROTOCOL, type RemoteModel, type RemoteSnapshot } from '../src/remote/protocol.js'

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
async function fixture(t: { after(fn: () => void): void }, models: RemoteModel[] | null = [OPUS, TEXT_ONLY]) {
	const localToken = createScopedCapability()
	const enrollment = {
		id: randomUUID(),
		capabilityHash: hashScopedCapability(localToken),
		scopeId: null,
		generation: 1,
	}
	const origin = 'https://remote.example'
	const access = new RemoteAccess(join(scratch(t), 'devices.json'))
	const host = new RemoteHost({ origin, enrollments: [enrollment], access })
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
	const exchange = await host.local.request('/exchange', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${localToken}`,
			'X-Helm-Enrollment': enrollment.id,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] }),
	})
	assert.equal(exchange.status, 200)

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
				operation: { kind: 'model', ...model },
			}),
		})
	return { host, snapshot, device, choose }
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
