import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { dispatchSolveItem } from '../src/actions/dispatcher.js'
import {
	CONFIG_SECRET_REDACTION,
	buildConfigDocument,
	configSchemaAcceptsPath,
	unknownConfigPaths,
} from '../src/config-document.js'
import { configSchema } from '../src/config.js'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { DeployWatcher, httpUrlOrNull, parsePrUrl } from '../src/github/deploy-watcher.js'
import { ItemCommands } from '../src/items/commands.js'
import { toDashboardItem, toDashboardItems } from '../src/items/contract.js'
import { resolveItemWorkspace } from '../src/items/identity.js'
import { observeItemRun } from '../src/items/observation.js'
import { PlanWorkspace } from '../src/plan/workspace.js'
import { Poller } from '../src/poller/poller.js'
import { Drainer } from '../src/queue/drainer.js'
import { AlmanacLoopRunner } from '../src/queue/loop-runner.js'
import type { LoopRunParams, LoopRunResult, LoopRunner } from '../src/queue/loop-runner.js'
import { processRalphItem, processSolveItem } from '../src/queue/worker.js'
import { apiRoutes } from '../src/server/routes/api.js'
import { createAgentAdapter } from '../src/solver/agent-adapter.js'
import { buildPrompt } from '../src/solver/prompt-builder.js'
import type { SolveParams, SolveResult, Solver } from '../src/solver/solver.js'
import {
	createSpawner,
	createSpawnerRegistry,
	listSpawnerAdapters,
	spawnerNameSchema,
} from '../src/spawner/registry.js'
import type { PlanningSessionParams, PlanningSessionResult, Spawner } from '../src/spawner/spawner.js'
import type { SolverResult as SolverResultFile } from '../src/types.js'
import { phaseError, taskCancelled } from '../src/util/errors.js'
import { createWorktree, withRepoLock } from '../src/worktree/manager.js'

// apiRoutes takes an ItemEnricher (used only by the ingest route); these route
// tests don't ingest, so a no-op enqueue stub is enough.
const fakeEnricher = { enqueue() {} }

function withTempDb(fn: (db: DB) => Promise<void> | void) {
	const dir = mkdtempSync(join(tmpdir(), 'helm-items-'))
	const db = new DB(join(dir, 'helm.db'))
	return Promise.resolve(fn(db)).finally(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})
}

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const config: HelmConfig = {
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
		displayName: { enabled: false },
		triage: { enabled: false },
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

const queue = {
	getStatus: () => ({ paused: false, pending: 0, active: 0, maxConcurrency: 2, activeTasks: [] }),
	enqueue: () => undefined,
	processOne: () => true,
	processOneItem: () => true,
	cancel: () => false,
	cancelItem: () => false,
	retryItem: () => {
		throw new Error('not implemented')
	},
	pause: () => undefined,
	resume: () => undefined,
	wake: () => undefined,
}

const poller = { pollOnce: async () => undefined }
const provider = {
	name: 'fake',
	pollNewTasks: async () => [],
	getTaskContext: async () => null,
	resolveTaskSummary: async () => null,
	postComment: async () => undefined,
}
const spawner = {
	name: 'fake',
	startPlanningSession: async () => {
		throw new Error('not implemented')
	},
}

function configEditPathArrays(document: ReturnType<typeof buildConfigDocument>): string[][] {
	return document.edit.sections.flatMap(section =>
		section.controls.flatMap(control => {
			if (control.type === 'field') return [control.path]
			return control.fields.map(field => [...control.path, '*', ...field.path])
		}),
	)
}

function configEditPaths(document: ReturnType<typeof buildConfigDocument>): string[] {
	return configEditPathArrays(document).map(path => path.join('.'))
}

test('DB migration drops legacy Task + chat storage, keeps Items and poll_state', () => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-schema-reset-'))
	const dbPath = join(dir, 'helm.db')
	const db = new DB(dbPath)
	db.close()

	const sqlite = new Database(dbPath, { readonly: true })
	try {
		const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
			name: string
		}>
		const tableNames = tables.map(table => table.name)
		// Legacy Task model is gone.
		assert.equal(tableNames.includes('tasks'), false)
		assert.equal(tableNames.includes('event_log'), false)
		assert.equal(tableNames.includes('chat_sessions'), false)
		assert.equal(tableNames.includes('chat_messages'), false)
		// Item model + provider watermark survive.
		assert.equal(tableNames.includes('items'), true)
		assert.equal(tableNames.includes('item_events'), true)
		assert.equal(tableNames.includes('poll_state'), true)
	} finally {
		sqlite.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

test('Drainer defaults to running and persists a deliberate pause across restarts', () =>
	withTempDb(db => {
		const fresh = new Drainer(config, db, provider, {} as never)
		assert.equal(fresh.isPaused(), false) // default: running

		fresh.pause()
		assert.equal(fresh.isPaused(), true)

		// A new Drainer on the same DB (simulating a daemon restart) stays paused.
		const restarted = new Drainer(config, db, provider, {} as never)
		assert.equal(restarted.isPaused(), true)

		restarted.resume()
		const afterResume = new Drainer(config, db, provider, {} as never)
		assert.equal(afterResume.isPaused(), false)
	}))

test('unknownConfigPaths flags config keys the schema does not recognize', () => {
	const base = {
		provider: { type: 'contember', apiBaseUrl: 'https://x.test', projectSlug: 'v', apiToken: 't' },
		projects: [{ slug: 'v', repoPath: '/r' }],
	}
	assert.deepEqual(unknownConfigPaths(base), [])
	assert.deepEqual(unknownConfigPaths({ ...base, solver: { concurrency: 4 } }), [])
	assert.deepEqual(unknownConfigPaths({ ...base, solver: { setupDelaySeconds: 9 }, bogus: 1 }), [
		'solver.setupDelaySeconds',
		'bogus',
	])
})

class FakeSolveSolver implements Solver {
	readonly calls: SolveParams[] = []
	maxConcurrent = 0
	private active = 0

	constructor(
		private readonly worktreeRoot: string,
		private readonly delayMs = 0,
		private readonly resultPatch: Partial<SolverResultFile> = {},
	) {}

	async solve(params: SolveParams): Promise<SolveResult> {
		this.calls.push(params)
		this.active++
		this.maxConcurrent = Math.max(this.maxConcurrent, this.active)
		try {
			if (this.delayMs > 0) await sleep(this.delayMs)
			const worktreePath = params.existingWorktreePath ?? join(this.worktreeRoot, params.taskId)
			mkdirSync(worktreePath, { recursive: true })
			const workspace = new PlanWorkspace(worktreePath, params.planDirName)
			workspace.ensureDir()
			writeFileSync(
				workspace.resultPath,
				JSON.stringify({
					summary: `Solved ${params.taskTitle}`,
					filesChanged: ['src/example.ts'],
					...this.resultPatch,
				}),
				'utf-8',
			)
			return {
				worktreePath,
				branchName: params.branchName,
				outcome: {
					exitCode: 0,
					events: [{ type: 'command', detail: `ran ${params.taskTitle}` }],
					rawOutput: 'ok',
				},
			}
		} finally {
			this.active--
		}
	}
}

class SnapshotMutatingSolver implements Solver {
	constructor(private readonly worktreeRoot: string) {}

	async solve(params: SolveParams): Promise<SolveResult> {
		const worktreePath = params.existingWorktreePath ?? join(this.worktreeRoot, params.taskId)
		mkdirSync(worktreePath, { recursive: true })
		const workspace = new PlanWorkspace(worktreePath, params.planDirName)
		const prompt = buildPrompt(params.taskContext, { planDirName: params.planDirName, worktreePath })
		const snapshot = (params as { onPromptSnapshot?: (prompt: string) => void }).onPromptSnapshot
		snapshot?.(prompt)
		workspace.writeReadme('AFTER snapshot artifact')
		writeFileSync(
			workspace.resultPath,
			JSON.stringify({ summary: `Solved ${params.taskTitle}`, filesChanged: ['src/example.ts'] }),
			'utf-8',
		)
		return {
			worktreePath,
			branchName: params.branchName,
			outcome: {
				exitCode: 0,
				events: [],
			},
		}
	}
}

class CancellingWorktreeSolver implements Solver {
	constructor(private readonly worktreeRoot: string) {}

	async solve(params: SolveParams): Promise<SolveResult> {
		const worktreePath = join(this.worktreeRoot, params.taskId)
		mkdirSync(worktreePath, { recursive: true })
		params.onWorktreeReady?.(worktreePath)
		throw taskCancelled()
	}
}

class FakePlanningSpawner implements Spawner {
	readonly calls: PlanningSessionParams[] = []

	constructor(
		private readonly worktreeRoot: string,
		readonly name = 'fake',
	) {}

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		this.calls.push(params)
		const worktreePath = params.existingWorktreePath ?? join(this.worktreeRoot, params.branchName.replace(/\//g, '-'))
		mkdirSync(worktreePath, { recursive: true })
		const workspace = new PlanWorkspace(worktreePath, params.planDirName)
		workspace.writeContext(
			`Task: ${params.taskContext.title}\n\nDescription:\n${params.taskContext.description ?? ''}\n`,
		)
		workspace.writePlanningPrompt('fake planning prompt')
		return {
			worktreePath,
			branchName: params.branchName,
			hint: `planned ${params.taskTitle}`,
		}
	}
}

class FakeLoopRunner implements LoopRunner {
	readonly calls: LoopRunParams[] = []

	get ralphCalls(): LoopRunParams[] {
		return this.calls.filter(call => call.payload.kind === 'ralph')
	}

	get hardenCalls(): LoopRunParams[] {
		return this.calls.filter(call => call.payload.kind === 'harden')
	}

	constructor(
		private readonly delayMs = 0,
		private readonly runId = 'loop-run-1',
	) {}

	async runLoop(params: LoopRunParams): Promise<LoopRunResult> {
		this.calls.push(params)
		params.onRunId(this.runId)
		if (this.delayMs > 0) await sleep(this.delayMs)
		return { runId: this.runId, exitCode: 0 }
	}
}

class FailingLoopRunner implements LoopRunner {
	async runLoop(params: LoopRunParams): Promise<LoopRunResult> {
		params.onRunId(`${params.payload.kind}-failed-run`)
		throw phaseError('loop', `${params.payload.kind} runner failed`)
	}
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (assertion()) return
		await sleep(10)
	}
	throw new Error(message)
}

test('Config Document redacts dashboard config and validates edit metadata against schema paths', () => {
	const document = buildConfigDocument(
		{
			...config,
			provider: { ...config.provider, apiToken: 'secret-token', taskBaseUrl: 'https://tasks.example.test/' },
			solver: { ...config.solver, transformer: 'stale-transformer' },
		},
		config,
	)

	assert.equal('apiToken' in document.dashboard.provider, false)
	assert.equal(document.dashboard.taskBaseUrl, 'https://tasks.example.test/')
	assert.deepEqual(document.dashboard.spawner, { name: 'default' })
	assert.deepEqual(document.dashboard.spawnerAdapters, listSpawnerAdapters())
	assert.equal((document.dashboard.solver as Record<string, unknown>).transformer, undefined)
	assert.equal((document.config.solver as Record<string, unknown>).transformer, undefined)
	assert.equal(document.config.provider.apiToken, CONFIG_SECRET_REDACTION)

	const editablePaths = configEditPaths(document)
	assert.ok(!editablePaths.includes('solver.transformer'))
	assert.ok(editablePaths.includes('spawner.name'))
	assert.ok(editablePaths.includes('provider.apiToken'))
	assert.deepEqual(
		// Validate on segment arrays — model ids in record keys contain dots.
		configEditPathArrays(document)
			.filter(path => !configSchemaAcceptsPath(path))
			.map(path => path.join('.')),
		[],
	)
})

test('Agent Adapter selects command shape, labels, interactive commands, and timeline parsing', () => {
	const claude = createAgentAdapter({ ...config.solver, agent: 'claude', model: 'claude-opus-4' })
	assert.equal(claude.agent, 'claude')
	assert.equal(claude.label, 'Claude Code')
	assert.deepEqual(claude.buildHeadlessInvocation(), {
		command: 'claude',
		args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--model', 'claude-opus-4'],
		label: 'claude-invoker',
	})
	assert.deepEqual(
		claude.parseTimeline(
			JSON.stringify([
				{ type: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
			]),
		),
		[{ type: 'command', detail: 'npm test' }],
	)

	const codex = createAgentAdapter({ ...config.solver, agent: 'codex', model: 'gpt-5' })
	assert.equal(codex.agent, 'codex')
	assert.equal(codex.label, 'Codex')
	assert.deepEqual(codex.buildHeadlessInvocation(), {
		command: 'codex',
		args: [
			'exec',
			'--dangerously-bypass-approvals-and-sandbox',
			'--sandbox',
			'danger-full-access',
			'-',
			'--model',
			'gpt-5',
		],
		label: 'codex-invoker',
	})
	assert.deepEqual(codex.parseTimeline('codex raw output'), [])
	assert.equal(
		codex.buildInteractiveCommand('docs/plans/demo/.planning-prompt.txt', '/tmp/work tree'),
		"cd '/tmp/work tree' && 'codex' '--dangerously-bypass-approvals-and-sandbox' '--sandbox' 'danger-full-access' '--model' 'gpt-5' \"$(cat 'docs/plans/demo/.planning-prompt.txt')\"",
	)
})

test('config routes use Config Document and preserve redacted secrets while rejecting stale fields', async () => {
	await withTempDb(async db => {
		const dir = mkdtempSync(join(tmpdir(), 'helm-config-document-'))
		const configPath = join(dir, 'helm.config.json')
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					...config,
					provider: { ...config.provider, apiToken: 'secret-token' },
					solver: { ...config.solver, transformer: 'stale-transformer' },
				},
				null,
				'\t',
			),
			'utf-8',
		)
		const api = apiRoutes(
			config,
			configPath,
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const safeRes = await api.request('/config')
		assert.equal(safeRes.status, 200)
		const safeBody = (await safeRes.json()) as { data: ReturnType<typeof buildConfigDocument>['dashboard'] }
		assert.equal('apiToken' in safeBody.data.provider, false)
		assert.deepEqual(safeBody.data.spawner, { name: 'default' })
		assert.deepEqual(safeBody.data.spawnerAdapters, listSpawnerAdapters())
		assert.equal((safeBody.data.solver as Record<string, unknown>).transformer, undefined)

		const fullRes = await api.request('/config/full')
		assert.equal(fullRes.status, 200)
		const fullBody = (await fullRes.json()) as { data: ReturnType<typeof buildConfigDocument> }
		assert.equal(fullBody.data.config.provider.apiToken, CONFIG_SECRET_REDACTION)
		assert.ok(!configEditPaths(fullBody.data).includes('solver.transformer'))

		const update = structuredClone(fullBody.data.config) as Record<string, unknown>
		const polling = update.polling as Record<string, unknown>
		polling.intervalSeconds = 120
		const solver = update.solver as Record<string, unknown>
		solver.transformer = 'stale-transformer'

		const updateRes = await api.request('/config', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(update),
		})

		assert.equal(updateRes.status, 400)
		const failedUpdate = (await updateRes.json()) as { error: string; details: { formErrors: string[] } }
		assert.equal(failedUpdate.error, 'Validation failed')
		assert.match(failedUpdate.details.formErrors.join('\n'), /Unknown config field: solver\.transformer/)
		const unchanged = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
		const unchangedSolver = unchanged.solver as Record<string, unknown> | undefined
		assert.equal(unchangedSolver?.transformer, 'stale-transformer')

		update.solver = Object.fromEntries(Object.entries(solver).filter(([key]) => key !== 'transformer'))
		const cleanUpdateRes = await api.request('/config', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(update),
		})

		assert.equal(cleanUpdateRes.status, 200)
		const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
		const savedProvider = saved.provider as Record<string, unknown> | undefined
		const savedSolver = saved.solver as Record<string, unknown> | undefined
		const savedSpawner = saved.spawner as Record<string, unknown> | undefined
		const savedPolling = saved.polling as Record<string, unknown> | undefined
		assert.equal(savedProvider?.apiToken, 'secret-token')
		assert.equal(savedSolver?.transformer, undefined)
		assert.equal(savedSpawner?.name, 'default')
		assert.equal(savedPolling?.intervalSeconds, 120)

		rmSync(dir, { recursive: true, force: true })
	})
})

