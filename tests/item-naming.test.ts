import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { resolveItemWorkspace } from '../src/items/identity.js'
import {
	ensureItemDisplayName,
	ensureItemWorkspaceName,
	parseBranchName,
	parseDisplayName,
} from '../src/items/naming.js'
import type { TaskContext } from '../src/providers/provider.js'
import { taskCancelled } from '../src/util/errors.js'

function makeConfig(overrides?: {
	branchNaming?: Partial<HelmConfig['solver']['branchNaming']>
	displayName?: Partial<HelmConfig['solver']['displayName']>
}): HelmConfig {
	return configSchema.parse({
		provider: {
			type: 'contember',
			apiBaseUrl: 'https://example.test',
			projectSlug: 'helm',
			apiToken: 'token',
		},
		projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
		solver: {
			type: 'default',
			agent: 'claude',
			branchNaming: { enabled: true, ...overrides?.branchNaming },
			displayName: { enabled: true, ...overrides?.displayName },
		},
	})
}

function withTempDb(fn: (db: DB) => Promise<void> | void) {
	const dir = mkdtempSync(join(tmpdir(), 'helm-naming-'))
	const db = new DB(join(dir, 'helm.db'))
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

test('parseBranchName extracts a name sharing a line with trailing text', () => {
	assert.deepEqual(parseBranchName('feat/add-thing (recommended)'), { type: 'feat', descriptionSlug: 'add-thing' })
	assert.deepEqual(parseBranchName('- fix/login-loop  # conventional name'), {
		type: 'fix',
		descriptionSlug: 'login-loop',
	})
})

test('parseBranchName prefers the last conventional line (codex echoes a name then answers)', () => {
	const raw = ['I see the repo has a feat/old-thing branch.', 'feat/add-real-answer'].join('\n')
	assert.deepEqual(parseBranchName(raw), { type: 'feat', descriptionSlug: 'add-real-answer' })
})

test('parseBranchName takes the last answer across match shapes (clean preamble then labeled answer)', () => {
	// Earlier clean whole-line name, later labeled/trailing answer — the last wins.
	const raw = ['feat/old', 'Branch name: fix/new'].join('\n')
	assert.deepEqual(parseBranchName(raw), { type: 'fix', descriptionSlug: 'new' })
})

test('parseBranchName ignores a slash buried in prose with a non-standard type', () => {
	assert.equal(parseBranchName('handle the and/or case here'), null)
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
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })

		const result = await ensureItemWorkspaceName({
			commands,
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

test('ensureItemWorkspaceName clamps an over-long model name to the whole-name budget', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })

		const longName = `refactor/${'extract-shared-validation-helpers-and-consolidate-everything'}`
		const result = await ensureItemWorkspaceName({
			commands,
			item,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			deps: { runOneShot: async () => longName, branchExists: () => false },
		})

		assert(result.branchName)
		assert.ok(result.branchName.length <= 50, `branch ${result.branchName} (${result.branchName.length}) exceeds 50`)
		assert.ok(result.branchName.startsWith('refactor/'))
		assert.ok(!result.branchName.endsWith('-'))
	}))

test('ensureItemWorkspaceName appends the id suffix on collision', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })

		const result = await ensureItemWorkspaceName({
			commands,
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

test('ensureItemWorkspaceName skips loop (ralph/harden) Items', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createRalphItem({ title: 'payments loop', projectSlug: 'helm', prdPath: 'docs/prd/pay.md' })

		let called = false
		const result = await ensureItemWorkspaceName({
			commands,
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
		assert.match(resolveItemWorkspace(result).branchName, /^helm\/item\//)
	}))

test('ensureItemWorkspaceName is a no-op when disabled', () =>
	withTempDb(async db => {
		const config = makeConfig({ branchNaming: { enabled: false } })
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })

		let called = false
		const result = await ensureItemWorkspaceName({
			commands,
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
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })

		const result = await ensureItemWorkspaceName({
			commands,
			item,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			deps: { runOneShot: async () => null, branchExists: () => false },
		})

		assert.equal(result.branchName, null)
		assert.match(resolveItemWorkspace(result).branchName, /^helm\/item\//)
	}))

test('ensureItemWorkspaceName swallows model errors and returns the input Item', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })

		const result = await ensureItemWorkspaceName({
			commands,
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
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })

		await assert.rejects(
			ensureItemWorkspaceName({
				commands,
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
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })
		db.items.update(item.id, { branchName: 'helm/item/preset-abcd1234' })
		const preset = commands.getItem(item.id)
		assert(preset)

		const result = await ensureItemWorkspaceName({
			commands,
			item: preset,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			deps: { runOneShot: async () => 'feat/should-not-apply', branchExists: () => false },
		})

		assert.equal(result.branchName, 'helm/item/preset-abcd1234')
		assert.equal(commands.getItem(item.id)?.branchName, 'helm/item/preset-abcd1234')
	}))

