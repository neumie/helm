import assert from 'node:assert/strict'
import test from 'node:test'
import equality from '../app/src/renderer/remote/remote-poll-equality.js'
import { remoteDetailSchema, remoteDirectorySchema } from '../src/remote/protocol.js'

const snapshot = {
	target: {
		sessionId: '11111111-1111-7111-8111-111111111111',
		incarnation: '22222222-2222-4222-8222-222222222222',
		scopeId: null,
		generation: 1,
	},
	revision: 0,
	label: 'Fixture',
	workspace: 'Fixture',
	model: null,
	activity: 'idle',
	capabilities: { prompt: true, interrupt: true, answer: false },
	connected: true,
	question: null,
	messages: [],
	historyTruncated: false,
	subagents: { availability: 'available', coverage: 'limited', active: true },
	subagentsFreshForMs: 100,
}
const detail = () =>
	remoteDetailSchema.parse({ protocol: 1, hostEpoch: snapshot.target.incarnation, resync: true, snapshot })

test('detail equality ignores only lease metadata, not source activity, owner or native authority', () => {
	const a = detail()
	const b = detail()
	b.snapshot.subagentsFreshForMs = 500
	assert.equal(equality.sameRemoteDetail(a, b), true)
	for (const mutate of [
		(value: typeof b) => {
			value.snapshot.subagents = { availability: 'available', coverage: 'limited', active: false }
		},
		(value: typeof b) => {
			value.snapshot.connected = false
		},
		(value: typeof b) => {
			value.snapshot.capabilities.interrupt = false
		},
		(value: typeof b) => {
			value.hostEpoch = snapshot.target.sessionId
		},
		(value: typeof b) => {
			value.snapshot.revision++
		},
	]) {
		const changed = detail()
		mutate(changed)
		assert.equal(equality.sameRemoteDetail(a, changed), false)
	}
})

test('directory equality ignores TTL but includes source-only activity changes', () => {
	const { question: _question, messages: _messages, ...row } = detail().snapshot
	const a = remoteDirectorySchema.parse({
		protocol: 1,
		hostEpoch: snapshot.target.incarnation,
		overlayStamp: 'fixture',
		sessions: [row],
	})
	const b = structuredClone(a)
	b.sessions[0].subagentsFreshForMs = 500
	assert.equal(equality.sameRemoteDirectory(a, b), true)
	b.sessions[0].subagents = undefined
	assert.equal(equality.sameRemoteDirectory(a, b), false)
})
