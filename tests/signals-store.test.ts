import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DB } from '../src/db/client.js'
import { MIGRATIONS } from '../src/db/schema.js'
import type {
	SignalFilteredObservation,
	SignalObservation,
	SignalPollResult,
	SignalPollSource,
} from '../src/signals/contract.js'
import {
	SIGNAL_ASK_ANSWERED_REASON,
	SIGNAL_ASK_CLOSED_REASON,
	SIGNAL_EVENT_RETENTION,
	SIGNAL_MUTED_REASON,
	SIGNAL_OPEN_ASKS_MAX,
	SignalConflictError,
	SignalInvalidError,
	SignalLimitError,
	SignalNotFoundError,
} from '../src/signals/store.js'

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

test('creates threads as new and Jakub-owned, dedupes by thread key, one inbox across profiles', () => {
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

		// Signals are global: every profile view is the same inbox.
		const beta = db.forProfile('beta').signals
		assert.equal(beta.list({}, T0).length, 2)
		assert.equal(beta.get(first.id)?.threadKey, first.threadKey)
		assert.deepEqual(beta.events(0), db.signals.events(0))
		assert.equal(beta.latestSeq(), db.signals.latestSeq())
		assert.equal(beta.update(first.id, { state: 'done' }, T0).state, 'done')
		assert.equal(db.signals.get(first.id)?.state, 'done')
		// The same thread seen while another profile is active is still one row.
		assert.deepEqual(beta.applyPoll(poll([github(1), github(2)]), at(2)).created, 0)
		assert.throws(() => db.signals.update(999_999, { state: 'done' }, T0), SignalNotFoundError)
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

test('keeps only the newest events', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1)]), T0)
		const id = db.signals.getByThreadKey('github:acme/widgets#1')?.id ?? 0
		for (let index = 0; index < SIGNAL_EVENT_RETENTION + 5; index += 1) {
			db.signals.setNote(id, `note ${index}`, T0)
		}
		const latest = db.signals.latestSeq()
		const first = db.signals.events(0, 1)[0]
		assert.equal(first?.seq, latest - SIGNAL_EVENT_RETENTION + 1)
	})
})

test('source health defaults to disabled and remembers the last good poll', () => {
	withDb(db => {
		assert.deepEqual(
			db.signals.sources().map(source => [source.source, source.status]),
			[
				['github', 'disabled'],
				['mail', 'disabled'],
				['slack', 'disabled'],
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
		assert.equal(db.forProfile('beta').signals.sources()[0]?.status, 'disabled', 'health is global')
	})
})

test('migration 38 merges per-profile v37 rows into one global inbox without losing ids or cursors', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-v38-'))
	try {
		const path = join(root, 'helm.db')
		new DB(path, 'alpha').close()
		// Rebuild the v37 per-profile tables and populate them like a daemon that ran with two profiles.
		const raw = new Database(path)
		const v37 = MIGRATIONS.find(migration => migration.version === 37)
		assert.ok(v37)
		raw.exec('DROP TABLE signal_threads; DROP TABLE signal_events; DROP TABLE signal_sources;')
		raw.exec(v37.sql)
		const insert = raw.prepare(
			`INSERT INTO signal_threads (id, profile_id, thread_key, source, kind, reasons, ref, full_ref, title, head,
			   state, owner, activity_key, last_activity_at, note, created_at, updated_at)
			 VALUES (?, ?, ?, 'github', 'review', '["review"]', 'w#1', 'acme/w#1', 'T', 'H', ?, ?, 'k', ?, ?, ?, ?)`,
		)
		// Same thread in two profiles, same foreign activity: beta's copy is the one handed to an agent, so it wins.
		insert.run(
			5,
			'alpha',
			'github:acme/w#1',
			'new',
			'jakub',
			T0.toISOString(),
			null,
			T0.toISOString(),
			T0.toISOString(),
		)
		insert.run(
			9,
			'beta',
			'github:acme/w#1',
			'seen',
			'managed',
			T0.toISOString(),
			'handled',
			T0.toISOString(),
			at(5).toISOString(),
		)
		insert.run(
			12,
			'alpha',
			'github:acme/w#2',
			'new',
			'jakub',
			T0.toISOString(),
			null,
			T0.toISOString(),
			T0.toISOString(),
		)
		// Jakub closed w#3 in alpha; beta's later poll inserted a fresh `new` copy of the same activity.
		// The handled copy wins, not the newer one.
		insert.run(
			20,
			'alpha',
			'github:acme/w#3',
			'done',
			'jakub',
			T0.toISOString(),
			null,
			T0.toISOString(),
			T0.toISOString(),
		)
		insert.run(
			21,
			'beta',
			'github:acme/w#3',
			'new',
			'jakub',
			T0.toISOString(),
			null,
			at(5).toISOString(),
			at(5).toISOString(),
		)
		// w#4 was handed to an agent with a note in alpha; beta saw newer foreign activity. Beta's copy
		// wins (that activity is real) but keeps the agent handoff and the note.
		insert.run(
			30,
			'alpha',
			'github:acme/w#4',
			'seen',
			'managed',
			T0.toISOString(),
			'agent note',
			T0.toISOString(),
			T0.toISOString(),
		)
		insert.run(
			31,
			'beta',
			'github:acme/w#4',
			'new',
			'jakub',
			at(3).toISOString(),
			null,
			at(5).toISOString(),
			at(5).toISOString(),
		)
		const event = raw.prepare(
			'INSERT INTO signal_events (seq, profile_id, thread_id, type, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
		)
		event.run(40, 'alpha', 5, 'created', '{}', T0.toISOString())
		event.run(41, 'beta', 9, 'owner', '{}', at(5).toISOString())
		event.run(42, 'alpha', 12, 'created', '{}', T0.toISOString())
		const source = raw.prepare(
			'INSERT INTO signal_sources (profile_id, source, status, detail, last_poll_at, last_ok_at) VALUES (?, ?, ?, ?, ?, ?)',
		)
		source.run('alpha', 'github', 'error', 'old', T0.toISOString(), null)
		source.run('beta', 'github', 'ok', null, at(5).toISOString(), at(5).toISOString())
		raw.prepare('DELETE FROM schema_version WHERE version >= 38').run()
		raw.close()

		const db = new DB(path, 'alpha')
		try {
			const threads = db.signals.list({ includeAllDone: true }, at(6))
			assert.deepEqual(
				threads.map(thread => [thread.id, thread.threadKey, thread.state, thread.owner, thread.note]).sort(),
				[
					[12, 'github:acme/w#2', 'new', 'jakub', null],
					[9, 'github:acme/w#1', 'seen', 'managed', 'handled'],
					[20, 'github:acme/w#3', 'done', 'jakub', null],
					[31, 'github:acme/w#4', 'new', 'managed', 'agent note'],
				].sort(),
			)
			// Events of the dropped duplicate move to the kept row and keep their seq.
			assert.deepEqual(
				db.signals.events(0).map(row => [row.seq, row.threadId]),
				[
					[40, 9],
					[41, 9],
					[42, 12],
				],
			)
			assert.equal(db.signals.sources()[0]?.status, 'ok')
			// AUTOINCREMENT high-water marks survive: new ids/seqs never reuse old ones.
			db.signals.applyPoll(poll([github(77)]), at(7))
			assert.ok((db.signals.getByThreadKey('github:acme/widgets#77')?.id ?? 0) > 31)
			assert.ok(db.signals.latestSeq() > 42)
			assert.equal(
				db.forProfile('beta').signals.list({ includeAllDone: true }, at(7)).length,
				5,
				'every profile sees the same inbox',
			)
		} finally {
			db.close()
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
test('a gone thread that comes back to Jakub (snooze wake, take-back) closes instead of sitting in Needs you', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1), github(2), github(3), github(4), github(5)]), T0)
		const id = (n: number) => db.signals.getByThreadKey(`github:acme/widgets#${n}`)?.id ?? 0
		db.signals.update(id(1), { state: 'snoozed', snoozedUntil: at(60).toISOString() }, at(1))
		db.signals.update(id(2), { owner: 'managed', managedBy: 'agent-a' }, at(1))
		db.signals.update(id(3), { owner: 'managed', managedBy: 'agent-b' }, at(1))
		db.signals.update(id(4), { state: 'snoozed', snoozedUntil: at(60).toISOString() }, at(1))
		db.signals.update(id(4), { owner: 'managed', managedBy: 'agent-c' }, at(1))
		db.signals.applyPoll(poll([github(5)]), at(2))
		db.signals.applyPoll(poll([github(5)]), at(3))
		for (const n of [1, 2, 3, 4]) assert.equal(db.signals.get(id(n))?.active, false)
		assert.equal(db.signals.get(id(1))?.state, 'snoozed')

		// Snooze ends: Jakub's gone thread closes with its gone reason; the agent's wakes for the agent.
		assert.equal(db.signals.wakeSnoozed(at(60)), 2)
		const woke = db.signals.get(id(1))
		assert.equal(woke?.state, 'done')
		assert.equal(woke?.closedReason, 'no longer open or requested')
		assert.equal(woke?.snoozedUntil, null)
		assert.equal(db.signals.get(id(4))?.state, 'new')
		assert.equal(db.signals.get(id(4))?.owner, 'managed')

		// Jakub takes two gone managed threads back; for one he also says "seen" explicitly.
		db.signals.update(id(2), { owner: 'jakub', managedBy: null }, at(61))
		db.signals.update(id(3), { owner: 'jakub', managedBy: null, state: 'seen' }, at(61))
		assert.equal(db.signals.get(id(2))?.state, 'new')
		// An incomplete poll proves nothing.
		db.signals.applyPoll(poll([], false), at(62))
		assert.equal(db.signals.get(id(2))?.state, 'new')
		const counts = db.signals.applyPoll(poll([github(5)]), at(63))
		assert.equal(counts.gone, 1)
		const taken = db.signals.get(id(2))
		assert.equal(taken?.state, 'done')
		assert.equal(taken?.closedReason, 'no longer open or requested')
		assert.equal(db.signals.get(id(3))?.state, 'seen', 'an explicit state update by Jakub wins')
		assert.equal(db.signals.list({ owner: 'jakub', states: ['new', 'seen'] }, at(63)).length, 2)

		// It still reopens if GitHub reports it again with newer activity.
		db.signals.applyPoll(
			poll([github(2, { activityKey: 'later', lastActivityAt: at(64).toISOString() }), github(5)]),
			at(64),
		)
		assert.equal(db.signals.get(id(2))?.state, 'new')
		assert.equal(db.signals.get(id(2))?.active, true)
	})
})

