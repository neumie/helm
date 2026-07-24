import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import terminalTransferIpcGateModule from '../app/src/terminal-transfer-ipc-gate.ts'

const { createTerminalTransferIpcGate } = terminalTransferIpcGateModule

test('terminal transfer IPC requires both the current main renderer and exact profile token', () => {
	const mainRenderer = { id: 'main' }
	const gate = createTerminalTransferIpcGate(
		token => token === 'work:3',
		() => mainRenderer,
	)
	let calls = 0

	assert.equal(gate.allows(mainRenderer, 'work:3'), true)
	assert.equal(gate.allows({ id: 'other' }, 'work:3'), false)
	assert.equal(gate.allows(mainRenderer, 'work:2'), false)
	assert.equal(
		gate.handle({ id: 'other' }, 'work:3', 'closed', () => {
			calls += 1
			return 'opened'
		}),
		'closed',
	)
	assert.equal(
		gate.handle(mainRenderer, 'work:2', 'closed', () => {
			calls += 1
			return 'opened'
		}),
		'closed',
	)
	assert.equal(
		gate.handle(mainRenderer, 'work:3', 'closed', () => {
			calls += 1
			return 'opened'
		}),
		'opened',
	)
	assert.equal(calls, 1)
})

test('production IPC gates controller-backed transfer commands by sender and captured token', () => {
	const main = readFileSync(resolve('app/src/main.ts'), 'utf8')
	assert.match(main, /ipcMain\.handle\(\s*'terminal-transfer:preflight'/)
	assert.match(main, /ipcMain\.handle\(\s*'terminal-transfer:move'/)
	assert.match(main, /ipcMain\.handle\(\s*'terminal-transfer:ack'/)
	assert.match(main, /terminalTransferIpcGate\.handle\(\s*event\.sender,\s*profileToken/s)
	assert.match(main, /terminalTransferMain\.move\(/)
	assert.doesNotMatch(main, /sourceSocket:\s*.*event/)
	assert.doesNotMatch(main, /destinationSocket:\s*.*event/)
})
