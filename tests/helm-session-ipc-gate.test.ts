import assert from 'node:assert/strict'
import test from 'node:test'
import sessionIpcGateModule from '../app/src/session-ipc-gate.ts'
const { createSessionIpcGate } = sessionIpcGateModule

test('closed session IPC admission performs no PTY, support, registry, socket, or buffer operation', () => {
	const gate = createSessionIpcGate(() => false)
	const effects: string[] = []
	const sideEffects = [
		'pty:spawn',
		'pty:write',
		'pty:resize',
		'pty:kill',
		'session:close-with-grace',
		'session:undo-close',
		'sessions:list',
		'session:set-parked',
		'session:set-order',
		'session:title',
		'session:set-custom-name',
		'tab-groups:list',
		'tab-groups:create',
		'tab-groups:rename',
		'tab-groups:delete',
		'tab-groups:set-membership',
		'tab-groups:set-collapsed',
		'tab-groups:move',
		'tab-groups:intent',
		'buffer:save',
		'buffer:read',
	]
	for (const channel of sideEffects) {
		if (channel === 'pty:spawn') {
			assert.throws(() => gate.require('old:1'), /Terminal profile changed/)
			continue
		}
		const result = gate.handle('old:1', 'closed', () => {
			effects.push(channel)
			return 'opened'
		})
		assert.equal(result, 'closed', channel)
		gate.event('old:1', () => effects.push(`${channel}:event`))
	}
	assert.deepEqual(effects, [])
})

test('current session IPC admission invokes operations exactly once', () => {
	const gate = createSessionIpcGate(token => token === 'work:2')
	let calls = 0
	assert.equal(
		gate.handle('work:2', null, () => ++calls),
		1,
	)
	gate.event('work:2', () => ++calls)
	gate.require('work:2')
	assert.equal(calls, 2)
})