test("poll-only refreshes never move a done thread's done time", () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1), github(2)]), T0)
		const id = db.signals.getByThreadKey('github:acme/widgets#1')?.id ?? 0
		db.signals.update(id, { state: 'done' }, at(1))
		const doneAt = at(1).toISOString()
		const later = (days: number) => at(days * 24 * 60)

		// Head refresh (same activity) on the done thread.
		db.signals.applyPoll(poll([github(1, { head: 'review requested · someone else' }), github(2)]), later(3))
		assert.equal(db.signals.get(id)?.head, 'review requested · someone else')
		assert.equal(db.signals.get(id)?.updatedAt, doneAt)

		// Missing, then gone: bookkeeping only.
		db.signals.applyPoll(poll([github(2)]), later(4))
		db.signals.applyPoll(poll([github(2)]), later(5))
		const gone = db.signals.get(id)
		assert.equal(gone?.active, false)
		assert.equal(gone?.state, 'done')
		assert.equal(gone?.updatedAt, doneAt)

		// Reported again unchanged: active again, still the same done time.
		db.signals.applyPoll(poll([github(1), github(2)]), later(6))
		assert.equal(db.signals.get(id)?.active, true)
		assert.equal(db.signals.get(id)?.updatedAt, doneAt)

		// Eight days after Jakub dismissed it, it is no longer in the default (recent done) list.
		assert.equal(
			db.signals.list({}, later(8)).some(thread => thread.id === id),
			false,
		)

		// New foreign activity is a real change: it reopens and moves updated_at.
		db.signals.applyPoll(
			poll([github(1, { activityKey: 'new', lastActivityAt: later(9).toISOString() }), github(2)]),
			later(9),
		)
		assert.equal(db.signals.get(id)?.state, 'new')
		assert.equal(db.signals.get(id)?.updatedAt, later(9).toISOString())
	})
})

// ---------- filtered mail log ----------

function filteredEntry(key: string, patch: Partial<SignalFilteredObservation> = {}): SignalFilteredObservation {
	return {
		messageKey: key,
		senderName: 'News',
		senderAddress: 'digest@news.example',
		senderIdentity: 'digest@news.example',
		subject: `Weekly ${key}`,
		reason: 'newsletter',
		mailbox: null,
		url: `message://%3C${key}%3E`,
		receivedAt: T0.toISOString(),
		...patch,
	}
}

function mailPoll(entries: SignalFilteredObservation[], keptKeys: string[] = [], complete = true): SignalPollResult {
	return {
		source: 'mail',
		observations: [],
		complete,
		goneReason: 'no longer unread in the inbox',
		filtered: { entries, keptKeys },
	}
}

test('filtered log: heads only, upserted per message, newest first, counted in the snapshot window', () => {
	withDb(db => {
		const store = db.signals
		assert.equal(store.filteredCount(T0), 0)
		store.applyPoll(
			mailPoll([
				filteredEntry('A@News.example', { receivedAt: at(-30).toISOString() }),
				filteredEntry('b@ooo.example', {
					reason: 'auto-reply',
					senderName: 'Petra‮',
					senderAddress: 'Petra@Psyon.example',
					senderIdentity: '',
					subject: 'Out\nof office',
					url: 'https://evil.example/x',
					receivedAt: at(-10).toISOString(),
				}),
				// Not a filter reason / no key / bad time: dropped.
				filteredEntry('c@x.example', { reason: 'spam' as never }),
				filteredEntry('', {}),
				filteredEntry('d@x.example', { receivedAt: 'yesterday' }),
			]),
			T0,
		)
		const page = store.listFiltered(T0)
		assert.equal(page.total, 2)
		assert.equal(page.retentionDays, 7)
		assert.deepEqual(
			page.entries.map(entry => entry.subject),
			['Out of office', 'Weekly A@News.example'],
		)
		const [ooo, news] = page.entries
		assert.equal(ooo?.senderAddress, 'petra@psyon.example')
		assert.equal(ooo?.senderIdentity, 'petra@psyon.example')
		assert.equal(ooo?.senderName.includes('‮'), false)
		assert.equal(ooo?.url, null)
		assert.equal(ooo?.reason, 'auto-reply')
		assert.equal(news?.url, 'message://%3CA@News.example%3E')
		assert.equal(store.getFiltered(news?.id ?? 0, T0)?.subject, 'Weekly A@News.example')
		assert.equal(store.getFiltered(9999, T0), null)

		// The same message again (an incomplete poll logs too) updates its row, never a second one.
		store.applyPoll(mailPoll([filteredEntry('a@news.example', { subject: 'Weekly, renamed' })], [], false), at(1))
		assert.equal(store.filteredCount(at(1)), 2)
		assert.equal(store.getFiltered(news?.id ?? 0, at(1))?.subject, 'Weekly, renamed')
		assert.equal(store.getFiltered(news?.id ?? 0, at(1))?.receivedAt, T0.toISOString())

		// A GitHub poll never touches the log.
		store.applyPoll({ ...poll([]), filtered: { entries: [filteredEntry('g@x.example')], keptKeys: [] } }, at(2))
		assert.equal(store.filteredCount(at(2)), 2)
	})
})

