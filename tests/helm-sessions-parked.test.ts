// Background terminals: the session registry's `parked` flag must survive a
// kill/relaunch cycle (app/src/sessions.ts SessionRegistry) — a parked session
// restores as parked (popover row), a restored one as a strip tab. CJS
// default-import pattern per the helm test convention.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import sessionsModule from '../app/src/sessions.ts'

type SessionsModule = typeof import('../app/src/sessions.ts')
const { SessionRegistry, compareSessionOrder } = sessionsModule as SessionsModule

function tempRegistryFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-park-')), 'sessions.json')
}

test('parked flag survives a registry relaunch as parked', () => {
	const file = tempRegistryFile()
	const first = new SessionRegistry(file)
	first.add('aaaa1111')
	first.add('bbbb2222')
	first.setTitle('aaaa1111', 'okena')
	first.setParked('aaaa1111', true)
	first.flush()

	// "Relaunch": a fresh registry instance reading the same file.
	const second = new SessionRegistry(file)
	assert.equal(second.get('aaaa1111')?.parked, true)
	assert.equal(second.get('aaaa1111')?.lastTitle, 'okena') // title reused for the popover row
	assert.equal(second.get('bbbb2222')?.parked ?? false, false) // non-parked stays a tab
})

test('restore clears the parked flag across a relaunch', () => {
	const file = tempRegistryFile()
	const first = new SessionRegistry(file)
	first.add('cccc3333')
	first.setParked('cccc3333', true)
	first.setParked('cccc3333', false) // popover row restored to the strip
	first.flush()

	const second = new SessionRegistry(file)
	assert.equal(second.get('cccc3333')?.parked ?? false, false)
})

test('setParked ignores unknown sessions and prune drops parked metadata with the session', () => {
	const file = tempRegistryFile()
	const registry = new SessionRegistry(file)
	registry.setParked('missing1', true) // no throw, no entry created
	assert.equal(registry.get('missing1'), undefined)

	registry.add('dddd4444')
	registry.setParked('dddd4444', true)
	registry.prune(new Set()) // socket gone → session forgotten, parked flag with it
	registry.flush()
	const reloaded = new SessionRegistry(file)
	assert.equal(reloaded.get('dddd4444'), undefined)
})

test('explicit terminal order survives relaunch and ignores unknown or duplicate ids', () => {
	const file = tempRegistryFile()
	const first = new SessionRegistry(file)
	first.add('aaaa1111')
	first.add('bbbb2222')
	first.add('cccc3333')
	first.setOrder(['cccc3333', 'missing1', 'aaaa1111', 'cccc3333', 'bbbb2222'])
	first.flush()

	const second = new SessionRegistry(file)
	assert.equal(second.get('cccc3333')?.order, 0)
	assert.equal(second.get('aaaa1111')?.order, 1)
	assert.equal(second.get('bbbb2222')?.order, 2)
	const restored = second
		.ids()
		.map(id => {
			const meta = second.get(id)
			assert.ok(meta)
			return { id, ...meta }
		})
		.sort(compareSessionOrder)
	assert.deepEqual(
		restored.map(entry => entry.id),
		['cccc3333', 'aaaa1111', 'bbbb2222'],
	)
})

test('legacy sessions without explicit order fall back to creation time', () => {
	const sessions = [{ createdAt: '2026-07-02T00:00:00.000Z' }, { createdAt: '2026-07-01T00:00:00.000Z' }]
	assert.deepEqual([...sessions].sort(compareSessionOrder), [sessions[1], sessions[0]])
})
