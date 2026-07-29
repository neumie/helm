import assert from 'node:assert/strict'
import test from 'node:test'
import sessionModule, {
	type DurablePlacementCommand,
	type DurablePlacementResult,
	type SessionPlacementPort,
} from '../app/src/terminal-placement-session.ts'
import placementModule, {
	type PlacementGroup,
	type PlacementHydration,
	type TerminalId,
} from '../app/src/terminal-placement.ts'

const { TerminalPlacement, terminalId } = placementModule as typeof import('../app/src/terminal-placement.ts')
const { InMemorySessionPlacementPort } = sessionModule as typeof import('../app/src/terminal-placement-session.ts')

const profileId = 'work'
const generation = 7
const id = (value: string): TerminalId => terminalId(value)

type Deferred<T> = {
	promise: Promise<T>
	resolve(value: T): void
	reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

class ControlledPort implements SessionPlacementPort {
	readonly commands: DurablePlacementCommand[] = []
	readonly pending: Deferred<DurablePlacementResult>[] = []

	authorizeAndCommit(command: DurablePlacementCommand): Promise<DurablePlacementResult> {
		this.commands.push(command)
		const next = deferred<DurablePlacementResult>()
		this.pending.push(next)
		return next.promise
	}

	resolve(
		command: DurablePlacementCommand,
		groups: readonly PlacementGroup[] = [],
		generationValue = generation,
	): void {
		const pending = this.pending.shift()
		if (!pending) throw new Error('No pending port command')
		const order = command.type === 'set-collapsed' ? [] : [...command.strip, ...command.background]
		pending.resolve({
			profileId,
			generation: generationValue,
			persisted: true,
			durabilityDirty: false,
			registryEpoch: 1,
			affectedIds:
				command.type === 'move' ? command.affectedIds : command.type === 'set-membership' ? [command.terminalId] : [],
			authoritativeOrder: order,
			authoritativeGroups: groups,
		})
	}

	reject(error = new Error('denied')): void {
		const pending = this.pending.shift()
		if (!pending) throw new Error('No pending port command')
		pending.reject(error)
	}
}

function group(
	groupId: string,
	members: readonly string[],
	collapsedStrip = false,
	collapsedBackground = false,
): PlacementGroup {
	return {
		id: groupId,
		name: groupId,
		color: 'blue',
		collapsedStrip,
		collapsedBackground,
		memberIds: members.map(id),
	}
}

function hydration(overrides: Partial<PlacementHydration> = {}): PlacementHydration {
	return {
		profileId,
		generation,
		inventoryVersion: 10,
		terminals: [
			{ id: id('a'), surface: 'strip', groupId: 'g' },
			{ id: id('b'), surface: 'background' },
			{ id: id('c'), surface: 'strip', groupId: 'g' },
			{ id: id('d'), surface: 'strip' },
		],
		groups: [{ id: 'g', name: 'Grouped', color: 'purple', collapsedStrip: false, collapsedBackground: true }],
		...overrides,
	}
}

function placement(port: SessionPlacementPort, input = hydration()): InstanceType<typeof TerminalPlacement> {
	const value = new TerminalPlacement({ profileId, generation, port })
	value.hydrate(input)
	return value
}

test('hydrates immutable profile-generation-bound ID snapshots and canonicalizes group blocks', () => {
	const value = placement(new InMemorySessionPlacementPort({ profileId, generation }))
	const snapshot = value.snapshot()
	assert.deepEqual(snapshot.inventory, [id('a'), id('b'), id('c'), id('d')])
	assert.deepEqual(snapshot.strip, [id('a'), id('c'), id('d')])
	assert.deepEqual(snapshot.background, [id('b')])
	assert.deepEqual(snapshot.groups, [
		{
			id: 'g',
			name: 'Grouped',
			color: 'purple',
			collapsedStrip: false,
			collapsedBackground: true,
			memberIds: [id('a'), id('c')],
		},
	])
	assert.equal(snapshot.selectedId, null)
	assert.equal(Object.isFrozen(snapshot), true)
	assert.equal(Object.isFrozen(snapshot.strip), true)
	assert.equal(Object.isFrozen(snapshot.groups[0]?.memberIds), true)

	const repeated = value.hydrate(hydration({ terminals: [{ id: id('z'), surface: 'strip' }] }))
	assert.equal(repeated, snapshot)
	assert.equal(
		value.inventory({
			type: 'add',
			profileId: 'other',
			generation,
			version: 11,
			terminal: { id: id('z'), surface: 'strip' },
		}),
		snapshot,
	)
})

test('deferred durability accepts unbound local placement and flushes the current canonical snapshot after binding', async () => {
	class DeferredPort implements SessionPlacementPort {
		bound = false
		readonly commands: DurablePlacementCommand[] = []
		async authorizeAndCommit(command: DurablePlacementCommand): Promise<DurablePlacementResult> {
			this.commands.push(command)
			if (!this.bound)
				return {
					profileId,
					generation,
					persisted: false,
					durabilityDirty: true,
					registryEpoch: 0,
					affectedIds: [],
					authoritativeOrder: [],
					authoritativeGroups: [],
				}
			return {
				profileId,
				generation,
				persisted: true,
				durabilityDirty: false,
				registryEpoch: 1,
				affectedIds: command.type === 'move' ? command.affectedIds : [],
				authoritativeOrder: command.type === 'set-collapsed' ? [] : [...command.strip, ...command.background],
				authoritativeGroups: [],
			}
		}
	}
	const port = new DeferredPort()
	const value = placement(port, hydration({ terminals: [{ id: id('fresh'), surface: 'strip' }] }))
	const parked = await value.execute({ type: 'park', id: id('fresh') })
	assert.equal(parked.ok, true)
	assert.deepEqual(value.snapshot().background, [id('fresh')])
	assert.equal(value.snapshot().durabilityDirty, true)
	port.bound = true
	const flushed = await value.flushDurability()
	assert.equal(flushed.ok, true)
	assert.equal(value.snapshot().durabilityDirty, false)
	assert.deepEqual(port.commands.at(-1), {
		type: 'move',
		profileId,
		generation,
		affectedIds: [id('fresh')],
		flush: true,
		strip: [],
		background: [id('fresh')],
	})
})

test('open Background selects without restoring ownership or invoking persistence', async () => {
	const port = new InMemorySessionPlacementPort({ profileId, generation })
	const value = placement(port)
	const result = await value.execute({ type: 'open-background', id: id('b') })
	assert.equal(result.ok, true)
	assert.deepEqual(value.snapshot().strip, [id('a'), id('c'), id('d')])
	assert.deepEqual(value.snapshot().background, [id('b')])
	assert.equal(value.snapshot().selectedId, id('b'))
	assert.equal(port.commands.length, 0)
})

test('park chooses the current next strip neighbor and restore selects the restored terminal', async () => {
	const port = new InMemorySessionPlacementPort({
		profileId,
		generation,
		groups: [group('g', ['a', 'c'], false, true)],
	})
	const value = placement(port)
	await value.execute({ type: 'select', id: id('c') })
	const parked = await value.execute({ type: 'park', id: id('c') })
	assert.equal(parked.ok, true)
	assert.deepEqual(value.snapshot().strip, [id('a'), id('d')])
	assert.deepEqual(value.snapshot().background, [id('b'), id('c')])
	assert.equal(value.snapshot().selectedId, id('d'))
	assert.equal(port.commands[0]?.type, 'move')

	const restored = await value.execute({ type: 'restore', id: id('c') })
	assert.equal(restored.ok, true)
	assert.deepEqual(value.snapshot().strip, [id('a'), id('c'), id('d')])
	assert.equal(value.snapshot().selectedId, id('c'))
})

test('group restore selects its final restored member and collapse remains independent per surface', async () => {
	const groups = [group('g', ['a', 'c'], false, true)]
	const port = new InMemorySessionPlacementPort({ profileId, generation, groups })
	const value = placement(
		port,
		hydration({
			terminals: [
				{ id: id('a'), surface: 'background', groupId: 'g' },
				{ id: id('c'), surface: 'background', groupId: 'g' },
				{ id: id('d'), surface: 'strip' },
			],
		}),
	)
	const restored = await value.execute({ type: 'restore-group', groupId: 'g' })
	assert.equal(restored.ok, true)
	assert.deepEqual(value.snapshot().strip, [id('d'), id('a'), id('c')])
	assert.equal(value.snapshot().selectedId, id('c'))

	const collapsed = await value.execute({ type: 'set-collapsed', groupId: 'g', surface: 'strip', collapsed: true })
	assert.equal(collapsed.ok, true)
	assert.deepEqual(value.snapshot().groups, [group('g', ['a', 'c'], true, true)])
})

test('drag projection is synchronous and visible without changing committed Background ownership; cancel is exact', () => {
	const value = placement(new InMemorySessionPlacementPort({ profileId, generation }))
	const before = value.snapshot()
	const drag = value.beginDrag({ type: 'terminal', id: id('b') })
	const projected = drag.project({ surface: 'strip', index: 1 })
	assert.equal(projected.ok, true)
	assert.deepEqual(value.snapshot().strip, before.strip)
	assert.deepEqual(value.snapshot().background, before.background)
	assert.deepEqual(value.snapshot().drag?.strip, [id('a'), id('b'), id('c'), id('d')])
	assert.deepEqual(value.snapshot().drag?.background, [])
	assert.equal(value.snapshot().busy, true)

	const cancelled = drag.cancel()
	assert.equal(cancelled.ok, true)
	assert.equal(value.snapshot().drag, null)
	assert.deepEqual(value.snapshot().strip, before.strip)
	assert.deepEqual(value.snapshot().background, before.background)
	const stale = drag.cancel()
	assert.deepEqual(stale.ok ? null : stale.reason, 'stale-drag')
})

test('drag admission starts at begin and set-order accepts an exact permutation', async () => {
	const value = placement(
		new InMemorySessionPlacementPort({
			profileId,
			generation,
			groups: [group('g', ['a', 'c'])],
		}),
	)
	const drag = value.beginDrag({ type: 'terminal', id: id('b') })
	assert.equal(value.snapshot().busy, true)
	const second = value.beginDrag({ type: 'terminal', id: id('a') }).project({ surface: 'strip', index: 0 })
	assert.deepEqual(second.ok ? null : second.reason, 'busy')
	const blocked = await value.execute({ type: 'select', id: id('a') })
	assert.deepEqual(blocked.ok ? null : blocked.reason, 'busy')
	assert.equal(drag.cancel().ok, true)
	assert.equal(value.snapshot().busy, false)

	const reordered = await value.execute({ type: 'set-order', surface: 'strip', order: [id('d'), id('a'), id('c')] })
	assert.equal(reordered.ok, true)
	assert.deepEqual(value.snapshot().strip, [id('d'), id('a'), id('c')])
})

test('authoritative group reconciliation preserves membership, admits empty definitions, and cancels a removed group drag', () => {
	const value = placement(new InMemorySessionPlacementPort({ profileId, generation }))
	const drag = value.beginDrag({ type: 'group', groupId: 'g' })
	value.reconcileGroups({
		profileId,
		generation,
		version: 1,
		groups: [
			{ id: 'g', name: 'Renamed', color: 'cyan', collapsedStrip: true, collapsedBackground: false },
			{ id: 'new', name: 'New', color: 'blue', collapsedStrip: false, collapsedBackground: false },
		],
	})
	assert.deepEqual(value.snapshot().groups, [
		{
			id: 'g',
			name: 'Renamed',
			color: 'cyan',
			collapsedStrip: true,
			collapsedBackground: false,
			memberIds: [id('a'), id('c')],
		},
		{
			id: 'new',
			name: 'New',
			color: 'blue',
			collapsedStrip: false,
			collapsedBackground: false,
			memberIds: [],
		},
	])
	assert.equal(value.snapshot().busy, true)
	value.reconcileGroups({ profileId, generation, version: 2, groups: [] })
	assert.deepEqual(value.snapshot().groups, [])
	assert.equal(value.snapshot().busy, false)
	const cancelled = drag.cancel()
	assert.deepEqual(cancelled.ok ? null : cancelled.reason, 'stale-drag')
})

test('terminal cross-group drag persists membership and order as one transaction', async () => {
	const port = new InMemorySessionPlacementPort({ profileId, generation, groups: [group('g', ['a', 'c'])] })
	const value = placement(port)
	const drag = value.beginDrag({ type: 'terminal', id: id('a') })
	assert.equal(drag.project({ surface: 'strip', index: 2, groupId: null }).ok, true)
	const result = await drag.commit()
	assert.equal(result.ok, true)
	assert.equal(port.commands.length, 1)
	assert.deepEqual(port.commands[0], {
		type: 'set-membership',
		profileId,
		generation,
		terminalId: id('a'),
		groupId: null,
		strip: [id('c'), id('d'), id('a')],
		background: [id('b')],
	})
	assert.deepEqual(value.snapshot().strip, [id('c'), id('d'), id('a')])
	assert.deepEqual(value.snapshot().groups[0]?.memberIds, [id('c')])
})

test('queued binding flush runs after a busy drag settles and preserves local debt until then', async () => {
	// Seed a local durability debt through a controlled local-only result.
	const deferredPort = new ControlledPort()
	const deferredValue = placement(deferredPort, hydration({ terminals: [{ id: id('fresh'), surface: 'strip' }] }))
	const park = deferredValue.execute({ type: 'park', id: id('fresh') })
	const parkCommand = deferredPort.commands[0]
	if (!parkCommand) throw new Error('Expected park command')
	deferredPort.pending.shift()?.resolve({
		profileId,
		generation,
		persisted: false,
		durabilityDirty: true,
		registryEpoch: 0,
		affectedIds: [],
		authoritativeOrder: [],
		authoritativeGroups: [],
	})
	await park
	const drag = deferredValue.beginDrag({ type: 'terminal', id: id('fresh') })
	drag.project({ surface: 'strip', index: 0 })
	const busy = await deferredValue.flushDurability()
	assert.deepEqual(busy.ok ? null : busy.reason, 'busy')
	assert.equal(drag.cancel().ok, true)
	await new Promise(resolve => setTimeout(resolve, 0))
	assert.equal(deferredPort.commands.at(-1)?.type, 'move')
})

test('commit merges current authoritative group reconciliation without resurrecting deleted or dropping new groups', async () => {
	const port = new ControlledPort()
	const value = placement(port)
	const drag = value.beginDrag({ type: 'terminal', id: id('b') })
	drag.project({ surface: 'strip', index: 0 })
	const completion = drag.commit()
	value.reconcileGroups({
		profileId,
		generation,
		version: 1,
		groups: [{ id: 'new', name: 'New', color: 'green', collapsedStrip: false, collapsedBackground: false }],
	})
	value.inventory({
		type: 'add',
		profileId,
		generation,
		version: 11,
		terminal: { id: id('e'), surface: 'background', groupId: 'new' },
	})
	const command = port.commands[0]
	if (!command) throw new Error('Expected command')
	port.resolve(command, [])
	await completion
	assert.deepEqual(value.snapshot().groups, [
		{ id: 'new', name: 'New', color: 'green', collapsedStrip: false, collapsedBackground: false, memberIds: [id('e')] },
	])
})

test('group drag preserves all members once and contiguously across surfaces', async () => {
	const groups = [group('g', ['a', 'c'])]
	const port = new InMemorySessionPlacementPort({ profileId, generation, groups })
	const value = placement(port)
	const drag = value.beginDrag({ type: 'group', groupId: 'g' })
	assert.equal(drag.project({ surface: 'background', index: 0 }).ok, true)
	assert.deepEqual(value.snapshot().drag?.background, [id('a'), id('c'), id('b')])
	const completion = await drag.commit()
	assert.equal(port.commands.length, 1)
	assert.equal(port.commands[0]?.type === 'move' ? port.commands[0].groupId : null, 'g')
	assert.equal(completion.ok, true)
	assert.deepEqual(value.snapshot().strip, [id('d')])
	assert.deepEqual(value.snapshot().background, [id('a'), id('c'), id('b')])
	assert.deepEqual([...value.snapshot().strip, ...value.snapshot().background].sort(), [
		id('a'),
		id('b'),
		id('c'),
		id('d'),
	])
})

test('rejected delayed drag merges inventory append rather than restoring an old full snapshot', async () => {
	const port = new ControlledPort()
	const value = placement(port)
	const drag = value.beginDrag({ type: 'terminal', id: id('b') })
	drag.project({ surface: 'strip', index: 0 })
	const completion = drag.commit()
	assert.equal(value.snapshot().busy, true)
	value.inventory({ type: 'add', profileId, generation, version: 11, terminal: { id: id('e'), surface: 'background' } })
	port.reject()
	const result = await completion
	assert.deepEqual(result.ok ? null : result.reason, 'port-rejected')
	assert.deepEqual(value.snapshot().strip, [id('a'), id('c'), id('d')])
	assert.deepEqual(value.snapshot().background, [id('b'), id('e')])
	assert.equal(value.snapshot().drag, null)
	assert.equal(value.snapshot().busy, false)
})

test('removal during a deferred commit cannot be resurrected by a rejected rollback', async () => {
	const port = new ControlledPort()
	const value = placement(port)
	const drag = value.beginDrag({ type: 'terminal', id: id('b') })
	drag.project({ surface: 'strip', index: 0 })
	const completion = drag.commit()
	value.inventory({ type: 'remove', profileId, generation, version: 11, id: id('b') })
	port.reject()
	await completion
	assert.deepEqual(value.snapshot().inventory, [id('a'), id('c'), id('d')])
	assert.deepEqual(value.snapshot().background, [])
	assert.equal(value.snapshot().drag, null)
})

test('one user transaction is admitted while versioned inventory events continue to merge', async () => {
	const port = new ControlledPort()
	const value = placement(port)
	const drag = value.beginDrag({ type: 'terminal', id: id('b') })
	drag.project({ surface: 'strip', index: 0 })
	const completion = drag.commit()
	const rejected = await value.execute({ type: 'park', id: id('a') })
	assert.deepEqual(rejected.ok ? null : rejected.reason, 'busy')
	value.inventory({ type: 'add', profileId, generation, version: 11, terminal: { id: id('e'), surface: 'strip' } })
	assert.deepEqual(value.snapshot().strip, [id('a'), id('c'), id('d'), id('e')])
	port.reject()
	await completion
})

test('inventory ownership/remove rules retain one identity and deterministic selection fallback', async () => {
	const value = placement(new InMemorySessionPlacementPort({ profileId, generation }))
	await value.execute({ type: 'select', id: id('a') })
	value.inventory({ type: 'ownership', profileId, generation, version: 11, id: id('a'), surface: 'background' })
	assert.deepEqual(value.snapshot().strip, [id('c'), id('d')])
	assert.deepEqual(value.snapshot().background, [id('b'), id('a')])
	value.inventory({ type: 'remove', profileId, generation, version: 12, id: id('a') })
	assert.equal(value.snapshot().selectedId, id('c'))
	assert.deepEqual([...value.snapshot().strip, ...value.snapshot().background], [id('c'), id('d'), id('b')])
})

test('stale drag commits/cancels are typed rejections and an accepted commit is one-shot', async () => {
	const port = new ControlledPort()
	const value = placement(port)
	const drag = value.beginDrag({ type: 'terminal', id: id('b') })
	drag.project({ surface: 'strip', index: 0 })
	const first = drag.commit()
	const second = await drag.commit()
	assert.deepEqual(second.ok ? null : second.reason, 'stale-drag')
	const cancelled = drag.cancel()
	assert.deepEqual(cancelled.ok ? null : cancelled.reason, 'stale-drag')
	const command = port.commands[0]
	if (!command) throw new Error('Expected command')
	port.resolve(command)
	assert.equal((await first).ok, true)
	assert.equal(value.snapshot().drag, null)
})

test('late wrong-generation and disposed completions are inert and expose stable reasons', async () => {
	const generationPort = new ControlledPort()
	const value = placement(generationPort)
	const revisions: number[] = []
	value.subscribe(snapshot => revisions.push(snapshot.revision))
	const drag = value.beginDrag({ type: 'terminal', id: id('b') })
	drag.project({ surface: 'strip', index: 0 })
	const generationCompletion = drag.commit()
	const command = generationPort.commands[0]
	if (!command) throw new Error('Expected command')
	generationPort.resolve(command, [], generation + 1)
	const wrongGeneration = await generationCompletion
	assert.deepEqual(wrongGeneration.ok ? null : wrongGeneration.reason, 'generation-mismatch')
	assert.deepEqual(value.snapshot().background, [id('b')])

	const disposePort = new ControlledPort()
	const disposed = placement(disposePort)
	const disposeDrag = disposed.beginDrag({ type: 'terminal', id: id('b') })
	disposeDrag.project({ surface: 'strip', index: 0 })
	const disposeCompletion = disposeDrag.commit()
	const disposeCommand = disposePort.commands[0]
	if (!disposeCommand) throw new Error('Expected command')
	disposed.dispose()
	disposePort.resolve(disposeCommand)
	const late = await disposeCompletion
	assert.deepEqual(late.ok ? null : late.reason, 'disposed')
	assert.equal(disposed.snapshot().busy, false)
	assert.equal(revisions.length > 0, true)
})

test('invalid actions reject with stable reasons and leave the immutable snapshot unchanged', async () => {
	const value = placement(new InMemorySessionPlacementPort({ profileId, generation }))
	const before = value.snapshot()
	const unknown = await value.execute({ type: 'restore', id: id('missing') })
	assert.deepEqual(unknown.ok ? null : unknown.reason, 'unknown-terminal')
	assert.equal(value.snapshot(), before)
	const invalid = await value.execute({ type: 'open-background', id: id('a') })
	assert.deepEqual(invalid.ok ? null : invalid.reason, 'invalid-action')
	assert.equal(value.snapshot(), before)
})

test('split-surface bulk group actions submit and move complete current membership', async () => {
	const port = new InMemorySessionPlacementPort({ profileId, generation, groups: [group('g', ['a', 'c'])] })
	const value = placement(
		port,
		hydration({
			terminals: [
				{ id: id('a'), surface: 'strip', groupId: 'g' },
				{ id: id('b'), surface: 'background' },
				{ id: id('c'), surface: 'background', groupId: 'g' },
				{ id: id('d'), surface: 'strip' },
			],
		}),
	)
	const result = await value.execute({ type: 'restore-group', groupId: 'g' })
	assert.equal(result.ok, true)
	const command = port.commands.at(-1)
	assert.equal(command?.type, 'move')
	if (command?.type !== 'move') return
	assert.deepEqual(command.affectedIds, [id('a'), id('c')])
	assert.equal(command.groupId, 'g')
	assert.deepEqual(value.snapshot().strip, [id('d'), id('a'), id('c')])
	assert.deepEqual(value.snapshot().background, [id('b')])
})

test('successful delayed commit preserves unrelated ownership inventory received while awaiting', async () => {
	const port = new ControlledPort()
	const value = placement(port)
	const pending = value.execute({ type: 'park', id: id('d') })
	const command = port.commands[0]
	if (!command) throw new Error('Expected placement command')
	value.inventory({ type: 'ownership', profileId, generation, version: 11, id: id('b'), surface: 'background' })
	port.resolve(command, [group('g', ['a', 'c'])])
	assert.equal((await pending).ok, true)
	assert.ok(value.snapshot().background.includes(id('b')))
	assert.ok(value.snapshot().background.includes(id('d')))
})

test('drag projection includes target membership before its one-shot commit', () => {
	const value = placement(new InMemorySessionPlacementPort({ profileId, generation, groups: [group('g', ['a', 'c'])] }))
	const drag = value.beginDrag({ type: 'terminal', id: id('d') })
	assert.equal(drag.project({ surface: 'strip', index: 1, groupId: 'g' }).ok, true)
	const projected = value.snapshot().drag
	assert.ok(projected)
	assert.deepEqual(projected.groups.find(item => item.id === 'g')?.memberIds, [id('a'), id('c'), id('d')])
	drag.cancel()
})

test('binding flush carries deferred unbound membership and clears debt only after persistence', async () => {
	class FlushPort implements SessionPlacementPort {
		bound = false
		readonly commands: DurablePlacementCommand[] = []
		async authorizeAndCommit(command: DurablePlacementCommand): Promise<DurablePlacementResult> {
			this.commands.push(command)
			return {
				profileId,
				generation,
				persisted: this.bound,
				durabilityDirty: !this.bound,
				registryEpoch: 1,
				affectedIds: command.type === 'move' ? [...command.affectedIds] : [],
				authoritativeOrder: command.type === 'set-collapsed' ? [] : [...command.strip, ...command.background],
				authoritativeGroups: [group('g', ['a', 'c', 'fresh'])],
			}
		}
	}
	const port = new FlushPort()
	const value = placement(port)
	value.inventory({ type: 'add', profileId, generation, version: 11, terminal: { id: id('fresh'), surface: 'strip' } })
	await value.execute({ type: 'set-membership', id: id('fresh'), groupId: 'g' })
	assert.equal(value.snapshot().durabilityDirty, true)
	port.bound = true
	const flushed = await value.flushDurability()
	assert.equal(flushed.ok, true)
	const command = port.commands.at(-1)
	assert.equal(command?.type, 'move')
	if (command?.type !== 'move') return
	assert.ok(command.memberships?.some(entry => entry.terminalId === id('fresh') && entry.groupId === 'g'))
	assert.equal(value.snapshot().durabilityDirty, false)
})

test('newer group reconciliation cannot be resurrected by an older successful result', async () => {
	const port = new ControlledPort()
	const value = placement(port)
	const pending = value.execute({ type: 'park', id: id('d') })
	const command = port.commands[0]
	if (!command) throw new Error('Expected placement command')
	value.reconcileGroups({ profileId, generation, version: 1, groups: [] })
	port.resolve(command, [group('g', ['a', 'c'])])
	assert.equal((await pending).ok, true)
	assert.deepEqual(value.snapshot().groups, [])
})

test('partial durable order preserves local-only identities in their candidate slots', async () => {
	const port: SessionPlacementPort = {
		authorizeAndCommit: async command => ({
			profileId,
			generation,
			persisted: true,
			durabilityDirty: false,
			registryEpoch: 1,
			affectedIds: command.type === 'move' ? [...command.affectedIds] : [],
			authoritativeOrder: [id('live'), id('a')],
			authoritativeGroups: [],
		}),
	}
	const value = placement(
		port,
		hydration({
			groups: [],
			terminals: [
				{ id: id('a'), surface: 'strip' },
				{ id: id('exited'), surface: 'background' },
				{ id: id('live'), surface: 'background' },
			],
		}),
	)
	assert.equal((await value.execute({ type: 'park', id: id('a') })).ok, true)
	assert.deepEqual(value.snapshot().background, [id('exited'), id('live'), id('a')])
})

test('post-dispatch abort reconciles a successful durable result', async () => {
	const port = new ControlledPort()
	const value = placement(port)
	const controller = new AbortController()
	const pending = value.execute({ type: 'park', id: id('d') }, controller.signal)
	const command = port.commands[0]
	if (!command) throw new Error('Expected placement command')
	controller.abort()
	port.resolve(command, [group('g', ['a', 'c'])])
	const result = await pending
	assert.equal(result.ok, true)
	assert.ok(value.snapshot().background.includes(id('d')))
})