test('ItemCommands creates queued source-less solve Items with default BaseRef', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)

		const item = commands.createSolveItem({
			title: 'Ship AFK dashboard',
			projectSlug: 'helm',
			prompt: 'Build the new Item dashboard.',
		})

		assert.equal(item.kind, 'solve')
		assert.equal(item.status, 'ready')
		assert.equal(item.projectSlug, 'helm')
		assert.equal(item.title, 'Ship AFK dashboard')
		assert.equal(item.baseRef, 'main')
		assert.equal(item.source, null)
		assert.deepEqual(item.payload, { kind: 'solve', prompt: 'Build the new Item dashboard.' })

		const roundTripped = db.items.get(item.id)
		assert.deepEqual(roundTripped, item)
	})
})

test('CLI add posts to the running daemon (headless) and creates queued Item kinds', async () => {
	// Headless control plane: `helm add` is a pure HTTP client. Stand up the real
	// /api routes on an ephemeral port, point the CLI at it via $HELM_URL, and
	// assert the daemon (not the CLI) wrote the rows. The CLI never opens the DB —
	// it does not read HELM_CONFIG or run from the repo cwd.
	const dir = mkdtempSync(join(tmpdir(), 'helm-cli-add-'))
	const db = new DB(join(dir, 'helm.db'))
	const app = new Hono()
	app.route(
		'/api',
		apiRoutes(
			config,
			join(dir, 'helm.config.json'),
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		),
	)
	// port 0 → OS-assigned; execFile (async) keeps the event loop free so this
	// in-process server can answer the subprocess's request (execFileSync would deadlock).
	const server = await new Promise<{ close: () => void; port: number }>(res => {
		const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: { port: number }) =>
			res({ close: () => s.close(), port: info.port }),
		)
	})
	const execFileAsync = promisify(execFile)
	const cliPath = resolve('src/cli/helm.ts')
	const tsxBin = resolve('node_modules/.bin/tsx')
	// No cwd / HELM_CONFIG — only the daemon URL. Proves it runs from anywhere.
	const env = { ...process.env, HELM_URL: `http://127.0.0.1:${server.port}` }
	const run = (extra: string[]) => execFileAsync(tsxBin, [cliPath, 'add', ...extra], { env })

	try {
		await run([
			'solve',
			'--project',
			'helm',
			'--title',
			'CLI solve',
			'--prompt',
			'Ship a CLI-created solve.',
			'--base-ref',
			'feature/base',
			'--parallelism',
			'2',
		])
		await run([
			'ralph',
			'--project',
			'helm',
			'--title',
			'CLI ralph',
			'--prd-path',
			'docs/plans/afk-rework/prd.md',
			'--mode',
			'afk',
			'--provider',
			'codex',
			'--iterations',
			'3',
			'--no-oversee',
		])
		await run(['harden', '--project', 'helm', '--title', 'CLI harden', '--target', 'src/items', '--rounds', '2'])

		const items = db.items.list({ projectSlug: 'helm', limit: 10 })
		const solveItems = items.filter(item => item.title === 'CLI solve')
		assert.equal(solveItems.length, 2)
		assert.equal(new Set(solveItems.map(item => item.groupId)).size, 1)
		assert.ok(solveItems[0].groupId)
		assert.equal(solveItems[0].status, 'ready')
		assert.equal(solveItems[0].baseRef, 'feature/base')
		assert.deepEqual(solveItems[0].payload, {
			kind: 'solve',
			prompt: 'Ship a CLI-created solve.',
		})

		const ralph = items.find(item => item.title === 'CLI ralph')
		assert.ok(ralph)
		assert.equal(ralph.status, 'ready')
		assert.deepEqual(ralph.payload, {
			kind: 'ralph',
			prdPath: 'docs/plans/afk-rework/prd.md',
			mode: 'afk',
			provider: 'codex',
			iterations: 3,
			noOversee: true,
		})

		const harden = items.find(item => item.title === 'CLI harden')
		assert.ok(harden)
		assert.equal(harden.status, 'ready')
		assert.deepEqual(harden.payload, {
			kind: 'harden',
			target: 'src/items',
			rounds: 2,
		})
	} finally {
		server.close()
		db.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

test('ItemCommands fans out solve Items with shared GroupId and independent lifecycle', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)

		const items = commands.createSolveItems({
			title: 'Parallel solve attempt',
			projectSlug: 'helm',
			prompt: 'Try several implementations.',
			parallelism: 3,
		})

		assert.equal(items.length, 3)
		assert.equal(new Set(items.map(item => item.id)).size, 3)
		assert.equal(new Set(items.map(item => item.groupId)).size, 1)
		assert.ok(items[0].groupId)
		assert.deepEqual(
			items.map(item => item.status),
			['ready', 'ready', 'ready'],
		)
		assert.equal(new Set(items.map(item => resolveItemWorkspace(item).branchName)).size, 3)

		commands.startItem(items[0].id)
		commands.failItem(items[0].id, 'attempt failed', 'solve')
		commands.cancelQueuedItem(items[1].id)
		commands.startItem(items[2].id)
		commands.completeSolveItem(items[2].id, {
			worktreePath: '/tmp/helm-parallel-3',
			branchName: 'helm/item/parallel-3',
			planDirName: 'parallel-3',
			resultSummary: 'third attempt ready',
		})
		assert.equal(db.items.get(items[0].id)?.status, 'failed')
		assert.equal(db.items.get(items[1].id)?.status, 'cancelled')
		assert.equal(db.items.get(items[2].id)?.status, 'review')
		const retried = commands.retryItem(items[1].id)
		assert.equal(retried.status, 'ready')
		assert.equal(retried.groupId, items[1].groupId)

		const stored = items.map(item => {
			const reloaded = db.items.get(item.id)
			assert.ok(reloaded)
			return reloaded
		})
		assert.deepEqual(
			stored.map(item => item.status),
			['failed', 'ready', 'review'],
		)
		assert.deepEqual(
			stored.map(item => item.resultSummary),
			[null, null, 'third attempt ready'],
		)
	})
})

test('ItemCommands only cancels processing Items through the processing cancellation path', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Guard processing cancel',
			projectSlug: 'helm',
			prompt: 'Do not cancel this through the active-run path.',
		})

		assert.throws(
			() => commands.cancelProcessingItem(item.id, 'cancelled from wrong state', 'solve'),
			/Only running Items can be cancelled during execution/,
		)
		assert.equal(db.items.get(item.id)?.status, 'ready')

		commands.startItem(item.id)
		const cancelled = commands.cancelProcessingItem(item.id, 'cancelled while running', 'solve')
		assert.equal(cancelled.status, 'cancelled')
		assert.equal(cancelled.errorPhase, 'solve')
	})
})

test('ItemCommands only fails processing Items through the execution failure path', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Guard processing failure',
			projectSlug: 'helm',
			prompt: 'Do not fail this through the active-run path.',
		})

		assert.throws(
			() => commands.failItem(item.id, 'failed from wrong state', 'solve'),
			/Only running Items can fail during execution/,
		)
		assert.equal(db.items.get(item.id)?.status, 'ready')

		commands.startItem(item.id)
		const failed = commands.failItem(item.id, 'failed while running', 'solve')
		assert.equal(failed.status, 'failed')
		assert.equal(failed.errorPhase, 'solve')
	})
})

test('ItemCommands only completes processing Items through execution completion paths', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const solve = commands.createSolveItem({
			title: 'Guard solve completion',
			projectSlug: 'helm',
			prompt: 'Do not complete this before execution starts.',
		})
		const loop = commands.createRalphItem({
			title: 'Guard loop completion',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})

		assert.throws(
			() =>
				commands.completeSolveItem(solve.id, {
					worktreePath: '/tmp/helm-guard-solve',
					branchName: 'helm/item/guard-solve',
					planDirName: 'guard-solve',
					resultSummary: 'Should not complete',
				}),
			/Only running solve Items can complete through Solver/,
		)
		assert.equal(db.items.get(solve.id)?.status, 'ready')
		assert.throws(
			() => commands.completeLoopItem(loop.id, { resultSummary: 'Should not complete' }),
			/Only running loop Items can complete through almanac/,
		)
		assert.equal(db.items.get(loop.id)?.status, 'ready')

		commands.startItem(solve.id)
		const completedSolve = commands.completeSolveItem(solve.id, {
			worktreePath: '/tmp/helm-guard-solve',
			branchName: 'helm/item/guard-solve',
			planDirName: 'guard-solve',
			resultSummary: 'Solve completion guarded',
		})
		assert.equal(completedSolve.status, 'review')

		commands.startItem(loop.id)
		const completedLoop = commands.completeLoopItem(loop.id, { resultSummary: 'Loop completion guarded' })
		assert.equal(completedLoop.status, 'done')
	})
})

test('ItemCommands only records AlmanacRunId for processing loop Items', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createRalphItem({
			title: 'Guard loop run id',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})

		assert.throws(
			() => commands.recordAlmanacRunId(item.id, 'ralph-guard-run-1'),
			/Only running loop Items can record AlmanacRunId/,
		)
		assert.equal(db.items.get(item.id)?.almanacRunId, null)
		assert.deepEqual(db.items.getEvents(item.id), [])

		commands.startItem(item.id)
		const updated = commands.recordAlmanacRunId(item.id, 'ralph-guard-run-1')
		assert.equal(updated.almanacRunId, 'ralph-guard-run-1')
		assert.deepEqual(
			db.items.getEvents(item.id).map(event => event.eventType),
			['item_started', 'almanac_run_started'],
		)
	})
})

test('ItemCommands only records solve input snapshots for processing solve Items', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Guard solve snapshot',
			projectSlug: 'helm',
			prompt: 'Do not snapshot this before execution starts.',
		})

		assert.throws(
			() => commands.recordSolveInputSnapshot(item.id, 'queued prompt snapshot'),
			/Only running solve Items can record solve input snapshots/,
		)
		assert.equal(db.items.get(item.id)?.solveInputSnapshot, null)

		commands.startItem(item.id)
		const updated = commands.recordSolveInputSnapshot(item.id, 'processing prompt snapshot')
		assert.equal(updated.solveInputSnapshot, 'processing prompt snapshot')
	})
})

test('ItemCommands only records dispatch PRs for review solve Items', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Guard dispatch PR',
			projectSlug: 'helm',
			prompt: 'Do not record PR dispatch before solve completion.',
		})
		const prUrl = 'https://github.com/neumie/helm/pull/204'

		assert.throws(() => commands.recordDispatchPr(item.id, { prUrl }), /Only review solve Items can record PR dispatch/)
		assert.equal(db.items.get(item.id)?.prUrl, null)
		assert.deepEqual(db.items.getEvents(item.id), [])

		commands.startItem(item.id)
		assert.throws(() => commands.recordDispatchPr(item.id, { prUrl }), /Only review solve Items can record PR dispatch/)

		commands.completeSolveItem(item.id, {
			worktreePath: '/tmp/helm-guard-dispatch',
			branchName: 'helm/item/guard-dispatch',
			planDirName: 'guard-dispatch',
			resultSummary: 'Ready for dispatch',
		})
		const updated = commands.recordDispatchPr(item.id, { prUrl, shippedByAgent: true })

		assert.equal(updated.prUrl, prUrl)
		assert.deepEqual(
			db.items.getEvents(item.id).map(event => event.eventType),
			['item_started', 'solve_completed', 'pr_created'],
		)
	})
})

test('ItemCommands only records dispatch events for review solve Items', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Guard dispatch events',
			projectSlug: 'helm',
			prompt: 'Do not record dispatch events before solve completion.',
		})
		const loop = commands.createRalphItem({
			title: 'No loop dispatch events',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})

		assert.throws(
			() => commands.recordDispatchSkipped(item.id, 'github.createPrs disabled'),
			/Only review solve Items can record dispatch skips/,
		)
		assert.throws(
			() => commands.recordDispatchComment(item.id, 'comment-queued'),
			/Only review solve Items can record dispatch comments/,
		)
		assert.throws(() => commands.recordActionCompleted(loop.id), /Only review solve Items can record action completion/)
		assert.deepEqual(db.items.getEvents(item.id), [])
		assert.deepEqual(db.items.getEvents(loop.id), [])

		commands.startItem(item.id)
		assert.throws(() => commands.recordActionCompleted(item.id), /Only review solve Items can record action completion/)

		commands.completeSolveItem(item.id, {
			worktreePath: '/tmp/helm-guard-dispatch-events',
			branchName: 'helm/item/guard-dispatch-events',
			planDirName: 'guard-dispatch-events',
			resultSummary: 'Ready for dispatch events',
		})
		commands.recordDispatchSkipped(item.id, 'github.createPrs disabled')
		commands.recordDispatchComment(item.id, 'comment-review')
		commands.recordActionCompleted(item.id)

		assert.deepEqual(
			db.items.getEvents(item.id).map(event => event.eventType),
			['item_started', 'solve_completed', 'dispatch_skipped', 'comment_posted', 'action_completed'],
		)
	})
})

test('ItemCommands only records generic run events for matching Item lifecycles', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const solve = commands.createSolveItem({
			title: 'Guard generic solve events',
			projectSlug: 'helm',
			prompt: 'Do not record solve events outside a solve run.',
		})
		const loop = commands.createRalphItem({
			title: 'Guard generic loop events',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})

		assert.throws(
			() => commands.recordEvent(solve.id, 'solve_command', { detail: 'npm test' }),
			/Only running solve Items can record solve events/,
		)
		commands.startItem(loop.id)
		assert.throws(
			() => commands.recordEvent(loop.id, 'solve_command', { detail: 'npm test' }),
			/Only running solve Items can record solve events/,
		)
		assert.equal(
			db.items.getEvents(solve.id).some(event => event.eventType === 'solve_command'),
			false,
		)
		assert.equal(
			db.items.getEvents(loop.id).some(event => event.eventType === 'solve_command'),
			false,
		)

		commands.startItem(solve.id)
		commands.recordEvent(solve.id, 'solve_command', { detail: 'npm test' })
		assert.throws(
			() => commands.recordEvent(solve.id, 'dispatch_failed', { error: 'network failed' }),
			/Only review solve Items can record dispatch failures/,
		)
		commands.completeSolveItem(solve.id, {
			worktreePath: '/tmp/helm-guard-generic-events',
			branchName: 'helm/item/guard-generic-events',
			planDirName: 'guard-generic-events',
			resultSummary: 'Ready for dispatch',
		})
		commands.recordEvent(solve.id, 'dispatch_failed', { error: 'network failed' })

		assert.deepEqual(
			db.items.getEvents(solve.id).map(event => event.eventType),
			['item_started', 'solve_command', 'solve_completed', 'dispatch_failed'],
		)
	})
})

test('ItemCommands rejects reserved lifecycle events through generic recordEvent', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Guard reserved generic events',
			projectSlug: 'helm',
			prompt: 'Do not forge lifecycle events through recordEvent.',
		})
		const reservedEvents = [
			'item_approved',
			'item_rejected',
			'item_started',
			'item_retried',
			'item_recovered',
			'item_cancelled',
			'item_failed',
			'solve_completed',
			'almanac_run_started',
			'loop_completed',
			'plan_prepared',
			'pr_created',
			'comment_posted',
			'dispatch_skipped',
			'action_completed',
		]

		for (const eventType of reservedEvents) {
			assert.throws(
				() => commands.recordEvent(item.id, eventType, { forged: true }),
				new RegExp(`Use the dedicated ItemCommands method to record ${eventType}`),
			)
		}

		assert.deepEqual(db.items.getEvents(item.id), [])
	})
})

test('ItemCommands records plan preparation through the planning lifecycle path', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Prepare plan through commands',
			projectSlug: 'helm',
			prompt: 'Keep planning lifecycle writes behind ItemCommands.',
		})
		const planned = commands.recordPlanPrepared(item.id, {
			worktreePath: '/tmp/helm-plan-command',
			branchName: 'helm/item/plan-command',
			planDirName: 'plan-command',
			spawner: 'default',
		})

		assert.equal(planned.worktreePath, '/tmp/helm-plan-command')
		assert.equal(planned.branchName, 'helm/item/plan-command')
		assert.equal(planned.planDirName, 'plan-command')
		assert.deepEqual(
			db.items.getEvents(item.id).map(event => event.eventType),
			['plan_prepared'],
		)

		commands.startItem(item.id)
		assert.throws(
			() =>
				commands.recordPlanPrepared(item.id, {
					worktreePath: '/tmp/helm-plan-command-2',
					branchName: 'helm/item/plan-command-2',
					planDirName: 'plan-command-2',
					spawner: 'default',
				}),
			/Running Items cannot be planned/,
		)
		assert.equal(db.items.get(item.id)?.worktreePath, '/tmp/helm-plan-command')
	})
})

