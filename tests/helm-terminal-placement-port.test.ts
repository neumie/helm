import assert from 'node:assert/strict'
import test from 'node:test'
import type { TerminalPlacementCommitCommand } from '../app/src/shared.ts'
import productionPortModule from '../app/src/terminal-placement-production-port.ts'
import placementModule from '../app/src/terminal-placement.ts'
const { terminalId } = placementModule
const { ProductionSessionPlacementPort } = productionPortModule

test('production placement port strips local profile identity and returns only authoritative placement facts', async () => {
	let received: unknown = null
	const bindings = {
		sessionIdFor: (id: string) => ({ a: 'aaaa1111', b: 'bbbb2222' })[id] ?? null,
		terminalIdFor: (id: string) => ({ aaaa1111: 'a', bbbb2222: 'b' })[id] ?? null,
	}
	const port = new ProductionSessionPlacementPort(
		{
			placementCommit: async command => {
				received = command
				return {
					registryEpoch: 4,
					affectedIds: ['aaaa1111'],
					authoritativeOrder: ['bbbb2222', 'aaaa1111'],
					authoritativeGroups: [
						{
							id: 'group-deadbeef',
							name: 'Deploy',
							color: 'blue',
							collapsedStrip: false,
							collapsedBackground: true,
							memberIds: ['bbbb2222', 'aaaa1111'],
						},
					],
				}
			},
		},
		bindings,
	)
	const result = await port.authorizeAndCommit({
		type: 'move',
		profileId: 'work',
		generation: 3,
		affectedIds: [terminalId('a')],
		groupId: 'group-deadbeef',
		strip: [terminalId('b')],
		background: [terminalId('a')],
	})
	assert.deepEqual(received, {
		type: 'move',
		affectedIds: ['aaaa1111'],
		groupId: 'group-deadbeef',
		strip: ['bbbb2222'],
		background: ['aaaa1111'],
	})
	assert.deepEqual(result, {
		profileId: 'work',
		generation: 3,
		persisted: true,
		durabilityDirty: false,
		registryEpoch: 4,
		affectedIds: [terminalId('a')],
		authoritativeOrder: [terminalId('b'), terminalId('a')],
		authoritativeGroups: [
			{
				id: 'group-deadbeef',
				name: 'Deploy',
				color: 'blue',
				collapsedStrip: false,
				collapsedBackground: true,
				memberIds: [terminalId('b'), terminalId('a')],
			},
		],
	})
})

test('production port accepts unbound local placement and flushes the complete bound subset after a binding arrives', async () => {
	const bindings = new Map<string, string | null>([
		['bound', 'aaaa1111'],
		['fresh', null],
	])
	const received: unknown[] = []
	const port = new ProductionSessionPlacementPort(
		{
			placementCommit: async command => {
				received.push(command)
				return {
					registryEpoch: received.length,
					affectedIds: ['aaaa1111'],
					authoritativeOrder: ['aaaa1111'],
					authoritativeGroups: [],
				}
			},
		},
		{
			sessionIdFor: id => bindings.get(id) ?? null,
			terminalIdFor: id => ({ aaaa1111: 'bound', bbbb2222: 'fresh' })[id] ?? null,
		},
	)
	const local = await port.authorizeAndCommit({
		type: 'move',
		profileId: 'work',
		generation: 1,
		affectedIds: [terminalId('fresh')],
		strip: [terminalId('fresh')],
		background: [],
	})
	assert.equal(local.persisted, false)
	assert.equal(local.durabilityDirty, true)
	assert.deepEqual(received, [])
	const mixed = await port.authorizeAndCommit({
		type: 'move',
		profileId: 'work',
		generation: 1,
		affectedIds: [terminalId('bound'), terminalId('fresh')],
		strip: [terminalId('fresh')],
		background: [terminalId('bound')],
	})
	assert.equal(mixed.persisted, true)
	assert.equal(mixed.durabilityDirty, true)
	assert.deepEqual(received, [{ type: 'move', affectedIds: ['aaaa1111'], strip: [], background: ['aaaa1111'] }])
	bindings.set('fresh', 'bbbb2222')
	const flushed = await port.authorizeAndCommit({
		type: 'move',
		profileId: 'work',
		generation: 1,
		affectedIds: [terminalId('bound'), terminalId('fresh')],
		strip: [terminalId('fresh')],
		background: [terminalId('bound')],
	})
	assert.equal(flushed.durabilityDirty, false)
	assert.deepEqual(received.at(-1), {
		type: 'move',
		affectedIds: ['aaaa1111', 'bbbb2222'],
		strip: ['bbbb2222'],
		background: ['aaaa1111'],
	})
})

