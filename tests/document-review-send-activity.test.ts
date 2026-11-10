import assert from 'node:assert/strict'
import { test } from 'node:test'
import sendActivityModule from '../app/src/renderer/document-review/send-activity'
import type { LastSend } from '../app/src/renderer/document-review/send-activity'
import type { ReviewActivity, ReviewReceipt, ReviewSession } from '../src/document-review/types.js'
const { deriveSendActivity, activityElapsed, activityTokens, activityWords } = sendActivityModule

const ID = '6a4c4d8e-2c8b-4f43-9a55-7c1b5d0f9e11'
const last = (overrides: Partial<LastSend> = {}): LastSend => ({
	id: ID,
	scope: 'whole',
	passage: null,
	at: 1000,
	failed: null,
	...overrides,
})
const session = (overrides: Partial<ReviewSession> = {}): ReviewSession => ({
	id: 'review:one',
	owner: 'owner',
	provider: 'claude',
	name: 'Document conversation',
	capabilities: {
		transport: 'tool-return',
		continuation: 'live-session',
		readOnlyPolicy: 'session-owned',
		interactiveQuestions: true,
		interrupt: 'unsupported',
		providerAcknowledgement: false,
		minimumVersion: null,
	},
	state: 'waiting',
	listening: false,
	busy: true,
	needsAcknowledgement: false,
	messages: [{ id: `${ID}:user`, role: 'user', text: 'Tighten it.', at: 1010 }],
	error: null,
	historyTruncated: false,
	...overrides,
})
const receipt = (outcome: ReviewReceipt['outcome'], extra: Partial<ReviewReceipt> = {}): ReviewReceipt => ({
	id: ID,
	outcome,
	detail: 'detail',
	sentAt: 1010,
	...extra,
})
const running = { id: ID, phase: 'running' as const }
const derive = (input: Partial<Parameters<typeof deriveSendActivity>[0]>) =>
	deriveSendActivity({
		last: last(),
		operation: running,
		receipt: null,
		session: session(),
		activity: null,
		agent: 'Claude Code',
		...input,
	})

test('nothing is said before this window sends', () => {
	assert.equal(derive({ last: null }), null)
})

test('sending until the host has handed it over; received once the waiting tool acknowledged', () => {
	assert.equal(derive({ operation: { id: ID, phase: 'sending' } })?.phase, 'sending')
	assert.equal(derive({ receipt: receipt('pending') })?.phase, 'sending')
	const received = derive({ receipt: receipt('dispatched') })
	assert.equal(received?.phase, 'received')
	// Host time replaces the window clock as soon as the host says.
	assert.equal(received?.sentAt, 1010)
	assert.equal(derive({})?.sentAt, 1000)
	assert.equal(received?.verb, null)
	assert.equal(received?.outputTokens, null)
})

test('working needs evidence: a Pi working report, or activity bound to this exact request', () => {
	assert.equal(derive({ receipt: receipt('dispatched'), session: session({ state: 'working' }) })?.phase, 'working')
	assert.equal(derive({ receipt: receipt('dispatched'), session: session({ state: 'working' }) })?.verb, 'Thinking')
	const bound: ReviewActivity = {
		sessionId: 'review:one',
		requestId: ID,
		working: true,
		verb: 'Editing',
		outputTokens: 16_300,
	}
	const working = derive({ receipt: receipt('dispatched'), activity: bound })
	assert.equal(working?.phase, 'working')
	assert.equal(working?.verb, 'Editing')
	assert.equal(working?.outputTokens, 16_300)
	assert.equal(working?.bound, true)
	// Another request's or another caller's activity is never borrowed.
	for (const foreign of [
		{ ...bound, requestId: '00000000-0000-4000-8000-000000000000' },
		{ ...bound, sessionId: 'review:two' },
	]) {
		const view = derive({ receipt: receipt('dispatched'), activity: foreign })
		assert.equal(view?.phase, 'received')
		assert.equal(view?.bound, false)
		assert.equal(view?.outputTokens, null)
	}
	// Bound but not working (the turn ended without a reply): elapsed only, no claim of work.
	assert.equal(derive({ receipt: receipt('dispatched'), activity: { ...bound, working: false } })?.phase, 'received')
})