test('filtered log: a message the next poll keeps leaves it; rows expire after 7 days; a sender can be forgotten', () => {
	withDb(db => {
		const store = db.signals
		store.applyPoll(
			mailPoll([
				filteredEntry('a@news.example'),
				filteredEntry('b@news.example'),
				filteredEntry('c@ooo.example', {
					reason: 'auto-reply',
					senderAddress: 'jana_at_x_cz_aa_bb@privaterelay.appleid.com',
					senderIdentity: 'jana@x.cz',
				}),
				filteredEntry('old@news.example', { receivedAt: at(-8 * 24 * 60).toISOString() }),
			]),
			T0,
		)
		assert.equal(store.filteredCount(T0), 3)
		// Kept now (an include, a changed rule): out of the log.
		store.applyPoll(mailPoll([], ['A@News.example']), at(1))
		assert.deepEqual(
			store
				.listFiltered(at(1))
				.entries.map(entry => entry.subject)
				.sort(),
			['Weekly b@news.example', 'Weekly c@ooo.example'],
		)
		// The decoded identity and the raw relay address both name the sender.
		assert.equal(store.forgetFilteredSender('Jana@X.cz'), 1)
		assert.equal(store.forgetFilteredSender('nobody@x.example'), 0)
		assert.equal(store.forgetFilteredSender('  '), 0)
		assert.equal(store.filteredCount(at(1)), 1)
		// Seven days after receipt it no longer counts, and the next mail poll prunes it.
		const later = new Date(T0.getTime() + 7 * 24 * 60 * 60_000 + 60_000)
		assert.equal(store.filteredCount(later), 0)
		assert.equal(store.listFiltered(later).entries.length, 0)
		assert.equal(store.filteredCount(T0), 1)
		store.applyPoll(mailPoll([]), later)
		// Pruned, not just hidden: even counted from T0 it is gone.
		assert.equal(store.filteredCount(T0), 0)
	})
})

function mailThread(
	key: string,
	sender: string | undefined,
	patch: Partial<SignalObservation> = {},
): SignalObservation {
	return {
		threadKey: `mail:${key}`,
		source: 'mail',
		kind: 'mail',
		reasons: ['mail'],
		ref: 'Ridge',
		fullRef: `Ridge <${sender ?? 'unknown@x.example'}>`,
		title: `Subject ${key}`,
		head: `Subject ${key}`,
		actor: 'Ridge',
		url: `message://%3C${key}%40ridge.example%3E`,
		repo: null,
		number: null,
		branch: null,
		activityKey: `<${key.toUpperCase()}@ridge.example>`,
		lastActivityAt: at(-60).toISOString(),
		...(sender === undefined ? {} : { sender }),
		...patch,
	}
}

function mailThreads(observations: SignalObservation[], complete = true): SignalPollResult {
	return { ...mailPoll([], [], complete), observations }
}

test('mute closes Jakub’s open mail threads from the sender and lists their mail as filtered', () => {
	withDb(db => {
		const store = db.signals
		const ridge = 'hello@eu.ridge.com'
		store.applyPoll(
			mailThreads([
				mailThread('r1', 'Hello@EU.ridge.com'),
				mailThread('r2', ridge),
				mailThread('r3', ridge),
				mailThread('r4', ridge),
				mailThread('other', 'klara@psyon.example'),
			]),
			T0,
		)
		store.applyPoll(poll([github(1)]), T0)
		const [r1, r2, r3, r4, other] = ['r1', 'r2', 'r3', 'r4', 'other'].map(key => {
			const thread = store.getByThreadKey(`mail:${key}`)
			assert.ok(thread)
			return thread
		})
		assert.ok(r1 && r2 && r3 && r4 && other)
		assert.deepEqual(store.threadSender(r1.id), { identity: ridge, raw: ridge, owner: 'jakub' })
		assert.deepEqual(store.threadSender(other.id), {
			identity: 'klara@psyon.example',
			raw: 'klara@psyon.example',
			owner: 'jakub',
		})
		assert.equal(store.threadSender(store.getByThreadKey('github:acme/widgets#1')?.id ?? 0), null)
		assert.equal(store.threadSender(9999), null)
		// The sender is never served.
		assert.equal('sender' in r1, false)
		store.update(r2.id, { state: 'snoozed', snoozedUntil: at(600).toISOString() }, T0)
		store.update(r3.id, { owner: 'managed', managedBy: 'agent-a' }, T0)
		assert.equal(store.threadSender(r3.id)?.owner, 'managed')
		store.update(r4.id, { state: 'done' }, T0)
		const seq = store.latestSeq()

		const muted = store.muteSender(' Hello@EU.ridge.com ', at(1))
		assert.deepEqual(muted.sort(), [r1.id, r2.id].sort())
		for (const id of muted) {
			const thread = store.get(id)
			assert.equal(thread?.state, 'done')
			assert.equal(thread?.closedReason, SIGNAL_MUTED_REASON)
			assert.equal(thread?.closedBy, 'jakub')
			assert.equal(thread?.active, false)
			assert.equal(thread?.snoozedUntil, null)
			assert.equal(thread?.updatedAt, at(1).toISOString())
		}
		// A managed thread stays with its agent; done and other senders' threads are untouched.
		assert.equal(store.get(r3.id)?.owner, 'managed')
		assert.equal(store.get(r3.id)?.state, 'new')
		assert.equal(store.get(r4.id)?.closedReason, null)
		assert.equal(store.get(other.id)?.state, 'new')
		assert.deepEqual(
			store.events(seq).map(event => [event.threadId, event.type, (event.detail as { reason?: string }).reason]),
			[r1.id, r2.id].sort().map(id => [id, 'state', SIGNAL_MUTED_REASON]),
		)
		const filtered = store.listFiltered(at(1)).entries
		assert.deepEqual(filtered.map(entry => [entry.subject, entry.reason, entry.senderIdentity, entry.url]).sort(), [
			['Subject r1', 'excluded', ridge, 'message://%3Cr1%40ridge.example%3E'],
			['Subject r2', 'excluded', ridge, 'message://%3Cr2%40ridge.example%3E'],
		])
		assert.deepEqual(store.muteSender(ridge, at(2)), [], 'nothing left to close')
		assert.equal(store.listFiltered(at(2)).total, 2, 'the same messages are one row each')

		// Polls without the muted threads (the exclude list keeps them out) never relabel them as gone.
		store.applyPoll(mailThreads([mailThread('other', 'klara@psyon.example')]), at(3))
		store.applyPoll(mailThreads([mailThread('other', 'klara@psyon.example')]), at(4))
		store.applyPoll(mailThreads([mailThread('other', 'klara@psyon.example')]), at(5))
		assert.equal(store.get(r1.id)?.closedReason, SIGNAL_MUTED_REASON)
		assert.equal(store.get(r1.id)?.updatedAt, at(1).toISOString())
		// Shown again (`i`): the next poll that reports the thread reopens it as seen.
		store.applyPoll(mailThreads([mailThread('r1', ridge), mailThread('other', 'klara@psyon.example')]), at(6))
		assert.equal(store.get(r1.id)?.state, 'seen')
		assert.equal(store.get(r1.id)?.closedReason, null)
		assert.equal(store.get(r1.id)?.closedBy, null)
		assert.equal(store.get(r2.id)?.closedReason, SIGNAL_MUTED_REASON)
	})
})

