import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowed, parseAllow } from '../src/cli/slack.js'
import { SlackActions, escapeSlackText, parseSlackThreadTarget } from '../src/signals/slack-actions.js'
import type { SlackSession, SlackSessionStore } from '../src/slack/session.js'
import type { SlackClient } from '../src/slack/web-api.js'

const session: SlackSession = {
	teamId: 'T1',
	token: 'xoxc',
	cookie: 'xoxd',
	name: 'Contember',
	domain: 'cntmbr',
	userId: 'UME',
}

function fakeStore(): SlackSessionStore {
	return {
		list: async () => ['T1'],
		get: async (id: string) => (id === 'T1' ? session : null),
		save: async () => undefined,
		remove: async () => undefined,
	} as unknown as SlackSessionStore
}

test('escapeSlackText escapes only & < >', () => {
	assert.equal(escapeSlackText('a & b < c > d'), 'a &amp; b &lt; c &gt; d')
})

test('parseSlackThreadTarget: DM and thread keys', () => {
	assert.deepEqual(parseSlackThreadTarget({ threadKey: 'slack:T1:D1' }), {
		teamId: 'T1',
		channel: 'D1',
		threadTs: undefined,
	})
	assert.deepEqual(parseSlackThreadTarget({ threadKey: 'slack:T1:C1:100.0' }), {
		teamId: 'T1',
		channel: 'C1',
		threadTs: '100.0',
	})
	assert.equal(parseSlackThreadTarget({ threadKey: 'github:x#1' }), null)
})

test('SlackActions.reply posts to the right channel/thread and escapes', async () => {
	const calls: { method: string; params: Record<string, unknown> }[] = []
	const client = {
		call: async (method: string, params: Record<string, unknown>) => {
			calls.push({ method, params })
			return { ok: true }
		},
	} as unknown as SlackClient
	const actions = new SlackActions({ store: fakeStore(), clientFor: () => client })
	const res = await actions.reply({ threadKey: 'slack:T1:C1:100.0' }, 'hi <there>')
	assert.equal(res.ok, true)
	assert.equal(calls[0].method, 'chat.postMessage')
	assert.equal(calls[0].params.channel, 'C1')
	assert.equal(calls[0].params.thread_ts, '100.0')
	assert.equal(calls[0].params.text, 'hi &lt;there&gt;')
})

test('SlackActions.reply refuses a non-slack thread', async () => {
	const actions = new SlackActions({ store: fakeStore(), clientFor: () => ({}) as unknown as SlackClient })
	assert.deepEqual(await actions.reply({ threadKey: 'github:x#1' }, 'hi'), { ok: false, error: 'not_a_slack_thread' })
})

// ---- send guard ----

test('parseAllow normalizes lines', () => {
	assert.deepEqual(parseAllow('  @Bob \n#General\n\nC123 '), ['@bob', '#general', 'c123'])
})

test('isAllowed matches id, @handle and #channel forms', () => {
	assert.equal(isAllowed({ user: 'UBOB' }, '@bob', ['@bob']), true)
	assert.equal(isAllowed({ channel: 'C1' }, '#general', ['general']), true)
	assert.equal(isAllowed({ user: 'UBOB' }, 'UBOB', ['ubob']), true)
	assert.equal(isAllowed({ user: 'UEVE' }, '@eve', ['@bob']), false)
})