test('replied needs a clean settle the window saw, keeps the host settle time and stays until the next send', () => {
	const reply = session({
		state: 'idle',
		busy: false,
		messages: [
			{ id: `${ID}:user`, role: 'user', text: 'Tighten it.', at: 1010 },
			{ id: `${ID}:assistant`, role: 'assistant', text: 'Done.', at: 186_000 },
		],
	})
	const clean = last({ settled: { outcome: 'replied', at: 186_020 } })
	const replied = derive({
		last: clean,
		operation: null,
		receipt: receipt('dispatched', { settledAt: 186_010 }),
		session: reply,
	})
	assert.equal(replied?.phase, 'replied')
	assert.equal(replied?.endedAt, 186_010)
	assert.equal(activityElapsed((replied?.endedAt ?? 0) - (replied?.sentAt ?? 0)), '3m 5s')
	// Without the receipt the window's own settle record times it, never the first partial text.
	assert.equal(derive({ last: clean, operation: null, receipt: null, session: reply })?.endedAt, 186_020)
	assert.equal(derive({ operation: null, receipt: receipt('dispatched') }), null)
	// An assistant message alone (a working report with partial text) is not a reply.
	assert.equal(derive({ operation: null, receipt: null, session: reply }), null)
	// Not confirmed, then acknowledged: no line at all, never "Replied after".
	assert.equal(
		derive({
			last: last({ settled: { outcome: 'unconfirmed', at: null } }),
			operation: null,
			receipt: null,
			session: reply,
		}),
		null,
	)
})

test('a refusal is not sent; a lost or uncertain outcome is not confirmed', () => {
	const refused = derive({ last: last({ failed: { reason: 'The agent is not listening.', restored: true } }) })
	assert.equal(refused?.phase, 'not-sent')
	assert.equal(refused?.reason, 'The agent is not listening.')
	assert.equal(refused?.restored, true)
	assert.equal(derive({ operation: { id: ID, phase: 'uncertain' } })?.phase, 'unconfirmed')
	assert.equal(derive({ receipt: receipt('unknown') })?.phase, 'unconfirmed')
	assert.equal(derive({ session: session({ error: 'Needs attention' }) })?.phase, 'unconfirmed')
})

test('the screen-reader status changes with the phase or the verb, never with the clock', () => {
	const words = (input: Partial<Parameters<typeof deriveSendActivity>[0]>) => {
		const view = derive(input)
		assert.ok(view)
		return activityWords(view)
	}
	assert.deepEqual(words({ receipt: receipt('dispatched') }), { verb: 'With Claude Code', status: 'With Claude Code' })
	assert.deepEqual(words({ operation: { id: ID, phase: 'sending' } }), {
		verb: 'Sending to Claude Code',
		status: 'Sending to Claude Code',
	})
	assert.deepEqual(words({ receipt: receipt('dispatched'), session: session({ state: 'working' }) }), {
		verb: 'Thinking',
		status: 'Claude Code: Thinking',
	})
})

test('elapsed and token spellings follow Claude Code', () => {
	assert.equal(activityElapsed(-5), '0s')
	assert.equal(activityElapsed(12_900), '12s')
	assert.equal(activityElapsed(177_000), '2m 57s')
	assert.equal(activityElapsed(3_840_000), '1h 4m')
	assert.equal(activityTokens(812), '812')
	assert.equal(activityTokens(16_300), '16.3k')
	assert.equal(activityTokens(2000), '2k')
	assert.equal(activityTokens(999_960), '1m')
	assert.equal(activityTokens(1_250_000), '1.3m')
})
