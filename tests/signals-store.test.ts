import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DB } from '../src/db/client.js'
import type { SignalObservation, SignalPollResult } from '../src/signals/contract.js'
import { SIGNAL_EVENT_RETENTION, SignalInvalidError, SignalNotFoundError } from '../src/signals/store.js'

const T0 = new Date('2026-11-05T10:00:00.000Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)

function withDb(run: (db: DB) => void) {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-store-'))
	const db = new DB(join(root, 'helm.db'), 'alpha')
	try {
		run(db)
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
}

function github(number: number, patch: Partial<SignalObservation> = {}): SignalObservation {
	return {
		threadKey: `github:acme/widgets#${number}`,
		source: 'github',
		kind: 'review',
		reasons: ['review'],
		ref: `widgets#${number}`,
		fullRef: `acme/widgets#${number}`,
		title: `Fix the widget ${number}`,
		head: 'review requested · reviewer-a',
		actor: 'reviewer-a',
		url: `https://github.com/acme/widgets/pull/${number}`,
		repo: 'acme/widgets',
		number,
		branch: `fix/widget-${number}`,
		activityKey: `review:${T0.toISOString()}:1`,
		lastActivityAt: T0.toISOString(),
		...patch,
	}
}

function poll(observations: SignalObservation[], complete = true): SignalPollResult {
	return { source: 'github', observations, complete, goneReason: 'no longer open or requested' }
}

test('creates threads as new and Jakub-owned, dedupes by thread key, isolates profiles', () => {
	withDb(db => {
		const counts = db.signals.applyPoll(poll([github(1), github(1, { head: 'later duplicate' }), github(2)]), T0)
		assert.deepEqual(counts, { created: 2, renewed: 0, gone: 0 })
		const threads = db.signals.list({}, T0)
		assert.equal(threads.length, 2)
		const first = db.signals.getByThreadKey('github:acme/widgets#1')
		assert.ok(first)
		assert.equal(first.state, 'new')
		assert.equal(first.owner, 'jakub')
		assert.equal(first.active, true)
		assert.deepEqual(first.reasons, ['review'])
		assert.equal(first.number, 1)
		assert.equal(first.createdAt, T0.toISOString())

		const again = db.signals.applyPoll(poll([github(1), github(2)]), at(1))
		assert.deepEqual(again, { created: 0, renewed: 0, gone: 0 })
		assert.equal(db.signals.list({}, at(1)).length, 2)

		const beta = db.forProfile('beta').signals
		assert.deepEqual(beta.list({}, T0), [])
		assert.equal(beta.get(first.id), null)
		assert.equal(beta.latestSeq(), 0)
		assert.throws(() => beta.update(first.id, { state: 'done' }, T0), SignalNotFoundError)
	})
})

test('sanitizes untrusted heads and refuses unsafe links', () => {
	withDb(db => {
		db.signals.applyPoll(
			poll([
				github(1, {
					title: `Evil\u202e title\u0007 with\nnewline ${'x'.repeat(400)}`,
					head: '\u2066spoof\u2069 head',
					url: 'javascript:alert(1)',
				}),
				github(2, { url: 'http://github.com/acme/widgets/pull/2' }),
				github(3, { source: 'mail' }),
				github(4, { lastActivityAt: 'not a time' }),
				github(5, { url: 'message://%3Cabc%40example.com%3E', number: -3 }),
			]),
			T0,
		)
		const one = db.signals.getByThreadKey('github:acme/widgets#1')
		assert.ok(one)
		assert.ok(!['\u202e', '\u0007', '\n', '\u2066', '\u2069'].some(char => (one.title + one.head).includes(char)))
		assert.ok(one.title.length <= 300)
		assert.ok(one.title.endsWith('…'))
		assert.equal(one.head, 'spoof head')
		assert.equal(one.url, null)
		assert.equal(db.signals.getByThreadKey('github:acme/widgets#2')?.url, null)
		assert.equal(db.signals.getByThreadKey('github:acme/widgets#3'), null, 'wrong source is dropped')
		assert.equal(db.signals.getByThreadKey('github:acme/widgets#4'), null, 'bad time is dropped')
		const five = db.signals.getByThreadKey('github:acme/widgets#5')
		assert.equal(five?.url, 'message://%3Cabc%40example.com%3E')
		assert.equal(five?.number, null)
	})
})

test('new again only on a changed activity key with newer foreign activity', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1)]), T0)
		const thread = db.signals.getByThreadKey('github:acme/widgets#1')
		assert.ok(thread)
		db.signals.update(thread.id, { state: 'seen' }, at(1))

		// Same activity, new heads: refreshed, still seen.
		db.signals.applyPoll(poll([github(1, { title: 'Renamed' })]), at(2))
		assert.equal(db.signals.get(thread.id)?.state, 'seen')
		assert.equal(db.signals.get(thread.id)?.title, 'Renamed')

		// Changed key but not newer: key stored, state kept.
		const counts = db.signals.applyPoll(poll([github(1, { activityKey: 'other' })]), at(3))
		assert.equal(counts.renewed, 0)
		assert.equal(db.signals.get(thread.id)?.state, 'seen')

		// Changed key and newer: new again with an activity event.
		const later = at(10).toISOString()
		const renewed = db.signals.applyPoll(
			poll([
				github(1, {
					kind: 'comments',
					reasons: ['comments', 'review'],
					head: '2 comments · bob',
					activityKey: 'c:2',
					lastActivityAt: later,
				}),
			]),
			at(11),
		)
		assert.equal(renewed.renewed, 1)
		const fresh = db.signals.get(thread.id)
		assert.equal(fresh?.state, 'new')
		assert.equal(fresh?.kind, 'comments')
		assert.deepEqual(fresh?.reasons, ['comments', 'review'])
		assert.equal(fresh?.lastActivityAt, later)
		const activity = db.signals.events(0).filter(event => event.type === 'activity')
		assert.equal(activity.length, 1)
		assert.deepEqual(activity[0]?.detail, { owner: 'jakub', kind: 'comments', head: '2 comments · bob', state: 'new' })
	})
})