test('production port includes run-owned sessions, excludes exited rows, and accepts unbound-only local placement', async () => {
	const received: unknown[] = []
	const bindings = new Map<string, string | null>([
		['ordinary', 'ordinary11'],
		['run-owned', 'runowned11'],
		['exited', 'exited111'],
		['fresh', null],
	])
	const port = new ProductionSessionPlacementPort(
		{
			placementCommit: async command => {
				received.push(command)
				return {
					registryEpoch: 1,
					affectedIds: ['ordinary11'],
					authoritativeOrder: ['ordinary11'],
					authoritativeGroups: [],
				}
			},
		},
		{
			sessionIdFor: id => bindings.get(id) ?? null,
			terminalIdFor: id => ({ ordinary11: 'ordinary', runowned11: 'run-owned' })[id] ?? null,
			placementEligibleFor: id => id !== 'exited',
		},
	)
	const ordinary = await port.authorizeAndCommit({
		type: 'move',
		profileId: 'work',
		generation: 1,
		affectedIds: [terminalId('ordinary')],
		strip: [terminalId('ordinary'), terminalId('run-owned')],
		background: [terminalId('exited'), terminalId('fresh')],
	})
	assert.equal(ordinary.persisted, true)
	assert.equal(ordinary.durabilityDirty, true)
	assert.deepEqual(received, [
		{ type: 'move', affectedIds: ['ordinary11'], strip: ['ordinary11', 'runowned11'], background: [] },
	])
	const local = await port.authorizeAndCommit({
		type: 'move',
		profileId: 'work',
		generation: 1,
		affectedIds: [terminalId('fresh')],
		strip: [terminalId('ordinary')],
		background: [terminalId('fresh')],
	})
	assert.equal(local.persisted, false)
	assert.equal(received.length, 1)
	const runOwned = await port.authorizeAndCommit({
		type: 'move',
		profileId: 'work',
		generation: 1,
		affectedIds: [terminalId('run-owned')],
		strip: [terminalId('ordinary'), terminalId('run-owned')],
		background: [],
	})
	assert.equal(runOwned.persisted, true)
})

test('mixed live and exited group moves persist the durable subset and keep the full local move', async () => {
	let received: TerminalPlacementCommitCommand | null = null
	const port = new ProductionSessionPlacementPort(
		{
			placementCommit: async command => {
				received = command
				return {
					registryEpoch: 1,
					affectedIds: ['live1111'],
					authoritativeOrder: ['live1111', 'exited11'],
					authoritativeGroups: [
						{
							id: 'group-deadbeef',
							name: 'Group',
							color: 'blue',
							collapsedStrip: false,
							collapsedBackground: false,
							memberIds: ['live1111', 'exited11'],
						},
					],
				}
			},
		},
		{
			sessionIdFor: id => ({ live: 'live1111', exited: 'exited11' })[id] ?? null,
			terminalIdFor: id => ({ live1111: 'live', exited11: 'exited' })[id] ?? null,
			placementEligibleFor: id => id === 'live',
		},
	)
	const result = await port.authorizeAndCommit({
		type: 'move',
		profileId: 'work',
		generation: 1,
		affectedIds: [terminalId('live'), terminalId('exited')],
		groupId: 'group-deadbeef',
		strip: [terminalId('live'), terminalId('exited')],
		background: [],
	})
	assert.deepEqual(received, {
		type: 'move',
		affectedIds: ['live1111'],
		strip: ['live1111'],
		background: [],
	})
	assert.deepEqual(result.affectedIds, [terminalId('live'), terminalId('exited')])
	assert.equal(result.durabilityDirty, false)
})

test('production placement port fails closed on main rejection and abort', async () => {
	const port = new ProductionSessionPlacementPort(
		{ placementCommit: async () => null },
		{ sessionIdFor: () => null, terminalIdFor: () => null },
	)
	const command = {
		type: 'set-collapsed' as const,
		profileId: 'work',
		generation: 1,
		groupId: 'group-deadbeef',
		surface: 'strip' as const,
		collapsed: true,
	}
	await assert.rejects(port.authorizeAndCommit(command), /placement commit rejected/)
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(
		port.authorizeAndCommit(command, controller.signal),
		error => (error as Error).name === 'AbortError',
	)
})

test('production port filters exited authoritative rows without reordering the local ineligible subset', async () => {
	const port = new ProductionSessionPlacementPort(
		{
			placementCommit: async () => ({
				registryEpoch: 1,
				affectedIds: ['live1111'],
				authoritativeOrder: ['live1111', 'exited11'],
				authoritativeGroups: [
					{
						id: 'group-deadbeef',
						name: 'Group',
						color: 'blue',
						collapsedStrip: false,
						collapsedBackground: false,
						memberIds: ['live1111', 'exited11'],
					},
				],
			}),
		},
		{
			sessionIdFor: id => ({ live: 'live1111', exited: 'exited11' })[id] ?? null,
			terminalIdFor: id => ({ live1111: 'live', exited11: 'exited' })[id] ?? null,
			placementEligibleFor: id => id === 'live',
		},
	)
	const result = await port.authorizeAndCommit({
		type: 'move',
		profileId: 'work',
		generation: 1,
		affectedIds: [terminalId('live')],
		strip: [terminalId('live')],
		background: [terminalId('exited')],
	})
	assert.deepEqual(result.authoritativeOrder, [terminalId('live')])
	assert.deepEqual(result.authoritativeGroups[0]?.memberIds, [terminalId('live')])
})

test('production port reconciles a successful main result after post-dispatch abort', async () => {
	const controller = new AbortController()
	const port = new ProductionSessionPlacementPort(
		{
			placementCommit: async () => {
				controller.abort()
				return {
					registryEpoch: 1,
					affectedIds: ['live1111'],
					authoritativeOrder: ['live1111'],
					authoritativeGroups: [],
				}
			},
		},
		{ sessionIdFor: () => 'live1111', terminalIdFor: () => 'live' },
	)
	const result = await port.authorizeAndCommit(
		{
			type: 'move',
			profileId: 'work',
			generation: 1,
			affectedIds: [terminalId('live')],
			strip: [],
			background: [terminalId('live')],
		},
		controller.signal,
	)
	assert.equal(result.persisted, true)
	assert.deepEqual(result.authoritativeOrder, [terminalId('live')])
})
