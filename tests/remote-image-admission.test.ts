import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { RemoteAdmission, type RemoteAdmissionTicket } from '../src/remote/admission.js'
import type { RemoteCommand, RemoteTarget } from '../src/remote/protocol.js'
function harness(limit = 4096) {
	let now = 1000
	const target: RemoteTarget = { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 }
	const ledger = new RemoteAdmission(target, limit, () => now)
	const command = (text = 'photo'): RemoteCommand => ({
		protocol: 1,
		hostEpoch: randomUUID(),
		commandId: randomUUID(),
		target: { ...target },
		operation: {
			kind: 'prompt',
			text,
			delivery: 'followUp',
			images: [
				{ handle: randomUUID(), sha256: 'a'.repeat(64), mimeType: 'image/jpeg', bytes: 100, width: 1, height: 1 },
			],
		},
	})
	return {
		ledger,
		target,
		command,
		setNow: (value: number) => {
			now = value
		},
	}
}
test('prepare reserves pending once and shares deduplication with synchronous dispatch', () => {
	const { ledger, command } = harness()
	const value = command()
	let effects = 0
	const prepared = ledger.prepare(value, 11000)
	assert.ok(prepared.ticket)
	assert.equal(prepared.receipt.status, 'pending')
	prepared.receipt.status = 'dispatched' // Published receipts cannot mutate the ledger.
	const duplicate = ledger.prepare(value, 11000)
	assert.equal(duplicate.ticket, undefined)
	assert.equal(duplicate.receipt.status, 'pending')
	assert.equal(
		ledger.dispatch(value, () => {
			effects++
			return 'dispatched'
		}).status,
		'pending',
	)
	assert.equal(effects, 0)
	assert.equal(
		ledger.commit(
			prepared.ticket,
			() => true,
			() => {
				effects++
				return 'dispatched'
			},
		)?.status,
		'dispatched',
	)
	assert.equal(
		ledger.commit(
			prepared.ticket,
			() => true,
			() => {
				effects++
				return 'dispatched'
			},
		)?.status,
		'dispatched',
	)
	assert.equal(ledger.prepare(value, 11000).receipt.status, 'dispatched')
	assert.equal(effects, 1)
})
test('prepared effects receive an immutable captured command, not later caller mutations', () => {
	const { ledger, command } = harness()
	const value = command()
	const original = structuredClone(value)
	const prepared = ledger.prepare(value, 11000)
	assert.ok(prepared.ticket)
	if (value.operation.kind !== 'prompt') throw new Error('Fixture must be prompt')
	value.operation.text = 'replacement'
	const image = value.operation.images?.[0]
	assert.ok(image)
	image.sha256 = 'b'.repeat(64)
	value.target.generation++
	let effects = 0
	const receipt = ledger.commit(
		prepared.ticket,
		captured => {
			assert.deepEqual(captured, original)
			assert.ok(Object.isFrozen(captured))
			assert.ok(Object.isFrozen(captured.target))
			assert.ok(Object.isFrozen(captured.operation))
			if (captured.operation.kind !== 'prompt') return false
			assert.ok(Object.isFrozen(captured.operation.images))
			const capturedImage = captured.operation.images?.[0]
			assert.ok(capturedImage)
			assert.ok(Object.isFrozen(capturedImage))
			return true
		},
		captured => {
			assert.deepEqual(captured, original)
			effects++
			return 'dispatched'
		},
	)
	assert.equal(receipt?.status, 'dispatched')
	assert.equal(effects, 1)
	assert.equal(ledger.prepare(original, 11000).receipt.status, 'dispatched')
})
test('constructor target is captured and changed-ID fingerprints cannot replace preparation', () => {
	const { ledger, target, command } = harness()
	const value = command()
	target.generation = 2
	const prepared = ledger.prepare(value, 11000)
	assert.ok(prepared.ticket)
	const changed = structuredClone(value)
	if (changed.operation.kind !== 'prompt') throw new Error('Fixture must be prompt')
	changed.operation.text = 'different'
	assert.equal(ledger.prepare(changed, 11000).receipt.status, 'rejected')
	assert.equal(ledger.prepare(command(), 11000).receipt.status, 'rejected')
	assert.equal(
		ledger.commit(
			prepared.ticket,
			() => true,
			() => 'dispatched',
		)?.status,
		'dispatched',
	)
})
for (const kind of ['false', 'throw', 'expire', 'dispose'] as const)
	test(`known pre-effect ${kind} refuses invocation`, () => {
		const { ledger, command, setNow } = harness()
		const value = command()
		const prepared = ledger.prepare(value, 11000)
		assert.ok(prepared.ticket)
		if (kind === 'expire') setNow(11000)
		if (kind === 'dispose') ledger.dispose()
		let effects = 0
		const receipt = ledger.commit(
			prepared.ticket,
			() => {
				if (kind === 'throw') throw new Error('guard failed')
				return kind !== 'false'
			},
			() => {
				effects++
				return 'dispatched'
			},
		)
		assert.equal(receipt?.status, 'rejected')
		assert.equal(effects, 0)
		assert.equal(ledger.reject(prepared.ticket)?.status, 'rejected')
	})
