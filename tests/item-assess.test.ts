import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ensureItemAssessment, parseAssessment } from '../src/items/assess.js'
import { ItemCommands } from '../src/items/commands.js'
import type { TaskContext } from '../src/providers/provider.js'
import type { OneShotImage } from '../src/solver/one-shot.js'
import { taskCancelled } from '../src/util/errors.js'

function makeConfig(triage?: Partial<HelmConfig['solver']['triage']>): HelmConfig {
	return configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
		projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
		solver: { type: 'default', agent: 'claude', triage: { enabled: true, ...triage } },
	})
}

function withTempDb(fn: (db: DB) => Promise<void> | void) {
	const dir = mkdtempSync(join(tmpdir(), 'helm-assess-'))
	const db = new DB(join(dir, 'helm.db'))
	return Promise.resolve(fn(db)).finally(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})
}

const ctx: TaskContext = { title: 'Invoice recipient', description: 'The invoice recipient should be unified.' }

const VALID = JSON.stringify({
	intent: 'Unify the invoice recipient',
	verdict: 'clear',
	clarifyingQuestions: [],
	securityNote: null,
})

test('parseAssessment reads a clean JSON object', () => {
	const a = parseAssessment(VALID)
	assert(a)
	assert.equal(a.verdict, 'clear')
	assert.equal(a.intent, 'Unify the invoice recipient')
})

test('parseAssessment extracts JSON from markdown fences and surrounding prose', () => {
	const raw = `Here is the assessment:\n\`\`\`json\n${VALID}\n\`\`\`\nDone.`
	const a = parseAssessment(raw)
	assert(a)
	assert.equal(a.verdict, 'clear')
})

test('parseAssessment returns null on invalid JSON or wrong shape', () => {
	assert.equal(parseAssessment('not json'), null)
	assert.equal(parseAssessment('{"verdict":"bogus"}'), null)
	assert.equal(parseAssessment(''), null)
})

test('ensureItemAssessment persists a parsed assessment with a stamped assessedAt', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Invoice recipient',
			projectSlug: 'helm',
			prompt: 'x',
			source: { provider: 'contember', externalId: 'e1' },
		})

		const result = await ensureItemAssessment({
			commands,
			item,
			taskContext: ctx,
			config,
			deps: { runOneShot: async () => VALID, now: () => '2026-06-30T00:00:00.000Z' },
		})

		assert.equal(result.assessment?.verdict, 'clear')
		assert.equal(result.assessment?.assessedAt, '2026-06-30T00:00:00.000Z')
		assert.equal(commands.getItem(item.id)?.assessment?.intent, 'Unify the invoice recipient')
	}))

test('ensureItemAssessment sends fetched screenshots to the model for the claude agent', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'x',
			projectSlug: 'helm',
			prompt: 'x',
			source: { provider: 'contember', externalId: 'e1' },
		})
		let seen: OneShotImage[] | undefined
		await ensureItemAssessment({
			commands,
			item,
			taskContext: ctx,
			config,
			deps: {
				fetchImages: async () => [{ data: 'AAAA', mediaType: 'image/png' }],
				runOneShot: async opts => {
					seen = opts.images
					return VALID
				},
			},
		})
		assert.equal(seen?.length, 1)
		assert.equal(seen?.[0].mediaType, 'image/png')
	}))

test('ensureItemAssessment does not fetch or send images for the codex agent', () =>
	withTempDb(async db => {
		const config = makeConfig({ agent: 'codex' })
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'x',
			projectSlug: 'helm',
			prompt: 'x',
			source: { provider: 'contember', externalId: 'e1' },
		})
		let fetched = false
		let seen: OneShotImage[] | undefined = undefined
		await ensureItemAssessment({
			commands,
			item,
			taskContext: ctx,
			config,
			deps: {
				fetchImages: async () => {
					fetched = true
					return [{ data: 'AAAA', mediaType: 'image/png' }]
				},
				runOneShot: async opts => {
					seen = opts.images
					return VALID
				},
			},
		})
		assert.equal(fetched, false)
		assert.deepEqual(seen, [])
	}))

test('ensureItemAssessment is a no-op when triage is disabled', () =>
	withTempDb(async db => {
		const config = makeConfig({ enabled: false })
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'x', projectSlug: 'helm', prompt: 'x' })

		let called = false
		const result = await ensureItemAssessment({
			commands,
			item,
			taskContext: ctx,
			config,
			deps: {
				runOneShot: async () => {
					called = true
					return VALID
				},
			},
		})

		assert.equal(called, false)
		assert.equal(result.assessment, null)
	}))

test('ensureItemAssessment does not re-assess an already-assessed Item', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'x', projectSlug: 'helm', prompt: 'x' })
		commands.recordAssessment(item.id, {
			intent: 'preset',
			verdict: 'clear',
			clarifyingQuestions: [],
			securityNote: null,
			assessedAt: '2026-01-01T00:00:00.000Z',
		})
		const preset = commands.getItem(item.id)
		assert(preset)

		let called = false
		const result = await ensureItemAssessment({
			commands,
			item: preset,
			taskContext: ctx,
			config,
			deps: {
				runOneShot: async () => {
					called = true
					return VALID
				},
			},
		})

		assert.equal(called, false)
		assert.equal(result.assessment?.intent, 'preset')
	}))

test('ensureItemAssessment swallows model errors and leaves no assessment', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'x', projectSlug: 'helm', prompt: 'x' })

		const result = await ensureItemAssessment({
			commands,
			item,
			taskContext: ctx,
			config,
			deps: {
				runOneShot: async () => {
					throw new Error('boom')
				},
			},
		})

		assert.equal(result.assessment, null)
		assert.equal(commands.getItem(item.id)?.assessment, null)
	}))

test('ensureItemAssessment re-throws cancellation', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'x', projectSlug: 'helm', prompt: 'x' })

		await assert.rejects(
			ensureItemAssessment({
				commands,
				item,
				taskContext: ctx,
				config,
				deps: {
					runOneShot: async () => {
						throw taskCancelled()
					},
				},
			}),
			/cancelled/i,
		)
	}))

test('ensureItemAssessment force re-assesses when disabled and already assessed', () =>
	withTempDb(async db => {
		// Manual trigger: triage OFF and the Item already has an assessment — force
		// runs anyway and overwrites the verdict.
		const config = makeConfig({ enabled: false })
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'x', projectSlug: 'helm', prompt: 'x' })
		commands.recordAssessment(item.id, {
			intent: 'preset',
			verdict: 'clear',
			clarifyingQuestions: [],
			securityNote: null,
			assessedAt: '2026-01-01T00:00:00.000Z',
		})
		const preset = commands.getItem(item.id)
		assert(preset)

		const fresh = JSON.stringify({
			intent: 'Touches CI secrets',
			verdict: 'security',
			clarifyingQuestions: [],
			securityNote: 'Asks to modify a workflow file',
		})
		const result = await ensureItemAssessment({
			commands,
			item: preset,
			taskContext: ctx,
			config,
			force: true,
			deps: { runOneShot: async () => fresh, now: () => '2026-06-30T00:00:00.000Z' },
		})

		assert.equal(result.assessment?.verdict, 'security')
		assert.equal(commands.getItem(item.id)?.assessment?.intent, 'Touches CI secrets')
	}))

test('ensureItemAssessment force throws on an unparseable answer', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'x', projectSlug: 'helm', prompt: 'x' })

		await assert.rejects(
			ensureItemAssessment({
				commands,
				item,
				taskContext: ctx,
				config,
				force: true,
				deps: { runOneShot: async () => 'not json at all' },
			}),
			/could not parse an assessment/i,
		)
	}))