test('ensureItemWorkspaceName force re-derives even when disabled and already named', () =>
	withTempDb(async db => {
		// Manual dashboard trigger: branchNaming is OFF and the Item already has a
		// name — force must still run the model and overwrite.
		const config = makeConfig({ branchNaming: { enabled: false } })
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })
		db.items.update(item.id, { branchName: 'helm/item/preset-abcd1234' })
		const preset = commands.getItem(item.id)
		assert(preset)

		const result = await ensureItemWorkspaceName({
			commands,
			item: preset,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			force: true,
			deps: { runOneShot: async () => 'feat/fresh-name', branchExists: () => false },
		})

		assert.equal(result.branchName, 'feat/fresh-name')
		assert.equal(commands.getItem(item.id)?.branchName, 'feat/fresh-name')
	}))

test('ensureItemWorkspaceName force does NOT rename once a worktree exists (TOCTOU backstop)', () =>
	withTempDb(async db => {
		// Models the race: a concurrent solve created the worktree during the manual
		// rename's model await. recordDerivedWorkspaceName re-fetches the row and
		// refuses the write even though force is set, so the worktree can't desync.
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })
		db.items.update(item.id, { worktreePath: '/tmp/wt-created-concurrently' })
		const withWorktree = commands.getItem(item.id)
		assert(withWorktree)

		const result = await ensureItemWorkspaceName({
			commands,
			item: withWorktree,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			force: true,
			deps: { runOneShot: async () => 'feat/should-not-apply', branchExists: () => false },
		})

		assert.equal(result.branchName, null) // refused despite force — worktree present
		assert.equal(commands.getItem(item.id)?.branchName, null)
	}))

test('ensureItemWorkspaceName force still skips loop Items (structural gate)', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createRalphItem({ title: 'payments loop', projectSlug: 'helm', prdPath: 'docs/prd/pay.md' })

		let called = false
		const result = await ensureItemWorkspaceName({
			commands,
			item,
			taskContext,
			config,
			repoPath: '/repo',
			agent: 'claude',
			force: true,
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
	}))

test('ensureItemWorkspaceName force throws on an unparseable model answer', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })

		await assert.rejects(
			ensureItemWorkspaceName({
				commands,
				item,
				taskContext,
				config,
				repoPath: '/repo',
				agent: 'claude',
				force: true,
				deps: { runOneShot: async () => 'I cannot help with that.', branchExists: () => false },
			}),
			/could not parse a branch name/i,
		)
	}))

// --- display naming -------------------------------------------------------

const LONG_TITLE = '[Echo] Please remove the operative crane exchange from the catalog view'

test('parseDisplayName strips quotes, a label echo, and a trailing period', () => {
	assert.equal(parseDisplayName('Short title: "Unify invoice recipient logic."'), 'Unify invoice recipient logic')
	assert.equal(parseDisplayName('`Remove crane exchange`'), 'Remove crane exchange')
})

test('parseDisplayName takes the last non-empty line past preamble', () => {
	const raw = ['thinking...', 'Here is a title:', 'Fix chart total mismatch'].join('\n')
	assert.equal(parseDisplayName(raw), 'Fix chart total mismatch')
})

test('parseDisplayName clamps to the word budget', () => {
	assert.equal(
		parseDisplayName('one two three four five six seven eight nine ten'),
		'one two three four five six seven eight',
	)
})

test('parseDisplayName returns null when empty', () => {
	assert.equal(parseDisplayName(''), null)
	assert.equal(parseDisplayName('   \n  '), null)
})

