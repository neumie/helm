import assert from 'node:assert/strict'
import test from 'node:test'
import transportModule from '../app/src/renderer/remote/transport.js'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteHost } from '../src/remote/host.js'
import type { RemoteCommand } from '../src/remote/protocol.js'

const { createRemoteTransport } = transportModule
const command: RemoteCommand = {
	commandId: '018f3f5f-5b7a-7abc-8def-0123456789ab',
	hostEpoch: '018f3f5f-5b7a-7abc-8def-abcdef012345',
	target: {
		sessionId: '018f3f5f-5b7a-7abc-8def-0123456789ac',
		incarnation: '018f3f5f-5b7a-7abc-8def-0123456789ad',
		scopeId: null,
		generation: 1,
	},
	operation: { kind: 'interrupt' },
}

function json(status: string) {
	return new Response(JSON.stringify({ commandId: command.commandId, status }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}

test('production transport decodes every receipt status from the request envelope', async () => {
	const original = globalThis.fetch
	try {
		for (const status of ['pending', 'dispatched', 'answered', 'rejected', 'unknown']) {
			globalThis.fetch = (async () => json(status)) as typeof fetch
			const receipt = await createRemoteTransport().receipt(command, new AbortController().signal)
			assert.deepEqual(receipt, { commandId: command.commandId, status })
		}
	} finally {
		globalThis.fetch = original
	}
})

test('in-memory host ACKs activity negotiation and returns the opt-in field', async () => {
	const capability = createScopedCapability()
	const enrollment = {
		id: '018f3f5f-5b7a-7abc-8def-0123456789ae',
		capabilityHash: hashScopedCapability(capability),
		scopeId: null,
		generation: 1,
	}
	const host = new RemoteHost({
		origin: 'http://127.0.0.1:31877',
		enrollments: [enrollment],
		browserCapabilityHash: hashScopedCapability(capability),
	})
	const snapshot = {
		target: command.target,
		revision: 0,
		label: 'Fixture',
		workspace: 'Fixture',
		model: null,
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: false },
		question: null,
		messages: [],
		historyTruncated: false,
		subagents: { availability: 'available', coverage: 'limited', active: false },
	}
	const response = await host.local.fetch(
		new Request('http://local/exchange', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${capability}`,
				'X-Helm-Enrollment': enrollment.id,
				'Content-Type': 'application/json',
				'X-Helm-Subagent-Activity': '1',
			},
			body: JSON.stringify({ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] }),
		}),
		{},
	)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get('X-Helm-Subagent-Activity'), '1')
	host.revoke()
})

test('receipt transport rejects non-success responses as access errors', async () => {
	const original = globalThis.fetch
	try {
		globalThis.fetch = (async () => new Response('{}', { status: 409 })) as typeof fetch
		await assert.rejects(
			createRemoteTransport().receipt(command, new AbortController().signal),
			(error: unknown) => error instanceof Error && error.message === 'Remote request failed (409)',
		)
	} finally {
		globalThis.fetch = original
	}
})

test('host leases only connected available evidence and GET never renews the observation', async () => {
	const capability = createScopedCapability()
	const enrollment = {
		id: '018f3f5f-5b7a-7abc-8def-0123456789ae',
		capabilityHash: hashScopedCapability(capability),
		scopeId: null,
		generation: 1,
	}
	const origin = 'http://127.0.0.1:31877'
	let now = 1000
	const host = new RemoteHost({
		origin,
		enrollments: [enrollment],
		browserCapabilityHash: hashScopedCapability(capability),
		now: () => now,
	})
	const headers = { Host: new URL(origin).host, Authorization: `Bearer ${capability}`, Origin: origin }
	try {
		for (const activity of [
			{ availability: 'available', coverage: 'limited', active: true },
			{ availability: 'available', coverage: 'limited', active: false },
			{ availability: 'unavailable', coverage: 'unavailable', active: null },
			{ availability: 'unsupported', coverage: 'unavailable', active: null },
			undefined,
		]) {
			const snapshot = {
				target: command.target,
				revision: 0,
				label: 'Fixture',
				workspace: 'Fixture',
				model: null,
				activity: 'idle',
				capabilities: { prompt: true, interrupt: true, answer: false },
				question: null,
				messages: [],
				historyTruncated: false,
				subagents: activity,
			}
			const response = await host.local.fetch(
				new Request('http://local/exchange', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${capability}`,
						'X-Helm-Enrollment': enrollment.id,
						'Content-Type': 'application/json',
						'X-Helm-Subagent-Activity': '1',
					},
					body: JSON.stringify({ protocol: 1, enrollmentId: enrollment.id, snapshot, receipts: [] }),
				}),
				{},
			)
			assert.equal(response.status, 200)
			const observedAt = now
			for (const path of ['/v1/sessions', `/v1/sessions/${command.target.sessionId}`]) {
				const legacy = await host.browser.fetch(new Request(origin + path, { headers }), {})
				const old = await legacy.json()
				const row = old.snapshot ?? old.sessions[0]
				assert.equal('subagents' in row, false)
				assert.equal('subagentsFreshForMs' in row, false)
				const response = await host.browser.fetch(
					new Request(origin + path, { headers: { ...headers, 'X-Helm-Subagent-Activity': '1' } }),
					{},
				)
				const body = await response.json()
				const next = body.snapshot ?? body.sessions[0]
				assert.equal(next.subagentsFreshForMs !== undefined, activity?.availability === 'available')
			}

			for (const elapsed of [4999, 4999, 5000]) {
				now = observedAt + elapsed
				for (const path of ['/v1/sessions', `/v1/sessions/${command.target.sessionId}`]) {
					const timed = await host.browser.fetch(
						new Request(origin + path, {
							headers: { ...headers, 'X-Helm-Subagent-Activity': '1' },
						}),
						{},
					)
					const timedBody = await timed.json()
					const projected = timedBody.snapshot ?? timedBody.sessions[0]
					assert.equal(
						projected.subagentsFreshForMs,
						activity?.availability === 'available' && elapsed < 5000 ? 1 : undefined,
					)
					if (elapsed === 5000) {
						assert.equal(projected.connected, false)
						if (activity) assert.equal(projected.subagents.availability, 'unavailable')
					} else if (activity?.availability === 'available') {
						assert.equal(projected.subagents.active, activity.active)
					}
				}
			}
		}
		now += 6000
		const stale = await host.browser.fetch(
			new Request(`${origin}/v1/sessions`, { headers: { ...headers, 'X-Helm-Subagent-Activity': '1' } }),
			{},
		)
		const body = await stale.json()
		assert.equal(body.sessions[0].connected, false)
		assert.equal(body.sessions[0].subagentsFreshForMs, undefined)
	} finally {
		host.revoke()
	}
})