test('done and snoozed threads reopen on newer activity', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1), github(2)]), T0)
		const one = db.signals.getByThreadKey('github:acme/widgets#1')
		const two = db.signals.getByThreadKey('github:acme/widgets#2')
		assert.ok(one && two)
		db.signals.update(one.id, { state: 'done' }, at(1))
		db.signals.update(two.id, { state: 'snoozed', snoozedUntil: at(600).toISOString() }, at(1))
		db.signals.applyPoll(
			poll([
				github(1, { activityKey: 'k2', lastActivityAt: at(5).toISOString() }),
				github(2, { activityKey: 'k2', lastActivityAt: at(5).toISOString() }),
			]),
			at(6),
		)
		assert.equal(db.signals.get(one.id)?.state, 'new')
		const woken = db.signals.get(two.id)
		assert.equal(woken?.state, 'new')
		assert.equal(woken?.snoozedUntil, null)
	})
})

test('auto-closes after two complete misses, never on incomplete polls, never managed threads', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1), github(2), github(3), github(4)]), T0)
		const ids = [1, 2, 3, 4].map(n => db.signals.getByThreadKey(`github:acme/widgets#${n}`)?.id ?? 0)
		db.signals.update(ids[1] ?? 0, { owner: 'managed', managedBy: 'agent-a' }, at(1))
		db.signals.update(ids[2] ?? 0, { state: 'snoozed', snoozedUntil: at(9_000).toISOString() }, at(1))

		// Incomplete polls never count as misses.
		db.signals.applyPoll(poll([], false), at(2))
		db.signals.applyPoll(poll([], false), at(3))
		assert.equal(db.signals.get(ids[0] ?? 0)?.active, true)

		const first = db.signals.applyPoll(poll([github(4)]), at(4))
		assert.equal(first.gone, 0)
		assert.equal(db.signals.get(ids[0] ?? 0)?.state, 'new')
		const second = db.signals.applyPoll(poll([github(4)]), at(5))
		assert.equal(second.gone, 3)

		const closed = db.signals.get(ids[0] ?? 0)
		assert.equal(closed?.active, false)
		assert.equal(closed?.state, 'done')
		assert.equal(closed?.closedReason, 'no longer open or requested')
		const managed = db.signals.get(ids[1] ?? 0)
		assert.equal(managed?.active, false)
		assert.equal(managed?.state, 'new', 'managed threads are never auto-closed')
		assert.equal(managed?.owner, 'managed')
		assert.equal(db.signals.get(ids[2] ?? 0)?.state, 'snoozed', 'only new/seen threads close')
		assert.equal(db.signals.get(ids[3] ?? 0)?.active, true)
		const gone = db.signals.events(0).filter(event => event.type === 'gone')
		assert.equal(gone.length, 3)
		assert.equal(gone.find(event => event.threadId === ids[0])?.detail.state, 'done')

		// A thread reported again between misses resets its count.
		db.signals.applyPoll(poll([github(1), github(4)]), at(6))
		db.signals.applyPoll(poll([github(4)]), at(7))
		db.signals.applyPoll(poll([github(1), github(4)]), at(8))
		db.signals.applyPoll(poll([github(4)]), at(9))
		assert.equal(db.signals.get(ids[0] ?? 0)?.active, true)
	})
})

