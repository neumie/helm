import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import * as sessionsModule from '../app/src/sessions.ts'
import * as tabGroupColorModule from '../app/src/tab-group-colors.ts'

type SessionsModule = typeof import('../app/src/sessions.ts')
type TabGroupColorModule = typeof import('../app/src/tab-group-colors.ts')
const sessions = ((sessionsModule as { default?: SessionsModule }).default ?? sessionsModule) as SessionsModule
const { SessionRegistry, isValidTabGroupId, tabGroupActionIntent } = sessions
const tabGroupColors = ((tabGroupColorModule as unknown as { default?: TabGroupColorModule }).default ??
	tabGroupColorModule) as TabGroupColorModule
const { TAB_GROUP_COLORS, defaultTabGroupColor } = tabGroupColors

function registryFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-groups-')), 'sessions.json')
}

function registryDocument(file: string): {
	_tabGroups: Record<string, { name: string; color?: string; collapsedStrip?: boolean; collapsedBackground?: boolean }>
} {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'))
	} catch (error) {
		assert.fail(`invalid registry fixture: ${String(error)}`)
	}
}

function grouped(file = registryFile()) {
	const registry = new SessionRegistry(file)
	registry.add('aaaa1111')
	registry.add('bbbb2222')
	registry.add('cccc3333')
	const group = registry.createGroup('Deploy watch', ['aaaa1111', 'bbbb2222', 'aaaa1111'])
	assert.ok(group)
	return { file, registry, group }
}

test('legacy session registries remain ungrouped and group metadata round-trips compactly', () => {
	const file = registryFile()
	fs.writeFileSync(file, JSON.stringify({ aaaa1111: { createdAt: '2026-01-01T00:00:00.000Z', parked: true } }))
	const legacy = new SessionRegistry(file)
	assert.deepEqual(legacy.getGroups(), [])
	assert.equal(legacy.get('aaaa1111')?.groupId, undefined)

	const group = legacy.createGroup('  Deploy watch  ', ['aaaa1111'])
	assert.ok(group)
	legacy.setGroupCollapsed(group.id, 'strip', true)
	legacy.flush()
	const disk = registryDocument(file)
	assert.equal(disk._tabGroups[group.id].name, 'Deploy watch')
	assert.equal(disk._tabGroups[group.id].color, group.color)
	assert.equal(disk._tabGroups[group.id].collapsedStrip, true)
	assert.equal('collapsedBackground' in disk._tabGroups[group.id], false)
	const reloaded = new SessionRegistry(file)
	assert.deepEqual(reloaded.getGroups(), [{ ...group, collapsedStrip: true }])
	assert.equal(reloaded.get('aaaa1111')?.groupId, group.id)
})

test('legacy groups get a stable palette color and explicit changes persist', () => {
	const file = registryFile()
	fs.writeFileSync(
		file,
		JSON.stringify({
			aaaa1111: { createdAt: '2026-01-01T00:00:00.000Z', groupId: 'group-deadbeef' },
			_tabGroups: { 'group-deadbeef': { name: 'Legacy' } },
		}),
	)
	const registry = new SessionRegistry(file)
	assert.equal(registry.getGroups()[0]?.color, defaultTabGroupColor('group-deadbeef'))
	const replacement = TAB_GROUP_COLORS.find(color => color !== registry.getGroups()[0]?.color)
	assert.ok(replacement)
	assert.equal(registry.setGroupColor('group-deadbeef', replacement)?.color, replacement)
	registry.flush()
	const disk = registryDocument(file)
	assert.equal(disk._tabGroups['group-deadbeef'].color, replacement)
	assert.equal(new SessionRegistry(file).getGroups()[0]?.color, replacement)
	assert.equal(registry.setGroupColor('group-deadbeef', 'invalid' as never), null)
})

test('members can split across strip and background while collapse is independent per surface', () => {
	const { file, registry, group } = grouped()
	registry.setParked('bbbb2222', true)
	registry.setGroupCollapsed(group.id, 'strip', true)
	registry.setGroupCollapsed(group.id, 'background', false)
	registry.flush()
	const reloaded = new SessionRegistry(file)
	assert.equal(reloaded.get('aaaa1111')?.groupId, group.id)
	assert.equal(reloaded.get('bbbb2222')?.groupId, group.id)
	assert.equal(reloaded.get('aaaa1111')?.parked, undefined)
	assert.equal(reloaded.get('bbbb2222')?.parked, true)
	assert.deepEqual(reloaded.getGroups(), [{ ...group, collapsedStrip: true }])
})

