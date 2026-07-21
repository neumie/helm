import assert from 'node:assert/strict'
import test from 'node:test'
import outputModule from '../app/src/renderer/synchronized-output.ts'

const { createSynchronizedOutputGuard } = outputModule
const START = '\x1b[?2026h'
const END = '\x1b[?2026l'

function harness() {
	const events: string[] = []
	const writes: Array<{ data: string; done?: () => void }> = []
	const guard = createSynchronizedOutputGuard({
		onFreeze: () => events.push('freeze'),
		onUnfreeze: () => events.push('unfreeze'),
	})
	const write = (data: string, done?: () => void): void => {
		writes.push({ data, ...(done ? { done } : {}) })
	}
	return { guard, events, writes, write }
}

test('keeps the previous frame frozen until a synchronized redraw has parsed', () => {
	const { guard, events, writes, write } = harness()
	guard.write(`${START}\x1b[2Jpartial`, write)
	guard.write(`history${END}`, write)

	assert.deepEqual(events, ['freeze'])
	assert.equal(writes.length, 2)
	assert.equal(writes[1].done instanceof Function, true)

	writes[1].done?.()
	assert.deepEqual(events, ['freeze', 'unfreeze'])
})

test('recognizes synchronized-output markers split across PTY chunks', () => {
	const { guard, events, writes, write } = harness()
	guard.write('\x1b[?20', write)
	guard.write('26hframe\x1b[?20', write)
	guard.write('26l', write)

	assert.deepEqual(events, ['freeze'])
	assert.equal(writes.length, 3)
	writes[2].done?.()
	assert.deepEqual(events, ['freeze', 'unfreeze'])
})

test('does not reveal an older frame completion over a newer synchronized redraw', () => {
	const { guard, events, writes, write } = harness()
	guard.write(`${START}first${END}`, write)
	guard.write(`${START}second`, write)

	writes[0].done?.()
	assert.deepEqual(events, ['freeze'])

	guard.write(`done${END}`, write)
	writes[2].done?.()
	assert.deepEqual(events, ['freeze', 'unfreeze'])
})

test('passes ordinary output through and abort releases any frozen frame', () => {
	const { guard, events, writes, write } = harness()
	guard.write('ordinary output', write)
	assert.deepEqual(
		writes.map(entry => entry.data),
		['ordinary output'],
	)
	assert.deepEqual(events, [])

	guard.write(`${START}unfinished`, write)
	guard.abort()
	assert.deepEqual(events, ['freeze', 'unfreeze'])
})

test('an idle redraw with no closing marker cannot freeze Helm forever', () => {
	const events: string[] = []
	let releaseIdle: (() => void) | undefined
	const guard = createSynchronizedOutputGuard({
		onFreeze: () => events.push('freeze'),
		onUnfreeze: () => events.push('unfreeze'),
		scheduleIdleRelease: release => {
			releaseIdle = release
			return () => {
				releaseIdle = undefined
			}
		},
	})

	guard.write(`${START}unfinished`, () => {})
	assert.deepEqual(events, ['freeze'])
	releaseIdle?.()
	assert.deepEqual(events, ['freeze', 'unfreeze'])
})
