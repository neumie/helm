import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DB } from '../src/db/client.js'
import { MIGRATIONS } from '../src/db/schema.js'
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