test('ItemCommands only records execution workspace identity for processing Items', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Guard execution workspace identity',
			projectSlug: 'helm',
			prompt: 'Do not persist execution identity before execution starts.',
		})

		assert.throws(
			() =>
				commands.recordExecutionWorkspaceIdentity(item.id, {
					worktreePath: '/tmp/helm-execution-workspace',
					branchName: 'helm/item/execution-workspace',
					planDirName: 'execution-workspace',
				}),
			/Only running Items can record execution workspace identity/,
		)
		assert.equal(db.items.get(item.id)?.worktreePath, null)

		commands.startItem(item.id)
		const updated = commands.recordExecutionWorkspaceIdentity(item.id, {
			worktreePath: '/tmp/helm-execution-workspace',
			branchName: 'helm/item/execution-workspace',
			planDirName: 'execution-workspace',
		})

		assert.equal(updated.worktreePath, '/tmp/helm-execution-workspace')
		assert.equal(updated.branchName, 'helm/item/execution-workspace')
		assert.equal(updated.planDirName, 'execution-workspace')
	})
})

test('server creates queued ralph Items with PRD path and almanac flags', async () => {
	await withTempDb(async db => {
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request('/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'ralph',
				title: 'Run AFK PRD',
				projectSlug: 'helm',
				prdPath: 'docs/plans/afk-rework/prd.md',
				baseRef: 'release/afk',
				mode: 'afk',
				provider: 'codex',
				model: 'gpt-5',
				effort: 'high',
				iterations: 3,
				noOversee: true,
			}),
		})

		assert.equal(res.status, 201)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem> }
		assert.equal(body.data.kind, 'ralph')
		assert.equal(body.data.status, 'ready')
		assert.equal(body.data.baseRef, 'release/afk')

		const stored = db.items.get(body.data.id)
		assert.deepEqual(stored?.payload, {
			kind: 'ralph',
			prdPath: 'docs/plans/afk-rework/prd.md',
			mode: 'afk',
			provider: 'codex',
			model: 'gpt-5',
			effort: 'high',
			iterations: 3,
			noOversee: true,
		})
	})
})

test('server creates parallel solve Items through dashboard contract', async () => {
	await withTempDb(async db => {
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request('/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'solve',
				title: 'Parallel API solve',
				projectSlug: 'helm',
				prompt: 'Create multiple attempts.',
				parallelism: 2,
			}),
		})

		assert.equal(res.status, 201)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem>[] }
		assert.equal(body.data.length, 2)
		assert.equal(new Set(body.data.map(item => item.id)).size, 2)
		assert.equal(new Set(body.data.map(item => item.groupId)).size, 1)
		assert.ok(body.data[0].groupId)
		assert.deepEqual(body.data[0].group, {
			id: body.data[0].groupId,
			label: 'Group 1/2',
			position: 1,
			size: 2,
			siblingIds: body.data.map(item => item.id),
		})
		assert.deepEqual(body.data[1].group, {
			id: body.data[0].groupId,
			label: 'Group 2/2',
			position: 2,
			size: 2,
			siblingIds: body.data.map(item => item.id),
		})
		assert.deepEqual(
			body.data.map(item => item.status),
			['ready', 'ready'],
		)
		assert.equal(db.items.list({ projectSlug: 'helm' }).length, 2)
	})
})

test('server creates plan-intent Items without enqueueing execution', async () => {
	await withTempDb(async db => {
		let wakeCount = 0
		const trackingQueue = {
			...queue,
			wake: () => {
				wakeCount++
			},
			processOneItem: () => true,
		}
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			trackingQueue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request('/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'solve',
				title: 'Plan before queue',
				projectSlug: 'helm',
				prompt: 'Prepare plan artifacts first.',
				intent: 'plan',
			}),
		})

		assert.equal(res.status, 201)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem> }
		assert.equal(body.data.status, 'triage')
		assert.equal(body.data.queuedAt, null)
		assert.deepEqual(
			body.data.allowedActions.map(action => action.id),
			['start', 'cancel'],
		)
		assert.equal(wakeCount, 0)

		const stored = db.items.get(body.data.id)
		assert.equal(stored?.status, 'triage')
		assert.equal(stored?.queuedAt, null)

		const startRes = await api.request(`/items/${body.data.id}/start`, { method: 'POST' })
		assert.equal(startRes.status, 200)
	})
})

test('server Item list expands grouped siblings across pagination windows', async () => {
	await withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const siblings = commands.createSolveItems({
			title: 'Paginated grouped Item',
			projectSlug: 'helm',
			prompt: 'Keep siblings together even when the page is small.',
			parallelism: 2,
		})
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request('/items?limit=1')

		assert.equal(res.status, 200)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem>[] }
		assert.deepEqual(
			body.data.map(item => item.id),
			siblings.map(item => item.id),
		)
		assert.deepEqual(
			body.data.map(item => item.group?.label),
			['Group 1/2', 'Group 2/2'],
		)
	})
})

test('server creates a new Item forked from an existing Item branch', async () => {
	await withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const base = commands.createSolveItem({
			title: 'Base attempt',
			projectSlug: 'helm',
			prompt: 'Build the first attempt.',
		})
		const baseWithBranch = commands.recordPlanPrepared(base.id, {
			worktreePath: '/tmp/helm-base-attempt',
			branchName: 'helm/item/base-attempt',
			planDirName: 'base-attempt',
			spawner: 'default',
		})
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request('/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'solve',
				title: 'Forked follow-up',
				projectSlug: 'helm',
				prompt: 'Continue from the base attempt branch.',
				baseItemId: base.id,
			}),
		})

		assert.equal(res.status, 201)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem> }
		const forked = db.items.get(body.data.id)
		assert.ok(forked)
		assert.equal(forked.baseRef, 'helm/item/base-attempt')
		assert.equal(body.data.baseRef, 'helm/item/base-attempt')
		assert.notEqual(resolveItemWorkspace(forked).branchName, baseWithBranch.branchName)
		assert.deepEqual(toDashboardItem(baseWithBranch).forkContext, {
			itemId: base.id,
			branchName: 'helm/item/base-attempt',
			baseRef: 'helm/item/base-attempt',
		})
	})
})

test('withRepoLock serializes work per repo and keeps repos independent', async () => {
	const order: string[] = []
	const gate = { resolve: () => {} }
	const first = withRepoLock('/repo/a', async () => {
		order.push('a1-start')
		await new Promise<void>(resolve => {
			gate.resolve = resolve
		})
		order.push('a1-end')
	})
	const second = withRepoLock('/repo/a', async () => {
		order.push('a2')
	})
	const other = withRepoLock('/repo/b', async () => {
		order.push('b1')
	})

	await other // repo/b is not blocked by repo/a's in-flight lock
	assert.deepEqual(order, ['a1-start', 'b1'])

	gate.resolve()
	await Promise.all([first, second])
	assert.deepEqual(order, ['a1-start', 'b1', 'a1-end', 'a2'])

	// A rejection must not wedge the lock for the next caller.
	await withRepoLock('/repo/a', async () => {
		throw new Error('boom')
	}).catch(() => {})
	await withRepoLock('/repo/a', async () => {
		order.push('a3')
	})
	assert.deepEqual(order.at(-1), 'a3')
})

test('createWorktree can fork from a local Item branch BaseRef', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-fork-worktree-'))
	try {
		const repoPath = join(dir, 'repo')
		mkdirSync(repoPath)
		git(repoPath, ['init', '-b', 'main'])
		git(repoPath, ['config', 'user.email', 'helm@example.test'])
		git(repoPath, ['config', 'user.name', 'Helm Test'])
		writeFileSync(join(repoPath, 'README.md'), 'main\n')
		git(repoPath, ['add', 'README.md'])
		git(repoPath, ['commit', '-m', 'init'])
		git(repoPath, ['switch', '-c', 'helm/item/base-attempt'])
		writeFileSync(join(repoPath, 'base.txt'), 'base branch content\n')
		git(repoPath, ['add', 'base.txt'])
		git(repoPath, ['commit', '-m', 'base attempt'])
		git(repoPath, ['switch', 'main'])

		const worktreePath = await createWorktree(
			repoPath,
			'helm/item/base-attempt',
			'helm/item/forked-attempt',
			join(dir, 'worktrees'),
		)

		assert.equal(git(worktreePath, ['branch', '--show-current']), 'helm/item/forked-attempt')
		assert.equal(readFileSync(join(worktreePath, 'base.txt'), 'utf-8'), 'base branch content\n')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('server creates queued harden Items with target and almanac flags', async () => {
	await withTempDb(async db => {
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request('/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'harden',
				title: 'Harden Item pipeline',
				projectSlug: 'helm',
				target: 'src/items',
				baseRef: 'release/afk',
				rounds: 3,
			}),
		})

		assert.equal(res.status, 201)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem> }
		assert.equal(body.data.kind, 'harden')
		assert.equal(body.data.status, 'ready')
		assert.equal(body.data.baseRef, 'release/afk')

		const stored = db.items.get(body.data.id)
		assert.deepEqual(stored?.payload, {
			kind: 'harden',
			target: 'src/items',
			rounds: 3,
		})
	})
})

test('server creates parallel loop Items with shared GroupId', async () => {
	await withTempDb(async db => {
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const ralphRes = await api.request('/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'ralph',
				title: 'Parallel ralph run',
				projectSlug: 'helm',
				prdPath: 'docs/plans/afk-rework/prd.md',
				parallelism: 2,
			}),
		})
		const hardenRes = await api.request('/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'harden',
				title: 'Parallel harden run',
				projectSlug: 'helm',
				target: 'src/items',
				parallelism: 2,
			}),
		})

		assert.equal(ralphRes.status, 201)
		assert.equal(hardenRes.status, 201)
		const ralphBody = (await ralphRes.json()) as { data: ReturnType<typeof toDashboardItem>[] }
		const hardenBody = (await hardenRes.json()) as { data: ReturnType<typeof toDashboardItem>[] }
		assert.equal(ralphBody.data.length, 2)
		assert.equal(hardenBody.data.length, 2)
		assert.equal(new Set(ralphBody.data.map(item => item.groupId)).size, 1)
		assert.equal(new Set(hardenBody.data.map(item => item.groupId)).size, 1)
		assert.notEqual(ralphBody.data[0].groupId, hardenBody.data[0].groupId)
		assert.deepEqual(
			db.items
				.list({ projectSlug: 'helm' })
				.map(item => item.kind)
				.sort(),
			['harden', 'harden', 'ralph', 'ralph'],
		)
	})
})

test('Item workspace identity is item-scoped and preserves captured BaseRef', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Ship AFK dashboard item',
			projectSlug: 'helm',
			prompt: 'Build the new Item dashboard.',
			baseRef: 'release/afk',
		})
		const changedConfig = {
			...config,
			projects: [{ ...config.projects[0], baseBranch: 'develop' }],
		}
		const reader = new ItemCommands(db.items, changedConfig)

		const reloaded = reader.getItem(item.id)
		assert.equal(reloaded?.baseRef, 'release/afk')
		assert.ok(reloaded)
		const firstIdentity = resolveItemWorkspace(reloaded)
		const createdDay = new Date(reloaded.createdAt).toISOString().slice(0, 10)
		assert.deepEqual(firstIdentity, {
			baseRef: 'release/afk',
			planDirName: `${createdDay}-ship-afk-dashboard-item-${reloaded.id.slice(0, 8)}`,
			branchName: `helm/item/ship-afk-dashboard-item-${reloaded.id.slice(0, 8)}`,
			existingWorktreePath: undefined,
		})

		const worktreePath = join(tmpdir(), `helm-item-worktree-${reloaded.id}`)
		const stored = db.items.update(reloaded.id, {
			planDirName: 'stored-plan',
			branchName: 'stored-branch',
			worktreePath,
		})
		assert.equal(resolveItemWorkspace(stored).existingWorktreePath, undefined)

		mkdirSync(worktreePath, { recursive: true })
		assert.deepEqual(resolveItemWorkspace(stored), {
			baseRef: 'release/afk',
			planDirName: 'stored-plan',
			branchName: 'stored-branch',
			existingWorktreePath: worktreePath,
		})
		rmSync(worktreePath, { recursive: true, force: true })
	})
})

