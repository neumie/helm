// macOS-native terminal editing shortcuts translated at Helm's xterm boundary.
// Terminal.app-specific Karabiner rules do not apply inside the Electron app.

import assert from 'node:assert/strict'
import test from 'node:test'
import keybindingsModule from '../app/src/renderer/terminal-keybindings.ts'
import shortcutsModule from '../app/src/shortcuts.ts'

type KeybindingsModule = typeof import('../app/src/renderer/terminal-keybindings.ts')
const { terminalShortcut, terminalInputShortcut } = keybindingsModule as KeybindingsModule
const { effectiveShortcuts } = shortcutsModule

const commandBackspace = {
	key: 'Backspace',
	code: 'Backspace',
	metaKey: true,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
}
const commandPeriod = { key: '.', code: 'Period', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
const controlZ = { key: 'z', code: 'KeyZ', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }

test('Ctrl+Z sends SUB and suppresses xterm on macOS', () => {
	assert.deepEqual(terminalShortcut('darwin', controlZ), { input: '\x1a', suppress: true })
})

test('other platforms and modified Ctrl+Z combinations pass through', () => {
	assert.equal(terminalShortcut('linux', controlZ), null)
	assert.equal(terminalShortcut('darwin', { ...controlZ, ctrlKey: false }), null)
	assert.equal(terminalShortcut('darwin', { ...controlZ, metaKey: true }), null)
	assert.equal(terminalShortcut('darwin', { ...controlZ, shiftKey: true }), null)
	assert.equal(terminalShortcut('darwin', { ...controlZ, altKey: true }), null)
})

test('terminal-scoped configurable delete-line and interrupt emit exact bytes', () => {
	const shortcuts = effectiveShortcuts()
	assert.deepEqual(terminalInputShortcut('darwin', commandBackspace, shortcuts), { input: '\x15', suppress: true })
	assert.deepEqual(terminalInputShortcut('darwin', commandPeriod, shortcuts), { input: '\x03', suppress: true })
})

test('modified, repeating, and composing terminal aliases are not translated', () => {
	const shortcuts = effectiveShortcuts()
	assert.equal(terminalInputShortcut('darwin', { ...commandBackspace, shiftKey: true }, shortcuts), null)
	assert.equal(terminalInputShortcut('darwin', { ...commandPeriod, altKey: true }, shortcuts), null)
	assert.equal(terminalInputShortcut('linux', commandBackspace, shortcuts), null)
	assert.equal(terminalInputShortcut('darwin', { ...commandBackspace, repeat: true }, shortcuts), null)
	assert.equal(terminalInputShortcut('darwin', { ...commandBackspace, isComposing: true }, shortcuts), null)
	assert.equal(terminalInputShortcut('darwin', { ...commandBackspace, key: 'Dead' }, shortcuts), null)
	assert.equal(terminalInputShortcut('darwin', { ...commandBackspace, key: 'Process' }, shortcuts), null)
	// Fixed plain Ctrl+Z keeps its separate reliability boundary.
	assert.deepEqual(terminalInputShortcut('darwin', { ...controlZ, isComposing: true }, shortcuts), {
		input: '\x1a',
		suppress: true,
	})
})
