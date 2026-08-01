import assert from 'node:assert/strict'
import test from 'node:test'
import shortcutsModule from '../app/src/shortcuts.ts'

const {
	SHORTCUTS,
	effectiveShortcuts,
	parseShortcut,
	serializeShortcut,
	shortcutDisplay,
	electronAccelerator,
	matchesShortcut,
	validateShortcutBindings,
	shortcutConflicts,
	moveShortcut,
	moveShortcutCandidate,
	matchingShortcutAction,
} = shortcutsModule

test('shortcut registry is complete and defaults are globally unique', () => {
	assert.equal(SHORTCUTS.length, 22)
	const bindings = effectiveShortcuts()
	assert.doesNotThrow(() => validateShortcutBindings(bindings))
	assert.deepEqual(bindings.previousTerminal.map(serializeShortcut), [
		'Primary+Alt+ArrowLeft',
		'Primary+Shift+BracketLeft',
	])
})

test('shortcut parse/serialize/display and Electron accelerator round trip', () => {
	const chord = parseShortcut('Primary+Shift+Alt+KeyT')
	assert.deepEqual(chord, { code: 'KeyT', shift: true, alt: true })
	if (!chord) assert.fail('Expected a valid shortcut chord')
	assert.equal(serializeShortcut(chord), 'Primary+Shift+Alt+KeyT')
	assert.equal(shortcutDisplay(chord, 'darwin'), '⌥⇧⌘T')
	assert.equal(shortcutDisplay(chord, 'linux'), 'Alt+Shift+Ctrl+T')
	assert.equal(electronAccelerator(chord), 'CommandOrControl+Alt+Shift+T')
	assert.equal(parseShortcut('Primary+Control+KeyT'), null)
	assert.deepEqual(parseShortcut('Primary+F1'), { code: 'F1' })
})

test('event matching requires the exact primary and modifiers', () => {
	const chord = { code: 'Digit1' }
	assert.equal(
		matchesShortcut({ code: 'Digit1', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, chord, 'darwin'),
		true,
	)
	assert.equal(
		matchesShortcut({ code: 'Digit1', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, chord, 'darwin'),
		false,
	)
	assert.equal(
		matchesShortcut({ code: 'Digit1', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, chord, 'linux'),
		true,
	)
})

test('physical-code menu matching ignores printable-key layout differences', () => {
	const bindings = effectiveShortcuts()
	assert.equal(
		matchingShortcutAction(
			bindings,
			'menu',
			{ code: 'KeyW', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
			'darwin',
		),
		'closeFocused',
	)
	// On a non-US layout this physical key can print another character; code wins.
	assert.equal(
		matchingShortcutAction(
			bindings,
			'menu',
			{ code: 'KeyW', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
			'linux',
		),
		'closeFocused',
	)
})

test('empty arrays explicitly disable actions and moves are explicit', () => {
	const disabled = effectiveShortcuts({ newTerminal: [], runContextSave: [] })
	assert.deepEqual(disabled.newTerminal, [])
	assert.deepEqual(disabled.runContextSave, [])
	assert.doesNotThrow(() => validateShortcutBindings(disabled))
	const moved = moveShortcut(disabled, { code: 'KeyT' }, 'newTerminal', 'fontSmaller')
	assert.deepEqual(moved.newTerminal, [])
	assert.deepEqual(moved.fontSmaller, [{ code: 'Minus' }, { code: 'KeyT' }])
})

test('candidate moves retain the replacement position for all owner orders', () => {
	const before = effectiveShortcuts()
	const ownerBefore = structuredClone(before)
	ownerBefore.fontSmaller[0] = { code: 'KeyT' }
	assert.deepEqual(moveShortcutCandidate(ownerBefore, { code: 'KeyT' }, 'newTerminal', 'fontSmaller', 0).fontSmaller, [
		{ code: 'KeyT' },
	])
	const ownerAfter = structuredClone(before)
	ownerAfter.newTerminal[0] = { code: 'Minus' }
	assert.deepEqual(moveShortcutCandidate(ownerAfter, { code: 'Minus' }, 'fontSmaller', 'newTerminal', 0).newTerminal, [
		{ code: 'Minus' },
	])
	const sameAction = structuredClone(before)
	sameAction.newTerminal.push({ code: 'KeyT' })
	assert.deepEqual(moveShortcutCandidate(sameAction, { code: 'KeyT' }, 'newTerminal', 'newTerminal', 1).newTerminal, [
		{ code: 'KeyT' },
	])
})

test('structured conflicts identify native and Helm owners', () => {
	const native = effectiveShortcuts()
	native.fontSmaller = [{ code: 'KeyV', shift: true }]
	assert.deepEqual(shortcutConflicts(native)[0], {
		kind: 'native',
		chord: { code: 'KeyV', shift: true },
		owner: 'Edit > Paste and Match Style',
	})
	const helm = effectiveShortcuts()
	helm.fontSmaller = [{ code: 'KeyT' }]
	assert.deepEqual(shortcutConflicts(helm)[0], {
		kind: 'helm',
		chord: { code: 'KeyT' },
		owner: 'newTerminal',
		ownerLabel: 'New terminal',
	})
})

test('duplicate, native, system-owned, and macOS control-like conflicts are rejected', () => {
	const duplicate = effectiveShortcuts()
	duplicate.fontSmaller = [{ code: 'KeyT' }]
	assert.throws(() => validateShortcutBindings(duplicate), /conflicts/)
	const darwinSystemChords = [
		{ code: 'KeyQ' },
		{ code: 'Space' },
		{ code: 'Tab' },
		{ code: 'Tab', shift: true },
		{ code: 'Backquote' },
	]
	for (const chord of darwinSystemChords) {
		const native = effectiveShortcuts()
		native.fontSmaller = [chord]
		assert.throws(() => validateShortcutBindings(native, 'darwin'), /reserved/)
	}
	for (const chord of darwinSystemChords)
		assert.doesNotThrow(() => effectiveShortcuts({ fontSmaller: [chord] }, 'linux'))
	assert.throws(
		() => effectiveShortcuts({ fontSmaller: [{ code: 'KeyC' }] }, 'linux'),
		error => error instanceof Error && error.message.includes('Ctrl+C') && !error.message.includes('⌘'),
	)
	assert.equal(parseShortcut('Primary+Ctrl+KeyT'), null)
})