test('Drainer runs queued solve Items oldest-first through the Solver and Item Store', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-drainer-worktrees-'))
		const singleSolveConfig = { ...config, solver: { ...config.solver, concurrency: 1 } }
		const commands = new ItemCommands(db.items, singleSolveConfig)
		const newer = commands.createSolveItem({
			title: 'Newer solve',
			projectSlug: 'helm',
			prompt: 'Run after the older solve Item.',
		})
		const older = commands.createSolveItem({
			title: 'Older solve',
			projectSlug: 'helm',
			prompt: 'Run before the newer solve Item.',
			baseRef: 'release/afk',
		})
		db.items.update(newer.id, { queuedAt: '2026-06-19T12:00:02.000Z' })
		db.items.update(older.id, { queuedAt: '2026-06-19T12:00:01.000Z' })
		const solver = new FakeSolveSolver(worktreeRoot, 10)
		const drainer = new Drainer(singleSolveConfig, db, provider, solver)

		try {
			drainer.start()
			drainer.resume()

			await waitFor(
				() => db.items.get(older.id)?.status === 'review' && db.items.get(newer.id)?.status === 'review',
				'queued solve Items did not finish',
			)

			assert.deepEqual(
				solver.calls.map(call => call.taskId),
				[older.id, newer.id],
			)
			assert.equal(solver.maxConcurrent, 1)
			assert.equal(solver.calls[0].projectConfig.baseBranch, 'release/afk')
			assert.equal(solver.calls[0].taskContext.title, 'Older solve')
			assert.equal(solver.calls[0].taskContext.description, 'Run before the newer solve Item.')

			const olderDone = db.items.get(older.id)
			const olderPlanDate = olderDone ? new Date(olderDone.createdAt).toISOString().slice(0, 10) : ''
			assert.equal(olderDone?.resultSummary, 'Solved Older solve')
			assert.match(olderDone?.worktreePath ?? '', /helm-drainer-worktrees-/)
			assert.match(olderDone?.branchName ?? '', /^helm\/item\/older-solve-/)
			assert.match(olderDone?.planDirName ?? '', new RegExp(`^${olderPlanDate}-older-solve-`))
			assert.deepEqual(
				db.items.getEvents(older.id).map(event => event.eventType),
				['item_started', 'solve_command', 'solve_completed', 'dispatch_skipped', 'action_completed'],
			)
		} finally {
			drainer.stop()
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('Drainer runs queued ralph Items through the loop lane and captures AlmanacRunId', async () => {
	await withTempDb(async db => {
		const worktreePath = mkdtempSync(join(tmpdir(), 'helm-ralph-worktree-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createRalphItem({
			title: 'Run ralph loop',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
			mode: 'once',
			provider: 'codex',
		})
		commands.recordPlanPrepared(item.id, {
			worktreePath,
			branchName: 'helm/item/ralph-loop',
			planDirName: 'afk-rework',
			spawner: 'default',
		})
		const solver = new FakeSolveSolver(worktreePath)
		const loopRunner = new FakeLoopRunner(10, 'ralph-afk-rework-1')
		const drainer = new Drainer(config, db, provider, solver, loopRunner)

		try {
			drainer.start()
			drainer.resume()

			await waitFor(() => db.items.get(item.id)?.status === 'done', 'queued ralph Item did not finish')

			assert.equal(solver.calls.length, 0)
			assert.equal(loopRunner.ralphCalls.length, 1)
			assert.equal(loopRunner.ralphCalls[0].worktreePath, worktreePath)
			assert.equal(loopRunner.ralphCalls[0].branchName, 'helm/item/ralph-loop')
			assert.equal(loopRunner.ralphCalls[0].payload.prdPath, 'docs/plans/afk-rework/prd.md')
			assert.equal(db.items.get(item.id)?.almanacRunId, 'ralph-afk-rework-1')
			assert.equal(db.items.get(item.id)?.resultSummary, 'almanac ralph run completed')
			assert.deepEqual(
				db.items.getEvents(item.id).map(event => event.eventType),
				['plan_prepared', 'item_started', 'almanac_run_started', 'loop_completed'],
			)
		} finally {
			drainer.stop()
			rmSync(worktreePath, { recursive: true, force: true })
		}
	})
})

test('Drainer runs queued harden Items through the loop lane and captures AlmanacRunId', async () => {
	await withTempDb(async db => {
		const worktreePath = mkdtempSync(join(tmpdir(), 'helm-harden-worktree-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createHardenItem({
			title: 'Run harden loop',
			projectSlug: 'helm',
			target: 'src/items',
			rounds: 2,
		})
		commands.recordPlanPrepared(item.id, {
			worktreePath,
			branchName: 'helm/item/harden-loop',
			planDirName: 'harden-loop',
			spawner: 'default',
		})
		const solver = new FakeSolveSolver(worktreePath)
		const loopRunner = new FakeLoopRunner(10, 'harden-src-items-1')
		const drainer = new Drainer(config, db, provider, solver, loopRunner)

		try {
			drainer.start()
			drainer.resume()

			await waitFor(() => db.items.get(item.id)?.status === 'done', 'queued harden Item did not finish')

			assert.equal(solver.calls.length, 0)
			assert.equal(loopRunner.hardenCalls.length, 1)
			assert.equal(loopRunner.hardenCalls[0].worktreePath, worktreePath)
			assert.equal(loopRunner.hardenCalls[0].branchName, 'helm/item/harden-loop')
			assert.equal(loopRunner.hardenCalls[0].payload.target, 'src/items')
			assert.equal(loopRunner.hardenCalls[0].payload.rounds, 2)
			assert.equal(db.items.get(item.id)?.almanacRunId, 'harden-src-items-1')
			assert.equal(db.items.get(item.id)?.resultSummary, 'almanac harden run completed')
			assert.deepEqual(
				db.items.getEvents(item.id).map(event => event.eventType),
				['plan_prepared', 'item_started', 'almanac_run_started', 'loop_completed'],
			)
		} finally {
			drainer.stop()
			rmSync(worktreePath, { recursive: true, force: true })
		}
	})
})

test('Drainer runs loop Items oldest-first across ralph and harden kinds', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-loop-order-'))
		const ralphWorktree = join(worktreeRoot, 'ralph')
		const hardenWorktree = join(worktreeRoot, 'harden')
		mkdirSync(ralphWorktree, { recursive: true })
		mkdirSync(hardenWorktree, { recursive: true })
		const commands = new ItemCommands(db.items, config)
		const newerRalph = commands.createRalphItem({
			title: 'Newer ralph loop',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})
		const olderHarden = commands.createHardenItem({
			title: 'Older harden loop',
			projectSlug: 'helm',
			target: 'src/items',
		})
		db.items.update(newerRalph.id, { queuedAt: '2026-06-19T12:00:02.000Z' })
		db.items.update(olderHarden.id, { queuedAt: '2026-06-19T12:00:01.000Z' })
		commands.recordPlanPrepared(newerRalph.id, {
			worktreePath: ralphWorktree,
			branchName: 'helm/item/newer-ralph-loop',
			planDirName: 'newer-ralph-loop',
			spawner: 'default',
		})
		commands.recordPlanPrepared(olderHarden.id, {
			worktreePath: hardenWorktree,
			branchName: 'helm/item/older-harden-loop',
			planDirName: 'older-harden-loop',
			spawner: 'default',
		})
		const solver = new FakeSolveSolver(worktreeRoot)
		const loopRunner = new FakeLoopRunner(10, 'loop-order-run')
		const drainer = new Drainer(config, db, provider, solver, loopRunner)

		try {
			drainer.start()
			drainer.resume()

			await waitFor(
				() => db.items.get(olderHarden.id)?.status === 'done' && db.items.get(newerRalph.id)?.status === 'done',
				'queued loop Items did not finish',
			)

			assert.deepEqual(
				loopRunner.calls.map(call => call.itemId),
				[olderHarden.id, newerRalph.id],
			)
			assert.equal(solver.calls.length, 0)
		} finally {
			drainer.stop()
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('AlmanacLoopRunner cancellation writes ralph stop signal and preserves worktree', async () => {
	const worktreePath = mkdtempSync(join(tmpdir(), 'helm-ralph-cancel-worktree-'))
	const fakeBin = mkdtempSync(join(tmpdir(), 'helm-fake-almanac-'))
	const outputLogPath = join(worktreePath, 'ralph.log')
	const almanacPath = join(fakeBin, 'almanac')
	writeFileSync(
		almanacPath,
		[
			'#!/bin/sh',
			'echo "Run ID: ralph-cancel-test"',
			'while [ ! -f .ralph-stop ]; do',
			'  sleep 0.01',
			'done',
			'echo "stop seen"',
		].join('\n'),
		'utf-8',
	)
	chmodSync(almanacPath, 0o755)

	const oldPath = process.env.PATH
	process.env.PATH = `${fakeBin}:${oldPath ?? ''}`
	const controller = new AbortController()
	let runId: string | null = null

	try {
		await assert.rejects(
			new AlmanacLoopRunner().runLoop({
				projectConfig: config.projects[0],
				solverConfig: config.solver,
				itemId: 'item-ralph-cancel',
				itemTitle: 'Cancel ralph',
				payload: {
					kind: 'ralph',
					prdPath: 'docs/plans/afk-rework/prd.md',
					mode: 'once',
					provider: 'codex',
				},
				worktreePath,
				branchName: 'helm/item/cancel-ralph',
				planDirName: 'cancel-ralph',
				outputLogPath,
				signal: controller.signal,
				onRunId: id => {
					runId = id
					controller.abort()
				},
			}),
			(err: unknown) => err instanceof Error && err.name === 'AbortError',
		)

		assert.equal(runId, 'ralph-cancel-test')
		assert.equal(existsSync(join(worktreePath, '.ralph-stop')), true)
		assert.equal(existsSync(worktreePath), true)
		assert.match(readFileSync(outputLogPath, 'utf-8'), /stop seen/)
	} finally {
		process.env.PATH = oldPath
		rmSync(worktreePath, { recursive: true, force: true })
		rmSync(fakeBin, { recursive: true, force: true })
	}
})

test('AlmanacLoopRunner cancellation writes harden stop signal and preserves worktree', async () => {
	const worktreePath = mkdtempSync(join(tmpdir(), 'helm-harden-cancel-worktree-'))
	const fakeBin = mkdtempSync(join(tmpdir(), 'helm-fake-almanac-'))
	const outputLogPath = join(worktreePath, 'harden.log')
	const argsLogPath = join(worktreePath, 'args.log')
	const almanacPath = join(fakeBin, 'almanac')
	writeFileSync(
		almanacPath,
		[
			'#!/bin/sh',
			`printf '%s\\n' "$@" > "${argsLogPath}"`,
			'echo "Run registered: harden-cancel-test"',
			'while [ ! -f .harden-stop ]; do',
			'  sleep 0.01',
			'done',
			'echo "stop seen"',
		].join('\n'),
		'utf-8',
	)
	chmodSync(almanacPath, 0o755)

	const oldPath = process.env.PATH
	process.env.PATH = `${fakeBin}:${oldPath ?? ''}`
	const controller = new AbortController()
	let runId: string | null = null

	try {
		await assert.rejects(
			new AlmanacLoopRunner().runLoop({
				projectConfig: config.projects[0],
				solverConfig: config.solver,
				itemId: 'item-harden-cancel',
				itemTitle: 'Cancel harden',
				payload: {
					kind: 'harden',
					target: 'src/items',
					rounds: 2,
				},
				worktreePath,
				branchName: 'helm/item/cancel-harden',
				planDirName: 'cancel-harden',
				outputLogPath,
				signal: controller.signal,
				onRunId: id => {
					runId = id
					controller.abort()
				},
			}),
			(err: unknown) => err instanceof Error && err.name === 'AbortError',
		)

		assert.equal(runId, 'harden-cancel-test')
		assert.deepEqual(readFileSync(argsLogPath, 'utf-8').trim().split('\n'), [
			'harden',
			'src/items',
			'--loop',
			'--rounds',
			'2',
		])
		assert.equal(existsSync(join(worktreePath, '.harden-stop')), true)
		assert.equal(existsSync(worktreePath), true)
		assert.match(readFileSync(outputLogPath, 'utf-8'), /stop seen/)
	} finally {
		process.env.PATH = oldPath
		rmSync(worktreePath, { recursive: true, force: true })
		rmSync(fakeBin, { recursive: true, force: true })
	}
})

test('processRalphItem records loop runner failures through ItemCommands', async () => {
	await withTempDb(async db => {
		const worktreePath = mkdtempSync(join(tmpdir(), 'helm-ralph-fail-worktree-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createRalphItem({
			title: 'Fail ralph loop',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})
		commands.recordPlanPrepared(item.id, {
			worktreePath,
			branchName: 'helm/item/fail-ralph',
			planDirName: 'fail-ralph',
			spawner: 'default',
		})

		try {
			await processRalphItem(item.id, config, db, new FailingLoopRunner())

			const failed = db.items.get(item.id)
			assert.equal(failed?.status, 'failed')
			assert.equal(failed?.almanacRunId, 'ralph-failed-run')
			assert.equal(failed?.errorPhase, 'loop')
			assert.equal(failed?.errorMessage, 'ralph runner failed')
			assert.deepEqual(
				db.items.getEvents(item.id).map(event => event.eventType),
				['plan_prepared', 'item_started', 'almanac_run_started', 'item_failed'],
			)
		} finally {
			rmSync(worktreePath, { recursive: true, force: true })
		}
	})
})

test('Drainer routes solve Item pause, retry, cancel, start, and resume through Item lifecycle', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-drainer-lifecycle-'))
		const commands = new ItemCommands(db.items, config)
		const pausedItem = commands.createSolveItem({
			title: 'Paused solve',
			projectSlug: 'helm',
			prompt: 'Do not start until asked.',
		})
		const solver = new FakeSolveSolver(worktreeRoot)
		const drainer = new Drainer(config, db, provider, solver)

		try {
			drainer.pause()
			drainer.start()
			await sleep(20)
			assert.equal(db.items.get(pausedItem.id)?.status, 'ready')
			assert.equal(solver.calls.length, 0)

			assert.equal(drainer.cancelItem(pausedItem.id), true)
			assert.equal(db.items.get(pausedItem.id)?.status, 'cancelled')
			assert.equal(drainer.retryItem(pausedItem.id).status, 'ready')
			assert.equal(drainer.processOneItem(pausedItem.id), true)

			await waitFor(() => db.items.get(pausedItem.id)?.status === 'review', 'manually started Item did not finish')

			const resumedItem = commands.createSolveItem({
				title: 'Resumed solve',
				projectSlug: 'helm',
				prompt: 'Start when drainer resumes.',
			})
			drainer.resume()
			await waitFor(() => db.items.get(resumedItem.id)?.status === 'review', 'resumed Item did not finish')

			assert.deepEqual(
				db.items.getEvents(pausedItem.id).map(event => event.eventType),
				[
					'item_cancelled',
					'item_retried',
					'item_started',
					'solve_command',
					'solve_completed',
					'dispatch_skipped',
					'action_completed',
				],
			)
		} finally {
			drainer.stop()
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('Drainer ignores planned Items until explicit start', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-drainer-planned-'))
		const commands = new ItemCommands(db.items, config)
		const plannedItem = commands.createSolveItem({
			title: 'Plan-only solve',
			projectSlug: 'helm',
			prompt: 'Start only after planning.',
			initialStatus: 'triage',
		})
		const solver = new FakeSolveSolver(worktreeRoot)
		const drainer = new Drainer(config, db, provider, solver)

		try {
			drainer.start()
			drainer.resume()
			await sleep(20)

			assert.equal(db.items.get(plannedItem.id)?.status, 'triage')
			assert.equal(solver.calls.length, 0)

			assert.equal(drainer.processOneItem(plannedItem.id), true)
			await waitFor(() => db.items.get(plannedItem.id)?.status === 'review', 'planned Item did not start explicitly')

			assert.equal(solver.calls.length, 1)
			assert.equal(solver.calls[0].taskId, plannedItem.id)
		} finally {
			drainer.stop()
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('Drainer refuses to manually start Items outside queued or planned states', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-drainer-start-guard-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Already completed solve',
			projectSlug: 'helm',
			prompt: 'Do not run this Item again without retry.',
		})
		commands.startItem(item.id)
		commands.completeSolveItem(item.id, {
			worktreePath: worktreeRoot,
			branchName: 'helm/item/already-completed',
			planDirName: 'already-completed',
			resultSummary: 'Already done',
		})
		const solver = new FakeSolveSolver(worktreeRoot)
		const drainer = new Drainer(config, db, provider, solver)

		try {
			drainer.start()

			assert.equal(drainer.processOneItem(item.id), false)
			assert.equal(db.items.get(item.id)?.status, 'review')
			assert.equal(solver.calls.length, 0)
		} finally {
			drainer.stop()
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('Drainer recovers stale processing Items before scheduling lanes', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-stale-items-'))
		const loopWorktree = mkdtempSync(join(tmpdir(), 'helm-stale-loop-'))
		const commands = new ItemCommands(db.items, config)
		const solveItem = commands.createSolveItem({
			title: 'Recover stale solve',
			projectSlug: 'helm',
			prompt: 'Continue after daemon restart.',
		})
		const loopItem = commands.createRalphItem({
			title: 'Recover stale ralph',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})
		commands.startItem(solveItem.id)
		commands.startItem(loopItem.id)
		commands.recordExecutionWorkspaceIdentity(loopItem.id, {
			worktreePath: loopWorktree,
			branchName: 'helm/item/recover-stale-ralph',
			planDirName: 'recover-stale-ralph',
		})

		const solver = new FakeSolveSolver(worktreeRoot)
		const loopRunner = new FakeLoopRunner(0, 'ralph-recovered-1')
		const drainer = new Drainer(config, db, provider, solver, loopRunner)

		try {
			// Pause so we observe recovery (→ queued) before the lanes re-run them.
			drainer.pause()
			drainer.start()

			assert.equal(db.items.get(solveItem.id)?.status, 'ready')
			assert.equal(db.items.get(loopItem.id)?.status, 'ready')
			assert.deepEqual(
				db.items.getEvents(solveItem.id).map(event => event.eventType),
				['item_started', 'item_recovered'],
			)
			assert.deepEqual(
				db.items.getEvents(loopItem.id).map(event => event.eventType),
				['item_started', 'item_recovered'],
			)

			drainer.resume()

			await waitFor(
				() => db.items.get(solveItem.id)?.status === 'review' && db.items.get(loopItem.id)?.status === 'done',
				'recovered Items did not finish',
			)

			assert.equal(solver.calls.length, 1)
			assert.equal(loopRunner.ralphCalls.length, 1)
			assert.equal(db.items.get(loopItem.id)?.almanacRunId, 'ralph-recovered-1')
		} finally {
			drainer.stop()
			rmSync(worktreeRoot, { recursive: true, force: true })
			rmSync(loopWorktree, { recursive: true, force: true })
		}
	})
})

test('solve Items display the immutable prompt snapshot captured before invocation', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-snapshot-worktrees-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Snapshot solve',
			projectSlug: 'helm',
			prompt: 'Use stored solve input.',
		})
		const planDirName = 'snapshot-plan'
		const worktreePath = join(worktreeRoot, 'planned-worktree')
		mkdirSync(worktreePath, { recursive: true })
		const workspace = new PlanWorkspace(worktreePath, planDirName)
		workspace.writeReadme('BEFORE snapshot artifact')
		commands.recordPlanPrepared(item.id, {
			worktreePath,
			branchName: 'helm/item/snapshot-solve',
			planDirName,
			spawner: 'default',
		})

		try {
			await processSolveItem(item.id, config, db, provider, new SnapshotMutatingSolver(worktreeRoot))

			const stored = db.items.get(item.id)
			assert.ok(stored)
			assert.equal(stored.status, 'review')
			const dashboard = toDashboardItem(stored)
			const solveInputSnapshot = dashboard.solveInputSnapshot
			assert.equal(typeof solveInputSnapshot, 'string')
			assert.match(solveInputSnapshot ?? '', /BEFORE snapshot artifact/)
			assert.doesNotMatch(solveInputSnapshot ?? '', /AFTER snapshot artifact/)
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('processSolveItem uses solve Item selected solver agent', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-item-agent-'))
		const item = db.items.create({
			kind: 'solve',
			status: 'ready',
			projectSlug: 'helm',
			title: 'Run with Codex',
			source: null,
			baseRef: 'main',
			payload: { kind: 'solve', prompt: 'Use selected agent.', solverAgent: 'codex' },
		})
		const solver = new FakeSolveSolver(worktreeRoot)

		try {
			await processSolveItem(item.id, config, db, provider, solver)

			assert.equal(solver.calls[0].solverConfig.agent, 'codex')
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('solve Item cancellation preserves the newly-created worktree identity', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-cancelled-solve-worktrees-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Cancelled solve',
			projectSlug: 'helm',
			prompt: 'Create worktree, then cancel before returning a solve result.',
		})

		try {
			await processSolveItem(item.id, config, db, provider, new CancellingWorktreeSolver(worktreeRoot))

			const stored = db.items.get(item.id)
			assert.equal(stored?.status, 'cancelled')
			assert.equal(stored?.worktreePath, join(worktreeRoot, item.id))
			assert.ok(stored?.branchName)
			assert.ok(stored?.planDirName)
			assert.equal(existsSync(join(worktreeRoot, item.id)), true)
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('processSolveItem dispatches pre-shipped PR URLs for solve Items without opening another PR', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-preship-worktrees-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Pre-shipped solve',
			projectSlug: 'helm',
			prompt: 'Use the PR URL in solver-result.json.',
		})
		const prUrl = 'https://github.com/neumie/helm/pull/77'

		try {
			await processSolveItem(item.id, config, db, provider, new FakeSolveSolver(worktreeRoot, 0, { prUrl }))

			const stored = db.items.get(item.id)
			assert.equal(stored?.status, 'review')
			assert.equal(stored?.prUrl, prUrl)
			assert.deepEqual(
				db.items.getEvents(item.id).map(event => event.eventType),
				['item_started', 'solve_command', 'solve_completed', 'pr_created', 'action_completed'],
			)
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('Run Observation normalizes solve logs, events, and PR status into Dashboard Contract', async () => {
	await withTempDb(async db => {
		const logRoot = mkdtempSync(join(tmpdir(), 'helm-observe-solve-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Observe solve Item',
			projectSlug: 'helm',
			prompt: 'Capture dashboard observation.',
		})
		const prUrl = 'https://github.com/neumie/helm/pull/91'

		try {
			writeFileSync(join(logRoot, `${item.id}.log`), 'agent boot\nagent done\n', 'utf-8')
			commands.startItem(item.id)
			commands.recordEvent(item.id, 'solve_command', { detail: 'npm test' })
			commands.completeSolveItem(item.id, {
				worktreePath: '/tmp/helm-observe-solve',
				branchName: 'helm/item/observe-solve',
				planDirName: 'observe-solve',
				resultSummary: 'Solve observation complete',
			})
			commands.recordDispatchPr(item.id, { prUrl, shippedByAgent: true })
			const stored = db.items.get(item.id)
			assert.ok(stored)

			const contract = toDashboardItem(
				stored,
				await observeItemRun(stored, {
					store: db.items,
					logRoot,
					readPrStatus: url => ({ url, state: 'OPEN', merged: false }),
				}),
			)

			assert.equal(contract.runObservation.source, 'solve')
			assert.equal(contract.runObservation.state, 'review')
			assert.equal(contract.runObservation.summary, 'Solve observation complete')
			assert.deepEqual(contract.runObservation.pr, { url: prUrl, state: 'OPEN', merged: false })
			assert.equal(contract.runObservation.log.available, true)
			assert.match(contract.runObservation.log.content, /agent done/)
			assert.deepEqual(
				contract.runObservation.events.map(event => event.label),
				['Item started', 'npm test', 'Solve completed: Solve observation complete', 'PR created: PR #91'],
			)
		} finally {
			rmSync(logRoot, { recursive: true, force: true })
		}
	})
})

test('Run Observation normalizes almanac status.tsv for loop Items', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-observe-loop-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createRalphItem({
			title: 'Observe ralph loop',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})
		const runId = 'ralph-afk-rework-99'
		const worktreePath = join(worktreeRoot, 'worktree')
		const statusPath = join(worktreePath, '.almanac', 'runs', runId, 'status.tsv')

		try {
			mkdirSync(join(worktreePath, '.almanac', 'runs', runId), { recursive: true })
			writeFileSync(
				statusPath,
				[
					`id\t${runId}`,
					'type\tralph',
					'target\tdocs/plans/afk-rework/prd.md',
					'pid\t12345',
					`status_file\t.almanac/runs/${runId}/status.tsv`,
					'started_at\t2026-06-19T12:00:00Z',
					'status\trunning',
					'finished_at\t',
					'round\t3',
					'summary\titeration 3/10',
				].join('\n'),
				'utf-8',
			)
			commands.startItem(item.id)
			commands.recordExecutionWorkspaceIdentity(item.id, {
				worktreePath,
				branchName: 'helm/item/observe-ralph',
				planDirName: 'observe-ralph',
			})
			commands.recordAlmanacRunId(item.id, runId)
			const stored = db.items.get(item.id)
			assert.ok(stored)

			const contract = toDashboardItem(stored, await observeItemRun(stored, { store: db.items }))

			assert.equal(contract.runObservation.source, 'loop')
			assert.equal(contract.runObservation.state, 'running')
			assert.equal(contract.runObservation.summary, 'iteration 3/10')
			assert.deepEqual(contract.runObservation.almanac, {
				runId,
				statusPath,
				status: 'running',
				round: '3',
				summary: 'iteration 3/10',
				failureReason: null,
			})
			assert.deepEqual(
				contract.runObservation.events.map(event => event.label),
				['Item started', `Almanac run started: ${runId}`],
			)
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('Run Observation surfaces almanac failure_reason when loop summary is absent', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-observe-loop-failure-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createHardenItem({
			title: 'Observe harden failure',
			projectSlug: 'helm',
			target: 'src/items',
		})
		const runId = 'harden-items-42'
		const worktreePath = join(worktreeRoot, 'worktree')
		const statusPath = join(worktreePath, '.almanac', 'runs', runId, 'status.tsv')

		try {
			mkdirSync(join(worktreePath, '.almanac', 'runs', runId), { recursive: true })
			writeFileSync(
				statusPath,
				[
					`id\t${runId}`,
					'type\tharden',
					'target\tsrc/items',
					'pid\t12345',
					`status_file\t.almanac/runs/${runId}/status.tsv`,
					'started_at\t2026-06-22T12:00:00Z',
					'status\tfailed',
					'failure_reason\texit=1; reviewer failed mid-round',
				].join('\n'),
				'utf-8',
			)
			commands.startItem(item.id)
			commands.recordExecutionWorkspaceIdentity(item.id, {
				worktreePath,
				branchName: 'helm/item/observe-harden-failure',
				planDirName: 'observe-harden-failure',
			})
			commands.recordAlmanacRunId(item.id, runId)
			const stored = db.items.get(item.id)
			assert.ok(stored)

			const contract = toDashboardItem(stored, await observeItemRun(stored, { store: db.items }))

			assert.equal(contract.runObservation.state, 'failed')
			assert.equal(contract.runObservation.summary, 'exit=1; reviewer failed mid-round')
			assert.deepEqual(contract.runObservation.almanac, {
				runId,
				statusPath,
				status: 'failed',
				round: null,
				summary: 'exit=1; reviewer failed mid-round',
				failureReason: 'exit=1; reviewer failed mid-round',
			})
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('server returns unknown and empty Run Observation fields when sources are missing', async () => {
	await withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createRalphItem({
			title: 'Missing observation sources',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})
		const runId = 'ralph-missing-1'
		const missingWorktree = join(tmpdir(), 'helm-missing-observation-worktree')
		commands.startItem(item.id)
		commands.recordExecutionWorkspaceIdentity(item.id, {
			worktreePath: missingWorktree,
			branchName: 'helm/item/missing-observation',
			planDirName: 'missing-observation',
		})
		commands.recordAlmanacRunId(item.id, runId)
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request(`/items/${item.id}`)

		assert.equal(res.status, 200)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem> }
		assert.equal(body.data.runObservation.source, 'loop')
		assert.equal(body.data.runObservation.state, 'unknown')
		assert.equal(body.data.runObservation.almanac.runId, runId)
		assert.match(body.data.runObservation.almanac.statusPath ?? '', /status\.tsv$/)
		assert.equal(body.data.runObservation.log.available, false)
		assert.deepEqual(
			body.data.runObservation.events.map(event => event.label),
			['Item started', `Almanac run started: ${runId}`],
		)
	})
})

test('dispatchSolveItem opens fallback PRs and posts provider comments only for matching Source Items', async () => {
	await withTempDb(async db => {
		const prConfig = {
			...config,
			github: { ...config.github, createPrs: true, postComments: true },
		}
		const commands = new ItemCommands(db.items, prConfig)
		const sourceItem = commands.createSolveItem({
			title: 'Dispatch source Item',
			projectSlug: 'helm',
			prompt: 'Open a PR and comment on the source task.',
			baseRef: 'release/afk',
			source: {
				provider: 'contember',
				externalId: 'task-dispatch',
				url: 'https://example.test/tasks/task-dispatch',
			},
		})
		const localItem = commands.createSolveItem({
			title: 'Dispatch local Item',
			projectSlug: 'helm',
			prompt: 'Open a PR without provider comment.',
			baseRef: 'release/local',
		})
		commands.approveItem(sourceItem.id)
		commands.startItem(sourceItem.id)
		commands.completeSolveItem(sourceItem.id, {
			worktreePath: '/tmp/helm-source-worktree',
			branchName: 'helm/item/source',
			planDirName: 'source-plan',
			resultSummary: 'Solved source Item',
		})
		commands.startItem(localItem.id)
		commands.completeSolveItem(localItem.id, {
			worktreePath: '/tmp/helm-local-worktree',
			branchName: 'helm/item/local',
			planDirName: 'local-plan',
			resultSummary: 'Solved local Item',
		})
		const pushed: Array<{ worktreePath: string; branchName: string }> = []
		const prs: Array<{ worktreePath: string; branchName: string; baseBranch: string; title: string; body: string }> = []
		const comments: Array<{ externalId: string; markdown: string }> = []
		const commentProvider = {
			...provider,
			name: 'contember',
			postComment: async (externalId: string, markdown: string) => {
				comments.push({ externalId, markdown })
				return 'comment-1'
			},
		}
		const sideEffects = {
			pushBranch: (worktreePath: string, branchName: string) => {
				pushed.push({ worktreePath, branchName })
			},
			createPr: (opts: {
				worktreePath: string
				branchName: string
				baseBranch: string
				title: string
				body: string
			}) => {
				prs.push(opts)
				return `https://github.com/neumie/helm/pull/${prs.length}`
			},
		}

		await dispatchSolveItem({
			itemId: sourceItem.id,
			result: {
				summary: 'Solved source Item',
				filesChanged: ['src/source.ts'],
				prTitle: 'Source PR',
				prBody: 'Source body',
			},
			config: prConfig,
			commands,
			provider: commentProvider,
			sideEffects,
		})
		await dispatchSolveItem({
			itemId: localItem.id,
			result: {
				summary: 'Solved local Item',
				filesChanged: ['src/local.ts'],
				prTitle: 'Local PR',
				prBody: 'Local body',
			},
			config: prConfig,
			commands,
			provider: commentProvider,
			sideEffects,
		})

		assert.deepEqual(pushed, [
			{ worktreePath: '/tmp/helm-source-worktree', branchName: 'helm/item/source' },
			{ worktreePath: '/tmp/helm-local-worktree', branchName: 'helm/item/local' },
		])
		assert.deepEqual(
			prs.map(pr => ({ branchName: pr.branchName, baseBranch: pr.baseBranch, title: pr.title, body: pr.body })),
			[
				{
					branchName: 'helm/item/source',
					baseBranch: 'release/afk',
					title: '[Helm] Source PR',
					body: 'Source body\n\n---\n**Source:** https://example.test/tasks/task-dispatch',
				},
				{ branchName: 'helm/item/local', baseBranch: 'release/local', title: '[Helm] Local PR', body: 'Local body' },
			],
		)
		assert.deepEqual(comments, [
			{ externalId: 'task-dispatch', markdown: '**Helm**: Solved. PR: https://github.com/neumie/helm/pull/1' },
		])
		assert.equal(db.items.get(sourceItem.id)?.prUrl, 'https://github.com/neumie/helm/pull/1')
		assert.equal(db.items.get(localItem.id)?.prUrl, 'https://github.com/neumie/helm/pull/2')
		assert.deepEqual(
			db.items.getEvents(sourceItem.id).map(event => event.eventType),
			['item_approved', 'item_started', 'solve_completed', 'pr_created', 'comment_posted', 'action_completed'],
		)
		assert.deepEqual(
			db.items.getEvents(localItem.id).map(event => event.eventType),
			['item_started', 'solve_completed', 'pr_created', 'action_completed'],
		)
	})
})

test('dispatchSolveItem never posts a provider comment for a captured (email) Item, even when source.provider matches', async () => {
	await withTempDb(async db => {
		const prConfig = { ...config, github: { ...config.github, createPrs: true, postComments: true } }
		const commands = new ItemCommands(db.items, prConfig)
		// A captured Item whose source.provider is spoofed to equal the active
		// provider name — the capturedContext guard must still suppress the comment.
		const captured = commands.createSolveItem({
			title: 'Ingested email',
			projectSlug: 'helm',
			prompt: 'Fix the thing from the email.',
			source: { provider: 'contember', externalId: 'email:abc' },
			capturedContext: { title: 'Ingested email' },
		})
		commands.approveItem(captured.id)
		commands.startItem(captured.id)
		commands.completeSolveItem(captured.id, {
			worktreePath: '/tmp/helm-captured',
			branchName: 'helm/item/captured',
			planDirName: 'captured-plan',
			resultSummary: 'done',
		})
		const comments: Array<{ externalId: string }> = []
		const commentProvider = {
			...provider,
			name: 'contember',
			postComment: async (externalId: string) => {
				comments.push({ externalId })
				return 'comment-1'
			},
		}
		await dispatchSolveItem({
			itemId: captured.id,
			result: { summary: 'done', filesChanged: [], prTitle: 'PR', prBody: 'body' },
			config: prConfig,
			commands,
			provider: commentProvider,
			sideEffects: {
				pushBranch: () => undefined,
				createPr: () => 'https://github.com/neumie/helm/pull/9',
			},
		})

		assert.deepEqual(comments, []) // provider-less Item → no comment
		assert.equal(
			db.items.getEvents(captured.id).some(e => e.eventType === 'comment_posted'),
			false,
		)
	})
})

test('ItemStore validates payload kind and shape at the persistence seam', async () => {
	await withTempDb(db => {
		const store = db.items

		assert.throws(
			() =>
				store.create({
					id: 'item-invalid',
					kind: 'solve',
					status: 'ready',
					projectSlug: 'helm',
					title: 'Bad payload',
					source: null,
					baseRef: 'main',
					groupId: null,
					payload: { kind: 'solve' },
				}),
			/payload/i,
		)

		assert.throws(
			() =>
				store.create({
					id: 'item-mismatch',
					kind: 'solve',
					status: 'ready',
					projectSlug: 'helm',
					title: 'Wrong kind',
					source: null,
					baseRef: 'main',
					groupId: null,
					payload: { kind: 'ralph', prdPath: 'docs/plans/x/prd.md' },
				}),
			/payload kind/i,
		)
	})
})

test('ItemStore rejects invalid lifecycle updates without corrupting the row', async () => {
	await withTempDb(db => {
		const item = db.items.create({
			id: 'item-status-guard',
			kind: 'solve',
			status: 'ready',
			projectSlug: 'helm',
			title: 'Status guard',
			source: null,
			baseRef: 'main',
			groupId: null,
			payload: { kind: 'solve', prompt: 'Keep this Item valid.' },
		})
		const invalidUpdate = { status: 'ghost' } as unknown as Parameters<typeof db.items.update>[1]

		assert.throws(() => db.items.update(item.id, invalidUpdate), /Item validation failed/)
		assert.equal(db.items.get(item.id)?.status, 'ready')
	})
})

test('server exposes created Items through the dashboard contract', async () => {
	await withTempDb(async db => {
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const createRes = await api.request('/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'solve',
				title: 'Create contract item',
				projectSlug: 'helm',
				prompt: 'Expose through server-owned contract.',
				spawner: 'default',
			}),
		})

		assert.equal(createRes.status, 201)
		const created = (await createRes.json()) as { data: ReturnType<typeof toDashboardItem> }
		assert.equal(created.data.kind, 'solve')
		assert.equal(created.data.baseRef, 'main')
		assert.equal(created.data.spawner, 'default')
		assert.equal(created.data.source, null)
		assert.deepEqual(created.data.card, {
			state: 'ready',
			statusLabel: 'Ready',
			statusTone: 'gray',
			pulse: false,
		})
		assert.deepEqual(
			created.data.allowedActions.map(a => a.id),
			['start', 'cancel'],
		)
		assert.deepEqual(created.data.links, {
			source: null,
			branch: null,
			pr: null,
		})
		assert.equal('payloadJson' in created.data, false)
		assert.equal('queued_at' in created.data, false)

		const readRes = await api.request(`/items/${created.data.id}`)
		assert.equal(readRes.status, 200)
		const read = (await readRes.json()) as { data: ReturnType<typeof toDashboardItem> }
		// The detail route enriches with the live source-task content (null here:
		// this Item is source-less) and the plan preview (empty: not planned).
		// Otherwise it matches the creation contract.
		assert.deepEqual(read.data, { ...created.data, sourceTask: null, planArtifacts: [] })
	})
})

test('server rejects Item creation with an unavailable Spawner adapter', async () => {
	await withTempDb(async db => {
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request('/items', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'solve',
				title: 'Missing spawner',
				projectSlug: 'helm',
				prompt: 'Do not store this Item.',
				spawner: 'missing-spawner-zz-test',
			}),
		})

		assert.equal(res.status, 400)
		const body = (await res.json()) as { error: string }
		assert.match(body.error, /Spawner adapter not installed/)
		assert.deepEqual(
			db.items.list().map(item => item.title),
			[],
		)
	})
})

test('server plans Items through Spawner and records reusable Item workspace identity', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-item-plans-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Plan Item flow',
			projectSlug: 'helm',
			prompt: 'Write a plan for this Item.',
			baseRef: 'release/plan',
		})
		const planningSpawner = new FakePlanningSpawner(worktreeRoot)
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			planningSpawner,
			fakeEnricher as never,
		)

		try {
			const firstRes = await api.request(`/items/${item.id}/plan`, { method: 'POST' })

			assert.equal(firstRes.status, 200)
			const first = (await firstRes.json()) as {
				data: {
					worktreePath: string
					branchName: string
					planDirName: string
					readmePath: string
					spawner: string
					hint: string
				}
			}
			assert.equal(first.data.spawner, 'fake')
			assert.match(first.data.branchName, /^helm\/item\/plan-item-flow-/)
			const planDate = new Date(item.createdAt).toISOString().slice(0, 10)
			assert.match(first.data.planDirName, new RegExp(`^${planDate}-plan-item-flow-`))
			assert.equal(planningSpawner.calls[0].projectConfig.baseBranch, 'release/plan')
			assert.equal(planningSpawner.calls[0].existingWorktreePath, undefined)
			assert.equal(planningSpawner.calls[0].taskContext.title, 'Plan Item flow')
			assert.equal(planningSpawner.calls[0].taskContext.description, 'Write a plan for this Item.')
			assert.match(readFileSync(first.data.readmePath, 'utf-8'), /Planning agent started/)
			assert.match(
				readFileSync(new PlanWorkspace(first.data.worktreePath, first.data.planDirName).contextPath, 'utf-8'),
				/Write a plan for this Item\./,
			)

			const stored = db.items.get(item.id)
			assert.equal(stored?.worktreePath, first.data.worktreePath)
			assert.equal(stored?.branchName, first.data.branchName)
			assert.equal(stored?.planDirName, first.data.planDirName)
			assert.deepEqual(
				db.items.getEvents(item.id).map(event => event.eventType),
				['plan_prepared'],
			)

			const secondRes = await api.request(`/items/${item.id}/plan`, { method: 'POST' })
			assert.equal(secondRes.status, 200)
			const second = (await secondRes.json()) as { data: { worktreePath: string; planDirName: string } }
			assert.equal(second.data.worktreePath, first.data.worktreePath)
			assert.equal(second.data.planDirName, first.data.planDirName)
			assert.equal(planningSpawner.calls[1].existingWorktreePath, first.data.worktreePath)
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('server plans source-backed solve Items with provider task context', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-source-item-plans-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Stored source summary',
			projectSlug: 'helm',
			prompt: 'Stored fallback prompt.',
			source: {
				provider: provider.name,
				externalId: 'task-plan-source',
				url: 'https://example.test/tasks/task-plan-source',
			},
		})
		const sourceProvider = {
			...provider,
			getTaskContext: async (externalId: string) => {
				assert.equal(externalId, 'task-plan-source')
				return {
					title: 'Provider source title',
					description: 'Provider source description.',
					metadata: { Priority: 'P1' },
				}
			},
		}
		const planningSpawner = new FakePlanningSpawner(worktreeRoot)
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			sourceProvider as never,
			planningSpawner,
			fakeEnricher as never,
		)

		try {
			const res = await api.request(`/items/${item.id}/plan`, { method: 'POST' })

			assert.equal(res.status, 200)
			assert.equal(planningSpawner.calls[0].taskContext.title, 'Provider source title')
			assert.equal(planningSpawner.calls[0].taskContext.description, 'Provider source description.')
			assert.deepEqual(planningSpawner.calls[0].taskContext.metadata, {
				Priority: 'P1',
				'Item ID': item.id,
				Kind: 'solve',
				BaseRef: 'main',
				Source: 'task-plan-source',
				'Source URL': 'https://example.test/tasks/task-plan-source',
			})
			const body = (await res.json()) as { data: { worktreePath: string; planDirName: string } }
			assert.match(
				readFileSync(new PlanWorkspace(body.data.worktreePath, body.data.planDirName).contextPath, 'utf-8'),
				/Provider source description\./,
			)
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('server rejects planning for processing Items before mutating workspace identity', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-processing-plan-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Already running plan',
			projectSlug: 'helm',
			prompt: 'Do not re-plan during execution.',
		})
		commands.startItem(item.id)
		const planningSpawner = new FakePlanningSpawner(worktreeRoot)
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			planningSpawner,
			fakeEnricher as never,
		)

		try {
			const res = await api.request(`/items/${item.id}/plan`, { method: 'POST' })

			assert.equal(res.status, 400)
			const body = (await res.json()) as { error: string }
			assert.match(body.error, /Running Items cannot be planned/)
			assert.equal(planningSpawner.calls.length, 0)
			const stored = db.items.get(item.id)
			assert.equal(stored?.worktreePath, null)
			assert.equal(stored?.branchName, null)
			assert.equal(stored?.planDirName, null)
			assert.deepEqual(
				db.items.getEvents(item.id).map(event => event.eventType),
				['item_started'],
			)
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('server plans Items with the per-Item selected Spawner', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-selected-spawner-'))
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Plan with selected spawner',
			projectSlug: 'helm',
			prompt: 'Open this planning session in the selected spawner.',
			spawner: 'okena',
		})
		const defaultSpawner = new FakePlanningSpawner(worktreeRoot, 'default')
		const selectedSpawner = new FakePlanningSpawner(worktreeRoot, 'okena')
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			defaultSpawner,
			fakeEnricher as never,
			async (_config, name) => {
				assert.equal(name, 'okena')
				return selectedSpawner
			},
		)

		try {
			const res = await api.request(`/items/${item.id}/plan`, { method: 'POST' })

			assert.equal(res.status, 200)
			const body = (await res.json()) as { data: { spawner: string } }
			assert.equal(body.data.spawner, 'okena')
			assert.equal(defaultSpawner.calls.length, 0)
			assert.equal(selectedSpawner.calls.length, 1)
			assert.equal(db.items.get(item.id)?.spawner, 'okena')
			const [event] = db.items.getEvents(item.id)
			assert.equal(JSON.parse(event.payload ?? '{}').spawner, 'okena')
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('Spawner registry discovers installed adapters and resolves the default adapter', async () => {
	const adapters = listSpawnerAdapters()
	assert.equal(adapters.find(adapter => adapter.name === 'default')?.available, true)
	assert.equal(adapters.find(adapter => adapter.name === 'okena')?.available, true)

	const defaultSpawner = await createSpawner(config, 'default')
	assert.equal(defaultSpawner.name, 'default')
})

test('Spawner registry discovers extension adapter files without a closed name enum', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-spawner-registry-'))
	const adapterDir = join(root, 'tmux')
	mkdirSync(adapterDir, { recursive: true })
	writeFileSync(
		join(adapterDir, 'spawner.mjs'),
		`
export async function createSpawner() {
\treturn {
\t\tname: 'tmux',
\t\tasync startPlanningSession(params) {
\t\t\treturn { worktreePath: '/tmp/tmux-plan', branchName: params.branchName, hint: 'tmux ready' }
\t\t},
\t}
}
`,
		'utf-8',
	)

	try {
		const registry = createSpawnerRegistry({ extensionDirUrl: pathToFileURL(root) })

		assert.equal(spawnerNameSchema.parse('tmux'), 'tmux')
		assert.deepEqual(
			registry.listAdapters().filter(adapter => adapter.name === 'tmux'),
			[{ name: 'tmux', available: true }],
		)

		const selected = await registry.create(config, 'tmux')
		assert.equal(selected.name, 'tmux')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('Spawner registry uses config spawner name as the default planning surface', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-spawner-default-'))
	const adapterDir = join(root, 'tmux')
	mkdirSync(adapterDir, { recursive: true })
	writeFileSync(
		join(adapterDir, 'spawner.mjs'),
		`
export function createSpawner() {
\treturn {
\t\tname: 'tmux',
\t\tasync startPlanningSession(params) {
\t\t\treturn { worktreePath: '/tmp/tmux-plan', branchName: params.branchName, hint: 'tmux ready' }
\t\t},
\t}
}
`,
		'utf-8',
	)

	try {
		const registry = createSpawnerRegistry({ extensionDirUrl: pathToFileURL(root) })
		const parsed = configSchema.parse({ ...config, spawner: { name: 'tmux' } })
		const selected = await registry.create(parsed)
		const document = buildConfigDocument(parsed, parsed)

		assert.equal(selected.name, 'tmux')
		assert.equal(document.dashboard.spawner.name, 'tmux')
		assert.ok(configEditPaths(document).includes('spawner.name'))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('server planning route accepts loop Item kinds through the same Spawner seam', async () => {
	await withTempDb(async db => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), 'helm-loop-item-plans-'))
		const ralph = db.items.create({
			kind: 'ralph',
			status: 'ready',
			projectSlug: 'helm',
			title: 'Plan ralph run',
			source: null,
			baseRef: 'main',
			payload: { kind: 'ralph', prdPath: 'docs/plans/afk-rework/prd.md' },
		})
		const harden = db.items.create({
			kind: 'harden',
			status: 'ready',
			projectSlug: 'helm',
			title: 'Plan harden run',
			source: null,
			baseRef: 'main',
			payload: { kind: 'harden', target: 'src/items' },
		})
		const planningSpawner = new FakePlanningSpawner(worktreeRoot)
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			planningSpawner,
			fakeEnricher as never,
		)

		try {
			const ralphRes = await api.request(`/items/${ralph.id}/plan`, { method: 'POST' })
			const hardenRes = await api.request(`/items/${harden.id}/plan`, { method: 'POST' })

			assert.equal(ralphRes.status, 200)
			assert.equal(hardenRes.status, 200)
			const ralphBody = (await ralphRes.json()) as { data: { planDirName: string } }
			const hardenBody = (await hardenRes.json()) as { data: { branchName: string } }
			assert.equal(
				planningSpawner.calls[0].taskContext.description,
				'Run almanac ralph for PRD: docs/plans/afk-rework/prd.md',
			)
			assert.equal(planningSpawner.calls[1].taskContext.description, 'Run almanac harden for target: src/items')
			assert.equal(db.items.get(ralph.id)?.planDirName, ralphBody.data.planDirName)
			assert.equal(db.items.get(harden.id)?.branchName, hardenBody.data.branchName)
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true })
		}
	})
})