test('an invocation exception is unknown forever and is never relabelled rejected', () => {
	const { ledger, command } = harness()
	const value = command()
	const prepared = ledger.prepare(value, 11000)
	assert.ok(prepared.ticket)
	let effects = 0
	const receipt = ledger.commit(
		prepared.ticket,
		() => true,
		() => {
			assert.equal(ledger.prepare(value, 11000).receipt.status, 'unknown')
			effects++
			throw new Error('effect may have occurred')
		},
	)
	assert.equal(receipt?.status, 'unknown')
	assert.equal(ledger.reject(prepared.ticket)?.status, 'unknown')
	assert.equal(
		ledger.dispatch(value, () => {
			effects++
			return 'dispatched'
		}).status,
		'unknown',
	)
	ledger.dispose()
	assert.equal(ledger.reject(prepared.ticket)?.status, 'unknown')
	assert.equal(effects, 1)
})
for (const kind of ['dispose', 'reject', 'commit'] as const)
	test(`reentrant ${kind} during guard cannot duplicate an effect`, () => {
		const { ledger, command } = harness()
		const prepared = ledger.prepare(command(), 11000)
		assert.ok(prepared.ticket)
		const ticket = prepared.ticket
		let effects = 0
		const receipt = ledger.commit(
			ticket,
			() => {
				if (kind === 'dispose') ledger.dispose()
				if (kind === 'reject') ledger.reject(ticket)
				if (kind === 'commit')
					assert.equal(
						ledger.commit(
							ticket,
							() => true,
							() => {
								effects += 100
								return 'dispatched'
							},
						)?.status,
						'pending',
					)
				return true
			},
			() => {
				effects++
				return 'dispatched'
			},
		)
		assert.equal(effects, kind === 'commit' ? 1 : 0)
		assert.equal(receipt?.status, kind === 'commit' ? 'dispatched' : 'rejected')
	})
test('forged and foreign tickets are unavailable even with the same visible shape', () => {
	const a = harness()
	const b = harness()
	const p = a.ledger.prepare(a.command(), 11000)
	assert.ok(p.ticket)
	const forged = { ...p.ticket } as RemoteAdmissionTicket
	assert.equal(
		a.ledger.commit(
			forged,
			() => true,
			() => 'dispatched',
		),
		null,
	)
	assert.equal(a.ledger.reject(forged), null)
	assert.equal(
		b.ledger.commit(
			p.ticket,
			() => true,
			() => 'dispatched',
		),
		null,
	)
	assert.equal(
		a.ledger.commit(
			p.ticket,
			() => true,
			() => 'dispatched',
		)?.status,
		'dispatched',
	)
})
test('nine preparation slots do not block legitimate synchronous Interrupt', () => {
	const { ledger, command } = harness()
	const pending = Array.from({ length: 9 }, () => {
		const value = command()
		const prepared = ledger.prepare(value, 11000)
		assert.ok(prepared.ticket)
		return { value, ticket: prepared.ticket }
	})
	const refused = command()
	assert.equal(ledger.prepare(refused, 11000).receipt.status, 'rejected')
	assert.equal(ledger.prepare(pending[0].value, 11000).receipt.status, 'pending')
	let effects = 0
	const interrupt = { ...command(), operation: { kind: 'interrupt' as const } }
	assert.equal(
		ledger.dispatch(interrupt, () => {
			effects++
			return 'dispatched'
		}).status,
		'dispatched',
	)
	assert.equal(effects, 1)
	assert.equal(ledger.reject(pending[0].ticket)?.status, 'rejected')
	assert.ok(ledger.prepare(refused, 11000).ticket)
	assert.equal(ledger.prepare(pending[0].value, 11000).ticket, undefined)
})
test('expired preparation slots are reclaimed, but their command IDs cannot execute again', () => {
	const { ledger, command, setNow } = harness()
	const pending = Array.from({ length: 9 }, () => {
		const value = command()
		const prepared = ledger.prepare(value, 11000)
		assert.ok(prepared.ticket)
		return { value, ticket: prepared.ticket }
	})
	setNow(11000)
	assert.ok(ledger.prepare(command(), 21000).ticket)
	assert.equal(ledger.prepare(pending[0].value, 11000).receipt.status, 'rejected')
	assert.equal(
		ledger.commit(
			pending[0].ticket,
			() => true,
			() => 'dispatched',
		)?.status,
		'rejected',
	)
})
test('total ledger exhaustion never evicts settled commands into re-executability', () => {
	const { ledger, command } = harness(1)
	const value = command()
	const p = ledger.prepare(value, 11000)
	assert.ok(p.ticket)
	assert.equal(ledger.reject(p.ticket)?.status, 'rejected')
	assert.equal(ledger.prepare(command(), 11000).ticket, undefined)
	assert.equal(ledger.dispatch(value, () => 'dispatched').status, 'rejected')
})
test('invalid deadlines refuse before reservation and disposal remains permanent', () => {
	const { ledger, command } = harness()
	const value = command()
	for (const deadline of [1000, 11001, Number.NaN, Number.POSITIVE_INFINITY])
		assert.equal(ledger.prepare(value, deadline).ticket, undefined)
	const p = ledger.prepare(value, 11000)
	assert.ok(p.ticket)
	ledger.dispose()
	assert.equal(
		ledger.commit(
			p.ticket,
			() => true,
			() => 'dispatched',
		)?.status,
		'rejected',
	)
	assert.equal(ledger.prepare(command(), 11000).ticket, undefined)
	assert.equal(ledger.dispatch(command(), () => 'dispatched').status, 'rejected')
})
test('synchronous dispatch still publishes unknown before a reentrant effect callback', () => {
	const { ledger, command } = harness()
	const value = command()
	let effects = 0
	assert.equal(
		ledger.dispatch(value, () => {
			effects++
			assert.equal(
				ledger.dispatch(value, () => {
					effects += 100
					return 'dispatched'
				}).status,
				'unknown',
			)
			return 'dispatched'
		}).status,
		'dispatched',
	)
	assert.equal(effects, 1)
})

