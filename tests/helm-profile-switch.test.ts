import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../app/src/helm-bridge.ts', import.meta.url), 'utf8')
const list = readFileSync(new URL('../app/src/renderer/sidebar/ListPage.tsx', import.meta.url), 'utf8')
const runContextPreload = readFileSync(new URL('../app/src/preload-run-context.ts', import.meta.url), 'utf8')

test('profile switching preserves the existing application process', () => {
	const activation = main.slice(
		main.indexOf('function createProfileSwitchCoordinator'),
		main.indexOf('function profileMenu'),
	)
	assert.doesNotMatch(activation, /app\.relaunch|app\.quit|sessions\.killSession/)
	assert.match(activation, /killAllPtyClients/)
	assert.match(activation, /reloadOrCreateWindowForProfile/)
})

test('bridge fence has no globally cancellable profile-switch API', () => {
	assert.match(bridge, /nextProfileFenceEpoch/)
	assert.match(bridge, /cancelIfCurrent/)
	assert.match(bridge, /invalidateIfCurrent/)
	assert.match(bridge, /Object\.assign\(record, makeReady\(\)\)/)
	assert.match(bridge, /isCurrentFence\(fence\)/)
	assert.doesNotMatch(bridge, /cancelProfileSwitch/)
	assert.doesNotMatch(bridge, /pendingProfileId/)
})

test('terminal, session, and buffer handlers gate mutable access during a profile fence', () => {
	for (const channel of [
		'pty:spawn',
		'pty:write',
		'pty:resize',
		'pty:kill',
		'session:close-with-grace',
		'session:undo-close',
		'sessions:list',
		'sessions:placement:commit',
		'session:title',
		'session:set-custom-name',
		'buffer:save',
		'buffer:read',
	]) {
		const start = main.indexOf(`'${channel}'`)
		assert.ok(start >= 0, `missing ${channel}`)
		const handler = main.slice(start, start + 700)
		assert.match(
			handler,
			/sessionIpcGate\.(?:handle|require|allows)/,
			`${channel} must fail closed before mutable access`,
		)
	}
	assert.match(main, /profileSwitchCoordinator\?\.stop\(\)/)
	assert.match(main, /while \(activeProfileSwitch\)/)
})

test('run-context preload remains restricted to its editor capability', () => {
	assert.match(runContextPreload, /contextBridge\.exposeInMainWorld\('runContextEditor'/)
	for (const forbidden of ['window.helm', 'pty:', 'session:', 'daemon:config', 'shell:']) {
		assert.doesNotMatch(runContextPreload, new RegExp(forbidden.replace(':', '\\:')))
	}
})

test('work overflow menu exposes direct profile choices and management', () => {
	assert.match(list, /availableProfiles\.map/)
	assert.match(list, /window\.helm\.profiles\.activate\(profileId\)/)
	assert.match(list, /label: 'Manage profiles…'/)
})
