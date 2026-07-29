import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
const shared = readFileSync(new URL('../app/src/shared.ts', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('../app/src/renderer/terminal-workspace.ts', import.meta.url), 'utf8')

test('Shell menu forwards previous and next terminal accelerators over narrow tab events', () => {
	assert.match(
		main,
		/label: 'Previous Terminal',[\s\S]*?accelerator: 'CmdOrCtrl\+Alt\+Left',[\s\S]*?click: send\('tab:previous'\)/,
	)
	assert.match(
		main,
		/label: 'Next Terminal',[\s\S]*?accelerator: 'CmdOrCtrl\+Alt\+Right',[\s\S]*?click: send\('tab:next'\)/,
	)
	assert.match(preload, /onPrevious: listener => subscribe\('tab:previous', listener\)/)
	assert.match(preload, /onNext: listener => subscribe\('tab:next', listener\)/)
	assert.match(shared, /onPrevious\(listener: \(\) => void\): \(\) => void/)
	assert.match(shared, /onNext\(listener: \(\) => void\): \(\) => void/)
})

test('foreground cycle events reuse cycleTab and release their subscriptions on workspace disposal', () => {
	assert.match(workspace, /helm\.tabs\.onPrevious\(\(\) => \{\s*if \(tabsReady\) cycleTab\(-1\)/)
	assert.match(workspace, /helm\.tabs\.onNext\(\(\) => \{\s*if \(tabsReady\) cycleTab\(1\)/)
	assert.match(workspace, /unsubscribeTabPrevious\(\)/)
	assert.match(workspace, /unsubscribeTabNext\(\)/)
})