test('Dashboard Contract includes optional source, branch, and PR links', async () => {
	await withTempDb(db => {
		const item = db.items.create({
			kind: 'solve',
			status: 'review',
			projectSlug: 'helm',
			title: 'Review linked Item',
			source: {
				provider: 'contember',
				externalId: 'task-123',
				url: 'https://example.test/tasks/task-123',
			},
			baseRef: 'main',
			payload: { kind: 'solve', prompt: 'Ship linked Item.' },
		})

		const contract = toDashboardItem({
			...item,
			branchName: 'helm/item-contract',
			prUrl: 'https://github.com/neumie/helm/pull/123',
		})

		assert.deepEqual(contract.card, {
			state: 'review',
			statusLabel: 'Review',
			statusTone: 'amber',
			pulse: false,
		})
		assert.deepEqual(contract.links, {
			source: { label: 'task-123', url: 'https://example.test/tasks/task-123' },
			branch: { label: 'helm/item-contract', url: 'https://github.com/neumie/helm/pull/123' },
			pr: { label: 'PR #123', url: 'https://github.com/neumie/helm/pull/123' },
		})
		assert.deepEqual(
			contract.allowedActions.map(a => a.id),
			['retry'],
		)
	})
})

test('Dashboard Contract exposes persisted Item plan identity', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createRalphItem({
			title: 'Resume planned Item',
			projectSlug: 'helm',
			prdPath: 'docs/plans/afk-rework/prd.md',
		})
		const planned = commands.recordPlanPrepared(item.id, {
			worktreePath: '/tmp/helm-planned-item',
			branchName: 'helm/item/resume-planned',
			planDirName: 'resume-planned-item',
			spawner: 'default',
		})

		const contract = toDashboardItem(planned)

		assert.deepEqual(contract.plan, {
			worktreePath: '/tmp/helm-planned-item',
			branchName: 'helm/item/resume-planned',
			planDirName: 'resume-planned-item',
			readmePath: new PlanWorkspace('/tmp/helm-planned-item', 'resume-planned-item').readmePath,
		})
	})
})

