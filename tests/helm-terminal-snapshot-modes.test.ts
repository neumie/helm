import assert from 'node:assert/strict'
import test from 'node:test'
import type { Terminal } from '../app/node_modules/@xterm/xterm'
import * as snapshotModule from '../app/src/renderer/terminal-snapshot-modes.ts'

const { TerminalSnapshotModesAddon } =
	'default' in snapshotModule ? (snapshotModule.default as typeof snapshotModule) : snapshotModule

function harness() {
	const callbacks = new Map<string, (params: Array<number | number[]>) => boolean>()
	let disposed = 0
	const terminal = {
		buffer: { active: { type: 'normal' } },
		parser: {
			registerCsiHandler(id: { final: string }, callback: (params: Array<number | number[]>) => boolean) {
				callbacks.set(id.final, callback)
				return {
					dispose() {
						disposed++
					},
				}
			},
			registerEscHandler(_id: unknown, callback: () => boolean) {
				callbacks.set('reset', callback)
				return {
					dispose() {
						disposed++
					},
				}
			},
		},
	}
	const addon = new TerminalSnapshotModesAddon()
	addon.activate(terminal as unknown as Terminal)
	return {
		addon,
		terminal,
		emit: (key: string, params: Array<number | number[]> = []) => callbacks.get(key)?.(params),
		disposed: () => disposed,
	}
}

test('normal shells retain default encoding; buffer mode and content policy stay unchanged', () => {
	const { addon, terminal, emit } = harness()
	assert.equal(addon.serialize(), '')
	terminal.buffer.active.type = 'alternate'
	assert.equal(addon.serialize(), '')
	emit('h', [1006])
	assert.equal(addon.serialize(), '\x1b[?1006h')
	terminal.buffer.active.type = 'normal'
	assert.equal(addon.serialize(), '\x1b[?1006h')
})

test('tracks ordered SGR cell/pixel mode changes without consuming xterm escapes', () => {
	const { addon, emit } = harness()
	assert.equal(emit('h', [1003, 1006]), false)
	assert.equal(addon.serialize(), '\x1b[?1006h')
	emit('h', [1006, 1016])
	assert.equal(addon.serialize(), '\x1b[?1016h')
	emit('h', [1016, 1006])
	assert.equal(addon.serialize(), '\x1b[?1006h')
	// xterm resets to DEFAULT when either encoding is disabled.
	assert.equal(emit('l', [1016]), false)
	assert.equal(addon.serialize(), '')
	emit('h', [1006])
	emit('l', [1006])
	assert.equal(addon.serialize(), '')
})

test('ignores unrelated/subparameter modes; RIS clears encoding; disposal releases every parser hook', () => {
	const { addon, emit, disposed } = harness()
	emit('h', [1006])
	emit('h', [1005, 1015, [1006], 25, 7])
	emit('l', [1003, 1005, 25])
	assert.equal(addon.serialize(), '\x1b[?1006h')
	assert.equal(emit('reset'), false)
	assert.equal(addon.serialize(), '')
	emit('h', [1016])
	addon.dispose()
	assert.equal(disposed(), 3)
	assert.equal(addon.serialize(), '')
	addon.dispose()
	assert.equal(disposed(), 3)
})