test('whole-group moves are atomic metadata changes and retain order, membership, names, and collapse', () => {
	const { file, registry, group } = grouped()
	registry.setTitle('aaaa1111', 'vim')
	registry.setCustomName('bbbb2222', 'deploy shell')
	registry.setOrder(['bbbb2222', 'aaaa1111', 'cccc3333'])
	registry.setParked('bbbb2222', true)
	registry.setGroupCollapsed(group.id, 'background', true)
	assert.deepEqual(registry.groupMembers(group.id), ['aaaa1111', 'bbbb2222'])
	assert.deepEqual(registry.moveGroup(group.id, true), ['aaaa1111', 'bbbb2222'])
	assert.equal(registry.get('aaaa1111')?.parked, true)
	assert.equal(registry.get('bbbb2222')?.parked, true)
	assert.deepEqual(registry.moveGroup(group.id, false), ['aaaa1111', 'bbbb2222'])
	registry.flush()
	const reloaded = new SessionRegistry(file)
	assert.equal(reloaded.get('aaaa1111')?.order, 1)
	assert.equal(reloaded.get('bbbb2222')?.customName, 'deploy shell')
	assert.equal(reloaded.get('aaaa1111')?.lastTitle, 'vim')
	assert.equal(reloaded.get('aaaa1111')?.parked, undefined)
	assert.equal(reloaded.get('bbbb2222')?.parked, undefined)
	assert.deepEqual(reloaded.getGroups(), [{ ...group, collapsedBackground: true }])
})

test('moving to a new group is non-empty and atomic, while delete non-destructively ungroups', () => {
	const { registry, group } = grouped()
	assert.equal(registry.createGroup('Empty', ['missing1']), null)
	const replacement = registry.createGroup('Release', ['aaaa1111', 'cccc3333'])
	assert.ok(replacement)
	assert.equal(registry.get('aaaa1111')?.groupId, replacement.id)
	assert.equal(registry.get('cccc3333')?.groupId, replacement.id)
	assert.equal(registry.get('bbbb2222')?.groupId, group.id)
	assert.equal(registry.deleteGroup(replacement.id), true)
	assert.equal(registry.groupMembers(replacement.id), null)
	assert.equal(registry.get('aaaa1111')?.groupId, undefined)
	assert.equal(registry.get('cccc3333')?.groupId, undefined)
	assert.deepEqual(registry.getGroups(), [group])
})

test('group definitions disappear only after their last member is explicitly removed', () => {
	const { file, registry, group } = grouped()
	registry.remove('aaaa1111')
	assert.deepEqual(registry.getGroups(), [group])
	registry.remove('cccc3333')
	assert.deepEqual(registry.getGroups(), [group], 'unrelated removal cannot drop a retained group member')
	registry.remove('bbbb2222')
	registry.flush()
	assert.deepEqual(registry.getGroups(), [])
	assert.equal(fs.readFileSync(file, 'utf8').includes('_tabGroups'), false)
})

test('placement commits atomically rewrite the complete document and preserve run-owned evidence', () => {
	const file = registryFile()
	const registry = new SessionRegistry(file)
	registry.add('aaaa1111')
	registry.add('bbbb2222')
	registry.add('cccc3333')
	const group = registry.createGroup('Deploy', ['aaaa1111', 'bbbb2222'])
	assert.ok(group)
	assert.equal(
		registry.registerRunOwned('dddd4444', {
			profileId: 'work',
			runId: 'run-1',
			revision: 1,
			adoptionId: '11111111-1111-4111-8111-111111111111',
			adopter: '22222222-2222-4222-8222-222222222222',
		}),
		true,
	)

	const result = registry.commitPlacement({
		type: 'move',
		affectedIds: ['bbbb2222'],
		strip: ['bbbb2222', 'aaaa1111'],
		background: ['cccc3333'],
	})
	assert.ok(result)
	assert.equal(result.registryEpoch, 1)
	assert.deepEqual(result.affectedIds, ['bbbb2222'])
	assert.deepEqual(result.authoritativeOrder, ['bbbb2222', 'aaaa1111', 'dddd4444', 'cccc3333'])
	assert.deepEqual(result.authoritativeGroups, [{ ...group, memberIds: ['bbbb2222', 'aaaa1111'] }])
	const disk = registryDocument(file) as Record<string, unknown>
	assert.deepEqual((disk.dddd4444 as { scheduledOwnership?: unknown }).scheduledOwnership, {
		profileId: 'work',
		runId: 'run-1',
		revision: 1,
		adoptionId: '11111111-1111-4111-8111-111111111111',
		adopter: '22222222-2222-4222-8222-222222222222',
	})
	assert.equal((disk.cccc3333 as { parked?: boolean }).parked, true)

	const runOwnedMove = registry.commitPlacement({
		type: 'move',
		affectedIds: ['dddd4444'],
		strip: ['bbbb2222', 'aaaa1111', 'cccc3333'],
		background: [],
	})
	assert.ok(runOwnedMove)
	assert.equal(registry.get('dddd4444')?.parked, undefined)
	assert.equal(registry.get('dddd4444')?.backing, 'run-owned')
	assert.deepEqual(
		((registryDocument(file) as Record<string, unknown>).dddd4444 as { scheduledOwnership?: unknown })
			.scheduledOwnership,
		{
			profileId: 'work',
			runId: 'run-1',
			revision: 1,
			adoptionId: '11111111-1111-4111-8111-111111111111',
			adopter: '22222222-2222-4222-8222-222222222222',
		},
	)
})

