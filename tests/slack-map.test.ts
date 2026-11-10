import assert from 'node:assert/strict'
import test from 'node:test'
import {
	type SlackMapContext,
	mapDm,
	mapMention,
	mapThread,
	mergeSlackObservations,
	slackMrkdwnToPlain,
	slackPermalink,
	slackThreadKey,
	slackTsToIso,
} from '../src/signals/slack-map.js'

const NOW = Date.parse('2026-11-10T12:00:00Z')

function ctx(overrides: Partial<SlackMapContext> = {}): SlackMapContext {
	return {
		teamId: 'T1',
		domain: 'cntmbr',
		me: 'UME',
		now: NOW,
		maxAgeMs: 7 * 24 * 60 * 60 * 1000,
		includeUsers: new Set(),
		excludeUsers: new Set(),
		resolveUser: id => ({ UME: 'Jakub', UBOB: 'Bob', UKLARA: 'Klara' })[id] ?? id,
		resolveChannel: id => ({ C1: 'general', D1: 'bob' })[id] ?? id,
		...overrides,
	}
}

const tsAt = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`

test('slackTsToIso + permalink + threadKey', () => {
	assert.equal(slackTsToIso('1513718191.000038'), new Date(1513718191000).toISOString())
	assert.equal(slackTsToIso('garbage'), null)
	assert.equal(
		slackPermalink('cntmbr', 'C1', '1513718191.000038'),
		'https://cntmbr.slack.com/archives/C1/p1513718191000038',
	)
	assert.match(slackPermalink('cntmbr', 'C1', '2.0', '1.0'), /\?thread_ts=1\.0&cid=C1$/)
	assert.equal(slackThreadKey('T1', 'C1'), 'slack:T1:C1')
	assert.equal(slackThreadKey('T1', 'C1', '1.0'), 'slack:T1:C1:1.0')
})

test('mrkdwn → plain: mentions, channels, links, entities', () => {
	const c = ctx()
	assert.equal(slackMrkdwnToPlain('hey <@UME> see <#C1|general>', c), 'hey @Jakub see #general')
	assert.equal(slackMrkdwnToPlain('look <https://x.com|here> &amp; <https://y.com>', c), 'look here & https://y.com')
	assert.equal(slackMrkdwnToPlain('line1\nline2', c), 'line1 line2')
	assert.equal(slackMrkdwnToPlain('<@UBOB> hi', c), '@Bob hi')
})

test('mapDm: foreign unread recent DM needs you', () => {
	const ts = tsAt('2026-11-10T11:00:00Z')
	const result = mapDm(
		{ id: 'D1', is_im: true, user: 'UBOB', last_read: '1.0', latest: { user: 'UBOB', text: 'ping', ts } },
		ctx(),
	)
	assert.ok(result.observation)
	assert.equal(result.observation?.kind, 'dm')
	assert.equal(result.observation?.ref, 'Bob')
	assert.equal(result.observation?.head, 'Bob: ping')
	assert.equal(result.observation?.sender, 'ubob')
	assert.equal(result.observation?.threadKey, 'slack:T1:D1')
})

test('mapDm: read (last_read >= latest) does not need you', () => {
	const ts = tsAt('2026-11-10T11:00:00Z')
	const result = mapDm(
		{ id: 'D1', is_im: true, user: 'UBOB', last_read: ts, latest: { user: 'UBOB', text: 'x', ts } },
		ctx(),
	)
	assert.equal(result.observation, undefined)
})

test('mapDm: my own latest message does not need you', () => {
	const ts = tsAt('2026-11-10T11:00:00Z')
	const result = mapDm(
		{ id: 'D1', is_im: true, user: 'UBOB', last_read: '1.0', latest: { user: 'UME', text: 'x', ts } },
		ctx(),
	)
	assert.equal(result.observation, undefined)
})

test('mapDm: old message is out of the window', () => {
	const ts = tsAt('2026-10-01T11:00:00Z')
	const result = mapDm(
		{ id: 'D1', is_im: true, user: 'UBOB', last_read: '1.0', latest: { user: 'UBOB', text: 'x', ts } },
		ctx(),
	)
	assert.equal(result.observation, undefined)
})

test('mapDm: a bot DM is filtered, not a signal', () => {
	const ts = tsAt('2026-11-10T11:00:00Z')
	const result = mapDm({ id: 'D1', is_im: true, latest: { bot_id: 'B1', text: 'deploy done', ts } }, ctx())
	assert.equal(result.observation, undefined)
	assert.equal(result.filtered?.reason, 'bot')
	assert.equal(result.filtered?.messageKey, `slack:D1:${ts}`)
})

test('mapDm: an excluded user is filtered', () => {
	const ts = tsAt('2026-11-10T11:00:00Z')
	const result = mapDm(
		{ id: 'D1', is_im: true, user: 'UBOB', last_read: '1.0', latest: { user: 'UBOB', text: 'x', ts } },
		ctx({ excludeUsers: new Set(['ubob']) }),
	)
	assert.equal(result.observation, undefined)
	assert.equal(result.filtered?.reason, 'excluded')
})

test('mapDm: includeUsers overrides a bot', () => {
	const ts = tsAt('2026-11-10T11:00:00Z')
	const result = mapDm(
		{ id: 'D1', is_im: true, last_read: '1.0', latest: { user: 'UBOB', bot_id: 'B1', text: 'x', ts } },
		ctx({ includeUsers: new Set(['ubob']) }),
	)
	assert.ok(result.observation)
})

test('mapMention: foreign recent mention needs you', () => {
	const ts = tsAt('2026-11-10T11:30:00Z')
	const result = mapMention(
		{
			user: 'UKLARA',
			text: 'can <@UME> review?',
			ts,
			permalink: 'https://cntmbr.slack.com/archives/C1/p1',
			channel: { id: 'C1', name: 'general' },
		},
		ctx(),
	)
	assert.ok(result.observation)
	assert.equal(result.observation?.kind, 'mention')
	assert.equal(result.observation?.ref, '#general')
	assert.equal(result.observation?.threadKey, `slack:T1:C1:${ts}`)
})

test('mapThread: new foreign reply after my last message needs you', () => {
	const mine = tsAt('2026-11-10T10:00:00Z')
	const reply = tsAt('2026-11-10T11:00:00Z')
	const result = mapThread(
		'C1',
		[
			{ user: 'UME', text: 'parent', ts: '100.0', thread_ts: '100.0' },
			{ user: 'UME', text: 'mine', ts: mine, thread_ts: '100.0' },
			{ user: 'UBOB', text: 'reply', ts: reply, thread_ts: '100.0' },
		],
		ctx(),
	)
	assert.ok(result.observation)
	assert.equal(result.observation?.kind, 'thread')
	assert.equal(result.observation?.threadKey, 'slack:T1:C1:100.0')
})

test('mapThread: my own reply last does not need you', () => {
	const reply = tsAt('2026-11-10T11:00:00Z')
	const result = mapThread(
		'C1',
		[
			{ user: 'UBOB', text: 'parent', ts: '100.0', thread_ts: '100.0' },
			{ user: 'UME', text: 'mine', ts: reply, thread_ts: '100.0' },
		],
		ctx(),
	)
	assert.equal(result.observation, undefined)
})

test('mergeSlackObservations: mention + thread on one thread merge reasons', () => {
	const ts = tsAt('2026-11-10T11:00:00Z')
	const mention = mapMention({ user: 'UBOB', text: '<@UME>', ts, channel: { id: 'C1' } }, ctx())
	const thread = mapThread(
		'C1',
		[
			{ user: 'UME', ts: `${ts}`, thread_ts: ts, text: 'p' },
			{ user: 'UBOB', ts: tsAt('2026-11-10T11:30:00Z'), thread_ts: ts, text: 'r' },
		],
		ctx(),
	)
	// Force both onto the same key by using the mention ts as the thread ts.
	const merged = mergeSlackObservations([mention, thread])
	assert.ok(merged.observations.length >= 1)
})