test('a thread polled before the sender column learns its sender quietly; muting a blank sender closes nothing', () => {
	withDb(db => {
		const store = db.signals
		store.applyPoll(mailThreads([mailThread('legacy', undefined, { fullRef: 'Ridge <hello@eu.ridge.com>' })]), T0)
		const legacy = store.getByThreadKey('mail:legacy')
		assert.ok(legacy)
		assert.equal(store.threadSender(legacy.id), null)
		const seq = store.latestSeq()
		store.applyPoll(mailThreads([mailThread('legacy', 'hello@eu.ridge.com')]), at(1))
		assert.equal(store.threadSender(legacy.id)?.identity, 'hello@eu.ridge.com')
		// Bookkeeping: no visible change, no event.
		assert.equal(store.get(legacy.id)?.updatedAt, legacy.updatedAt)
		assert.equal(store.latestSeq(), seq)
		assert.deepEqual(store.muteSender('  ', at(2)), [])
		// A GitHub observation carrying a sender keeps none.
		store.applyPoll(poll([{ ...github(1), sender: 'x@y.example' }]), at(2))
		assert.equal(store.threadSender(store.getByThreadKey('github:acme/widgets#1')?.id ?? 0), null)
	})
})

test('a Hide My Email thread keeps its relay address: mute lists it as the filtered mail’s address', () => {
	withDb(db => {
		const store = db.signals
		const relay = 'jana_at_x_cz_abc123_0f@privaterelay.appleid.com'
		store.applyPoll(mailThreads([mailThread('hme', 'jana@x.cz', { senderAddress: relay })]), T0)
		const thread = store.getByThreadKey('mail:hme')
		assert.ok(thread)
		assert.deepEqual(store.threadSender(thread.id), { identity: 'jana@x.cz', raw: relay, owner: 'jakub' })
		assert.deepEqual(store.muteSender('jana@x.cz', at(1), relay), [thread.id])
		const [entry] = store.listFiltered(at(1)).entries
		assert.equal(entry?.senderIdentity, 'jana@x.cz')
		assert.equal(entry?.senderAddress, relay)
	})
})

test('sender addresses are stored whole up to 254 units and never clipped into a different one', () => {
	withDb(db => {
		const store = db.signals
		const long = `${'a'.repeat(230)}@ridge.example`
		const tooLong = `${'b'.repeat(250)}@ridge.example`
		store.applyPoll(
			mailThreads([mailThread('long', long), mailThread('toolong', tooLong), mailThread('spaced', 'a b@x.cz')]),
			T0,
		)
		const id = (key: string) => store.getByThreadKey(`mail:${key}`)?.id ?? 0
		assert.equal(store.threadSender(id('long'))?.identity, long)
		assert.equal(store.threadSender(id('toolong')), null)
		assert.equal(store.threadSender(id('spaced')), null)
		store.applyPoll(
			mailPoll(
				[
					filteredEntry('long@x', { senderAddress: long, senderIdentity: long }),
					filteredEntry('too-long@x', { senderAddress: tooLong, senderIdentity: tooLong }),
				],
				[],
				false,
			),
			T0,
		)
		const entries = store.listFiltered(T0).entries
		assert.ok(entries.some(entry => entry.senderAddress === long && entry.senderIdentity === long))
		assert.ok(entries.some(entry => entry.senderAddress === '' && entry.senderIdentity === ''))
		assert.ok(entries.every(entry => !entry.senderAddress.includes('…')))
	})
})

test('filtered log is capped at 1000 rows, keeping the newest', () => {
	withDb(db => {
		const store = db.signals
		const entries = Array.from({ length: 1005 }, (_, index) =>
			filteredEntry(`m${index}@news.example`, { receivedAt: at(-index).toISOString() }),
		)
		store.applyPoll(mailPoll(entries), T0)
		assert.equal(store.filteredCount(T0), 1000)
		assert.equal(store.listFiltered(T0).entries.length, 300)
		assert.equal(store.listFiltered(T0).entries[0]?.subject, 'Weekly m0@news.example')
		assert.equal(store.listFiltered(T0, 5000).entries.at(-1)?.subject, 'Weekly m299@news.example')
	})
})

const TERMINAL = 'A1B2C3D4-0000-4000-8000-0123456789AB'

test('an ask with a key upserts: created, unchanged, updated in place, renewed', () => {
	withDb(db => {
		const ask = {
			key: 'dispatcher:design-pick',
			title: 'Pick a row layout',
			body: 'Two variants.',
			links: ['https://storybook.test/?path=/story/a'],
			from: 'dispatcher',
		}
		const created = db.signals.upsertAsk(ask, T0)
		assert.equal(created.outcome, 'created')
		const thread = created.thread
		assert.equal(thread.threadKey, 'agent:dispatcher:design-pick')
		assert.equal(thread.source, 'agent')
		assert.equal(thread.kind, 'ask')
		assert.deepEqual(thread.reasons, ['ask'])
		assert.equal(thread.state, 'new')
		assert.equal(thread.owner, 'jakub')
		assert.equal(thread.ref, 'dispatcher')
		assert.equal(thread.fullRef, 'dispatcher')
		assert.equal(thread.actor, 'dispatcher')
		assert.equal(thread.head, 'Pick a row layout')
		assert.equal(thread.url, null)
		assert.equal(thread.body, 'Two variants.')
		assert.deepEqual(thread.links, ['https://storybook.test/?path=/story/a'])
		assert.equal(thread.askTerminal, null)
		assert.equal(thread.reply, null)
		assert.equal(thread.lastActivityAt, T0.toISOString())
		assert.equal(db.signals.getAskByKey('dispatcher:design-pick')?.id, thread.id)
		assert.equal(db.signals.getAskByKey('nope'), null)
		assert.equal(db.signals.getAskByKey('bad key'), null)
		const createdEvents = db.signals.events(0)
		assert.deepEqual(
			createdEvents.map(event => [event.type, event.detail]),
			[['created', { owner: 'jakub', kind: 'ask', head: 'Pick a row layout' }]],
		)

		const unchanged = db.signals.upsertAsk(ask, at(1))
		assert.equal(unchanged.outcome, 'unchanged')
		assert.equal(unchanged.thread.updatedAt, T0.toISOString())

		// Jakub looked at it; new links refresh it without making it new again.
		db.signals.markSeen(thread.id, at(2))
		const seq = db.signals.latestSeq()
		const updated = db.signals.upsertAsk({ ...ask, links: [...ask.links, 'https://github.com/acme/w/pull/3'] }, at(3))
		assert.equal(updated.outcome, 'updated')
		assert.equal(updated.thread.id, thread.id)
		assert.equal(updated.thread.state, 'seen')
		assert.equal(updated.thread.links.length, 2)
		assert.equal(updated.thread.askTerminal, null)
		assert.equal(updated.thread.updatedAt, at(3).toISOString())
		assert.equal(updated.thread.lastActivityAt, T0.toISOString())
		assert.equal(db.signals.latestSeq(), seq, 'a refresh in place writes no event')

		// Jakub answered, then snoozed it; a changed body is a new question: new again, reply cleared.
		db.signals.reply(thread.id, 'Variant B', at(4))
		db.signals.update(thread.id, { state: 'snoozed', snoozedUntil: at(60).toISOString() }, at(5))
		const renewed = db.signals.upsertAsk({ ...ask, body: 'Two variants, now with a third.' }, at(6))
		assert.equal(renewed.outcome, 'renewed')
		assert.equal(renewed.thread.id, thread.id)
		assert.equal(renewed.thread.state, 'new')
		assert.equal(renewed.thread.snoozedUntil, null)
		assert.equal(renewed.thread.reply, null)
		assert.equal(renewed.thread.routedHow, null, 'the earlier reply route says nothing about the answer')
		assert.equal(renewed.thread.routedAgent, null)
		assert.equal(renewed.thread.replyAt, null)
		assert.equal(renewed.thread.body, 'Two variants, now with a third.')
		assert.deepEqual(renewed.thread.links, ask.links, 'links follow the latest add')
		assert.equal(renewed.thread.askTerminal, null)
		assert.equal(renewed.thread.lastActivityAt, at(6).toISOString())
		const last = db.signals.events(0).at(-1)
		assert.equal(last?.type, 'activity')
		assert.deepEqual(last?.detail, { owner: 'jakub', kind: 'ask', head: 'Pick a row layout', state: 'new' })

		// A new asking terminal is a new delivery target: new again and the earlier reply cleared,
		// so Jakub's answer never moves to another agent unseen.
		db.signals.reply(thread.id, 'Variant C', at(7))
		const moved = db.signals.upsertAsk({ ...ask, body: 'Two variants, now with a third.', terminal: TERMINAL }, at(8))
		assert.equal(moved.outcome, 'renewed')
		assert.equal(moved.thread.state, 'new')
		assert.equal(moved.thread.reply, null)
		assert.equal(moved.thread.askTerminal, TERMINAL.toLowerCase())
		assert.equal(moved.thread.fullRef, 'dispatcher · Okena terminal')

		// Done, then a changed title reopens it; a done ask refreshed in place keeps its done time.
		db.signals.done(thread.id, undefined, at(7))
		const doneLinks = db.signals.upsertAsk(
			{ ...ask, body: 'Two variants, now with a third.', terminal: TERMINAL, links: [] },
			at(8),
		)
		assert.equal(doneLinks.outcome, 'updated')
		assert.equal(doneLinks.thread.state, 'done')
		assert.equal(doneLinks.thread.updatedAt, at(7).toISOString())
		const reopened = db.signals.upsertAsk({ ...ask, title: 'Pick a row layout (v2)' }, at(9))
		assert.equal(reopened.outcome, 'renewed')
		assert.equal(reopened.thread.state, 'new')
		assert.equal(reopened.thread.closedReason, null)
		assert.equal(reopened.thread.head, 'Pick a row layout (v2)')
	})
})

