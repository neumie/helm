import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import type { VigilConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { resolveItemWorkspace } from '../src/items/identity.js'
import { ensureItemWorkspaceName, parseBranchName } from '../src/items/naming.js'
import type { TaskContext } from '../src/providers/provider.js'
import { taskCancelled } from '../src/util/errors.js'

function makeConfig(overrides?: Partial<VigilConfig['solver']['nameModel']>): VigilConfig {
	return configSchema.parse({
		provider: {
			type: 'contember',
			apiBaseUrl: 'https://example.test',
			projectSlug: 'vigil',
			apiToken: 'token',
		},
		projects: [{ slug: 'vigil', repoPath: '/repo', baseBranch: 'main' }],
		solver: { type: 'default', agent: 'claude', nameModel: { enabled: true, ...overrides } },
	})
}

function withTempDb(fn: (db: DB) => Promise<void> | void) {
	const dir = mkdtempSync(join(tmpdir(), 'vigil-naming-'))
	const db = new DB(join(dir, 'vigil.db'))
	return Promise.resolve(fn(db)).finally(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})
}

const taskContext: TaskContext = { title: 'Fix the login redirect loop' }

test('parseBranchName accepts a clean conventional name', () => {
	assert.deepEqual(parseBranchName('feat/add-ai-branch-naming'), {
		type: 'feat',
		descriptionSlug: 'add-ai-branch-naming',
	})
})

test('parseBranchName tolerates quotes, backticks, and a label echo', () => {
	assert.deepEqual(parseBranchName('Branch name: `fix/login-redirect`'), {
		type: 'fix',
		descriptionSlug: 'login-redirect',
	})
})

test('parseBranchName strips trailing sentence punctuation', () => {
	assert.deepEqual(parseBranchName('feat/add-thing.'), { type: 'feat', descriptionSlug: 'add-thing' })
	assert.deepEqual(parseBranchName('(fix/redirect-loop).'), { type: 'fix', descriptionSlug: 'redirect-loop' })
})

test('parseBranchName scans past codex preamble/log noise', () => {
	const raw = ['[2026-06-25] codex session started', 'thinking...', 'chore/cleanup-config', 'tokens used: 412'].join(
		'\n',
	)
	assert.deepEqual(parseBranchName(raw), { type: 'chore', descriptionSlug: 'cleanup-config' })
})

test('parseBranchName drops an unknown type but keeps the slug', () => {
	assert.deepEqual(parseBranchName('wip/some-thing'), { descriptionSlug: 'some-thing' })
})

test('parseBranchName returns null when nothing is branch-shaped', () => {
	assert.equal(parseBranchName('I cannot help with that.'), null)
	assert.equal(parseBranchName(''), null)
})

test('ensureItemWorkspaceName persists and returns a derived branch and plan dir', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'vigil', prompt: 'do it' })

		const result = await ensureItemWorkspaceName({
			commands,
			store: db.items,
			item,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			deps: { runOneShot: async () => 'feat/fix-login-redirect', branchExists: () => false },
		})

		// Returned item carries the name — no reload needed at the call site.
		assert.equal(result.branchName, 'feat/fix-login-redirect')
		assert.match(result.planDirName ?? '', /^\d{4}-\d{2}-\d{2}-fix-login-redirect-/)
		assert.equal(resolveItemWorkspace(result).branchName, 'feat/fix-login-redirect')

		const persisted = commands.getItem(item.id)
		assert.equal(persisted?.branchName, 'feat/fix-login-redirect')
	}))

test('ensureItemWorkspaceName appends the id suffix on collision', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'vigil', prompt: 'do it' })

		const result = await ensureItemWorkspaceName({
			commands,
			store: db.items,
			item,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			deps: {
				runOneShot: async () => 'feat/fix-login-redirect',
				branchExists: branch => branch === 'feat/fix-login-redirect',
			},
		})

		assert.match(result.branchName ?? '', /^feat\/fix-login-redirect-[a-z0-9]+$/)
		assert.notEqual(result.branchName, 'feat/fix-login-redirect')
	}))

test('ensureItemWorkspaceName is a no-op when disabled', () =>
	withTempDb(async db => {
		const config = makeConfig({ enabled: false })
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'vigil', prompt: 'do it' })

		let called = false
		const result = await ensureItemWorkspaceName({
			commands,
			store: db.items,
			item,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			deps: {
				runOneShot: async () => {
					called = true
					return 'feat/x'
				},
				branchExists: () => false,
			},
		})

		assert.equal(called, false)
		assert.equal(result.branchName, null)
		assert.equal(commands.getItem(item.id)?.branchName, null)
	}))

test('ensureItemWorkspaceName leaves the default when the model returns nothing', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'vigil', prompt: 'do it' })

		const result = await ensureItemWorkspaceName({
			commands,
			store: db.items,
			item,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			deps: { runOneShot: async () => null, branchExists: () => false },
		})

		assert.equal(result.branchName, null)
		assert.match(resolveItemWorkspace(result).branchName, /^vigil\/item\//)
	}))

test('ensureItemWorkspaceName swallows model errors and returns the input Item', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'vigil', prompt: 'do it' })

		const result = await ensureItemWorkspaceName({
			commands,
			store: db.items,
			item,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			deps: {
				runOneShot: async () => {
					throw new Error('boom')
				},
				branchExists: () => false,
			},
		})

		assert.equal(result.branchName, null)
		assert.equal(commands.getItem(item.id)?.branchName, null)
	}))

test('ensureItemWorkspaceName re-throws cancellation so the pipeline aborts promptly', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'vigil', prompt: 'do it' })

		await assert.rejects(
			ensureItemWorkspaceName({
				commands,
				store: db.items,
				item,
				taskContext,
				config,
				repoPath: '/repo',
				agent: 'claude',
				deps: {
					runOneShot: async () => {
						throw taskCancelled()
					},
					branchExists: () => false,
				},
			}),
			/cancelled/i,
		)
		assert.equal(commands.getItem(item.id)?.branchName, null)
	}))

test('ensureItemWorkspaceName does not override an already-named Item', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'vigil', prompt: 'do it' })
		db.items.update(item.id, { branchName: 'vigil/item/preset-abcd1234' })
		const preset = commands.getItem(item.id)
		assert(preset)

		const result = await ensureItemWorkspaceName({
			commands,
			store: db.items,
			item: preset,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			deps: { runOneShot: async () => 'feat/should-not-apply', branchExists: () => false },
		})

		assert.equal(result.branchName, 'vigil/item/preset-abcd1234')
		assert.equal(commands.getItem(item.id)?.branchName, 'vigil/item/preset-abcd1234')
	}))