for (const throws of [false, true])
	test(`correction R1 invocation boundary fences ${throws ? 'throw' : 'success'}`, () => {
		const { ledger, command } = harness()
		const value = command()
		const prepared = ledger.prepare(value, 11000)
		assert.ok(prepared.ticket)
		const ticket = prepared.ticket
		const observed: Array<string | undefined> = []
		let effects = 0
		const result = ledger.commit(
			prepared.ticket,
			() => true,
			() => {
				effects++
				observed.push(ledger.reject(ticket)?.status)
				observed.push(ledger.prepare(value, 11000).receipt.status)
				observed.push(
					ledger.commit(
						ticket,
						() => true,
						() => 'dispatched',
					)?.status,
				)
				if (throws) throw new Error('uncertain')
				return 'dispatched'
			},
		)
		assert.equal(effects, 1)
		assert.deepEqual(observed, ['unknown', 'unknown', 'unknown'])
		assert.equal(result?.status, throws ? 'unknown' : 'dispatched')
	})

test('correction R2 closed admission rejects duplicate evidence without rewriting outcome', () => {
	const { ledger, command } = harness()
	const value = command()
	const prepared = ledger.prepare(value, 11000)
	assert.ok(prepared.ticket)
	assert.equal(
		ledger.commit(
			prepared.ticket,
			() => true,
			() => 'dispatched',
		)?.status,
		'dispatched',
	)
	ledger.dispose()
	assert.equal(ledger.prepare(value, 11000).receipt.status, 'rejected')
	assert.equal(ledger.reject(prepared.ticket)?.status, 'dispatched')
})

test('correction R2 preserves unknown after disposal', () => {
	const { ledger, command } = harness()
	const value = command()
	const prepared = ledger.prepare(value, 11000)
	assert.ok(prepared.ticket)
	assert.equal(
		ledger.commit(
			prepared.ticket,
			() => true,
			() => {
				throw new Error('uncertain')
			},
		)?.status,
		'unknown',
	)
	ledger.dispose()
	assert.equal(ledger.prepare(value, 11000).receipt.status, 'rejected')
	assert.equal(ledger.reject(prepared.ticket)?.status, 'unknown')
})

test('correction R3 duplicate prepare reaps expired pending state', () => {
	const { ledger, command, setNow } = harness()
	const value = command()
	const prepared = ledger.prepare(value, 11000)
	assert.ok(prepared.ticket)
	setNow(11000)
	assert.equal(ledger.prepare(value, 11000).receipt.status, 'rejected')
	assert.equal(ledger.prepare(value, 21000).ticket, undefined)
})

test('correction R3 synchronous dispatch reaps expired preparation', () => {
	const { ledger, command, setNow } = harness()
	const value = command()
	const prepared = ledger.prepare(value, 11000)
	assert.ok(prepared.ticket)
	setNow(11000)
	let effects = 0
	assert.equal(
		ledger.dispatch(value, () => {
			effects++
			return 'dispatched'
		}).status,
		'rejected',
	)
	assert.equal(effects, 0)
})

test('correction R3 control dispatch reaps checking ticket before invoke', () => {
	const { ledger, command, setNow } = harness()
	const prepared = ledger.prepare(command(), 11000)
	assert.ok(prepared.ticket)
	const ticket = prepared.ticket
	let observed: string | undefined
	let controls = 0
	let prompts = 0
	const result = ledger.commit(
		prepared.ticket,
		() => {
			setNow(11000)
			const interrupt = { ...command(), commandId: randomUUID(), operation: { kind: 'interrupt' as const } }
			assert.equal(
				ledger.dispatch(interrupt, () => {
					controls++
					observed = ledger.commit(
						ticket,
						() => true,
						() => {
							prompts++
							return 'dispatched'
						},
					)?.status
					return 'dispatched'
				}).status,
				'dispatched',
			)
			return true
		},
		() => {
			prompts++
			return 'dispatched'
		},
	)
	assert.equal(controls, 1)
	assert.equal(prompts, 0)
	assert.equal(result?.status, 'rejected')
	assert.equal(observed, 'rejected')
})