test('an ask without a key is always a new thread; the owner survives a renewal', () => {
	withDb(db => {
		const first = db.signals.upsertAsk({ title: 'Approve the migration?' }, T0)
		const second = db.signals.upsertAsk({ title: 'Approve the migration?' }, T0)
		assert.equal(first.outcome, 'created')
		assert.equal(second.outcome, 'created')
		assert.notEqual(first.thread.id, second.thread.id)
		assert.match(first.thread.threadKey, /^agent:[0-9a-f-]{36}$/)
		assert.equal(first.thread.ref, 'agent', 'from defaults to agent')
		assert.equal(first.thread.body, null)
		assert.deepEqual(first.thread.links, [])

		const keyed = db.signals.upsertAsk({ key: 'k1', title: 'One' }, T0)
		db.signals.update(keyed.thread.id, { owner: 'managed', managedBy: 'dispatcher' }, at(1))
		const renewed = db.signals.upsertAsk({ key: 'k1', title: 'Two' }, at(2))
		assert.equal(renewed.outcome, 'renewed')
		assert.equal(renewed.thread.owner, 'managed')
		assert.equal(renewed.thread.managedBy, 'dispatcher')
	})
})

test('ask input is cleaned and bounded before it is stored', () => {
	withDb(db => {
		const body = [
			'first\u202e line\u0007  ',
			'',
			'',
			'',
			'\tthird',
			...Array.from({ length: 20 }, (_, n) => `line ${n}`),
		].join('\r\n')
		const { thread } = db.signals.upsertAsk(
			{
				key: 'clean',
				title: `  A \u2066title\u2069 ${'x'.repeat(400)}`,
				body,
				links: [
					'https://ok.test/a',
					'https://ok.test/a',
					'javascript:alert(1)',
					'https://user:pass@ok.test/',
					'https://ok.test/\u202eb',
					'ftp://ok.test/',
					'/relative',
					'https://ok.test/b',
				],
				from: ' Fix \u0000 widget\u202e  pane ',
				terminal: 'not-a-terminal',
			},
			T0,
		)
		assert.ok(thread.title.length <= 200)
		assert.ok(thread.title.startsWith('A title xxx'))
		assert.ok(thread.title.endsWith('…'))
		const lines = (thread.body ?? '').split('\n')
		assert.equal(lines.length, 12)
		assert.equal(lines[0], 'first line')
		assert.equal(lines[1], '', 'runs of blank lines collapse to one')
		assert.equal(lines[2], ' third', 'tabs become spaces')
		assert.ok(lines[11]?.endsWith('…'))
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting controls are gone
		assert.equal(/[\u0000-\u0009\u000b-\u001f\u202e]/.test(thread.body ?? ''), false)
		assert.deepEqual(thread.links, ['https://ok.test/a', 'https://ok.test/b'])
		assert.equal(thread.ref, 'Fix widget pane')
		assert.equal(thread.askTerminal, null)

		const long = db.signals.upsertAsk({ title: 'Long', body: `${'y'.repeat(999)}\n${'z'.repeat(5)}` }, T0).thread
		assert.ok((long.body ?? '').length <= 1000)
		assert.ok(long.body?.endsWith('…'))
		const many = Array.from({ length: 12 }, (_, n) => `https://ok.test/${n}`)
		assert.equal(db.signals.upsertAsk({ title: 'Links', links: many }, T0).thread.links.length, 8)
		assert.equal(db.signals.upsertAsk({ title: 'Blank body', body: ' \n\u0007\n ' }, T0).thread.body, null)
		assert.equal(db.signals.upsertAsk({ title: 'From', from: '\u0007 ' }, T0).thread.ref, 'agent')

		assert.throws(() => db.signals.upsertAsk({ title: ' \u0007 ' }, T0), SignalInvalidError)
		assert.throws(() => db.signals.upsertAsk({ key: 'bad key', title: 'T' }, T0), SignalInvalidError)
	})
})

test('an ask link opens what it shows: no backslash, no repaired slashes, the host as written', () => {
	withDb(db => {
		const good = [
			'http://localhost:6006/?path=/story/views-signals-agent-asks--title-rows',
			'http://localhost:6006/?path=/story/views-signals-agent-asks--body-line',
			'https://github.com',
			'HTTPS://GitHub.com/contember/okena/pull/311',
			'https://github.com:443/x',
			'https://github.com?tab=checks',
		]
		const bad = [
			'https://evil.com\\.github.com/x',
			'http:evil.com',
			'https:/\\evil.com',
			'https:///evil.com',
			'https://github.com/a\\b',
			'https://user@github.com/',
		]
		const { thread } = db.signals.upsertAsk({ title: 'Links', links: [...bad, ...good] }, T0)
		assert.deepEqual(thread.links, good)
	})
})

test('open asks are bounded; renewing or updating an existing key always works', () => {
	withDb(db => {
		for (let n = 0; n < SIGNAL_OPEN_ASKS_MAX; n++) db.signals.upsertAsk({ key: `ask-${n}`, title: `Ask ${n}` }, T0)
		const full = () => db.signals.upsertAsk({ title: 'One too many' }, at(1))
		assert.throws(full, SignalLimitError)
		assert.throws(full, { message: 'Too many open agent asks and answers (50). Close some with helm signal done.' })
		assert.throws(() => db.signals.upsertAsk({ key: 'new-key', title: 'Also too many' }, at(1)), SignalLimitError)
		assert.equal(db.signals.list({ source: 'agent' }, at(1)).length, SIGNAL_OPEN_ASKS_MAX)

		assert.equal(db.signals.upsertAsk({ key: 'ask-0', title: 'Ask 0, renewed' }, at(2)).outcome, 'renewed')
		assert.equal(
			db.signals.upsertAsk({ key: 'ask-1', title: 'Ask 1', links: ['https://github.com/'] }, at(2)).outcome,
			'updated',
		)
		assert.equal(db.signals.upsertAsk({ key: 'ask-2', title: 'Ask 2' }, at(2)).outcome, 'unchanged')

		// GitHub/Mail threads never count, and closing an ask makes room.
		db.signals.applyPoll(poll([github(1)]), at(2))
		const first = db.signals.getAskByKey('ask-3')
		assert.ok(first)
		db.signals.done(first.id, undefined, at(3))
		assert.equal(db.signals.upsertAsk({ title: 'Fits again' }, at(4)).outcome, 'created')
		assert.throws(full, SignalLimitError)

		// A done ask opened again by a new title takes a slot too; unchanged or link-only does not.
		assert.throws(() => db.signals.upsertAsk({ key: 'ask-3', title: 'Ask 3, again' }, at(5)), SignalLimitError)
		assert.equal(db.signals.getAskByKey('ask-3')?.state, 'done')
		assert.equal(db.signals.upsertAsk({ key: 'ask-3', title: 'Ask 3' }, at(5)).outcome, 'unchanged')
		const fourth = db.signals.getAskByKey('ask-4')
		assert.ok(fourth)
		db.signals.done(fourth.id, undefined, at(6))
		assert.equal(db.signals.upsertAsk({ key: 'ask-3', title: 'Ask 3, again' }, at(7)).outcome, 'renewed')
		assert.equal(db.signals.getAskByKey('ask-3')?.state, 'new')
	})
})

