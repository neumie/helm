import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { itemWantsAssessment } from '../src/items/assess.js'
import { ItemCommands } from '../src/items/commands.js'
import { ItemEnricher } from '../src/items/enricher.js'
import { itemWantsDisplayName } from '../src/items/naming.js'
import type { ItemRecord } from '../src/items/schema.js'
import type { OneShotOptions } from '../src/solver/one-shot.js'

function makeConfig(over?: { displayName?: boolean; triage?: boolean }): HelmConfig {
	return {
		provider: {
			type: 'contember',
			apiBaseUrl: 'https://example.test',
			projectSlug: 'helm',
			apiToken: 'token',
			statuses: ['new'],
		},
		projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
		polling: { intervalSeconds: 60 },
		solver: {
			type: 'default',
			agent: 'claude',
			concurrency: 2,
			timeoutMinutes: 30,
			branchNaming: { enabled: false },
			displayName: { enabled: over?.displayName ?? true },
			triage: { enabled: over?.triage ?? true },
		},
		spawner: { name: 'default' },
		server: { port: 7474, host: 'localhost' },
		github: {
			createPrs: false,
			postComments: true,
			prPrefix: '[Helm]',
			trackDeployments: false,
			deployPollSeconds: 120,
		},
	}
}

const provider = {
	name: 'Contember',
	pollNewTasks: async () => [],
	getTaskContext: async () => null,
	resolveTaskSummary: async () => null,
	postComment: async () => null,
} as never

function fakeItem(over: Partial<ItemRecord>): ItemRecord {
	return {
		id: 'x',
		kind: 'solve',
		status: 'triage',
		projectSlug: 'helm',
		title: 't',
		displayName: null,
		assessment: null,
		source: { provider: 'Email', externalId: 'email:x' },
		capturedContext: null,
		...over,
	} as ItemRecord
}

const LONG_TITLE = 'Assign customers to projects from the attached Excel by their IČO number'
const VALID_ASSESSMENT = JSON.stringify({
	intent: 'Assign customers to projects',
	verdict: 'clear',
	clarifyingQuestions: [],
	securityNote: null,
})

function withTempDb(fn: (db: DB) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), 'helm-enrich-'))
	const db = new DB(join(dir, 'helm.db'))
	return Promise.resolve(fn(db)).finally(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})
}

test('itemWantsDisplayName mirrors the skip gates', () => {
	const cfg = makeConfig()
	assert.equal(itemWantsDisplayName(fakeItem({ title: LONG_TITLE }), cfg), true)
	assert.equal(itemWantsDisplayName(fakeItem({ title: 'short title' }), cfg), false) // ≤40 chars → never wanted
	assert.equal(itemWantsDisplayName(fakeItem({ title: LONG_TITLE, displayName: 'Set' }), cfg), false)
	assert.equal(itemWantsDisplayName(fakeItem({ title: LONG_TITLE }), makeConfig({ displayName: false })), false)
})

test('itemWantsAssessment mirrors the skip gates', () => {
	const cfg = makeConfig()
	assert.equal(itemWantsAssessment(fakeItem({}), cfg), true)
	assert.equal(itemWantsAssessment(fakeItem({ assessment: { verdict: 'clear' } as never }), cfg), false)
	assert.equal(itemWantsAssessment(fakeItem({}), makeConfig({ triage: false })), false)
})

test('enricher retries a transient one-shot failure and eventually enriches', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const item = new ItemCommands(db.items, config).createSolveItem({
			projectSlug: 'helm',
			title: LONG_TITLE,
			prompt: 'body',
			source: { provider: 'Email', externalId: 'email:retry-1' },
			capturedContext: { title: LONG_TITLE, description: 'Fill companies by IČO.' },
		})

		// Fail (return null) the first 2 one-shot calls (transient timeout), then succeed.
		let calls = 0
		const runOneShot = async (opts: OneShotOptions): Promise<string | null> => {
			calls++
			if (calls <= 2) return null
			return opts.prompt.includes('Short title:') ? 'Assign customers to projects' : VALID_ASSESSMENT
		}

		const enricher = new ItemEnricher(config, db.items, provider, 3, {
			deps: { runOneShot, now: () => '2026-06-30T00:00:00.000Z' },
			retryDelaysMs: [10, 10, 10],
		})
		try {
			enricher.enqueue([item])
			let final: ItemRecord | null = null
			for (let i = 0; i < 100; i++) {
				const cur = db.items.get(item.id)
				if (cur?.assessment && cur.displayName) {
					final = cur
					break
				}
				await sleep(10)
			}
			assert.ok(final, 'item enriched within the retry window')
			assert.equal(final.displayName, 'Assign customers to projects')
			assert.equal(final.assessment?.verdict, 'clear')
			assert.ok(calls >= 3, 'retried after the transient failures')
		} finally {
			enricher.stop()
		}
	}))

test('enricher gives up after the retry cap when failures persist', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const item = new ItemCommands(db.items, config).createSolveItem({
			projectSlug: 'helm',
			title: LONG_TITLE,
			prompt: 'body',
			source: { provider: 'Email', externalId: 'email:retry-2' },
			capturedContext: { title: LONG_TITLE },
		})

		let calls = 0
		const runOneShot = async (): Promise<string | null> => {
			calls++
			return null // never succeeds
		}

		// 2 retries → 3 total enrichOne runs → 6 one-shot calls (display + assessment each), then stop.
		const enricher = new ItemEnricher(config, db.items, provider, 3, {
			deps: { runOneShot },
			retryDelaysMs: [10, 10],
		})
		try {
			enricher.enqueue([item])
			await sleep(200) // well past the [10,10] backoff window
			assert.equal(db.items.get(item.id)?.assessment, null)
			assert.equal(calls, 6, 'exactly 3 runs (1 initial + 2 retries), then gave up')
		} finally {
			enricher.stop()
		}
	}))
