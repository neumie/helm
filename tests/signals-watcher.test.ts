import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type HelmConfig, configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import type { SignalObservation, SignalPollResult, SignalPollSource } from '../src/signals/contract.js'
import { type SignalReader, SignalsWatcher } from '../src/signals/watcher.js'

const NOW = new Date('2026-11-05T10:00:00.000Z')

function config(signals: Record<string, unknown> = {}): HelmConfig {
	return configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
		projects: [{ slug: 'acme', repoPath: '/tmp/acme' }],
		signals,
	})
}

function withDb(run: (db: DB) => Promise<void>) {
	return async () => {
		const root = mkdtempSync(join(tmpdir(), 'helm-signals-watcher-'))
		const db = new DB(join(root, 'helm.db'), 'alpha')
		try {
			await run(db)
		} finally {
			db.close()
			rmSync(root, { recursive: true, force: true })
		}
	}
}

function observation(source: SignalPollSource, key: string): SignalObservation {
	return {
		threadKey: key,
		source,
		kind: source === 'github' ? 'review' : 'mail',
		reasons: [source === 'github' ? 'review' : 'mail'],
		ref: key,
		fullRef: key,
		title: `Title ${key}`,
		head: 'head',
		actor: null,
		url: null,
		repo: null,
		number: null,
		branch: null,
		activityKey: 'k1',
		lastActivityAt: NOW.toISOString(),
	}
}

function result(source: SignalPollSource, keys: string[], complete = true): SignalPollResult {
	return { source, observations: keys.map(key => observation(source, key)), complete, goneReason: 'gone' }
}

/** A reader whose reads wait until released; records every call and its abort signal. */
function gatedReader(source: SignalPollSource, keys: string[]) {
	const calls: AbortSignal[] = []
	let release: (() => void) | null = null
	const reader: SignalReader = {
		source,
		read: signal => {
			calls.push(signal)
			return new Promise(resolve => {
				release = () => resolve({ result: result(source, keys), health: { status: 'ok', detail: null } })
			})
		},
	}
	return {
		reader,
		calls,
		release: () => {
			assert.ok(release, 'a read is pending')
			release()
			release = null
		},
	}
}

function instantReader(
	source: SignalPollSource,
	keys: string[],
	health: { status: 'ok' | 'error' | 'needs_permission' | 'unavailable'; detail: string | null } = {
		status: 'ok',
		detail: null,
	},
	complete = true,
) {
	let calls = 0
	const reader: SignalReader = {
		source,
		read: async () => {
			calls += 1
			return { result: result(source, keys, complete), health }
		},
	}
	return { reader, calls: () => calls }
}

test(
	'pollOnce is single-flight per source and sources run independently',
	withDb(async db => {
		const github = gatedReader('github', ['github:acme/a#1'])
		const mail = instantReader('mail', ['mail:abc'])
		const watcher = new SignalsWatcher(config({ mail: { enabled: true } }), db, {
			github: github.reader,
			mail: mail.reader,
			now: () => NOW,
		})
		const first = watcher.pollOnce('github')
		const second = watcher.pollOnce('github')
		assert.equal(github.calls.length, 1)
		// Mail completes while GitHub is still in flight.
		await watcher.pollOnce('mail')
		assert.equal(mail.calls(), 1)
		assert.deepEqual(
			db.signals.list({}, NOW).map(thread => thread.source),
			['mail'],
		)
		github.release()
		await Promise.all([first, second])
		assert.equal(db.signals.list({}, NOW).length, 2)
	}),
)