test('done closes by id or key, with or without an outcome note', () => {
	withDb(db => {
		const ask = db.signals.upsertAsk({ key: 'done-me', title: 'Merge it?' }, T0).thread
		const done = db.signals.done(ask.id, undefined, at(1))
		assert.equal(done.state, 'done')
		assert.equal(done.closedReason, SIGNAL_ASK_CLOSED_REASON)
		assert.equal(done.updatedAt, at(1).toISOString())
		assert.deepEqual(db.signals.events(0).at(-1)?.detail, { owner: 'jakub', from: 'new', to: 'done' })

		// Already done without a note: nothing written.
		const seq = db.signals.latestSeq()
		assert.equal(db.signals.done(ask.id, undefined, at(2)).updatedAt, at(1).toISOString())
		assert.equal(db.signals.latestSeq(), seq)
		// Already done with a note: only the note.
		const noted = db.signals.done(ask.id, 'Merged as #12', at(3))
		assert.equal(noted.note, 'Merged as #12')
		assert.equal(noted.noteAt, at(3).toISOString())
		assert.deepEqual(
			db.signals.events(seq).map(event => event.type),
			['note'],
		)

		// By key (the route looks the key up, then closes), from snoozed, with a note.
		const other = db.signals.upsertAsk({ key: 'other', title: 'Later' }, T0).thread
		db.signals.update(other.id, { state: 'snoozed', snoozedUntil: at(60).toISOString() }, at(1))
		const byKey = db.signals.getAskByKey('other')
		assert.ok(byKey)
		const closed = db.signals.done(byKey.id, 'Answered in chat', at(4))
		assert.equal(closed.state, 'done')
		assert.equal(closed.snoozedUntil, null)
		assert.equal(closed.note, 'Answered in chat')
		assert.deepEqual(
			db.signals
				.events(0)
				.slice(-2)
				.map(event => [event.type, event.detail.to ?? event.detail.note]),
			[
				['state', 'done'],
				['note', 'Answered in chat'],
			],
		)

		// Any source: a GitHub thread closes without the agent's closed reason.
		db.signals.applyPoll(poll([github(1)]), T0)
		const pr = db.signals.getByThreadKey('github:acme/widgets#1')
		assert.ok(pr)
		assert.equal(db.signals.done(pr.id, undefined, at(5)).closedReason, null)

		assert.throws(() => db.signals.done(999_999, undefined, at(5)), SignalNotFoundError)
		assert.throws(() => db.signals.done(ask.id, ' \u0007', at(5)), SignalInvalidError)
	})
})

test('an ask bound to a terminal closes as answered when Jakub prompted it after it was asked', () => {
	withDb(db => {
		const terminal = '5d3f8a2e-1b4c-4e8a-9f21-6c0d7e9b3a14'
		const ask = db.signals.upsertAsk({ key: 'vos', title: 'Approve the slots?', terminal }, T0).thread
		const asked = ask.lastActivityAt
		// The prompt must come after the ask, and not from the future.
		assert.throws(
			() => db.signals.answered(ask.id, { activityAt: asked, promptAt: T0.toISOString() }, at(1)),
			SignalInvalidError,
		)
		assert.throws(
			() => db.signals.answered(ask.id, { activityAt: asked, promptAt: at(10).toISOString() }, at(1)),
			SignalInvalidError,
		)
		// Renewed since the prompt was matched: a conflict, nothing changes.
		const renewed = db.signals.upsertAsk({ key: 'vos', title: 'Approve the slots (v2)?', terminal }, at(2)).thread
		assert.throws(
			() => db.signals.answered(ask.id, { activityAt: asked, promptAt: at(1).toISOString() }, at(3)),
			SignalConflictError,
		)
		assert.equal(db.signals.get(ask.id)?.state, 'new')

		const seq = db.signals.latestSeq()
		const closed = db.signals.answered(
			ask.id,
			{ activityAt: renewed.lastActivityAt, promptAt: at(3).toISOString() },
			at(4),
		)
		assert.equal(closed.state, 'done')
		assert.equal(closed.closedReason, SIGNAL_ASK_ANSWERED_REASON)
		assert.equal(closed.closedBy, 'jakub')
		assert.equal(closed.updatedAt, at(4).toISOString())
		assert.deepEqual(
			db.signals.events(seq).map(event => [event.type, event.detail]),
			[['state', { owner: 'jakub', from: 'new', to: 'done', reason: SIGNAL_ASK_ANSWERED_REASON }]],
		)
		// Already done: idempotent, no event.
		const again = db.signals.answered(
			ask.id,
			{ activityAt: renewed.lastActivityAt, promptAt: at(5).toISOString() },
			at(6),
		)
		assert.equal(again.updatedAt, at(4).toISOString())
		assert.equal(db.signals.latestSeq(), seq + 1)

		// Snoozed and managed asks close too.
		const snoozed = db.signals.upsertAsk({ key: 'later', title: 'Later?', terminal }, T0).thread
		db.signals.update(snoozed.id, { state: 'snoozed', snoozedUntil: at(60).toISOString() }, at(1))
		const woke = db.signals.answered(
			snoozed.id,
			{ activityAt: snoozed.lastActivityAt, promptAt: at(1).toISOString() },
			at(2),
		)
		assert.equal(woke.state, 'done')
		assert.equal(woke.snoozedUntil, null)

		// Only asks bound to a terminal.
		const loose = db.signals.upsertAsk({ title: 'No terminal' }, T0).thread
		assert.throws(
			() => db.signals.answered(loose.id, { activityAt: loose.lastActivityAt, promptAt: at(1).toISOString() }, at(2)),
			SignalInvalidError,
		)
		db.signals.applyPoll(poll([github(1)]), T0)
		const pr = db.signals.getByThreadKey('github:acme/widgets#1')
		assert.ok(pr)
		assert.throws(
			() => db.signals.answered(pr.id, { activityAt: pr.lastActivityAt, promptAt: at(1).toISOString() }, at(2)),
			SignalInvalidError,
		)
		assert.throws(
			() => db.signals.answered(999_999, { activityAt: asked, promptAt: at(1).toISOString() }, at(2)),
			SignalNotFoundError,
		)
	})
})

