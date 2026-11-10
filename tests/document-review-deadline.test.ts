import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import sessionsModule from '../app/src/document-review/sessions'
import type { ReviewFeedback } from '../src/document-review/types.js'
const { ReviewSessions, wireReceipt } = sessionsModule

const DEADLINE = 1000
const CAP = 2500

/** A delivered, confirmed request on a fresh mailbox; time is the mocked clock from 0. */
function delivered(transport: 'tool-return' | 'in-process' = 'in-process') {
	const sessions = new ReviewSessions(() => {}, DEADLINE, 10000, CAP)
	const session = sessions.connect(transport === 'in-process' ? 'pi' : 'claude', '/w', 'Conversation', transport)
	const listening = sessions.next(session.id, session.owner, 60000, new AbortController().signal)
	const owner = sessions.reserve(session.id, session.owner, '/w')
	const id = randomUUID()
	const feedback: ReviewFeedback = {
		request: {
			id,
			documentId: randomUUID(),
			revision: 'r1',
			sessionId: session.id,
			owner: session.owner,
			intent: 'discuss',
			instruction: 'Tighten the second section.',
			passage: null,
		},
		prompt: 'Tighten the second section.',
		relativePath: 'spec.md',
	}
	const sent = sessions.dispatch(owner, id, 'fingerprint', feedback)
	sessions.confirm(session.id, session.owner, id)
	const report = (sequence: number, state: 'working' | 'complete' | 'error', text = '') =>
		sessions.report(session.id, session.owner, id, sequence, state, text)
	const receipt = () => sessions.receipt(id, session.id)
	return { sessions, session, id, sent, report, receipt, listening }
}

test('a working report renews the completion deadline, and a reply inside the renewed deadline is accepted', async t => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
	const f = delivered()
	t.mock.timers.tick(900)
	f.report(0, 'working')
	t.mock.timers.tick(900) // 1800: past the original 1000 ms deadline, inside the renewed one (1900)
	assert.equal(f.receipt()?.outcome, 'dispatched')
	f.report(1, 'complete', 'Done.')
	const receipt = f.receipt()
	assert.equal(receipt?.outcome, 'dispatched')
	assert.equal(receipt?.sentAt, 0)
	assert.equal(receipt?.settledAt, 1800)
	const snapshot = f.sessions.list('/w')[0]
	assert.equal(snapshot?.busy, false)
	assert.equal(snapshot?.needsAcknowledgement, false)
	assert.deepEqual(
		snapshot?.messages.map(message => [message.role, message.at]),
		[
			['user', 0],
			['assistant', 1800],
		],
	)
	await f.listening
})

test('without a working report the original deadline still applies', async t => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
	const f = delivered('tool-return')
	t.mock.timers.tick(DEADLINE)
	assert.equal(f.receipt()?.outcome, 'unknown')
	assert.equal(f.receipt()?.settledAt, DEADLINE)
	assert.throws(() => f.report(0, 'complete', 'Too late.'), /Only confirmed, current feedback/)
	await f.listening
})

test('renewal never passes the cap: a looping working caller still ends unknown, and nothing is replayed', async t => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
	const f = delivered()
	let sequence = 0
	for (let at = 0; at < CAP; at += 600) {
		f.report(sequence++, 'working')
		t.mock.timers.tick(Math.min(600, CAP - at))
	}
	// 2500 = delivery + cap, even though the latest working report was at 2400.
	assert.equal(f.receipt()?.outcome, 'unknown')
	assert.equal(f.receipt()?.settledAt, CAP)
	const snapshot = f.sessions.list('/w')[0]
	assert.equal(snapshot?.needsAcknowledgement, true)
	assert.equal(snapshot?.busy, false)
	assert.throws(() => f.report(sequence, 'complete', 'Late reply.'), /Only confirmed, current feedback/)
	// The uncertain request is never offered again: a new read refuses until the operator acknowledges.
	await assert.rejects(
		f.sessions.next(f.session.id, f.session.owner, 1000, new AbortController().signal),
		/unresolved feedback/,
	)
	await f.listening
})

test('an ignored (lower) or repeated report sequence does not renew the deadline', async t => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
	const f = delivered()
	t.mock.timers.tick(500)
	f.report(2, 'working') // renews to 1500
	t.mock.timers.tick(400)
	f.report(1, 'working') // lower: ignored
	f.report(2, 'working') // same contents: ignored
	t.mock.timers.tick(599) // 1499
	assert.equal(f.receipt()?.outcome, 'dispatched')
	t.mock.timers.tick(1) // 1500
	assert.equal(f.receipt()?.outcome, 'unknown')
	await f.listening
})

test('the control wire receipt stays the strict v1 shape, byte for byte', () => {
	mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 42 })
	try {
		const f = delivered()
		f.report(0, 'complete', 'Done.')
		const host = f.receipt()
		assert.equal(host?.sentAt, 42)
		assert.equal(host?.settledAt, 42)
		assert.equal(
			JSON.stringify(wireReceipt(host)),
			JSON.stringify({
				id: f.id,
				outcome: 'dispatched',
				detail: 'Dispatched to the existing caller. This does not prove provider acceptance or a file edit.',
			}),
		)
		assert.equal(wireReceipt(null), null)
		// The renderer's own send result still carries the host time it was handed over.
		assert.equal(f.sent.sentAt, 42)
	} finally {
		mock.timers.reset()
	}
})