test('a thread that reappears without newer activity is restored as seen', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1)]), T0)
		const id = db.signals.getByThreadKey('github:acme/widgets#1')?.id ?? 0
		db.signals.applyPoll(poll([]), at(1))
		db.signals.applyPoll(poll([]), at(2))
		assert.equal(db.signals.get(id)?.state, 'done')
		db.signals.applyPoll(poll([github(1)]), at(3))
		const back = db.signals.get(id)
		assert.equal(back?.active, true)
		assert.equal(back?.state, 'seen')
		assert.equal(back?.closedReason, null)

		// A thread Jakub dismissed himself stays done when it reappears unchanged.
		db.signals.update(id, { state: 'done' }, at(4))
		db.signals.applyPoll(poll([]), at(5))
		db.signals.applyPoll(poll([]), at(6))
		db.signals.applyPoll(poll([github(1)]), at(7))
		assert.equal(db.signals.get(id)?.state, 'done')
		assert.equal(db.signals.get(id)?.active, true)
	})
})

test('snoozed threads wake at their time', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1)]), T0)
		const id = db.signals.getByThreadKey('github:acme/widgets#1')?.id ?? 0
		db.signals.update(id, { state: 'snoozed', snoozedUntil: at(30).toISOString() }, at(1))
		assert.equal(db.signals.wakeSnoozed(at(29)), 0)
		assert.equal(db.signals.get(id)?.state, 'snoozed')
		assert.equal(db.signals.wakeSnoozed(at(30)), 1)
		assert.equal(db.signals.get(id)?.state, 'new')
		assert.equal(db.signals.get(id)?.snoozedUntil, null)
		assert.deepEqual(db.signals.events(0).at(-1)?.detail, { owner: 'jakub', from: 'snoozed', to: 'new' })
	})
})

test('update validates snooze times and emits events only for real changes', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1)]), T0)
		const id = db.signals.getByThreadKey('github:acme/widgets#1')?.id ?? 0
		const seq = db.signals.latestSeq()
		assert.throws(() => db.signals.update(id, { state: 'snoozed' }, at(1)), SignalInvalidError)
		assert.throws(
			() => db.signals.update(id, { state: 'snoozed', snoozedUntil: at(0).toISOString() }, at(1)),
			SignalInvalidError,
		)
		assert.throws(() => db.signals.update(999, { state: 'seen' }, at(1)), SignalNotFoundError)

		const unchanged = db.signals.update(id, { state: 'new', owner: 'jakub' }, at(1))
		assert.equal(unchanged.updatedAt, T0.toISOString())
		assert.equal(db.signals.latestSeq(), seq)

		const snoozed = db.signals.update(id, { state: 'snoozed', snoozedUntil: '2026-11-06T09:00:00+01:00' }, at(1))
		assert.equal(snoozed.snoozedUntil, '2026-11-06T08:00:00.000Z')
		const managed = db.signals.update(id, { state: 'seen', owner: 'managed', managedBy: 'agent-b' }, at(2))
		assert.equal(managed.snoozedUntil, null)
		assert.equal(managed.managedBy, 'agent-b')
		const types = db.signals.events(seq).map(event => [event.type, event.detail])
		assert.deepEqual(types, [
			['state', { owner: 'jakub', from: 'new', to: 'snoozed' }],
			['owner', { owner: 'managed', from: 'jakub', to: 'managed' }],
			['state', { owner: 'managed', from: 'snoozed', to: 'seen' }],
		])
		assert.equal(db.signals.update(id, { managedBy: null }, at(3)).managedBy, null)
	})
})