test('closed_by records who closed a thread by hand and is forgotten once it is not done', () => {
	withDb(db => {
		db.signals.applyPoll(poll([github(1), github(2)]), T0)
		const one = db.signals.getByThreadKey('github:acme/widgets#1')?.id ?? 0
		const two = db.signals.getByThreadKey('github:acme/widgets#2')?.id ?? 0
		assert.equal(db.signals.get(one)?.closedBy, null)

		// Through Helm (the route passes `jakub`), and by default an agent (`helm signal set`).
		assert.equal(db.signals.update(one, { state: 'done' }, at(1), 'jakub').closedBy, 'jakub')
		assert.equal(db.signals.update(two, { state: 'done' }, at(1)).closedBy, 'agent')
		// Already done: another close keeps who closed it first.
		assert.equal(db.signals.update(one, { state: 'done' }, at(2), 'agent').closedBy, 'jakub')
		assert.equal(db.signals.done(one, 'Merged', at(2)).closedBy, 'jakub')
		// Leaving done forgets it: by hand, and by newer foreign activity.
		assert.equal(db.signals.update(one, { state: 'seen' }, at(3), 'jakub').closedBy, null)
		db.signals.applyPoll(
			poll([github(1), github(2, { activityKey: 'later', lastActivityAt: at(4).toISOString() })]),
			at(4),
		)
		assert.equal(db.signals.get(two)?.state, 'new')
		assert.equal(db.signals.get(two)?.closedBy, null)

		// Closed on its own: the reason says why, nobody closed it.
		db.signals.update(two, { state: 'done' }, at(5), 'jakub')
		db.signals.update(two, { state: 'seen' }, at(6), 'jakub')
		db.signals.applyPoll(poll([github(1)]), at(7))
		db.signals.applyPoll(poll([github(1)]), at(8))
		const gone = db.signals.get(two)
		assert.equal(gone?.state, 'done')
		assert.equal(gone?.closedReason, 'no longer open or requested')
		assert.equal(gone?.closedBy, null)

		// An ask: the agent closing it keeps the agent's closed reason; Jakub closing it does not.
		const ask = db.signals.upsertAsk({ key: 'who', title: 'Ship it?' }, T0).thread
		const byAgent = db.signals.done(ask.id, undefined, at(9))
		assert.equal(byAgent.closedReason, SIGNAL_ASK_CLOSED_REASON)
		assert.equal(byAgent.closedBy, 'agent')
		// A renewed ask is open again: no closer.
		const renewed = db.signals.upsertAsk({ key: 'who', title: 'Ship it now?' }, at(10)).thread
		assert.equal(renewed.state, 'new')
		assert.equal(renewed.closedBy, null)
		const byJakub = db.signals.done(renewed.id, undefined, at(11), 'jakub')
		assert.equal(byJakub.closedReason, null)
		assert.equal(byJakub.closedBy, 'jakub')
	})
})

test('a reply is kept on the ask, marks it seen and never lands in the event log', () => {
	withDb(db => {
		const ask = db.signals.upsertAsk({ key: 'reply', title: 'Which variant?' }, T0).thread
		const replied = db.signals.reply(ask.id, ' Variant B,\r\nbut keep the \u202edot. \n\n\n\u0007', at(1))
		assert.equal(replied.reply, 'Variant B,\nbut keep the dot.')
		assert.equal(replied.replyAt, at(1).toISOString())
		assert.equal(replied.state, 'seen')
		const event = db.signals.events(0).at(-1)
		assert.equal(event?.type, 'reply')
		assert.deepEqual(event?.detail, { owner: 'jakub', state: 'seen' })
		assert.equal(JSON.stringify(db.signals.events(0)).includes('Variant'), false)

		// A second answer replaces the first; a snoozed ask stays snoozed.
		db.signals.update(ask.id, { state: 'snoozed', snoozedUntil: at(60).toISOString() }, at(2))
		const again = db.signals.reply(ask.id, 'Actually A', at(3))
		assert.equal(again.reply, 'Actually A')
		assert.equal(again.state, 'snoozed')
		const long = db.signals.reply(ask.id, 'w'.repeat(5000), at(4))
		assert.ok((long.reply ?? '').length <= 2000)

		assert.throws(() => db.signals.reply(ask.id, ' \n\u0007 ', at(5)), SignalInvalidError)
		db.signals.applyPoll(poll([github(1)]), T0)
		const pr = db.signals.getByThreadKey('github:acme/widgets#1')
		assert.ok(pr)
		assert.throws(() => db.signals.reply(pr.id, 'hi', at(5)), /Only agent asks take a reply/)
		assert.throws(() => db.signals.reply(999_999, 'hi', at(5)), SignalNotFoundError)
	})
})

test('polls never touch agent asks; agent is no poll source', () => {
	withDb(db => {
		const ask = db.signals.upsertAsk({ key: 'stay', title: 'Still here?' }, T0).thread
		db.signals.applyPoll(poll([github(1)]), at(1))
		db.signals.applyPoll(poll([]), at(2))
		db.signals.applyPoll(poll([]), at(3))
		db.signals.applyPoll({ source: 'mail', observations: [], complete: true, goneReason: 'read in Mail' }, at(4))
		db.signals.applyPoll({ source: 'mail', observations: [], complete: true, goneReason: 'read in Mail' }, at(5))
		const after = db.signals.get(ask.id)
		assert.equal(after?.state, 'new')
		assert.equal(after?.active, true)
		assert.equal(after?.updatedAt, T0.toISOString())

		// A poll observation pretending to be an ask is refused, so is an `agent` poll or health row.
		const forged = { ...github(9), threadKey: 'agent:stay', source: 'agent' as unknown as SignalPollSource }
		db.signals.applyPoll(poll([forged]), at(6))
		assert.equal(db.signals.get(ask.id)?.title, 'Still here?')
		assert.throws(
			() =>
				db.signals.applyPoll(
					{ source: 'agent' as unknown as SignalPollSource, observations: [], complete: true, goneReason: 'x' },
					at(6),
				),
			SignalInvalidError,
		)
		assert.throws(
			() => db.signals.setSourceHealth('agent' as unknown as SignalPollSource, 'ok', null, at(6), true),
			SignalInvalidError,
		)
		assert.deepEqual(
			db.signals.sources().map(source => source.source),
			['github', 'mail', 'slack'],
		)
		assert.equal(db.signals.list({ source: 'agent' }, at(6)).length, 1)
	})
})