test('ensureItemDisplayName persists a short AI display name', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: LONG_TITLE, projectSlug: 'helm', prompt: 'do it' })

		const result = await ensureItemDisplayName({
			commands,
			item,
			config,
			deps: { runOneShot: async () => 'Remove operative crane exchange' },
		})

		assert.equal(result.displayName, 'Remove operative crane exchange')
		assert.equal(commands.getItem(item.id)?.displayName, 'Remove operative crane exchange')
	}))

test('ensureItemDisplayName skips an already-short title (no model call)', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'Fix login', projectSlug: 'helm', prompt: 'do it' })

		let called = false
		const result = await ensureItemDisplayName({
			commands,
			item,
			config,
			deps: {
				runOneShot: async () => {
					called = true
					return 'X'
				},
			},
		})

		assert.equal(called, false)
		assert.equal(result.displayName, null)
	}))

test('ensureItemDisplayName is a no-op when displayNames is disabled', () =>
	withTempDb(async db => {
		const config = makeConfig({ displayName: { enabled: false } })
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: LONG_TITLE, projectSlug: 'helm', prompt: 'do it' })

		let called = false
		const result = await ensureItemDisplayName({
			commands,
			item,
			config,
			deps: {
				runOneShot: async () => {
					called = true
					return 'X'
				},
			},
		})

		assert.equal(called, false)
		assert.equal(result.displayName, null)
	}))

test('ensureItemDisplayName swallows model errors and keeps the raw title', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: LONG_TITLE, projectSlug: 'helm', prompt: 'do it' })

		const result = await ensureItemDisplayName({
			commands,
			item,
			config,
			deps: {
				runOneShot: async () => {
					throw new Error('boom')
				},
			},
		})

		assert.equal(result.displayName, null)
		assert.equal(commands.getItem(item.id)?.displayName, null)
	}))

test('ensureItemDisplayName does not override an existing display name', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: LONG_TITLE, projectSlug: 'helm', prompt: 'do it' })
		commands.recordDisplayName(item.id, 'Preset name')
		const preset = commands.getItem(item.id)
		assert(preset)

		let called = false
		const result = await ensureItemDisplayName({
			commands,
			item: preset,
			config,
			deps: {
				runOneShot: async () => {
					called = true
					return 'New name'
				},
			},
		})

		assert.equal(called, false)
		assert.equal(result.displayName, 'Preset name')
	}))

test('ensureItemDisplayName force overrides an existing name and runs on a short title', () =>
	withTempDb(async db => {
		// Manual trigger on an already-named Item with a SHORT title — force skips
		// both the already-named and short-title gates and re-runs the model.
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'Fix login', projectSlug: 'helm', prompt: 'do it' })
		commands.recordDisplayName(item.id, 'Preset name')
		const preset = commands.getItem(item.id)
		assert(preset)

		const result = await ensureItemDisplayName({
			commands,
			item: preset,
			config,
			force: true,
			deps: { runOneShot: async () => 'Fresh short label' },
		})

		assert.equal(result.displayName, 'Fresh short label')
		assert.equal(commands.getItem(item.id)?.displayName, 'Fresh short label')
	}))

test('ensureItemDisplayName force throws on a model failure (manual run surfaces it)', () =>
	withTempDb(async db => {
		const config = makeConfig()
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: LONG_TITLE, projectSlug: 'helm', prompt: 'do it' })

		await assert.rejects(
			ensureItemDisplayName({
				commands,
				item,
				config,
				force: true,
				deps: {
					runOneShot: async () => {
						throw new Error('boom')
					},
				},
			}),
			/boom/,
		)
	}))

test('ensureItemDisplayName threads a custom prompt and provider override', () =>
	withTempDb(async db => {
		const config = makeConfig({ displayName: { prompt: 'CUSTOM-INSTRUCTIONS-HERE', agent: 'codex' } })
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: LONG_TITLE, projectSlug: 'helm', prompt: 'do it' })

		let seenAgent: string | undefined
		let seenPrompt = ''
		await ensureItemDisplayName({
			commands,
			item,
			config,
			deps: {
				runOneShot: async opts => {
					seenAgent = opts.agent
					seenPrompt = opts.prompt
					return 'Some short name'
				},
			},
		})

		assert.equal(seenAgent, 'codex') // per-feature provider override wins
		assert.ok(seenPrompt.includes('CUSTOM-INSTRUCTIONS-HERE')) // custom instructions used
		assert.ok(seenPrompt.includes('Please remove the operative')) // task data still injected by code
	}))