test('Dashboard Contract groups sibling Items together without changing lifecycle actions', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const siblings = commands.createSolveItems({
			title: 'Grouped dashboard Item',
			projectSlug: 'helm',
			prompt: 'Render siblings together.',
			parallelism: 2,
		})
		const standalone = commands.createSolveItem({
			title: 'Standalone dashboard Item',
			projectSlug: 'helm',
			prompt: 'Render outside the group.',
		})
		commands.startItem(siblings[0].id)
		commands.failItem(siblings[0].id, 'attempt failed', 'solve')
		const first = db.items.get(siblings[0].id)
		const second = db.items.get(siblings[1].id)
		assert.ok(first)
		assert.ok(second)

		const contracts = toDashboardItems([first, standalone, second])

		assert.deepEqual(
			contracts.map(item => item.id),
			[first.id, second.id, standalone.id],
		)
		assert.deepEqual(contracts[0].group, {
			id: first.groupId,
			label: 'Group 1/2',
			position: 1,
			size: 2,
			siblingIds: [first.id, second.id],
		})
		assert.deepEqual(contracts[1].group, {
			id: first.groupId,
			label: 'Group 2/2',
			position: 2,
			size: 2,
			siblingIds: [first.id, second.id],
		})
		assert.equal(contracts[2].group, null)
		assert.deepEqual(
			// failed solve Item: retry (re-run) + reopen (manual false-failure override)
			contracts[0].allowedActions.map(action => action.id),
			['retry', 'reopen'],
		)
		assert.deepEqual(
			contracts[1].allowedActions.map(action => action.id),
			['start', 'cancel'],
		)
	})
})

test('runOutcome records the run guess separate from lifecycle status', () => {
	withTempDb(db => {
		const commands = new ItemCommands(db.items, config)

		const ok = commands.createSolveItem({ title: 'ok run', projectSlug: 'helm', prompt: 'do it' })
		commands.startItem(ok.id)
		const completed = commands.completeSolveItem(ok.id, {
			worktreePath: '/tmp/wt',
			branchName: 'helm/item/ok',
			planDirName: '2026-06-26-ok',
			resultSummary: 'done',
		})
		assert.equal(completed.status, 'review')
		assert.equal(completed.runOutcome, 'ok')

		const errored = commands.createSolveItem({ title: 'errored run', projectSlug: 'helm', prompt: 'do it' })
		commands.startItem(errored.id)
		const failed = commands.failItem(errored.id, 'agent blew up', 'solve')
		assert.equal(failed.status, 'failed')
		assert.equal(failed.runOutcome, 'errored')

		const noResult = commands.createSolveItem({ title: 'no result run', projectSlug: 'helm', prompt: 'do it' })
		commands.startItem(noResult.id)
		const failedNoResult = commands.failItem(noResult.id, 'No solver-result.json at docs/...', 'solve')
		assert.equal(failedNoResult.runOutcome, 'no_result')
	})
})