test('migration 41 keeps every thread, id and event, and ids continue after the old maximum', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-v41-'))
	try {
		const path = join(root, 'helm.db')
		new DB(path, 'alpha').close()
		// Rebuild the v38 table (no agent source, no ask columns) like a daemon before this change.
		const raw = new Database(path)
		raw.exec('DROP TABLE signal_threads')
		raw.exec(`CREATE TABLE signal_threads (
		  id INTEGER PRIMARY KEY AUTOINCREMENT,
		  thread_key TEXT NOT NULL UNIQUE,
		  source TEXT NOT NULL CHECK (source IN ('github','mail')),
		  kind TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]', ref TEXT NOT NULL, full_ref TEXT NOT NULL,
		  title TEXT NOT NULL, head TEXT NOT NULL, actor TEXT, url TEXT, repo TEXT, number INTEGER, branch TEXT,
		  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','seen','snoozed','done')),
		  owner TEXT NOT NULL DEFAULT 'jakub' CHECK (owner IN ('jakub','managed')),
		  snoozed_until TEXT, activity_key TEXT NOT NULL, last_activity_at TEXT NOT NULL,
		  active INTEGER NOT NULL DEFAULT 1, missed_polls INTEGER NOT NULL DEFAULT 0, closed_reason TEXT,
		  note TEXT, note_at TEXT, managed_by TEXT, routed_agent TEXT, routed_how TEXT, routed_at TEXT,
		  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		)`)
		raw.exec('CREATE INDEX idx_signal_threads_state ON signal_threads(state, last_activity_at)')
		const insert = raw.prepare(
			`INSERT INTO signal_threads (id, thread_key, source, kind, reasons, ref, full_ref, title, head, url,
			   state, owner, activity_key, last_activity_at, note, routed_agent, routed_how, routed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'r', 'fr', 'T', 'H', ?, ?, ?, 'k', ?, ?, ?, ?, ?, ?, ?)`,
		)
		insert.run(
			7,
			'github:acme/w#1',
			'github',
			'review',
			'["review"]',
			'https://github.com/acme/w/pull/1',
			'seen',
			'managed',
			T0.toISOString(),
			'handled',
			'fix-w',
			'sent',
			T0.toISOString(),
			T0.toISOString(),
			at(1).toISOString(),
		)
		insert.run(
			15,
			'mail:abc',
			'mail',
			'mail',
			'["mail"]',
			null,
			'done',
			'jakub',
			T0.toISOString(),
			null,
			null,
			null,
			null,
			T0.toISOString(),
			at(2).toISOString(),
		)
		// A thread inserted and deleted again: the high-water mark is 40, above every surviving id.
		raw.prepare("UPDATE sqlite_sequence SET seq = 40 WHERE name = 'signal_threads'").run()
		raw.prepare('DELETE FROM signal_events').run()
		const event = raw.prepare('INSERT INTO signal_events (seq, thread_id, type, detail, at) VALUES (?, ?, ?, ?, ?)')
		event.run(100, 7, 'created', '{"owner":"jakub"}', T0.toISOString())
		event.run(101, 15, 'state', '{"to":"done"}', at(2).toISOString())
		// A database at 40 (main's item_okena_terminals) runs only 41: the runner applies versions above its max.
		raw.prepare('DELETE FROM schema_version WHERE version >= 41').run()
		raw.close()

		const db = new DB(path, 'alpha')
		try {
			const threads = db.signals.list({ includeAllDone: true }, at(3))
			assert.deepEqual(
				threads.map(thread => [thread.id, thread.threadKey, thread.source, thread.state, thread.owner]).sort(),
				[
					[15, 'mail:abc', 'mail', 'done', 'jakub'],
					[7, 'github:acme/w#1', 'github', 'seen', 'managed'],
				].sort(),
			)
			const pr = db.signals.get(7)
			assert.equal(pr?.note, 'handled')
			assert.equal(pr?.routedAgent, 'fix-w')
			assert.equal(pr?.url, 'https://github.com/acme/w/pull/1')
			assert.equal(pr?.updatedAt, at(1).toISOString())
			assert.equal(pr?.body, null)
			assert.deepEqual(pr?.links, [])
			assert.equal(pr?.askTerminal, null)
			assert.equal(pr?.reply, null)
			assert.deepEqual(
				db.signals.events(0).map(row => [row.seq, row.threadId, row.type]),
				[
					[100, 7, 'created'],
					[101, 15, 'state'],
				],
			)
			const versions = (db.signals as unknown as { db: Database.Database }).db
				.prepare('SELECT MAX(version) AS v FROM schema_version')
				.get() as { v: number }
			// 41 rebuilt the table, 42 added closed_by, 43 the mail sender, 44 widened source for slack.
			assert.equal(versions.v, 44)
			assert.equal(db.signals.get(15)?.closedBy, null)
			assert.equal(db.signals.threadSender(15), null)
			const ask = db.signals.upsertAsk({ title: 'After the migration' }, at(4)).thread
			assert.equal(ask.id, 41)
			assert.ok(db.signals.latestSeq() > 101)
			const indexes = (db.signals as unknown as { db: Database.Database }).db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'signal_threads'")
				.all() as Array<{ name: string }>
			assert.ok(indexes.some(index => index.name === 'idx_signal_threads_state'))
		} finally {
			db.close()
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

// ---------- agent answers ----------

test('an answer is an agent thread of kind answer: no terminal, no reply, a longer body', () => {
	withDb(db => {
		const body = Array.from({ length: 30 }, (_, i) => `Line ${i}: ${'x'.repeat(58)}`).join('\n')
		const created = db.signals.upsertAsk(
			{ kind: 'answer', key: 'remote-proxy', title: 'Proxy blocks Remote', body, from: 'dispatcher' },
			T0,
		)
		assert.equal(created.outcome, 'created')
		const answer = created.thread
		assert.equal(answer.source, 'agent')
		assert.equal(answer.kind, 'answer')
		assert.deepEqual(answer.reasons, ['answer'])
		assert.equal(answer.state, 'new')
		assert.equal(answer.owner, 'jakub')
		assert.equal(answer.body, body, 'an answer keeps more than an ask body')
		assert.equal(answer.askTerminal, null)
		assert.equal(db.signals.getAskByKey('remote-proxy')?.id, answer.id)
		assert.deepEqual(
			db.signals.events(0).map(event => [event.type, event.detail]),
			[['created', { owner: 'jakub', kind: 'answer', head: 'Proxy blocks Remote' }]],
		)

		// An answer is bounded by its own limits (60 lines, 4000 units), an ask by the ask's.
		const huge = db.signals.upsertAsk(
			{ kind: 'answer', title: 'Long', body: Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n') },
			T0,
		).thread
		assert.equal((huge.body ?? '').split('\n').length, 60)
		const asked = db.signals.upsertAsk({ title: 'Ask', body: body }, T0).thread
		assert.ok((asked.body ?? '').length <= 1000)

		// It takes no terminal and no reply; it never closes from a terminal.
		assert.throws(
			() => db.signals.upsertAsk({ kind: 'answer', title: 'x', terminal: '5d3f8a2e-1b4c-4e8a-9f21-6c0d7e9b3a14' }, T0),
			/An answer takes no reply/,
		)
		assert.throws(() => db.signals.reply(answer.id, 'thanks', at(1)), /An answer takes no reply/)
		assert.throws(
			() => db.signals.setRouted(answer.id, { agent: 'dispatcher', how: 'replied' }, at(1)),
			/Only an agent ask is replied to/,
		)
		assert.throws(
			() => db.signals.answered(answer.id, { activityAt: answer.lastActivityAt, promptAt: at(1).toISOString() }, at(2)),
			/bound to a terminal/,
		)
		assert.equal(db.signals.get(answer.id)?.reply, null)

		// Jakub closes it once read (through Helm: closed by jakub, no reason).
		const read = db.signals.update(answer.id, { state: 'done' }, at(3), 'jakub')
		assert.equal(read.state, 'done')
		assert.equal(read.closedBy, 'jakub')
		assert.equal(read.closedReason, null)
	})
})

test('one key is one agent thread: changing its kind renews it; the open cap counts asks and answers', () => {
	withDb(db => {
		const ask = db.signals.upsertAsk({ key: 'proxy', title: 'Proxy blocks Remote' }, T0).thread
		db.signals.reply(ask.id, 'Why?', at(1))
		db.signals.setRouted(ask.id, { agent: 'dispatcher', how: 'replied' }, at(1))
		const unchanged = db.signals.upsertAsk({ key: 'proxy', title: 'Proxy blocks Remote', kind: 'ask' }, at(2))
		assert.equal(unchanged.outcome, 'unchanged', 'an explicit ask is the default kind')

		// The same key filed as an answer: the same thread, new again, kind answer, the reply cleared.
		const renewed = db.signals.upsertAsk({ key: 'proxy', kind: 'answer', title: 'Proxy blocks Remote' }, at(3))
		assert.equal(renewed.outcome, 'renewed')
		assert.equal(renewed.thread.id, ask.id)
		assert.equal(renewed.thread.kind, 'answer')
		assert.deepEqual(renewed.thread.reasons, ['answer'])
		assert.equal(renewed.thread.state, 'new')
		assert.equal(renewed.thread.reply, null)
		assert.deepEqual(db.signals.events(0).at(-1)?.detail, {
			owner: 'jakub',
			kind: 'answer',
			head: 'Proxy blocks Remote',
			state: 'new',
		})
		assert.equal(
			db.signals.upsertAsk({ key: 'proxy', kind: 'answer', title: 'Proxy blocks Remote' }, at(4)).outcome,
			'unchanged',
		)

		for (let i = 1; i < SIGNAL_OPEN_ASKS_MAX; i++)
			db.signals.upsertAsk({ kind: i % 2 === 0 ? 'answer' : 'ask', title: `Row ${i}` }, at(5))
		assert.throws(() => db.signals.upsertAsk({ kind: 'answer', title: 'One more' }, at(6)), SignalLimitError)
		assert.throws(() => db.signals.upsertAsk({ title: 'One more ask' }, at(6)), /asks and answers/)
	})
})
