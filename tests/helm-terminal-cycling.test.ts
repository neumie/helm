import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
const shared = readFileSync(new URL('../app/src/shared.ts', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('../app/src/renderer/terminal-workspace.ts', import.meta.url), 'utf8')

test('Shell menu forwards configurable previous and next terminal actions over narrow tab events', () => {
	assert.match(main, /previousTerminal: send\('tab:previous'\)/)
	assert.match(main, /nextTerminal: send\('tab:next'\)/)
	assert.match(main, /menuItem\('Previous Terminal', 'previousTerminal'\)/)
	assert.match(main, /menuItem\('Next Terminal', 'nextTerminal'\)/)
	assert.match(main, /registerAccelerator: false/)
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
