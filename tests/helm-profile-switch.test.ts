import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../app/src/helm-bridge.ts', import.meta.url), 'utf8')
const list = readFileSync(new URL('../app/src/renderer/sidebar/ListPage.tsx', import.meta.url), 'utf8')

test('profile switching keeps the BrowserWindow and swaps terminal namespaces in place', () => {
	const activation = main.slice(main.indexOf('async function activateProfile'), main.indexOf('function profileMenu'))
	assert.doesNotMatch(activation, /app\.relaunch|app\.quit/)
	assert.match(activation, /flushRendererBuffers/)
	assert.match(activation, /killAllPtyClients\(\)/)
	assert.match(activation, /sessionSupport = undefined/)
	assert.match(activation, /sessions\.configureSessionProfile\(profileId\)/)
	assert.match(activation, /helmBridge\.beginProfileSwitch\(profileId\)/)
	assert.ok(
		activation.indexOf('helmBridge.beginProfileSwitch(profileId)') <
			activation.indexOf('helmBridge.activateProfile(profileId)'),
		'old renderer must be fenced before daemon activation',
	)
	assert.match(activation, /sessionProfileGeneration \+= 1/)
	assert.match(activation, /win\.webContents\.reload\(\)/)
	assert.match(activation, /profileReady\.then[\s\S]{0,220}deliverOpenItem\(openItemId\)/)
	assert.match(main, /if \(pendingProfileReady\) await pendingProfileReady\.promise/)
	assert.match(main, /canOpen: \(\) => !profileSwitchInProgress/)
})

test('bridge hides old-profile rows and fast-polls for the target daemon runtime', () => {
	assert.match(bridge, /pendingProfileId/)
	assert.match(bridge, /status\.data\?\.profile\?\.id !== this\.pendingProfileId/)
	assert.match(bridge, /items\.data !== undefined/)
	assert.match(bridge, /items: null/)
	assert.match(bridge, /}, 150\)/)
	assert.match(bridge, /pendingProfileId !== null[\s\S]{0,120}Profile is switching/)
})

test('late IPC from the old renderer is rejected by a profile generation token', () => {
	assert.match(main, /acceptsSessionToken/)
	assert.match(main, /sessionProfileGeneration \+= 1/)
	assert.match(main, /buffer:save[\s\S]{0,180}acceptsSessionToken/)
	assert.match(bridge, /acceptsProfileToken/)
	assert.match(main, /const support = getSessionSupport\(\)[\s\S]{0,180}sessions\.killSession/)
	assert.match(main, /graceCloseSupports\.set\(entry\.sessionId, getSessionSupport\(\)\)/)
	assert.match(main, /graceCloseSupports\.get\(sessionId\)/)
})

test('work overflow menu exposes direct profile choices and management', () => {
	assert.match(list, /availableProfiles\.map/)
	assert.match(list, /window\.helm\.profiles\.activate\(profileId\)/)
	assert.match(list, /label: 'Manage profiles…'/)
})
