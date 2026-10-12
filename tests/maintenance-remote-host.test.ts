import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { RemoteAdmission } from '../src/remote/admission.js'
import type { RemoteCommand } from '../src/remote/protocol.js'

function fixture() {
	let now = 1000
	const command: RemoteCommand = {
		protocol: 1,
		hostEpoch: randomUUID(),
		commandId: randomUUID(),
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
		operation: { kind: 'model', provider: 'fixture', id: 'model' },
	}
	const ledger = new RemoteAdmission(command.target, 4096, () => now)
	let effects = 0
	const dispatch = () =>
		ledger.dispatch(
			command,
			() => {
				effects++
				return 'dispatched'
			},
			11000,
		)
	return {
		command,
		ledger,
		dispatch,
		advance: () => {
			now = 11000
		},
		effects: () => effects,
	}
}

test('model refusal corrects canonical dedup once without replay', () => {
	const f = fixture()
	assert.equal(f.dispatch().status, 'dispatched')
	assert.equal(f.ledger.correctModelRefusal({ ...f.command, hostEpoch: randomUUID() }), null)
	assert.equal(f.ledger.correctModelRefusal(f.command)?.status, 'rejected')
	assert.equal(f.ledger.correctModelRefusal(f.command), null)
	assert.equal(f.dispatch().status, 'rejected')
	assert.equal(f.effects(), 1)
})

for (const boundary of ['expiry', 'dispose', 'success', 'interrupt'] as const) {
	test(`model correction remains fenced at ${boundary}`, () => {
		const f = fixture()
		if (boundary === 'interrupt') f.command.operation = { kind: 'interrupt' }
		assert.equal(f.dispatch().status, 'dispatched')
		if (boundary === 'expiry') f.advance()
		if (boundary === 'dispose') f.ledger.dispose()
		if (boundary !== 'success') assert.equal(f.ledger.correctModelRefusal(f.command), null)
		if (boundary !== 'dispose') assert.equal(f.dispatch().status, 'dispatched')
		assert.equal(f.effects(), 1)
	})
}