test('group placement commits reject stale captured membership and return current authoritative members', () => {
	const registry = new SessionRegistry(registryFile())
	registry.add('aaaa1111')
	registry.add('bbbb2222')
	registry.add('cccc3333')
	const group = registry.createGroup('Deploy', ['aaaa1111', 'bbbb2222'])
	assert.ok(group)
	assert.equal(
		registry.commitPlacement({
			type: 'move',
			groupId: group.id,
			affectedIds: ['aaaa1111'],
			strip: ['cccc3333'],
			background: ['aaaa1111', 'bbbb2222'],
		}),
		null,
	)
	const moved = registry.commitPlacement({
		type: 'move',
		groupId: group.id,
		affectedIds: ['bbbb2222', 'aaaa1111'],
		strip: ['cccc3333'],
		background: ['aaaa1111', 'bbbb2222'],
	})
	assert.ok(moved)
	assert.deepEqual(moved.affectedIds, ['aaaa1111', 'bbbb2222'])
	assert.deepEqual(moved.authoritativeOrder, ['cccc3333', 'aaaa1111', 'bbbb2222'])
})

test('placement membership and collapse commands revalidate current groups and return authoritative members', () => {
	const registry = new SessionRegistry(registryFile())
	registry.add('aaaa1111')
	registry.add('bbbb2222')
	const group = registry.createGroup('Deploy', ['aaaa1111'])
	assert.ok(group)
	const membership = registry.commitPlacement({
		type: 'set-membership',
		terminalId: 'bbbb2222',
		groupId: group.id,
		strip: ['bbbb2222'],
		background: ['aaaa1111'],
	})
	assert.ok(membership)
	assert.deepEqual(membership.authoritativeGroups, [{ ...group, memberIds: ['bbbb2222', 'aaaa1111'] }])
	const collapsed = registry.commitPlacement({
		type: 'set-collapsed',
		groupId: group.id,
		surface: 'background',
		collapsed: true,
	})
	assert.ok(collapsed)
	assert.equal(collapsed.registryEpoch, 2)
	assert.deepEqual(collapsed.affectedIds, ['bbbb2222', 'aaaa1111'])
	assert.deepEqual(collapsed.authoritativeGroups, [
		{ ...group, collapsedBackground: true, memberIds: ['bbbb2222', 'aaaa1111'] },
	])
	assert.equal(
		registry.commitPlacement({
			type: 'set-membership',
			terminalId: 'bbbb2222',
			groupId: 'group-deadbeef',
			strip: ['bbbb2222'],
			background: ['aaaa1111'],
		}),
		null,
	)
})

test('placement commit restores complete in-memory state when the atomic write fails', async () => {
	const file = registryFile()
	let writes = 0
	const registry = new SessionRegistry(file, () => {
		writes += 1
		throw new Error('disk full')
	})
	registry.add('aaaa1111')
	registry.add('bbbb2222')
	const group = registry.createGroup('Deploy', ['aaaa1111'])
	assert.ok(group)
	assert.equal(
		registry.commitPlacement({
			type: 'set-membership',
			terminalId: 'bbbb2222',
			groupId: group.id,
			strip: ['bbbb2222', 'aaaa1111'],
			background: [],
		}),
		null,
	)
	assert.equal(registry.get('bbbb2222')?.groupId, undefined)
	assert.deepEqual(registry.groupMembers(group.id), ['aaaa1111'])
	assert.equal(registry.get('aaaa1111')?.order, undefined)
	assert.equal(writes, 1)
	await new Promise(resolve => setTimeout(resolve, 350))
	assert.equal(writes, 2, 'the pre-existing debounce is restored after the rejected transaction')
})

test('corrupt entries, dangling memberships, invalid inputs, and pure action intents cannot create orphan state', () => {
	const file = registryFile()
	fs.writeFileSync(
		file,
		JSON.stringify({
			aaaa1111: { createdAt: '2026-01-01T00:00:00.000Z', groupId: 'group-deadbeef' },
			_tabGroups: {
				'group-deadbeef': { name: '   ' },
				'group-nothex!': { name: 'Bad' },
			},
		}),
	)
	const registry = new SessionRegistry(file)
	assert.equal(registry.get('aaaa1111')?.groupId, undefined)
	assert.deepEqual(registry.getGroups(), [])
	registry.add('bbbb2222')
	assert.equal(registry.createGroup('   ', ['bbbb2222']), null)
	assert.equal(registry.createGroup('x'.repeat(201), ['bbbb2222'])?.name.length, 200)
	assert.equal(registry.setSessionGroup('bbbb2222', 'group-deadbeef'), false)
	assert.equal(isValidTabGroupId('group-deadbeef'), true)
	assert.equal(isValidTabGroupId('group-DEADBEEF'), false)
	assert.deepEqual(tabGroupActionIntent('open-all', { groupId: 'group-deadbeef' }), {
		type: 'open-all',
		groupId: 'group-deadbeef',
	})
	assert.deepEqual(tabGroupActionIntent('move', { sessionId: 'bbbb2222', targetGroupId: null }), {
		type: 'move',
		sessionId: 'bbbb2222',
		groupId: null,
	})
	assert.equal(tabGroupActionIntent('rename', { groupId: 'group-deadbeef', name: ' ' }), null)
})