test(
	'disabled sources never read and report disabled health',
	withDb(async db => {
		const github = instantReader('github', ['github:acme/a#1'])
		const mail = instantReader('mail', ['mail:abc'])
		db.signals.setSourceHealth('github', 'ok', null, NOW, true)
		const off = new SignalsWatcher(config({ enabled: false, mail: { enabled: true } }), db, {
			github: github.reader,
			mail: mail.reader,
			now: () => NOW,
		})
		assert.equal(off.isEnabled('github'), false)
		await off.pollOnce()
		assert.equal(github.calls(), 0)
		assert.equal(mail.calls(), 0)
		assert.deepEqual(
			db.signals.sources().map(source => source.status),
			['disabled', 'disabled'],
		)

		// Mail is off by default; a missing reader counts as off too.
		const defaults = new SignalsWatcher(config(), db, { github: github.reader })
		assert.equal(defaults.isEnabled('github'), true)
		assert.equal(defaults.isEnabled('mail'), false)
		const stale = [
			{ source: 'github' as const, status: 'ok' as const, detail: null, lastPollAt: null, lastOkAt: null },
			{ source: 'mail' as const, status: 'error' as const, detail: 'old', lastPollAt: null, lastOkAt: null },
		]
		assert.deepEqual(
			defaults.health(stale).map(entry => [entry.status, entry.detail]),
			[
				['ok', null],
				['disabled', null],
			],
		)
	}),
)

test(
	'health from the reader is stored, and a partial result never closes threads',
	withDb(async db => {
		db.signals.applyPoll(result('github', ['github:acme/a#1', 'github:acme/a#2']), NOW)
		const partial = instantReader('github', ['github:acme/a#1'], { status: 'error', detail: 'rate limited' }, false)
		const watcher = new SignalsWatcher(config(), db, {
			github: partial.reader,
			now: () => NOW,
		})
		await watcher.pollOnce('github')
		await watcher.pollOnce('github')
		assert.equal(db.signals.list({}, NOW).filter(thread => thread.active).length, 2)
		const health = db.signals.sources()[0]
		assert.equal(health?.status, 'error')
		assert.equal(health?.detail, 'rate limited')
		assert.equal(health?.lastOkAt, null)

		const throwing: SignalReader = {
			source: 'github',
			read: async () => {
				throw new Error('boom')
			},
		}
		const broken = new SignalsWatcher(config(), db, {
			github: throwing,
			now: () => NOW,
		})
		await broken.pollOnce('github')
		assert.equal(db.signals.sources()[0]?.status, 'error')
	}),
)