test('notes, routing and seen', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1)]), T0)
		const id = db.signals.getByThreadKey('github:acme/widgets#1')?.id ?? 0
		const noted = db.signals.setNote(id, ' replied in the thread\n', at(1))
		assert.equal(noted.note, 'replied in the thread')
		assert.equal(noted.noteAt, at(1).toISOString())
		assert.throws(() => db.signals.setNote(id, '\u0007 ', at(1)), SignalInvalidError)

		const routed = db.signals.setRouted(id, { agent: 'widget-fix', how: 'sent' }, at(2))
		assert.equal(routed.state, 'seen')
		assert.equal(routed.routedAgent, 'widget-fix')
		assert.equal(routed.routedHow, 'sent')
		assert.equal(routed.routedAt, at(2).toISOString())

		db.signals.update(id, { state: 'new' }, at(3))
		assert.equal(db.signals.markSeen(id, at(4)).state, 'seen')
		const seq = db.signals.latestSeq()
		assert.equal(db.signals.markSeen(id, at(5)).state, 'seen')
		assert.equal(db.signals.latestSeq(), seq, 'marking a seen thread seen is a no-op')

		const types = db.signals.events(0).map(event => event.type)
		assert.deepEqual(types, ['created', 'note', 'routed', 'state', 'state'])
		assert.deepEqual(db.signals.events(0)[2]?.detail, {
			owner: 'jakub',
			agent: 'widget-fix',
			how: 'sent',
			state: 'seen',
		})
	})
})

test('events page from a cursor and the default list hides old done threads', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1), github(2), github(3)]), T0)
		const all = db.signals.events(0)
		assert.equal(all.length, 3)
		assert.ok(all.every(event => event.type === 'created'))
		assert.deepEqual(
			db.signals.events(all[0]?.seq ?? 0, 1).map(event => event.seq),
			[all[1]?.seq],
		)
		assert.equal(db.signals.latestSeq(), all[2]?.seq)

		const id = db.signals.getByThreadKey('github:acme/widgets#1')?.id ?? 0
		db.signals.update(id, { state: 'done' }, T0)
		const eightDays = at(8 * 24 * 60)
		assert.equal(db.signals.list({}, eightDays).length, 2)
		assert.equal(db.signals.list({ includeAllDone: true }, eightDays).length, 3)
		assert.equal(db.signals.list({ states: ['done'] }, eightDays).length, 1)
		assert.equal(db.signals.list({ states: ['new'], owner: 'jakub', source: 'github' }, eightDays).length, 2)
		assert.equal(db.signals.list({ source: 'mail' }, eightDays).length, 0)

		// Newest activity first.
		db.signals.applyPoll(poll([github(3, { activityKey: 'k', lastActivityAt: at(60).toISOString() })]), at(61))
		assert.equal(db.signals.list({}, at(61))[0]?.number, 3)
	})
})

test('keeps only the newest events per profile', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1)]), T0)
		const id = db.signals.getByThreadKey('github:acme/widgets#1')?.id ?? 0
		const beta = db.forProfile('beta').signals
		beta.applyPoll(poll([github(9)]), T0)
		for (let index = 0; index < SIGNAL_EVENT_RETENTION + 5; index += 1) {
			db.signals.setNote(id, `note ${index}`, T0)
		}
		const latest = db.signals.latestSeq()
		const first = db.signals.events(0, 1)[0]
		assert.equal(first?.seq, latest - SIGNAL_EVENT_RETENTION + 1)
		assert.equal(beta.events(0).length, 1, 'pruning one profile leaves another alone')
	})
})

test('source health defaults to disabled and remembers the last good poll', () => {
	withDb(db => {
		assert.deepEqual(
			db.signals.sources().map(source => [source.source, source.status]),
			[
				['github', 'disabled'],
				['mail', 'disabled'],
			],
		)
		db.signals.setSourceHealth('github', 'ok', null, T0, true)
		db.signals.setSourceHealth('github', 'needs_permission', 'Run gh auth login\u0007', at(5), false)
		const github = db.signals.sources()[0]
		assert.deepEqual(github, {
			source: 'github',
			status: 'needs_permission',
			detail: 'Run gh auth login',
			lastPollAt: at(5).toISOString(),
			lastOkAt: T0.toISOString(),
		})
		db.signals.setSourceHealth('github', 'disabled', null, at(9), false)
		assert.equal(db.signals.sources()[0]?.lastPollAt, at(5).toISOString())
		assert.equal(db.forProfile('beta').signals.sources()[0]?.status, 'disabled')
	})
})
