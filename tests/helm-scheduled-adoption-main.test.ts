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
	const retained: Array<{ sessionId: string; ownership: typeof ownership; closePending?: boolean }> = []
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
			recoverCompletion: async () => {
				calls.push('recover-completion')
				if (options.fail === 'recover') throw new Error('ambiguous')
			},
			rollback: async input => {
				calls.push(`rollback:${input.revision}`)
			},
			finalize: async () => {
				calls.push('finalize')
				if (options.fail === 'finalize') throw new Error('ambiguous')
			},
			restoreDescriptor: async () => {
				calls.push('restore-descriptor')
				return options.fail === 'dead'
					? ({ state: 'dead' } as const)
					: {
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
			markRunOwnedClosePending: (sessionId, value) => {
				calls.push('close-pending')
				if (options.fail === 'close-pending') return false
				const entry = retained.find(candidate => candidate.sessionId === sessionId && candidate.ownership === value)
				if (!entry) return false
				entry.closePending = true
				return true
			},
			removeRunOwned: sessionId => {
				calls.push('remove')
				if (options.fail === 'remove') return false
				const index = retained.findIndex(entry => entry.sessionId === sessionId)
				if (index >= 0) retained.splice(index, 1)
				return true
			},
			listRunOwned: () =>
				retained.map(entry => ({
					...entry,
					closePending: entry.closePending === true,
					restored: {
						sessionId: entry.sessionId,
						title: null,
						customName: null,
						parked: false,
						groupId: null,
						agentRunning: false,
						agentAttention: false,
						placementEligible: true,
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
		assert.ok(f.calls.includes('rollback:8'), fail)
		if (fail !== 'attach') assert.ok(f.calls.includes('detach:42'), fail)
		assert.ok(!f.calls.includes('complete'), fail)
	}
})

test('failed ownership-evidence removal keeps daemon reservation ambiguous', async () => {
	const f = fixture({ fail: 'remove' })
	const result = await f.coordinator.adopt({ ...ownership, profileToken: 'work:0' })
	assert.deepEqual(result, { status: 'ambiguous', sessionId: 'safe-session', ptyId: 42 })
	assert.equal(
		f.calls.some(call => call.startsWith('rollback:')),
		false,
	)
	assert.equal(f.calls.includes('detach:42'), true)
})

test('completion ambiguity retains attached client and durable registry then retries idempotently', async () => {
	const f = fixture({ fail: 'complete' })
	const result = await f.coordinator.adopt({ ...ownership, profileToken: 'work:0' })
	assert.deepEqual(result, { status: 'ambiguous', sessionId: 'safe-session', ptyId: 42 })
	assert.equal(f.calls.includes('detach:42'), false)
	assert.equal(f.retained.length, 1)
	await f.coordinator.recoverAmbiguous()
	assert.equal(f.calls.filter(call => call === 'complete').length, 1)
	assert.equal(f.calls.filter(call => call === 'recover-completion').length, 1)
})

test('explicit close checkpoints ownership before detach and removes evidence only after daemon finalization', async () => {
	const f = fixture()
	await f.coordinator.adopt({ ...ownership, profileToken: 'work:0' })
	f.calls.length = 0
	const retained = f.retained[0]
	assert.ok(retained)
	assert.equal(await f.coordinator.close(retained.sessionId, 42, retained.ownership), 'closed')
	assert.deepEqual(f.calls, ['close-pending', 'detach:42', 'recover-completion', 'finalize', 'remove'])
	assert.equal(f.retained.length, 0)
})

test('failed close checkpoint keeps the client attached and ownership visible', async () => {
	const f = fixture({ fail: 'close-pending' })
	await f.coordinator.adopt({ ...ownership, profileToken: 'work:0' })
	f.calls.length = 0
	const retained = f.retained[0]
	assert.ok(retained)
	assert.equal(await f.coordinator.close(retained.sessionId, 42, retained.ownership), 'rejected')
	assert.deepEqual(f.calls, ['close-pending'])
	assert.equal(f.retained.length, 1)
})

test('close retains its durable checkpoint when completion recovery is still unavailable', async () => {
	const f = fixture({ fail: 'recover' })
	await f.coordinator.adopt({ ...ownership, profileToken: 'work:0' })
	f.calls.length = 0
	const retained = f.retained[0]
	assert.ok(retained)
	assert.equal(await f.coordinator.close(retained.sessionId, 42, retained.ownership), 'pending')
	assert.deepEqual(f.calls, ['close-pending', 'detach:42', 'recover-completion'])
	assert.equal(f.retained[0]?.closePending, true)
})

test('self-exit checkpoints and finalizes ownership without detaching a second time', async () => {
	const f = fixture()
	f.retained.push({ sessionId: 'scheduled-session', ownership })
	assert.equal(await f.coordinator.terminalExited('scheduled-session', ownership), 'closed')
	assert.deepEqual(f.calls, ['close-pending', 'recover-completion', 'finalize', 'remove'])
})

test('startup retries a durable close checkpoint instead of reattaching it', async () => {
	const f = fixture()
	f.retained.push({ sessionId: 'scheduled-session', ownership, closePending: true })
	await f.coordinator.restore('work:0')
	assert.deepEqual(f.calls, ['recover-completion', 'finalize', 'remove'])
	assert.equal(f.retained.length, 0)
})

test('restore finalizes a completed owner whose attested master is already dead', async () => {
	const f = fixture({ fail: 'dead' })
	f.retained.push({ sessionId: 'scheduled-session', ownership })
	await f.coordinator.restore('work:0')
	assert.deepEqual(f.calls, ['restore-descriptor', 'close-pending', 'recover-completion', 'finalize', 'remove'])
	assert.equal(f.retained.length, 0)
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