test('reconcileFailedSolve lands an errored run with shippable work in review, not failed', () => {
	withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'shipped but no result', projectSlug: 'helm', prompt: 'do it' })
		commands.startItem(item.id)
		commands.recordExecutionWorkspaceIdentity(item.id, {
			worktreePath: '/tmp/wt',
			branchName: 'helm/item/x',
			planDirName: '2026-06-26-x',
		})

		const reconciled = commands.reconcileFailedSolve(item.id, {
			message: 'No solver-result.json at docs/...',
			phase: 'solve',
			prUrl: 'https://github.com/neumie/helm/pull/9',
		})
		assert.equal(reconciled.status, 'review')
		assert.equal(reconciled.runOutcome, 'no_result')
		assert.equal(reconciled.prUrl, 'https://github.com/neumie/helm/pull/9')
		// error context is kept so the dashboard can flag "run was messy — verify"
		assert.equal(reconciled.errorMessage, 'No solver-result.json at docs/...')

		// only processing solve Items can be reconciled
		assert.throws(() => commands.reconcileFailedSolve(item.id, { message: 'x', phase: 'solve' }))
	})
})

test('reopenItem is the manual false-failure override (failed solve → review)', () => {
	withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'actually fine', projectSlug: 'helm', prompt: 'do it' })
		commands.startItem(item.id)
		commands.failItem(item.id, 'looked failed', 'solve')

		const reopened = commands.reopenItem(item.id)
		assert.equal(reopened.status, 'review')
		assert.equal(reopened.errorMessage, null)
		// failed solve Items advertise both retry and reopen; review does not
		assert.deepEqual(
			toDashboardItem(db.items.get(item.id) ?? reopened).allowedActions.map(a => a.id),
			['retry'],
		)

		// reopen is only valid from failed, and only for solve Items
		assert.throws(() => commands.reopenItem(item.id))
		const loop = commands.createRalphItem({ title: 'loop', projectSlug: 'helm', prdPath: 'docs/p.md' })
		commands.startItem(loop.id)
		commands.failItem(loop.id, 'loop failed', 'loop')
		assert.throws(() => commands.reopenItem(loop.id))
		assert.deepEqual(
			toDashboardItem(db.items.get(loop.id) ?? loop).allowedActions.map(a => a.id),
			['retry'],
		)
	})
})

test('parsePrUrl extracts owner/repo from a GitHub PR URL', () => {
	assert.deepEqual(parsePrUrl('https://github.com/neumie/helm/pull/123'), { owner: 'neumie', repo: 'helm' })
	assert.equal(parsePrUrl('https://example.com/not/a/pr'), null)
})

test('httpUrlOrNull rejects non-http(s) deploy URLs (XSS guard)', () => {
	assert.equal(httpUrlOrNull('https://staging.example.com'), 'https://staging.example.com')
	assert.equal(httpUrlOrNull('http://localhost:3000'), 'http://localhost:3000')
	// biome-ignore lint/suspicious/noExplicitAny: testing a hostile URL value
	assert.equal(httpUrlOrNull('javascript:alert(1)' as any), null)
	assert.equal(httpUrlOrNull('data:text/html,<script>x</script>'), null)
	assert.equal(httpUrlOrNull(null), null)
	assert.equal(httpUrlOrNull('not a url'), null)
})

test('listDeployWatchable returns shipped solve Items, excludes unshipped', () => {
	withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const shipped = commands.createSolveItem({ title: 'shipped', projectSlug: 'helm', prompt: 'x' })
		commands.startItem(shipped.id)
		commands.completeSolveItem(shipped.id, {
			worktreePath: '/tmp/a',
			branchName: 'b',
			planDirName: 'p',
			resultSummary: 's',
		})
		commands.recordDispatchPr(shipped.id, { prUrl: 'https://github.com/neumie/helm/pull/1' })
		const queuedNoPr = commands.createSolveItem({ title: 'ready', projectSlug: 'helm', prompt: 'x' })

		const ids = db.items.listDeployWatchable().map(i => i.id)
		assert.ok(ids.includes(shipped.id))
		assert.ok(!ids.includes(queuedNoPr.id))
	})
})

test('recordDeployState persists the ladder and emits transition events exactly once', () => {
	withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'shipped', projectSlug: 'helm', prompt: 'do it' })
		commands.startItem(item.id)
		commands.completeSolveItem(item.id, {
			worktreePath: '/tmp/wt',
			branchName: 'helm/item/x',
			planDirName: '2026-06-26-x',
			resultSummary: 'done',
		})
		commands.recordDispatchPr(item.id, { prUrl: 'https://github.com/neumie/helm/pull/9' })

		// first observation: merged, staging success, production in-progress
		const s1 = commands.recordDeployState(item.id, {
			merged: true,
			mergedAt: '2026-06-26T10:00:00Z',
			mergeSha: 'abc',
			deployments: [
				{ environment: 'staging', state: 'success', url: 'https://staging', updatedAt: null },
				{ environment: 'production', state: 'in_progress', url: null, updatedAt: null },
			],
			checkedAt: '2026-06-26T10:01:00Z',
		})
		assert.equal(s1.deployState?.merged, true)
		assert.equal(db.items.countEvents(item.id, 'deploy_merged'), 1)
		assert.equal(db.items.countEvents(item.id, 'deploy_succeeded'), 1) // staging only

		// production now succeeds → one more deploy_succeeded, merged event NOT re-fired
		commands.recordDeployState(item.id, {
			merged: true,
			mergedAt: '2026-06-26T10:00:00Z',
			mergeSha: 'abc',
			deployments: [
				{ environment: 'staging', state: 'success', url: 'https://staging', updatedAt: null },
				{ environment: 'production', state: 'success', url: 'https://prod', updatedAt: null },
			],
			checkedAt: '2026-06-26T10:05:00Z',
		})
		assert.equal(db.items.countEvents(item.id, 'deploy_merged'), 1)
		assert.equal(db.items.countEvents(item.id, 'deploy_succeeded'), 2)

		const row = db.items.get(item.id)
		assert.ok(row)
		assert.equal(toDashboardItem(row).deployState?.deployments.length, 2)

		// idempotent: identical state again writes nothing new
		const before = db.items.getEvents(item.id).length
		commands.recordDeployState(item.id, {
			merged: true,
			mergedAt: '2026-06-26T10:00:00Z',
			mergeSha: 'abc',
			deployments: [
				{ environment: 'staging', state: 'success', url: 'https://staging', updatedAt: null },
				{ environment: 'production', state: 'success', url: 'https://prod', updatedAt: null },
			],
			checkedAt: '2026-06-26T10:09:00Z',
		})
		assert.equal(db.items.getEvents(item.id).length, before)
	})
})

test('markItemMerged moves a review solve Item to completed and is idempotent', () => {
	withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'shipped', projectSlug: 'helm', prompt: 'p' })
		commands.startItem(item.id)
		commands.completeSolveItem(item.id, {
			worktreePath: '/tmp/wt',
			branchName: 'b',
			planDirName: 'p',
			resultSummary: 's',
		})
		assert.equal(db.items.get(item.id)?.status, 'review')

		const merged = commands.markItemMerged(item.id)
		assert.equal(merged.status, 'done')
		assert.equal(db.items.countEvents(item.id, 'item_merged'), 1)

		// idempotent: not in review anymore → no-op, no duplicate event
		const again = commands.markItemMerged(item.id)
		assert.equal(again.status, 'done')
		assert.equal(db.items.countEvents(item.id, 'item_merged'), 1)
	})
})

test('setItemStatus is a guarded manual override', () => {
	withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 't', projectSlug: 'helm', prompt: 'p' }) // queued

		const done = commands.setItemStatus(item.id, 'done')
		assert.equal(done.status, 'done')
		assert.ok(done.completedAt)
		assert.equal(db.items.countEvents(item.id, 'item_status_set'), 1)

		const requeued = commands.setItemStatus(item.id, 'ready')
		assert.equal(requeued.status, 'ready')
		assert.ok(requeued.queuedAt)
		assert.equal(requeued.completedAt, null)

		// cannot fake `processing`
		assert.throws(() => commands.setItemStatus(item.id, 'running'))

		// cannot override a running Item — cancel it first
		commands.startItem(item.id)
		assert.throws(() => commands.setItemStatus(item.id, 'done'))
	})
})

test('server single Item reads include sibling group dashboard metadata', async () => {
	await withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const siblings = commands.createSolveItems({
			title: 'Grouped detail Item',
			projectSlug: 'helm',
			prompt: 'Keep group metadata on detail reads.',
			parallelism: 2,
		})
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request(`/items/${siblings[1].id}`)

		assert.equal(res.status, 200)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem> }
		assert.deepEqual(body.data.group, {
			id: siblings[0].groupId,
			label: 'Group 2/2',
			position: 2,
			size: 2,
			siblingIds: siblings.map(item => item.id),
		})
	})
})

test('server can find an Item dashboard contract by Source external id', async () => {
	await withTempDb(async db => {
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)
		db.items.create({
			kind: 'solve',
			status: 'ready',
			projectSlug: 'helm',
			title: 'Source-backed Item',
			source: {
				provider: 'contember',
				externalId: 'task-456',
				url: 'https://example.test/tasks/task-456',
			},
			baseRef: 'main',
			payload: { kind: 'solve', prompt: 'Render in extension.' },
		})

		const res = await api.request('/items/by-source/task-456')

		assert.equal(res.status, 200)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem> | null }
		assert.equal(body.data?.title, 'Source-backed Item')
		assert.deepEqual(body.data?.links.source, {
			label: 'task-456',
			url: 'https://example.test/tasks/task-456',
		})
	})
})

test('poller ingests provider tasks as source-backed unverified Items', async () => {
	await withTempDb(async db => {
		const sourceConfig = {
			...config,
			provider: {
				...config.provider,
				taskBaseUrl: 'https://example.test/tasks/',
			},
		}
		const sourceProvider = {
			...provider,
			name: 'contember',
			pollNewTasks: async () => [
				{
					externalId: 'task-789',
					title: 'Review source task',
					createdAt: '2026-06-19T12:00:00.000Z',
				},
			],
		}
		const sourcePoller = new Poller(sourceConfig, db, sourceProvider)

		await sourcePoller.pollOnce()

		const item = db.items.findBySourceExternalId('task-789')
		assert.equal(item?.status, 'triage')
		assert.deepEqual(item?.source, {
			provider: 'contember',
			externalId: 'task-789',
			url: 'https://example.test/tasks/task-789',
		})
		assert.equal(item?.queuedAt, null)
		assert.equal(item?.baseRef, 'main')
		assert.deepEqual(item ? toDashboardItem(item).allowedActions.map(a => a.id) : [], ['approve', 'reject'])
	})
})

test('server creates source-backed unverified Items from external ids', async () => {
	await withTempDb(async db => {
		const sourceConfig = {
			...config,
			provider: {
				...config.provider,
				taskBaseUrl: 'https://example.test/tasks/',
			},
		}
		const sourceProvider = {
			...provider,
			name: 'contember',
			resolveTaskSummary: async (externalId: string) =>
				externalId === 'task-extension-create'
					? {
							projectSlug: 'helm',
							title: 'Extension-created source Item',
						}
					: null,
		}
		const api = apiRoutes(
			sourceConfig,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			sourceProvider,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request('/items/source', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ externalId: 'task-extension-create' }),
		})

		assert.equal(res.status, 201)
		const body = (await res.json()) as { data: ReturnType<typeof toDashboardItem> }
		assert.equal(body.data.kind, 'solve')
		assert.equal(body.data.status, 'triage')
		assert.equal(body.data.title, 'Extension-created source Item')
		assert.deepEqual(body.data.source, {
			provider: 'contember',
			externalId: 'task-extension-create',
			url: 'https://example.test/tasks/task-extension-create',
		})
		assert.deepEqual(
			body.data.allowedActions.map(action => action.id),
			['approve', 'reject'],
		)
		assert.equal(db.items.findBySourceExternalId('task-extension-create')?.id, body.data.id)
	})
})

test('server rejects solverAgent on source Item creation', async () => {
	await withTempDb(async db => {
		const sourceProvider = {
			...provider,
			name: 'contember',
			resolveTaskSummary: async (externalId: string) =>
				externalId === 'task-source-agent'
					? {
							projectSlug: 'helm',
							title: 'Source Item with stale agent field',
						}
					: null,
		}
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			sourceProvider,
			spawner as never,
			fakeEnricher as never,
		)

		const res = await api.request('/items/source', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ externalId: 'task-source-agent', solverAgent: 'codex' }),
		})

		assert.equal(res.status, 400)
		const body = (await res.json()) as { error: string }
		assert.match(body.error, /solverAgent is only accepted by planning and Item action routes/)
		assert.equal(db.items.findBySourceExternalId('task-source-agent'), null)
	})
})

test('ItemCommands approve and reject unverified Items with lifecycle events', async () => {
	await withTempDb(db => {
		const commands = new ItemCommands(db.items, config)
		const source = {
			provider: 'contember',
			externalId: 'task-approve',
			url: 'https://example.test/tasks/task-approve',
		}
		const toApprove = commands.createSolveItem({
			title: 'Approve source Item',
			projectSlug: 'helm',
			prompt: 'Approve this source Item.',
			source,
		})
		const toReject = commands.createSolveItem({
			title: 'Reject source Item',
			projectSlug: 'helm',
			prompt: 'Reject this source Item.',
			source: { ...source, externalId: 'task-reject', url: 'https://example.test/tasks/task-reject' },
		})

		const approved = commands.approveItem(toApprove.id)
		const rejected = commands.rejectItem(toReject.id)

		assert.equal(approved.status, 'ready')
		assert.notEqual(approved.queuedAt, null)
		assert.deepEqual(
			toDashboardItem(approved).allowedActions.map(a => a.id),
			['start', 'cancel'],
		)
		assert.deepEqual(
			db.items.getEvents(approved.id).map(event => event.eventType),
			['item_approved'],
		)
		assert.equal(rejected.status, 'cancelled')
		assert.notEqual(rejected.completedAt, null)
		assert.deepEqual(
			toDashboardItem(rejected).allowedActions.map(a => a.id),
			['retry'],
		)
		assert.deepEqual(
			db.items.getEvents(rejected.id).map(event => event.eventType),
			['item_rejected'],
		)
	})
})

test('server approves and rejects Items through dashboard contract routes', async () => {
	await withTempDb(async db => {
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			queue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)
		const approveTarget = db.items.create({
			kind: 'solve',
			status: 'triage',
			projectSlug: 'helm',
			title: 'Approve via API',
			source: {
				provider: 'contember',
				externalId: 'task-api-approve',
				url: 'https://example.test/tasks/task-api-approve',
			},
			baseRef: 'main',
			payload: { kind: 'solve', prompt: 'Approve via API.' },
		})
		const rejectTarget = db.items.create({
			kind: 'solve',
			status: 'triage',
			projectSlug: 'helm',
			title: 'Reject via API',
			source: {
				provider: 'contember',
				externalId: 'task-api-reject',
				url: 'https://example.test/tasks/task-api-reject',
			},
			baseRef: 'main',
			payload: { kind: 'solve', prompt: 'Reject via API.' },
		})

		const approveRes = await api.request(`/items/${approveTarget.id}/approve`, { method: 'POST' })
		const rejectRes = await api.request(`/items/${rejectTarget.id}/reject`, { method: 'POST' })

		assert.equal(approveRes.status, 200)
		assert.equal(rejectRes.status, 200)
		const approved = (await approveRes.json()) as { data: ReturnType<typeof toDashboardItem> }
		const rejected = (await rejectRes.json()) as { data: ReturnType<typeof toDashboardItem> }
		assert.equal(approved.data.status, 'ready')
		assert.deepEqual(
			approved.data.allowedActions.map(a => a.id),
			['start', 'cancel'],
		)
		assert.equal(rejected.data.status, 'cancelled')
		assert.deepEqual(
			rejected.data.allowedActions.map(a => a.id),
			['retry'],
		)
	})
})

test('server start and cancel Item action routes return dashboard contract', async () => {
	await withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const startTarget = commands.createSolveItem({
			title: 'Start via API',
			projectSlug: 'helm',
			prompt: 'Start this Item.',
		})
		const cancelTarget = commands.createSolveItem({
			title: 'Cancel via API',
			projectSlug: 'helm',
			prompt: 'Cancel this Item.',
		})
		const routeQueue = {
			...queue,
			processOneItem: (id: string) => {
				commands.startItem(id)
				return true
			},
			cancelItem: (id: string) => {
				commands.cancelQueuedItem(id)
				return true
			},
		}
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			routeQueue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)

		const startRes = await api.request(`/items/${startTarget.id}/start`, { method: 'POST' })
		const cancelRes = await api.request(`/items/${cancelTarget.id}/cancel`, { method: 'POST' })

		assert.equal(startRes.status, 200)
		assert.equal(cancelRes.status, 200)
		const started = (await startRes.json()) as { data: ReturnType<typeof toDashboardItem> }
		const cancelled = (await cancelRes.json()) as { data: ReturnType<typeof toDashboardItem> }
		assert.equal(started.data.id, startTarget.id)
		assert.equal(started.data.status, 'running')
		assert.deepEqual(
			started.data.allowedActions.map(a => a.id),
			['cancel'],
		)
		assert.equal(cancelled.data.id, cancelTarget.id)
		assert.equal(cancelled.data.status, 'cancelled')
		assert.deepEqual(
			cancelled.data.allowedActions.map(a => a.id),
			['retry'],
		)
	})
})

