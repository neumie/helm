import assert from 'node:assert/strict'
import test from 'node:test'
import stateModule, {
	type TerminalAgentReport,
	type TerminalAgentStatus,
} from '../app/src/renderer/terminal-agent-state.ts'

const { createTerminalAgentStateTracker, encodeTerminalAgentReport } = stateModule

function report(overrides: Partial<TerminalAgentReport> = {}): TerminalAgentReport {
	return {
		v: 1,
		agent: 'pi',
		instance: 'instance_01',
		seq: 1,
		state: 'working',
		phase: { kind: 'thinking' },
		...overrides,
	}
}

function harness(staleAfterMs = 6_000) {
	let now = 1_000
	const changes: TerminalAgentStatus[] = []
	const tracker = createTerminalAgentStateTracker({
		onChange: status => changes.push(status),
		now: () => now,
		staleAfterMs,
	})
	return {
		tracker,
		changes,
		advance: (ms: number) => {
			now += ms
		},
	}
}

test('structured OSC survives arbitrary chunk boundaries and reports a bounded tool phase', () => {
	const { tracker, changes } = harness()
	const frame = encodeTerminalAgentReport(report({ seq: 2, phase: { kind: 'tool', name: 'bash', count: 1 } }), 'st')
	for (const character of frame) tracker.feed(character)
	assert.deepEqual(changes, [
		{
			agent: 'pi',
			state: 'working',
			phase: { kind: 'tool', name: 'bash', count: 1 },
			label: 'Pi is using bash',
			structured: true,
		},
	])
})

test('heartbeats are idempotent while stale and competing reports are fenced', () => {
	const { tracker, changes, advance } = harness(100)
	tracker.feed(encodeTerminalAgentReport(report({ seq: 10 })))
	tracker.feed(encodeTerminalAgentReport(report({ seq: 10, state: 'idle', phase: undefined })))
	tracker.feed(
		encodeTerminalAgentReport(
			report({ instance: 'instance_02', seq: 1, state: 'blocked', phase: { kind: 'waiting', reason: 'question' } }),
		),
	)
	assert.equal(changes.length, 1)
	advance(101)
	tracker.tick()
	assert.equal(changes.at(-1)?.state, 'unknown')
	tracker.feed(
		encodeTerminalAgentReport(
			report({ instance: 'instance_02', seq: 1, state: 'blocked', phase: { kind: 'waiting', reason: 'question' } }),
		),
	)
	assert.equal(changes.at(-1)?.label, 'Pi is waiting for an answer')
})

test('heartbeat expiry becomes unknown without inventing completion', () => {
	const { tracker, changes, advance } = harness(50)
	tracker.feed(encodeTerminalAgentReport(report()))
	advance(49)
	tracker.tick()
	assert.equal(changes.length, 1)
	advance(1)
	tracker.tick()
	assert.deepEqual(changes.at(-1), {
		agent: null,
		state: 'unknown',
		phase: null,
		label: 'Agent status unavailable',
		structured: false,
	})
})

test('explicit absence releases ownership for the next Pi instance', () => {
	const { tracker, changes } = harness()
	tracker.feed(encodeTerminalAgentReport(report({ seq: 1 })))
	tracker.feed(encodeTerminalAgentReport(report({ seq: 2, state: 'absent', phase: undefined })))
	tracker.feed(encodeTerminalAgentReport(report({ instance: 'instance_02', seq: 1, state: 'idle', phase: undefined })))
	assert.deepEqual(
		changes.map(change => change.state),
		['working', 'unknown', 'idle'],
	)
})

test('malformed, oversized, secret-bearing, and inconsistent reports are ignored', () => {
	const { tracker, changes } = harness()
	tracker.feed('\u001b]777;helm-agent-state;not_base64!\u0007')
	tracker.feed(`\u001b]777;helm-agent-state;${'a'.repeat(3000)}\u0007`)
	for (const invalid of [
		{ ...report(), phase: { kind: 'tool', name: 'bash npm test', count: 1 } },
		{ ...report(), state: 'idle', phase: { kind: 'thinking' } },
		{ ...report(), prompt: 'secret' },
	]) {
		const json = JSON.stringify(invalid)
		const encoded = Buffer.from(json).toString('base64url')
		tracker.feed(`\u001b]777;helm-agent-state;${encoded}\u0007`)
	}
	assert.deepEqual(changes, [])
})

test('labels reveal only agent, phase kind, tool name, and bounded parallel count', () => {
	const { tracker, changes } = harness()
	tracker.feed(encodeTerminalAgentReport(report({ phase: { kind: 'tool', name: 'read', count: 3 } })))
	assert.equal(changes[0]?.label, 'Pi is using 3 tools')
	assert.doesNotMatch(changes[0]?.label ?? '', /path|prompt|argument/i)
})
