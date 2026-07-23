import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const shared = readFileSync(new URL('../app/src/shared.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')

const channels = [
	'tab-groups:list',
	'tab-groups:create',
	'tab-groups:rename',
	'tab-groups:delete',
	'tab-groups:set-membership',
	'tab-groups:set-collapsed',
	'tab-groups:move',
	'tab-groups:intent',
]

test('tab-group preload contract carries the captured profile token for every operation', () => {
	assert.match(shared, /export interface TabGroupsApi/)
	assert.match(shared, /groups: TabGroupsApi/)
	for (const channel of channels) {
		const start = preload.indexOf(`'${channel}'`)
		assert.notEqual(start, -1, channel)
		assert.ok(preload.slice(start, start + 220).includes('sessionProfileToken'), channel)
	}
})

test('tab-group main adapter is fail-closed and declarative rather than a PTY control path', () => {
	const start = main.indexOf('// Tab groups are persisted metadata only.')
	const end = main.indexOf('// Park/unpark a session', start)
	assert.notEqual(start, -1)
	assert.notEqual(end, -1)
	const adapter = main.slice(start, end)
	for (const channel of channels) {
		assert.ok(adapter.includes(`'${channel}'`), channel)
	}
	assert.match(adapter, /sessionIpcGate\.handle\(profileToken/)
	assert.match(adapter, /parseTabGroupActionIntent/)
	assert.match(main, /sessions\.tabGroupActionIntent/)
	assert.doesNotMatch(adapter, /\bptys\b|\.proc\.|killSession|pty:/)
})
