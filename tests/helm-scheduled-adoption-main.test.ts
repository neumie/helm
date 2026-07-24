import assert from 'node:assert/strict'
import test from 'node:test'
// tsx loads app modules through the project CJS bridge in Node tests.
// @ts-expect-error default-import convention for that bridge
import adoptionModule from '../app/src/scheduled-adoption-main.ts'
type AdoptionModule = typeof import('../app/src/scheduled-adoption-main.ts')
const { ScheduledAttentionAdoptionCoordinator, scheduledDtachAttachArgs } = adoptionModule as AdoptionModule

test('scheduled dtach adoption uses exact lowercase attach-only argv', () => {
	assert.deepEqual(scheduledDtachAttachArgs('/tmp/existing.sock'), ['-a', '/tmp/existing.sock', '-E', '-r', 'winch'])
})

const ownership = {
	profileId: 'work',
	runId: 'sr-run-1',
	revision: 7,
	adoptionId: '11111111-1111-4111-8111-111111111111',
	adopter: '22222222-2222-4222-8222-222222222222',
}

function fixture(options: { fail?: string; current?: boolean; currentSequence?: boolean[] } = {}) {
	const calls: string[] = []
	const retained: Array<{ sessionId: string; ownership: typeof ownership }> = []
	const coordinator = new ScheduledAttentionAdoptionCoordinator({
		daemon: {
			reserve: async input => {
				calls.push('reserve')
				assert.equal(input.revision, 7)
				if (options.fail === 'reserve') throw new Error('no')
				return { revision: 8, capability: 'secret' }
			},
			descriptor: async input => {
				calls.push('descriptor')
				assert.equal(input.capability, 'secret')
				if (options.fail === 'descriptor') throw new Error('no')
				return { socketPath: '/private/socket', mode: 'attach-existing' as const, redraw: 'winch' as const }
			},
			complete: async () => {
				calls.push('complete')
				if (options.fail === 'complete') throw new Error('ambiguous')
			},
			rollback: async () => {
				calls.push('rollback')
			},
			restoreDescriptor: async () => {
				calls.push('restore-descriptor')
				return {
					socketPath: '/private/socket',
					mode: 'attach-existing' as const,
					redraw: 'winch' as const,
				}
			},
		},
		attach: {
			attach: async input => {
				calls.push(`attach:${input.descriptor.mode}:${input.descriptor.redraw}`)
				if (options.fail === 'attach') throw new Error('no')
				return { ptyId: 42 }
			},
			detach: id => calls.push(`detach:${id}`),
		},
		registry: {
			registerRunOwned: (sessionId, value) => {
				calls.push('flush')
				if (options.fail === 'registry') return false
				retained.push({ sessionId, ownership: value })
				return true
			},
			removeRunOwned: () => {
				calls.push('remove')
				return options.fail !== 'remove'
			},
			listRunOwned: () =>
				retained.map(entry => ({
					...entry,
					restored: {
						sessionId: entry.sessionId,
						title: null,
						customName: null,
						parked: false,
						groupId: null,
						agentRunning: false,
						agentAttention: false,
					},
				})),
		},
		renderer: {
			open: async () => {
				calls.push('open')
				return options.fail !== 'renderer' && options.fail !== 'remove'
			},
		},
		newSessionId: () => 'safe-session',
		isCurrent: () => options.currentSequence?.shift() ?? options.current !== false,
	})
	return { coordinator, calls, retained }
}

test('scheduled adoption orders reserve, descriptor, lowercase-compatible attach, flush, open, complete', async () => {
	const f = fixture()
	const result = await f.coordinator.adopt({ ...ownership, profileToken: 'work:0' })
	assert.deepEqual(result, { status: 'completed', sessionId: 'safe-session', ptyId: 42 })
	assert.deepEqual(f.calls, ['reserve', 'descriptor', 'attach:attach-existing:winch', 'flush', 'open', 'complete'])
})

test('attach or registry failure detaches only the newly attached client and rolls back', async () => {
	for (const fail of ['attach', 'registry', 'renderer']) {
		const f = fixture({ fail })
		const result = await f.coordinator.adopt({ ...ownership, profileToken: 'work:0' })
		assert.equal(result.status, 'rolled-back', fail)
		assert.ok(f.calls.includes('rollback'), fail)
		if (fail !== 'attach') assert.ok(f.calls.includes('detach:42'), fail)
		assert.ok(!f.calls.includes('complete'), fail)
	}
})

test('failed ownership-evidence removal keeps daemon reservation ambiguous', async () => {
	const f = fixture({ fail: 'remove' })
	const result = await f.coordinator.adopt({ ...ownership, profileToken: 'work:0' })
	assert.deepEqual(result, { status: 'ambiguous', sessionId: 'safe-session', ptyId: 42 })
	assert.equal(f.calls.includes('rollback'), false)
	assert.equal(f.calls.includes('detach:42'), true)
})

test('completion ambiguity retains attached client and durable registry then retries idempotently', async () => {
	const f = fixture({ fail: 'complete' })
	const result = await f.coordinator.adopt({ ...ownership, profileToken: 'work:0' })
	assert.deepEqual(result, { status: 'ambiguous', sessionId: 'safe-session', ptyId: 42 })
	assert.equal(f.calls.includes('detach:42'), false)
	assert.equal(f.retained.length, 1)
	await f.coordinator.recoverAmbiguous()
	assert.equal(f.calls.filter(call => call === 'complete').length, 2)
})

test('restore detaches when the profile changes during attach', async () => {
	const f = fixture({ currentSequence: [true, true, false] })
	f.retained.push({ sessionId: 'scheduled-session', ownership })
	await f.coordinator.restore('work:0')
	assert.equal(f.calls.includes('detach:42'), true)
	assert.equal(f.calls.includes('open'), false)
})

test('stale profile admission does not reserve or leak descriptors', async () => {
	const f = fixture({ current: false })
	assert.deepEqual(await f.coordinator.adopt({ ...ownership, profileToken: 'old:0' }), { status: 'rejected' })
	assert.deepEqual(f.calls, [])
})
