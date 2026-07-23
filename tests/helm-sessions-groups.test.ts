import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import * as sessionsModule from '../app/src/sessions.ts'

type SessionsModule = typeof import('../app/src/sessions.ts')
const sessions = ((sessionsModule as { default?: SessionsModule }).default ?? sessionsModule) as SessionsModule
const { SessionRegistry, isValidTabGroupId, tabGroupActionIntent } = sessions

function registryFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-groups-')), 'sessions.json')
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
	const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
	assert.equal(disk._tabGroups[group.id].name, 'Deploy watch')
	assert.equal(disk._tabGroups[group.id].collapsedStrip, true)
	assert.equal('collapsedBackground' in disk._tabGroups[group.id], false)
	const reloaded = new SessionRegistry(file)
	assert.deepEqual(reloaded.getGroups(), [{ ...group, collapsedStrip: true }])
	assert.equal(reloaded.get('aaaa1111')?.groupId, group.id)
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
	assert.equal(registry.get('aaaa1111')?.groupId, undefined)
	assert.equal(registry.get('cccc3333')?.groupId, undefined)
	assert.deepEqual(registry.getGroups(), [group])
})

test('last global member removal and prune delete groups, but retained unknown metadata keeps them', () => {
	const { file, registry, group } = grouped()
	registry.remove('aaaa1111')
	assert.deepEqual(registry.getGroups(), [group])
	registry.prune(new Set(['bbbb2222']))
	assert.deepEqual(registry.getGroups(), [group], 'unknown-probe retained id remains a member')
	registry.prune(new Set())
	registry.flush()
	assert.deepEqual(registry.getGroups(), [])
	assert.equal(fs.readFileSync(file, 'utf8').includes('_tabGroups'), false)
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
