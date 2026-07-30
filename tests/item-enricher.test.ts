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
import { ensureItemDisplayName, itemWantsDisplayName, itemWantsWorkspaceName } from '../src/items/naming.js'
import type { ItemRecord } from '../src/items/schema.js'
import type { OneShotOptions } from '../src/solver/one-shot.js'

function makeConfig(over?: { branchNaming?: boolean; displayName?: boolean; triage?: boolean }): HelmConfig {
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
			workspace: 'worktree',
			concurrency: 2,
			timeoutMinutes: 30,
			branchNaming: { enabled: over?.branchNaming ?? false },
			displayName: { enabled: over?.displayName ?? true },
			triage: { enabled: over?.triage ?? true },
			modelGuidance: {},
		},
		spawner: { name: 'default' },
		scheduledRuns: { enabled: false, systemTargetsEnabled: false },
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
		status: 'inbox',
		projectSlug: 'helm',
		title: 't',
		displayName: null,
		assessment: null,
		source: { provider: 'Email', externalId: 'email:x' },
		capturedContext: null,
		payload: { kind: 'solve', prompt: 'test' },
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

test('display naming cannot publish output from a title changed during draft assignment', async () => {
	await withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const draft = commands.createSolveItem({
			title: LONG_TITLE,
			projectSlug: null,
			prompt: 'Captured before choosing a project.',
		})
		let resolveName: ((value: string) => void) | undefined
		const naming = ensureItemDisplayName({
			commands,
			item: draft,
			config,
			deps: {
				runOneShot: () =>
					new Promise<string>(resolve => {
						resolveName = resolve
					}),
			},
		})

		commands.assignItem(draft.id, { projectSlug: 'helm', title: 'Use the final assigned title' })
		resolveName?.('Stale generated title')
		const result = await naming
		assert.equal(result.title, 'Use the final assigned title')
		assert.equal(result.displayName, null)
		assert.equal(commands.getItem(draft.id)?.displayName, null)
	})
})

test('itemWantsAssessment mirrors the skip gates', () => {
	const cfg = makeConfig()
	assert.equal(itemWantsAssessment(fakeItem({}), cfg), true)
	assert.equal(itemWantsAssessment(fakeItem({ assessment: { verdict: 'clear' } as never }), cfg), false)
	assert.equal(itemWantsAssessment(fakeItem({}), makeConfig({ triage: false })), false)
	assert.equal(itemWantsAssessment(fakeItem({ projectSlug: null, baseRef: null, source: null }), cfg), false)
})

test('itemWantsWorkspaceName only prewarms runnable worktree solve Items', () => {
	const cfg = makeConfig({ branchNaming: true })
	assert.equal(itemWantsWorkspaceName(fakeItem({}), cfg), true)
	assert.equal(itemWantsWorkspaceName(fakeItem({ branchName: 'fix/already-named' }), cfg), false)
	assert.equal(itemWantsWorkspaceName(fakeItem({ status: 'running' }), cfg), false)
	assert.equal(
		itemWantsWorkspaceName(
			fakeItem({ payload: { kind: 'solve', prompt: 'x', solverWorkspace: 'main' } as never }),
			cfg,
		),
		false,
	)
	assert.equal(itemWantsWorkspaceName(fakeItem({}), makeConfig({ branchNaming: false })), false)
	assert.equal(
		itemWantsWorkspaceName(fakeItem({ projectSlug: null, baseRef: null, source: null, status: 'ready' }), cfg),
		false,
	)
})

test('startup backfill includes source and manual Queue branches but excludes running Items', () =>
	withTempDb(async db => {
		const config = makeConfig({ branchNaming: true, displayName: false, triage: false })
		const commands = new ItemCommands(db.items, config)
		const sourceItem = commands.createSolveItem({
			projectSlug: 'helm',
			title: 'Backfill source branch name',
			prompt: 'Prewarm this source Item.',
			source: { provider: 'Email', externalId: 'email:backfill-branch' },
			capturedContext: { title: 'Backfill source branch name' },
		})
		const manualItem = commands.createSolveItem({
			projectSlug: 'helm',
			title: 'Backfill manual branch name',
			prompt: 'Prewarm this manual Item.',
		})
		const activeManualItem = commands.createSolveItem({
			projectSlug: 'helm',
			title: 'Human-owned active Item',
			prompt: 'Do not prewarm after manual ownership begins.',
		})
		commands.setItemStatus(activeManualItem.id, 'active')
		commands.createLoopItem({
			projectSlug: 'helm',
			title: 'Loop is not AI named',
			prdPath: 'docs/plans/not-an-enrichment-target/prd.md',
		})
		commands.recordDisplayName(sourceItem.id, 'Backfill source branch')
		commands.recordAssessment(sourceItem.id, {
			intent: 'Prewarm this source Item',
			verdict: 'clear',
			clarifyingQuestions: [],
			securityNote: null,
			assessedAt: '2026-07-21T00:00:00.000Z',
		})
		assert.deepEqual(
			db.items
				.listItemsNeedingEnrichment()
				.map(candidate => candidate.id)
				.sort((a, b) => a.localeCompare(b)),
			[sourceItem.id, manualItem.id].sort((a, b) => a.localeCompare(b)),
		)

		commands.startItem(sourceItem.id)
		commands.startItem(manualItem.id)
		assert.deepEqual(db.items.listItemsNeedingEnrichment(), [])
	}))