test(
	'stop aborts and drains an in-flight tick without persisting it, then refuses admission',
	withDb(async db => {
		const github = gatedReader('github', ['github:acme/a#1'])
		const watcher = new SignalsWatcher(config(), db, {
			github: github.reader,
			now: () => NOW,
		})
		watcher.start()
		const deadline = Date.now() + 2_000
		while (github.calls.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
		assert.equal(github.calls.length, 1, 'start polls an enabled source at once')
		let drained = false
		const stopping = watcher.stop().then(() => {
			drained = true
		})
		assert.equal(github.calls[0]?.aborted, true)
		await new Promise(resolve => setTimeout(resolve, 10))
		assert.equal(drained, false, 'stop waits for the in-flight read')
		github.release()
		await stopping
		assert.equal(db.signals.list({}, NOW).length, 0, 'an aborted read is not persisted')
		await watcher.pollOnce('github')
		watcher.requestPoll()
		assert.equal(github.calls.length, 1, 'no admission after stop')
		assert.equal(watcher.stop(), watcher.stop())
	}),
)

test(
	'restartPoll drops a read begun under the old sender lists; the other source keeps its read',
	withDb(async db => {
		const github = gatedReader('github', ['github:acme/a#1'])
		const mail = gatedReader('mail', ['mail:abc'])
		const watcher = new SignalsWatcher(config({ mail: { enabled: true } }), db, {
			github: github.reader,
			mail: mail.reader,
			now: () => NOW,
		})
		watcher.start()
		const deadline = Date.now() + 2_000
		while ((github.calls.length === 0 || mail.calls.length === 0) && Date.now() < deadline)
			await new Promise(resolve => setTimeout(resolve, 5))
		// `x` muted a sender while this Mail read ran: it would report the muted thread again.
		watcher.restartPoll('mail')
		assert.equal(mail.calls[0]?.aborted, true)
		assert.equal(github.calls[0]?.aborted, false)
		mail.release()
		github.release()
		await new Promise(resolve => setTimeout(resolve, 20))
		assert.deepEqual(
			db.signals.list({}, NOW).map(thread => thread.source),
			['github'],
			'the stale Mail read is not persisted',
		)
		await watcher.stop()
		watcher.restartPoll('mail')
		assert.equal(mail.calls.length, 1, 'no admission after stop')
	}),
)

test(
	'manual polls are coalesced and spaced',
	withDb(async db => {
		const github = instantReader('github', ['github:acme/a#1'])
		const watcher = new SignalsWatcher(config(), db, {
			github: github.reader,
			now: () => NOW,
		})
		watcher.start()
		const deadline = Date.now() + 2_000
		while (github.calls() === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
		await new Promise(resolve => setTimeout(resolve, 20))
		assert.equal(github.calls(), 1)
		// Within the 15s gap of the start poll: nothing runs now, however often it is asked.
		watcher.requestPoll()
		watcher.requestPoll()
		await new Promise(resolve => setTimeout(resolve, 50))
		assert.equal(github.calls(), 1)
		await watcher.stop()
	}),
)

test(
	'a poll slower than its interval never overlaps the next; the next starts one interval after it settles; the other source keeps polling',
	withDb(async db => {
		const flush = () => new Promise(resolve => setImmediate(resolve))
		const mail = gatedReader('mail', ['mail:abc'])
		const github = instantReader('github', ['github:acme/a#1'])
		const watcher = new SignalsWatcher(
			config({ github: { pollSeconds: 30 }, mail: { enabled: true, pollSeconds: 30 } }),
			db,
			{ github: github.reader, mail: mail.reader, now: () => NOW },
		)
		// Mock after construction: only the watcher's timers, not the DB or setImmediate.
		const timers = (await import('node:test')).mock.timers
		timers.enable({ apis: ['setTimeout', 'Date'], now: NOW.getTime() })
		try {
			watcher.start()
			timers.tick(0)
			await flush()
			assert.equal(mail.calls.length, 1)
			assert.equal(github.calls(), 1)
			// Mail hangs for three of its intervals: no second Mail read, GitHub keeps its pace.
			for (let i = 0; i < 3; i++) {
				timers.tick(30_000)
				await flush()
			}
			assert.equal(mail.calls.length, 1)
			assert.equal(github.calls(), 4)
			// A manual poll during the slow read waits for it rather than starting a second one.
			watcher.requestPoll()
			await flush()
			assert.equal(mail.calls.length, 1)

			// Settled: the coalesced manual poll runs at once (the 15s gap since the slow poll began
			// has long passed), never alongside it.
			mail.release()
			await flush()
			timers.tick(0)
			await flush()
			assert.equal(mail.calls.length, 2)
			// The regular interval counts from when a poll settles.
			mail.release()
			await flush()
			timers.tick(29_999)
			await flush()
			assert.equal(mail.calls.length, 2)
			timers.tick(1)
			await flush()
			assert.equal(mail.calls.length, 3)
		} finally {
			timers.reset()
			const stopping = watcher.stop()
			try {
				mail.release()
			} catch {}
			await stopping
		}
	}),
)

test(
	'complete polls of both sources leave agent asks alone and report no agent health',
	withDb(async db => {
		const ask = db.signals.upsertAsk({ key: 'stays', title: 'Pick a variant' }, NOW).thread
		const github = instantReader('github', [])
		const mail = instantReader('mail', [])
		const watcher = new SignalsWatcher(config({ mail: { enabled: true } }), db, {
			github: github.reader,
			mail: mail.reader,
			now: () => NOW,
		})
		for (let n = 0; n < 3; n += 1) await watcher.pollOnce()
		assert.equal(github.calls(), 3)
		assert.equal(mail.calls(), 3)
		const after = db.signals.get(ask.id)
		assert.equal(after?.state, 'new')
		assert.equal(after?.active, true)
		const health = watcher.health(db.signals.sources())
		assert.deepEqual(
			health.map(entry => [entry.source, entry.status]),
			[
				['github', 'ok'],
				['mail', 'ok'],
			],
		)
	}),
)
