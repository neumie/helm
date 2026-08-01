import assert from 'node:assert/strict'
import test from 'node:test'
import recorderModule from '../app/src/shortcut-recorder.ts'

const { recordedShortcutInput } = recorderModule

test('recorder consumes Escape and every Primary chord before other dispatch', () => {
	assert.deepEqual(recordedShortcutInput({ type: 'keyDown', key: 'Escape' }, 'darwin'), {
		consume: true,
		complete: true,
		value: null,
	})
	assert.deepEqual(recordedShortcutInput({ type: 'keyDown', key: 't', code: 'KeyT', meta: true }, 'darwin'), {
		consume: true,
		complete: true,
		value: { code: 'KeyT' },
	})
	// Cmd+Q is reserved later by settings validation, but recorder still fences it.
	assert.equal(recordedShortcutInput({ type: 'keyDown', key: 'q', code: 'KeyQ', meta: true }, 'darwin').consume, true)
	// Unsupported Primary code also cannot leak to a native handler.
	assert.deepEqual(recordedShortcutInput({ type: 'keyDown', key: 'x', code: 'Numpad1', meta: true }, 'darwin'), {
		consume: true,
		complete: true,
		value: null,
	})
})

test('recorder leaves ordinary terminal/text input alone', () => {
	assert.deepEqual(recordedShortcutInput({ type: 'keyDown', key: 'x', code: 'KeyX' }, 'darwin'), {
		consume: false,
		complete: false,
		value: null,
	})
	assert.deepEqual(recordedShortcutInput({ type: 'keyDown', key: 'x', code: 'KeyX', control: true }, 'darwin'), {
		consume: false,
		complete: false,
		value: null,
	})
	assert.deepEqual(recordedShortcutInput({ type: 'keyDown', key: 'x', code: 'KeyX', control: true }, 'linux'), {
		consume: true,
		complete: true,
		value: { code: 'KeyX' },
	})
})