test('enricher precomputes a source Item branch before Start agent', () =>
	withTempDb(async db => {
		const config = makeConfig({ branchNaming: true, displayName: false, triage: false })
		const item = new ItemCommands(db.items, config).createSolveItem({
			projectSlug: 'helm',
			title: 'Fix delayed workspace visibility',
			prompt: 'Open the Okena workspace without waiting on branch naming.',
			source: { provider: 'Email', externalId: 'email:prewarm-branch' },
			capturedContext: { title: 'Fix delayed workspace visibility' },
		})
		let calls = 0
		const enricher = new ItemEnricher(config, db.items, provider, 1, {
			deps: {
				runOneShot: async () => {
					calls++
					return 'fix/prewarm-okena-workspace'
				},
				branchExists: async () => false,
			},
			retryDelaysMs: [],
		})
		try {
			enricher.enqueue([item])
			for (let i = 0; i < 50 && !db.items.get(item.id)?.branchName; i++) await sleep(10)
			assert.equal(db.items.get(item.id)?.branchName, 'fix/prewarm-okena-workspace')
			assert.equal(calls, 1, 'branch naming completed in the background before execution')
		} finally {
			enricher.stop()
		}
	}))

test('enricher precomputes a manual Queue Item display name before Start agent', () =>
	withTempDb(async db => {
		const config = makeConfig({ branchNaming: false, displayName: true, triage: false })
		const item = new ItemCommands(db.items, config).createSolveItem({
			projectSlug: 'helm',
			title: 'Use a concise display name for this manually created queued solve Item',
			prompt: 'Keep the raw task title canonical.',
		})
		const enricher = new ItemEnricher(config, db.items, provider, 1, {
			deps: { runOneShot: async () => 'Concise manual Item' },
			retryDelaysMs: [],
		})
		try {
			enricher.enqueue([item])
			for (let i = 0; i < 50 && !db.items.get(item.id)?.displayName; i++) await sleep(10)
			assert.equal(db.items.get(item.id)?.displayName, 'Concise manual Item')
		} finally {
			enricher.stop()
		}
	}))

test('enricher precomputes a manual Queue Item branch before Start agent', () =>
	withTempDb(async db => {
		const config = makeConfig({ branchNaming: true, displayName: false, triage: false })
		const item = new ItemCommands(db.items, config).createSolveItem({
			projectSlug: 'helm',
			title: 'Use descriptive manual worktree',
			prompt: 'Name this hand-added task before it starts.',
		})
		let prompt = ''
		const enricher = new ItemEnricher(config, db.items, provider, 1, {
			deps: {
				runOneShot: async opts => {
					prompt = opts.prompt
					return 'feat/name-manual-worktree'
				},
				branchExists: async () => false,
			},
			retryDelaysMs: [],
		})
		try {
			enricher.enqueue([item])
			for (let i = 0; i < 50 && !db.items.get(item.id)?.branchName; i++) await sleep(10)
			assert.equal(db.items.get(item.id)?.branchName, 'feat/name-manual-worktree')
			assert.match(prompt, /Name this hand-added task before it starts/)
		} finally {
			enricher.stop()
		}
	}))

test('late branch prewarming cannot rename a manual Item after execution starts', () =>
	withTempDb(async db => {
		const config = makeConfig({ branchNaming: true, displayName: false, triage: false })
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			projectSlug: 'helm',
			title: 'Start during manual branch prewarm',
			prompt: 'Keep execution identity stable.',
		})
		let finishNaming: ((value: string) => void) | undefined
		let markNamingStarted: (() => void) | undefined
		const namingStarted = new Promise<void>(resolve => {
			markNamingStarted = resolve
		})
		const enricher = new ItemEnricher(config, db.items, provider, 1, {
			deps: {
				runOneShot: () =>
					new Promise<string>(finish => {
						finishNaming = finish
						markNamingStarted?.()
					}),
				branchExists: async () => false,
			},
			retryDelaysMs: [],
		})

		try {
			enricher.enqueue([item])
			await namingStarted
			commands.startItem(item.id)
			finishNaming?.('fix/too-late-to-apply')
			await sleep(30)
			assert.equal(db.items.get(item.id)?.branchName, null)
		} finally {
			enricher.stop()
		}
	}))

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