test('server Item work-start routes persist selected solve agent before queue handoff', async () => {
	await withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const approveTarget = db.items.create({
			kind: 'solve',
			status: 'triage',
			projectSlug: 'helm',
			title: 'Approve with Codex',
			source: {
				provider: 'contember',
				externalId: 'task-api-approve-agent',
				url: 'https://example.test/tasks/task-api-approve-agent',
			},
			baseRef: 'main',
			payload: { kind: 'solve', prompt: 'Approve with selected agent.' },
		})
		const startTarget = commands.createSolveItem({
			title: 'Start with Codex',
			projectSlug: 'helm',
			prompt: 'Start with selected agent.',
		})
		const retryTarget = commands.createSolveItem({
			title: 'Retry with Codex',
			projectSlug: 'helm',
			prompt: 'Retry with selected agent.',
		})
		commands.startItem(retryTarget.id)
		commands.failItem(retryTarget.id, 'fail once', 'solve')

		const routeQueue = {
			...queue,
			processOneItem: (id: string) => {
				assert.equal(db.items.get(id)?.payload.solverAgent, 'codex')
				commands.startItem(id)
				return true
			},
			retryItem: (id: string) => {
				assert.equal(db.items.get(id)?.payload.solverAgent, 'codex')
				return commands.retryItem(id)
			},
			wake: () => {
				assert.equal(db.items.get(approveTarget.id)?.payload.solverAgent, 'codex')
			},
		}
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			routeQueue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)
		const postCodex = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ solverAgent: 'codex' }),
		}

		const approveRes = await api.request(`/items/${approveTarget.id}/approve`, postCodex)
		const startRes = await api.request(`/items/${startTarget.id}/start`, postCodex)
		const retryRes = await api.request(`/items/${retryTarget.id}/retry`, postCodex)

		assert.equal(approveRes.status, 200)
		assert.equal(startRes.status, 200)
		assert.equal(retryRes.status, 200)
		assert.equal(db.items.get(approveTarget.id)?.payload.solverAgent, 'codex')
		assert.equal(db.items.get(startTarget.id)?.payload.solverAgent, 'codex')
		assert.equal(db.items.get(retryTarget.id)?.payload.solverAgent, 'codex')
	})
})

test('recordPlanPrepared stamps plannedAt (the "planned" signal) and re-plan preserves the original', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'Plan me', projectSlug: 'helm', prompt: 'do it' })
		assert.equal(item.plannedAt, null) // a fresh item is unplanned

		const planned = commands.recordPlanPrepared(item.id, {
			worktreePath: '/tmp/wt',
			branchName: 'feat/x',
			planDirName: '2026-06-30-x',
			spawner: 'default',
		})
		assert.ok(planned.plannedAt, 'plannedAt stamped on plan')
		assert.equal(toDashboardItem(planned).plannedAt, planned.plannedAt) // contract surfaces it (free in list)

		// Re-planning keeps the first-planned time (don't reset the historical fact).
		const replanned = commands.recordPlanPrepared(item.id, {
			worktreePath: '/tmp/wt',
			branchName: 'feat/x',
			planDirName: '2026-06-30-x',
			spawner: 'default',
		})
		assert.equal(replanned.plannedAt, planned.plannedAt)
	}))

test('PlanWorkspace.listArtifacts returns each .md file with content and skips non-markdown', () => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-plan-'))
	try {
		const ws = new PlanWorkspace(dir, '2026-06-30-demo')
		ws.ensureDir()
		writeFileSync(join(ws.dir, 'context.md'), 'task context', 'utf-8')
		writeFileSync(join(ws.dir, 'prd.md'), '# PRD\nDecision: do X', 'utf-8')
		writeFileSync(join(ws.dir, '.planning-prompt.txt'), 'not markdown', 'utf-8')

		const arts = ws.listArtifacts()
		assert.deepEqual(arts.map(a => a.name).sort(), ['context.md', 'prd.md'])
		assert.equal(arts.find(a => a.name === 'prd.md')?.content, '# PRD\nDecision: do X')
		assert.ok(!arts.some(a => a.name.endsWith('.txt'))) // non-markdown excluded
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('PlanWorkspace.listArtifacts truncates a pathologically large plan file for the preview', () => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-plan-big-'))
	try {
		const ws = new PlanWorkspace(dir, '2026-06-30-big')
		ws.ensureDir()
		writeFileSync(join(ws.dir, 'prd.md'), 'x'.repeat(200_000), 'utf-8')
		const [art] = ws.listArtifacts()
		assert.ok(art.content.length < 200_000, 'content capped')
		assert.match(art.content, /truncated for preview/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

// Manual AI passes from the item detail — the route force-runs each pass with an
// injected one-shot (no real model) and returns the updated item. apiRoutes takes
// the injected one-shot as its trailing arg (9th = default planning spawner).
function aiApi(db: DB, oneShot: () => Promise<string | null>) {
	return apiRoutes(
		config,
		'helm.config.json',
		db,
		queue as never,
		poller as never,
		provider as never,
		spawner as never,
		fakeEnricher as never,
		undefined,
		oneShot,
	)
}

test('POST /items/:id/ai/display-name force-runs the pass and returns the updated item', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		// displayName is disabled in this config + the item starts unnamed — force
		// must run regardless and persist the result.
		const item = commands.createSolveItem({
			title: 'A long provider title that should compress to a short human label',
			projectSlug: 'helm',
			prompt: 'do the thing',
		})
		const api = aiApi(db, async () => 'Compress invoice recipient logic')
		const res = await api.request(`/items/${item.id}/ai/display-name`, { method: 'POST' })
		assert.equal(res.status, 200)
		const { data } = (await res.json()) as { data: { displayName: string } }
		assert.equal(data.displayName, 'Compress invoice recipient logic')
		assert.equal(db.items.get(item.id)?.displayName, 'Compress invoice recipient logic')
	}))

test('POST /items/:id/ai/assess force-runs triage and stores the assessment', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({
			title: 'Bug report',
			projectSlug: 'helm',
			prompt: 'export 500s',
			source: { provider: 'contember', externalId: 'assess-route-1' },
		})
		const assessmentJson = JSON.stringify({
			intent: 'Fix the export 500',
			verdict: 'clear',
			clarifyingQuestions: [],
			securityNote: null,
		})
		const api = aiApi(db, async () => assessmentJson)
		const res = await api.request(`/items/${item.id}/ai/assess`, { method: 'POST' })
		assert.equal(res.status, 200)
		const { data } = (await res.json()) as { data: { assessment: { verdict: string; intent: string } } }
		assert.equal(data.assessment.verdict, 'clear')
		assert.equal(db.items.get(item.id)?.assessment?.intent, 'Fix the export 500')
	}))

test('POST /items/:id/ai/branch-name force-derives a branch for a worktree-less solve Item', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })
		const api = aiApi(db, async () => 'feat/manual-branch')
		const res = await api.request(`/items/${item.id}/ai/branch-name`, { method: 'POST' })
		assert.equal(res.status, 200)
		const { data } = (await res.json()) as { data: { branchName: string } }
		assert.equal(data.branchName, 'feat/manual-branch')
		assert.equal(db.items.get(item.id)?.branchName, 'feat/manual-branch')
	}))

test('POST /items/:id/ai/:pass guards unknown pass, missing item, and unsafe branch renames', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const solve = commands.createSolveItem({ title: 'whatever', projectSlug: 'helm', prompt: 'do it' })
		const ralph = commands.createRalphItem({ title: 'loop', projectSlug: 'helm', prdPath: 'docs/prd/x.md' })
		// A worktree already exists → renaming its branch would orphan it.
		db.items.update(solve.id, { worktreePath: '/tmp/already-a-worktree' })

		let modelCalled = false
		const api = aiApi(db, async () => {
			modelCalled = true
			return 'feat/should-not-run'
		})
		const post = (path: string) => api.request(path, { method: 'POST' })

		assert.equal((await post(`/items/${solve.id}/ai/bogus`)).status, 400) // unknown pass
		assert.equal((await post('/items/nope/ai/display-name')).status, 404) // missing item
		assert.equal((await post(`/items/${ralph.id}/ai/branch-name`)).status, 400) // loop kind
		assert.equal((await post(`/items/${solve.id}/ai/branch-name`)).status, 400) // worktree exists
		assert.equal(modelCalled, false) // every guard short-circuits before the model
	}))

test('DeployWatcher backfills a late PR onto an errored review Item and stops once recorded', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'late pr', projectSlug: 'helm', prompt: 'x' })
		commands.startItem(item.id)
		commands.recordExecutionWorkspaceIdentity(item.id, {
			worktreePath: '/tmp/wt',
			branchName: 'fix/late',
			planDirName: 'p',
		})
		// Errored run reconciled to review with no PR yet — the backfill target.
		commands.reconcileFailedSolve(item.id, { message: 'idle timeout', phase: 'solve' })
		assert.deepEqual(
			db.items.listPrBackfillable().map(i => i.id),
			[item.id],
		)

		const discovered: Array<{ repoPath: string; branch: string }> = []
		const watcher = new DeployWatcher(config, db, {
			discoverPrUrl: async (repoPath, branch) => {
				discovered.push({ repoPath, branch })
				return discovered.length === 1 ? null : 'https://github.com/neumie/helm/pull/9'
			},
			fetchDeployState: async () => null,
		})

		// First poll: no PR yet — Item stays on the work-list, nothing written.
		await watcher.pollOnce()
		assert.equal(db.items.get(item.id)?.prUrl, null)
		assert.equal(db.items.listPrBackfillable().length, 1)

		// Second poll: PR appeared — recorded via recordDispatchPr, drops off the list.
		await watcher.pollOnce()
		assert.deepEqual(discovered, [
			{ repoPath: '/repo', branch: 'fix/late' },
			{ repoPath: '/repo', branch: 'fix/late' },
		])
		const updated = db.items.get(item.id)
		assert.equal(updated?.prUrl, 'https://github.com/neumie/helm/pull/9')
		assert.equal(updated?.status, 'review')
		assert.equal(db.items.countEvents(item.id, 'pr_created'), 1)
		assert.equal(db.items.listPrBackfillable().length, 0)
	}))

test('listPrBackfillable excludes ok runs, missing branches, and non-review statuses', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		// Clean completed run (runOutcome ok) — dispatch owns its PR story, not the backfill.
		const ok = commands.createSolveItem({ title: 'ok', projectSlug: 'helm', prompt: 'x' })
		commands.startItem(ok.id)
		commands.completeSolveItem(ok.id, { worktreePath: '/t', branchName: 'b1', planDirName: 'p', resultSummary: 's' })
		// Errored review Item without a branch — nothing to look up.
		const noBranch = commands.createSolveItem({ title: 'nb', projectSlug: 'helm', prompt: 'x' })
		commands.startItem(noBranch.id)
		commands.recordExecutionWorkspaceIdentity(noBranch.id, { worktreePath: '/t2', planDirName: 'p2' })
		// Failed (not review) Item.
		const failed = commands.createSolveItem({ title: 'f', projectSlug: 'helm', prompt: 'x' })
		commands.startItem(failed.id)
		commands.failItem(failed.id, 'boom', 'solve')

		// reconcileFailedSolve needs shippable work context; noBranch lacks branchName so
		// it lands in review via reconcile only when branch exists — emulate by failing it.
		commands.failItem(noBranch.id, 'boom', 'solve')

		assert.equal(db.items.listPrBackfillable().length, 0)
	}))

test('setSolveItemModel stores and clears the per-item model override', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'model pick', projectSlug: 'helm', prompt: 'x' })

		const withModel = commands.setSolveItemModel(item.id, 'claude-fable-5')
		assert.equal(withModel.payload.kind === 'solve' ? withModel.payload.solverModel : null, 'claude-fable-5')

		const cleared = commands.setSolveItemModel(item.id, null)
		assert.equal(cleared.payload.kind === 'solve' ? cleared.payload.solverModel : 'set', undefined)

		const ralph = commands.createRalphItem({ title: 'r', projectSlug: 'helm', prdPath: 'docs/prd.md' })
		assert.throws(() => commands.setSolveItemModel(ralph.id, 'claude-fable-5'))
	}))

test('Item action routes set, reject, and clear the per-item solver model', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const setTarget = commands.createSolveItem({ title: 'set model', projectSlug: 'helm', prompt: 'x' })
		const clearTarget = commands.createSolveItem({ title: 'clear model', projectSlug: 'helm', prompt: 'x' })
		commands.setSolveItemModel(clearTarget.id, 'claude-opus-4-8')

		const routeQueue = {
			...queue,
			processOneItem: (id: string) => {
				commands.startItem(id)
				return true
			},
		}
		const api = apiRoutes(
			config,
			'helm.config.json',
			db,
			routeQueue as never,
			poller as never,
			provider as never,
			spawner as never,
			fakeEnricher as never,
		)
		const post = (body: unknown) => ({
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})

		// Invalid model → 400, nothing persisted.
		const bad = await api.request(`/items/${setTarget.id}/start`, post({ solverModel: '' }))
		assert.equal(bad.status, 400)

		// Model set on start.
		const setRes = await api.request(`/items/${setTarget.id}/start`, post({ solverModel: 'claude-fable-5' }))
		assert.equal(setRes.status, 200)
		const setPayload = db.items.get(setTarget.id)?.payload
		assert.equal(setPayload?.kind === 'solve' ? setPayload.solverModel : null, 'claude-fable-5')

		// Explicit null clears a previously stored override (the "Auto" chip).
		const clearRes = await api.request(`/items/${clearTarget.id}/start`, post({ solverModel: null }))
		assert.equal(clearRes.status, 200)
		const clearedPayload = db.items.get(clearTarget.id)?.payload
		assert.equal(clearedPayload?.kind === 'solve' ? clearedPayload.solverModel : 'set', undefined)
	}))

test('late-PR backfill falls back to the worktree branch when the agent renamed it', () =>
	withTempDb(async db => {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'renamed', projectSlug: 'helm', prompt: 'x' })
		commands.startItem(item.id)
		commands.recordExecutionWorkspaceIdentity(item.id, {
			worktreePath: '/tmp/wt-renamed',
			branchName: 'fix/stored-name',
			planDirName: 'p',
		})
		commands.reconcileFailedSolve(item.id, { message: 'idle timeout', phase: 'solve' })

		const lookups: string[] = []
		const watcher = new DeployWatcher(config, db, {
			discoverPrUrl: async (_repoPath, branch) => {
				lookups.push(branch)
				return branch === 'fix/live-name' ? 'https://github.com/neumie/helm/pull/12' : null
			},
			readWorktreeBranch: async () => 'fix/live-name',
			fetchDeployState: async () => null,
		})
		await watcher.pollOnce()

		assert.deepEqual(lookups, ['fix/stored-name', 'fix/live-name'])
		assert.equal(db.items.get(item.id)?.prUrl, 'https://github.com/neumie/helm/pull/12')
	}))

test('buildPrompt injects model-tier guidance for known models only', () => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-guidance-'))
	try {
		const task = { title: 'Guide me', description: 'x' }
		const ctx = { planDirName: 'guide-plan', worktreePath: dir }
		const fable = buildPrompt(task as never, ctx as never, { model: 'claude-fable-5' })
		assert.ok(fable.includes('## How to spend this model'))
		assert.ok(fable.includes('orchestrator'))
		const unknown = buildPrompt(task as never, ctx as never, { model: 'some-custom-model' })
		assert.ok(!unknown.includes('## How to spend this model'))
		const none = buildPrompt(task as never, ctx as never)
		assert.ok(!none.includes('## How to spend this model'))
		const overridden = buildPrompt(task as never, ctx as never, {
			model: 'claude-fable-5',
			modelGuidance: { 'claude-fable-5': 'Custom marching orders.' },
		})
		assert.ok(overridden.includes('Custom marching orders.'))
		assert.ok(!overridden.includes('orchestrator'))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
