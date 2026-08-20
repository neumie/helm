import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { MIGRATIONS } from '../src/db/schema.js'
import { ItemCommands } from '../src/items/commands.js'
import { KnowledgeIntegration } from '../src/knowledge/integration.js'
import { type KnowledgeProvider, KnowledgeProviderError, KnowledgeProviderRegistry } from '../src/knowledge/provider.js'
import { PlanningApplication } from '../src/plan/application.js'
import { PlanWorkspace } from '../src/plan/workspace.js'
import type { TaskProvider } from '../src/providers/provider.js'
import type { LoopRunParams, LoopRunner } from '../src/queue/loop-runner.js'
import { processLoopItem, processSolveItem } from '../src/queue/worker.js'
import { createApp } from '../src/server/app.js'
import { buildPlanningPrompt, buildPrompt } from '../src/solver/prompt-builder.js'
import type { SolveParams, SolveResult, Solver } from '../src/solver/solver.js'
import type { PlanningSessionParams, PlanningSessionResult, Spawner } from '../src/spawner/spawner.js'
import { excludeHelmFiles } from '../src/worktree/manager.js'

const LOCAL_CONTROL_TOKEN = 'A'.repeat(43)
const KNOWLEDGE_CONTEXT = '## Project knowledge\n\nHold says signed handoffs require an integrity checksum.'

function testConfig(repoPath: string) {
	return configSchema.parse({
		provider: {
			type: 'contember',
			apiBaseUrl: 'https://example.test',
			projectSlug: 'test',
			apiToken: 'test-token',
		},
		projects: [{ slug: 'sample-project', repoPath, baseBranch: 'main' }],
		solver: {
			displayName: { enabled: false },
			triage: { enabled: false },
		},
		knowledge: {
			providers: [
				{
					id: 'test-knowledge',
					type: 'hold',
					socketPath: join(repoPath, 'hold.sock'),
					capabilityFile: join(repoPath, 'hold.capability'),
				},
			],
		},
	})
}

const provider: TaskProvider = {
	name: 'test',
	async pollNewTasks() {
		return []
	},
	async getTaskContext() {
		return null
	},
	async resolveTaskSummary() {
		return null
	},
	async postComment() {
		return null
	},
}

function sha256(value: string) {
	return createHash('sha256').update(value).digest('hex')
}

function manifest() {
	return [
		{
			sourceRef: 'wiki_project_master',
			role: 'foundational',
			label: 'project/master.md',
			heading: null,
			contentHash: sha256(KNOWLEDGE_CONTEXT),
			sourceHash: sha256('complete source'),
			characters: [...KNOWLEDGE_CONTEXT].length,
			range: { start: 0, end: KNOWLEDGE_CONTEXT.length, unit: 'utf16-code-units' as const },
		},
	]
}

class FakeKnowledgeProvider implements KnowledgeProvider {
	readonly id = 'test-knowledge'
	readonly type = 'fake'
	readonly protocolVersion = 1

	async prepareBrief() {
		return {
			briefRef: sha256('selection'),
			revision: '1:catalog',
			generatedAt: '2026-01-01T00:00:00.000Z',
			context: KNOWLEDGE_CONTEXT,
			contextHash: sha256(KNOWLEDGE_CONTEXT),
			sources: manifest(),
		}
	}

	async submitCandidates(input: Parameters<KnowledgeProvider['submitCandidates']>[0]) {
		return {
			receiptRef: `receipt-${input.idempotencyKey.slice(0, 12)}`,
			candidateRefs: input.candidates.map((_, index) => `candidate-${index}`),
			recordRef: 'record-1',
			jobRef: 'job-1',
			acceptedAt: '2026-01-01T00:00:00.000Z',
			replayed: false,
		}
	}
}

function fakeKnowledge(
	config: ReturnType<typeof testConfig>,
	provider: KnowledgeProvider = new FakeKnowledgeProvider(),
): KnowledgeIntegration {
	return new KnowledgeIntegration(
		config,
		profileId => ({
			id: profileId,
			name: 'Test profile',
			createdAt: '2026-01-01T00:00:00.000Z',
			enabledProjects: ['sample-project'],
			knowledgeBindings: [
				{
					projectSlug: 'sample-project',
					providerId: 'test-knowledge',
					providerProjectId: 'hold-project-1',
					characterBudget: 20_000,
					allowSharedProject: false,
				},
			],
			archivedAt: null,
		}),
		new KnowledgeProviderRegistry([provider]),
	)
}

class KnowledgeLoopStub implements LoopRunner {
	calls: LoopRunParams[] = []

	async runLoop(params: LoopRunParams) {
		this.calls.push(params)
		const workspace = new PlanWorkspace(params.worktreePath, params.planDirName)
		workspace.ensureDir()
		writeFileSync(
			workspace.knowledgeCandidatesPath,
			JSON.stringify([{ type: 'lesson', title: 'Loop evidence', content: 'Loop solves use exact project knowledge.' }]),
		)
		params.onRunId('knowledge-loop-run')
		return { runId: 'knowledge-loop-run', exitCode: 0 }
	}
}

class PlanningStub implements Spawner {
	readonly name = 'default'
	seenProjectContext = ''
	seenKnowledgeContext = ''

	constructor(private readonly root: string) {}

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		const worktreePath = join(this.root, 'planning', params.itemId)
		mkdirSync(worktreePath, { recursive: true })
		this.seenProjectContext = params.onWorktreeReady(worktreePath).projectContext ?? ''
		this.seenKnowledgeContext = params.knowledgeContext ?? ''
		return { worktreePath, branchName: params.branchName, hint: 'Planning ready' }
	}
}

class SolveStub implements Solver {
	seenProjectContext = ''

	constructor(private readonly root: string) {}

	async solve(params: SolveParams): Promise<SolveResult> {
		const worktreePath = join(this.root, 'worktrees', params.taskId)
		mkdirSync(worktreePath, { recursive: true })
		this.seenProjectContext = params.onWorktreeReady(worktreePath).projectContext ?? ''
		params.onPromptSnapshot?.(`PROMPT\n${this.seenProjectContext}`)
		const workspace = new PlanWorkspace(worktreePath, params.planDirName)
		workspace.ensureDir()
		writeFileSync(
			workspace.resultPath,
			JSON.stringify({
				summary: 'Solved with external project knowledge',
				filesChanged: [],
				prUrl: 'https://github.com/example/project/pull/1',
			}),
		)
		writeFileSync(
			workspace.knowledgeCandidatesPath,
			JSON.stringify([
				{ type: 'lesson', title: 'Handoff checksum', content: 'Signed handoffs require an integrity checksum.' },
			]),
		)
		return { worktreePath, branchName: params.branchName, outcome: { events: [], exitCode: 0 } }
	}
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'helm-knowledge-evidence-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	return {
		root,
		db,
		cleanup() {
			db.close()
			rmSync(root, { recursive: true, force: true })
		},
	}
}

test('migrations 34-36 preserve exact evidence, block unfrozen candidates, and bind current attempts', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-knowledge-migration-'))
	const dbPath = join(root, 'helm.db')
	try {
		const before = new Database(dbPath)
		for (const migration of MIGRATIONS.filter(entry => entry.version <= 32)) {
			before.exec(migration.sql)
			before.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(migration.version)
		}
		before
			.prepare(`INSERT INTO knowledge_documents (
				id, profile_id, project_slug, relative_path, title, content, frontmatter,
				content_hash, source_mtime_ms, source_updated_at, indexed_at
			) VALUES ('doc', 'work', 'sample-project', 'master.md', 'Master', 'private', '{}', 'hash', 0, '2026-01-01', '2026-01-01')`)
			.run()
		before
			.prepare(`INSERT INTO item_knowledge_snapshots (
				id, profile_id, item_id, project_slug, purpose, sequence, query, context, manifest, created_at
			) VALUES ('snapshot', 'work', 'item', 'sample-project', 'solve', 1, 'query', 'exact evidence', '[]', '2026-01-01T00:00:00.000Z')`)
			.run()
		before
			.prepare(`INSERT INTO knowledge_write_proposals (
				id, profile_id, item_id, snapshot_id, proposal_key, title, content,
				writeback_relative_path, state, revision, error_message, created_at, resolved_at
			) VALUES (
				'proposal', 'work', 'item', 'snapshot', 'snapshot:0', 'Durable fact',
				'Preserve this unresolved candidate.', 'project/knowledge.md', 'pending', 0, NULL,
				'2026-01-01T00:00:01.000Z', NULL
			)`)
			.run()
		before.close()

		const migrated = new DB(dbPath, 'work')
		assert.equal(migrated.knowledge.getSnapshot('snapshot')?.context, 'exact evidence')
		const migratedCandidates = migrated.knowledge.listCandidateBatches('item')
		assert.equal(migratedCandidates.length, 1)
		assert.equal(migratedCandidates[0].snapshotId, 'snapshot')
		assert.equal(migratedCandidates[0].state, 'blocked')
		assert.equal(migratedCandidates[0].providerId, null)
		assert.equal(migratedCandidates[0].candidates[0].type, 'lesson')
		assert.equal(migratedCandidates[0].candidates[0].title, 'Durable fact')
		migrated.close()

		const after = new Database(dbPath, { readonly: true })
		assert.equal(
			(after.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
			36,
		)
		const names = new Set(
			(
				after.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>
			).map(row => row.name),
		)
		assert.equal(names.has('knowledge_documents'), false)
		assert.equal(names.has('knowledge_chunks'), false)
		assert.equal(names.has('knowledge_chunks_fts'), false)
		assert.equal(names.has('knowledge_write_proposals'), false)
		assert.equal(names.has('item_knowledge_snapshots'), true)
		assert.equal(names.has('knowledge_candidate_outbox'), true)
		assert.equal(
			(after.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>).some(
				column => column.name === 'knowledge_snapshot_id',
			),
			true,
		)
		after.close()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('external briefs are bounded and cannot persist host paths as Helm evidence', async () => {
	const env = fixture()
	try {
		const config = testConfig(env.root)
		const unsafeProvider: KnowledgeProvider = {
			...new FakeKnowledgeProvider(),
			id: 'test-knowledge',
			type: 'fake',
			protocolVersion: 1,
			async prepareBrief() {
				return {
					briefRef: sha256('unsafe-selection'),
					revision: 'unsafe',
					generatedAt: '2026-01-01T00:00:00.000Z',
					context: KNOWLEDGE_CONTEXT,
					contextHash: sha256(KNOWLEDGE_CONTEXT),
					sources: [{ ...manifest()[0], label: '/private/host-secret.md' }],
				}
			},
			async submitCandidates(input) {
				return new FakeKnowledgeProvider().submitCandidates(input)
			},
		}
		const integration = fakeKnowledge(config, unsafeProvider)
		await assert.rejects(
			integration.prepareContext(env.db.knowledge, {
				profileId: 'work',
				itemId: 'unsafe-item',
				projectSlug: 'sample-project',
				purpose: 'solve',
				taskContext: { title: 'Unsafe evidence' },
				binding: integration.bindingFor('work', 'sample-project'),
			}),
			/violated the evidence contract/,
		)
		assert.equal(env.db.knowledge.latestSnapshot('unsafe-item'), null)
	} finally {
		env.cleanup()
	}
})

test('an admitted binding stays frozen when the profile mapping changes before provider I/O', async () => {
	const env = fixture()
	try {
		const config = testConfig(env.root)
		let providerProjectId = 'hold-project-original'
		const seen: string[] = []
		const recordingProvider: KnowledgeProvider = {
			id: 'test-knowledge',
			type: 'fake',
			protocolVersion: 1,
			async prepareBrief(input) {
				seen.push(input.providerProjectId)
				return new FakeKnowledgeProvider().prepareBrief()
			},
			async submitCandidates(input) {
				return new FakeKnowledgeProvider().submitCandidates(input)
			},
		}
		const integration = new KnowledgeIntegration(
			config,
			profileId => ({
				id: profileId,
				name: 'Mutable profile',
				createdAt: '2026-01-01T00:00:00.000Z',
				enabledProjects: ['sample-project'],
				knowledgeBindings: [
					{
						projectSlug: 'sample-project',
						providerId: 'test-knowledge',
						providerProjectId,
						characterBudget: 20_000,
						allowSharedProject: false,
					},
				],
				archivedAt: null,
			}),
			new KnowledgeProviderRegistry([recordingProvider]),
		)
		const admitted = integration.bindingFor('work', 'sample-project')
		providerProjectId = 'hold-project-changed'
		const prepared = await integration.prepareContext(env.db.knowledge, {
			profileId: 'work',
			itemId: 'frozen-item',
			projectSlug: 'sample-project',
			purpose: 'solve',
			taskContext: { title: 'Frozen binding' },
			binding: admitted,
		})
		assert.deepEqual(seen, ['hold-project-original'])
		assert.equal(prepared.snapshot?.provider?.providerProjectId, 'hold-project-original')
	} finally {
		env.cleanup()
	}
})

test('solve retry classification preserves permanent versus transient knowledge failures', async () => {
	const env = fixture()
	try {
		const config = testConfig(env.root)
		for (const scenario of [
			{
				title: 'Permanent knowledge failure',
				error: new KnowledgeProviderError('authorization', 'Knowledge provider authorization failed', false),
				phase: 'knowledge',
			},
			{
				title: 'Transient knowledge failure',
				error: new KnowledgeProviderError('timeout', 'Knowledge provider request timed out', true),
				phase: 'knowledge_retryable',
			},
		] as const) {
			const item = new ItemCommands(env.db.items, config).createSolveItem({
				title: scenario.title,
				projectSlug: 'sample-project',
				prompt: 'Classify the retrieval failure.',
			})
			const failingProvider: KnowledgeProvider = {
				...new FakeKnowledgeProvider(),
				id: 'test-knowledge',
				type: 'fake',
				protocolVersion: 1,
				async prepareBrief() {
					throw scenario.error
				},
				async submitCandidates(input) {
					return new FakeKnowledgeProvider().submitCandidates(input)
				},
			}
			await processSolveItem(item.id, config, env.db, provider, new SolveStub(env.root), undefined, {
				knowledge: fakeKnowledge(config, failingProvider),
			})
			assert.equal(env.db.items.get(item.id)?.errorPhase, scenario.phase)
		}
	} finally {
		env.cleanup()
	}
})

test('immutable evidence and candidate outbox remain profile scoped and idempotent', () => {
	const env = fixture()
	try {
		const binding = {
			bindingId: sha256('binding'),
			providerId: 'test-knowledge',
			providerProjectId: 'hold-project-1',
		}
		const snapshot = env.db.knowledge.createSnapshot({
			itemId: 'item-1',
			projectSlug: 'sample-project',
			purpose: 'solve',
			query: 'handoff',
			characterBudget: 20_000,
			context: KNOWLEDGE_CONTEXT,
			manifest: manifest(),
			provider: {
				...binding,
				providerType: 'fake',
				briefRef: sha256('selection'),
				revision: '1:catalog',
				generatedAt: '2026-01-01T00:00:00.000Z',
				contextHash: sha256(KNOWLEDGE_CONTEXT),
				protocolVersion: 1,
			},
		})
		const input = {
			itemId: 'item-1',
			projectSlug: 'sample-project',
			snapshotId: snapshot.id,
			binding,
			candidates: [{ type: 'lesson' as const, title: 'Checksum', content: 'Signed handoffs require a checksum.' }],
		}
		const first = env.db.knowledge.enqueueCandidateBatch(input)
		const retry = env.db.knowledge.enqueueCandidateBatch(input)
		assert.equal(retry.id, first.id)
		assert.equal(env.db.knowledge.listCandidateBatches('item-1').length, 1)
		assert.equal(env.db.forProfile('private').knowledge.latestSnapshot('item-1'), null)
		assert.deepEqual(env.db.forProfile('private').knowledge.listCandidateBatches('item-1'), [])
		const owner = 'test-delivery-owner'
		assert.equal(
			env.db.knowledge.claimCandidateBatches(1, '2026-01-01T00:00:00.000Z', owner, '2026-01-01T00:05:00.000Z')[0]?.id,
			first.id,
		)
		const failed = env.db.knowledge.recordCandidateDeliveryFailure(
			first.id,
			owner,
			'unavailable',
			'Provider unavailable',
			'2026-01-02T00:00:00.000Z',
		)
		assert.equal(failed.attemptCount, 1)
		assert.equal(failed.lastError, 'Provider unavailable')
		assert.equal(
			env.db.knowledge.claimCandidateBatches(1, '2026-01-03T00:00:00.000Z', owner, '2026-01-03T00:05:00.000Z')[0]?.id,
			first.id,
		)
		const receipt = {
			receiptRef: 'hold-receipt',
			candidateRefs: ['candidate-1'],
			recordRef: 'record-1',
			jobRef: 'job-1',
			acceptedAt: '2026-01-03T00:00:00.000Z',
			replayed: false,
		}
		const delivered = env.db.knowledge.markCandidateBatchDelivered(first.id, owner, receipt)
		assert.equal(delivered.state, 'delivered')
		assert.equal(env.db.knowledge.markCandidateBatchDelivered(first.id, owner, receipt).id, first.id)

		const withoutContext = env.db.knowledge.enqueueCandidateBatch({
			itemId: 'item-without-context',
			projectSlug: 'sample-project',
			snapshotId: null,
			binding,
			candidates: [
				{
					type: 'lesson',
					title: 'Independent fact',
					content: 'A run may learn a fact without prior provider context.',
				},
			],
		})
		assert.equal(withoutContext.snapshotId, null)
	} finally {
		env.cleanup()
	}
})

test('knowledge candidates use a bounded gitignored sidecar only for admitted knowledge runs', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-knowledge-candidate-'))
	try {
		const ordinaryPrompt = buildPrompt({ title: 'Learn safely' }, { planDirName: 'safe-plan', worktreePath: root })
		assert.doesNotMatch(ordinaryPrompt, /\.helm-knowledge-candidates\.json/)
		const knowledgePrompt = buildPrompt(
			{ title: 'Learn safely' },
			{ planDirName: 'safe-plan', worktreePath: root },
			{ knowledgeCandidates: true },
		)
		assert.match(knowledgePrompt, /\.helm-knowledge-candidates\.json/)
		assert.match(knowledgePrompt, /profile's configured knowledge provider/)
		assert.match(knowledgePrompt, /NEVER git-add, commit, or push this `\.helm-\*` sidecar/)
		const planningPrompt = buildPlanningPrompt('safe-plan')
		assert.match(planningPrompt, /UNTRUSTED.*CONTEXT/i)
		assert.match(planningPrompt, /\.helm-knowledge-context\.md/)

		const workspace = new PlanWorkspace(root, 'safe-plan')
		workspace.ensureDir()
		writeFileSync(workspace.knowledgeCandidatesPath, '{not json')
		assert.deepEqual(workspace.readKnowledgeCandidates(), [])
		writeFileSync(workspace.knowledgeCandidatesPath, 'x'.repeat(25_001))
		assert.deepEqual(workspace.readKnowledgeCandidates(), [])
		writeFileSync(join(root, 'valid-candidates.json'), '[]')
		rmSync(workspace.knowledgeCandidatesPath, { force: true })
		symlinkSync(join(root, 'valid-candidates.json'), workspace.knowledgeCandidatesPath)
		assert.deepEqual(workspace.readKnowledgeCandidates(), [], 'candidate reads never follow symlinks')
		rmSync(workspace.knowledgeCandidatesPath, { force: true })
		const redirectedContext = join(root, 'redirected-context.md')
		writeFileSync(redirectedContext, 'unchanged')
		symlinkSync(redirectedContext, workspace.contextPath)
		assert.throws(() => workspace.writeContext('private provider bytes'), /unsafe Helm runtime file/)
		assert.equal(readFileSync(redirectedContext, 'utf-8'), 'unchanged')
		rmSync(workspace.contextPath, { force: true })
		writeFileSync(workspace.knowledgeCandidatesPath, '[]')
		writeFileSync(join(workspace.dir, '.helm-knowledge-proposals.json'), '[]')
		workspace.writeKnowledgeContext(KNOWLEDGE_CONTEXT)
		assert.throws(() => workspace.loopArtifactPath(), /No runnable plan artifact/)
		workspace.clearResult()
		assert.equal(existsSync(workspace.knowledgeCandidatesPath), false)
		assert.equal(existsSync(join(workspace.dir, '.helm-knowledge-proposals.json')), false)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('candidate sidecars are ignored in linked worktrees through Git real-path exclusion', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-knowledge-ignore-'))
	const repository = join(root, 'repository')
	const linkedWorktree = join(root, 'linked-worktree')
	try {
		mkdirSync(repository)
		execFileSync('git', ['init', '-q'], { cwd: repository })
		writeFileSync(join(repository, 'README.md'), '# Fixture\n')
		execFileSync('git', ['add', 'README.md'], { cwd: repository })
		execFileSync(
			'git',
			['-c', 'user.name=Helm Test', '-c', 'user.email=helm@example.test', 'commit', '-qm', 'Initial fixture'],
			{ cwd: repository },
		)
		execFileSync('git', ['worktree', 'add', '-q', '-b', 'fixture-worktree', linkedWorktree], { cwd: repository })
		await excludeHelmFiles(linkedWorktree)
		const workspace = new PlanWorkspace(linkedWorktree, 'sample-plan')
		workspace.ensureDir()
		writeFileSync(workspace.knowledgeCandidatesPath, '[]')
		const relativePath = 'docs/plans/sample-plan/.helm-knowledge-candidates.json'
		assert.equal(
			execFileSync('git', ['check-ignore', relativePath], { cwd: linkedWorktree, encoding: 'utf8' }).trim(),
			relativePath,
		)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('Planning and solve consume the external seam while Helm owns evidence and candidate delivery', async () => {
	const env = fixture()
	try {
		const config = testConfig(env.root)
		const commands = new ItemCommands(env.db.items, config)
		const knowledge = fakeKnowledge(config)
		const planningItem = commands.createSolveItem({
			title: 'Plan the handoff repair',
			projectSlug: 'sample-project',
			prompt: 'Plan safely.',
		})
		const spawner = new PlanningStub(env.root)
		const planning = new PlanningApplication(
			config,
			commands,
			provider,
			spawner,
			async () => spawner,
			undefined,
			undefined,
			knowledge,
			profileId => env.db.forProfile(profileId).knowledge,
		)
		await planning.prepare({ itemId: planningItem.id })
		assert.doesNotMatch(spawner.seenProjectContext, /Hold says signed handoffs/)
		assert.equal(spawner.seenKnowledgeContext, KNOWLEDGE_CONTEXT)
		assert.equal(env.db.knowledge.latestSnapshot(planningItem.id)?.purpose, 'planning')
		assert.equal(
			env.db.items.get(planningItem.id)?.knowledgeSnapshotId,
			env.db.knowledge.latestSnapshot(planningItem.id)?.id,
		)

		const solveItem = commands.createSolveItem({
			title: 'Repair the handoff checksum',
			projectSlug: 'sample-project',
			prompt: 'Keep handoffs valid.',
		})
		const solver = new SolveStub(env.root)
		await processSolveItem(solveItem.id, config, env.db, provider, solver, undefined, { knowledge })
		assert.match(solver.seenProjectContext, /Hold says signed handoffs/)
		assert.match(env.db.items.get(solveItem.id)?.solveInputSnapshot ?? '', /Project knowledge/)
		assert.equal(env.db.items.get(solveItem.id)?.status, 'review')
		const queued = env.db.knowledge.listCandidateBatches(solveItem.id)
		assert.equal(queued.length, 1)
		assert.equal(queued[0].state, 'pending')
		assert.equal(queued[0].candidates[0].title, 'Handoff checksum')
		const completedSolve = env.db.items.get(solveItem.id)
		assert.ok(completedSolve?.worktreePath && completedSolve.planDirName)
		assert.equal(
			existsSync(new PlanWorkspace(completedSolve.worktreePath, completedSolve.planDirName).knowledgeCandidatesPath),
			false,
		)
		const firstSnapshotId = completedSolve.knowledgeSnapshotId
		assert.ok(firstSnapshotId)

		commands.retryItem(solveItem.id)
		const unmappedKnowledge = new KnowledgeIntegration(
			config,
			profileId => ({
				id: profileId,
				name: 'No knowledge mapping',
				createdAt: '2026-01-01T00:00:00.000Z',
				enabledProjects: ['sample-project'],
				knowledgeBindings: [],
				archivedAt: null,
			}),
			new KnowledgeProviderRegistry([new FakeKnowledgeProvider()]),
		)
		await processSolveItem(solveItem.id, config, env.db, provider, new SolveStub(env.root), undefined, {
			knowledge: unmappedKnowledge,
		})
		assert.equal(env.db.items.get(solveItem.id)?.knowledgeSnapshotId, null)
		assert.equal(env.db.knowledge.latestSnapshot(solveItem.id)?.id, firstSnapshotId)
	} finally {
		env.cleanup()
	}
})

test('solve-through-loop retrieves and associates exact configured knowledge before adapter launch', async () => {
	const env = fixture()
	try {
		const config = testConfig(env.root)
		const commands = new ItemCommands(env.db.items, config)
		const item = commands.createSolveItem({
			title: 'Run a prepared solve through loop',
			projectSlug: 'sample-project',
			prompt: 'Implement the prepared plan.',
		})
		const worktreePath = join(env.root, 'loop-worktree')
		const workspace = new PlanWorkspace(worktreePath, 'knowledge-loop-plan')
		workspace.ensureDir()
		writeFileSync(join(workspace.dir, 'spec.md'), '# Knowledge loop plan\n')
		commands.beginPlanning(item.id)
		commands.recordPlanPrepared(item.id, {
			worktreePath,
			branchName: 'helm/item/knowledge-loop',
			planDirName: workspace.planDirName,
			spawner: 'default',
		})
		commands.setSolveExecution(item.id, {
			mode: 'loop',
			prdPath: `${workspace.rel.dir}/spec.md`,
			options: { mode: 'once', iterations: 1 },
		})
		commands.setItemStatus(item.id, 'ready')
		const runner = new KnowledgeLoopStub()
		await processLoopItem(item.id, config, env.db, runner, undefined, {
			knowledge: fakeKnowledge(config),
			provider,
		})
		assert.equal(runner.calls.length, 1)
		assert.equal(runner.calls[0]?.knowledgeContext, KNOWLEDGE_CONTEXT)
		const completed = env.db.items.get(item.id)
		assert.equal(completed?.status, 'review')
		assert.equal(completed?.knowledgeSnapshotId, env.db.knowledge.latestSnapshot(item.id)?.id)
		assert.equal(env.db.knowledge.latestSnapshot(item.id)?.purpose, 'solve')
		assert.equal(env.db.knowledge.listCandidateBatches(item.id)[0]?.candidates[0]?.title, 'Loop evidence')
		assert.equal(existsSync(workspace.knowledgeCandidatesPath), false)
	} finally {
		env.cleanup()
	}
})

test('candidate outbox failure cannot turn successfully solved work into a failed Item', async () => {
	const env = fixture()
	try {
		const config = testConfig(env.root)
		const commands = new ItemCommands(env.db.items, config)
		const item = commands.createSolveItem({
			title: 'Finish despite Hold delivery storage failure',
			projectSlug: 'sample-project',
			prompt: 'Complete the coding task.',
		})
		const originalForProfile = env.db.forProfile.bind(env.db)
		env.db.forProfile = ((profileId: string) => {
			const scoped = originalForProfile(profileId)
			scoped.knowledge.enqueueCandidateBatch = () => {
				throw new Error('Injected outbox failure')
			}
			return scoped
		}) as DB['forProfile']

		await processSolveItem(item.id, config, env.db, provider, new SolveStub(env.root), undefined, {
			knowledge: fakeKnowledge(config),
		})

		const completed = env.db.items.get(item.id)
		assert.equal(completed?.status, 'review')
		assert.equal(completed?.runOutcome, 'ok')
		assert.deepEqual(env.db.knowledge.listCandidateBatches(item.id), [])
		assert.ok(completed?.worktreePath && completed.planDirName)
		const workspace = new PlanWorkspace(completed.worktreePath, completed.planDirName)
		assert.equal(existsSync(workspace.knowledgeCandidatesPath), true)

		env.db.forProfile = originalForProfile as DB['forProfile']
		const knowledge = fakeKnowledge(config)
		const app = createApp(
			config,
			join(env.root, 'helm.config.json'),
			env.db,
			{} as never,
			{} as never,
			provider,
			new PlanningStub(env.root),
			{} as never,
			{
				store: { activeProfile: () => ({ id: 'work' }) } as never,
				runtime: {} as never,
				localControlToken: LOCAL_CONTROL_TOKEN,
				knowledge,
			},
		)
		const detail = (
			await (
				await app.request(`/api/items/${item.id}`, {
					headers: { authorization: `Bearer ${LOCAL_CONTROL_TOKEN}`, 'x-helm-profile-id': 'work' },
				})
			).json()
		).data
		assert.deepEqual(detail.knowledgeRecovery, { candidateCount: 1 })
		const wrongProfile = await app.request(`/api/items/${item.id}/knowledge-deliveries/recover`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${LOCAL_CONTROL_TOKEN}`,
				'x-helm-profile-id': 'profile-aaaaaaaaaaaa',
			},
		})
		assert.equal(wrongProfile.status, 409)
		const recovered = await app.request(`/api/items/${item.id}/knowledge-deliveries/recover`, {
			method: 'POST',
			headers: { authorization: `Bearer ${LOCAL_CONTROL_TOKEN}`, 'x-helm-profile-id': 'work' },
		})
		assert.equal(recovered.status, 200)
		assert.equal(env.db.knowledge.listCandidateBatches(item.id).length, 1)
		assert.equal(existsSync(workspace.knowledgeCandidatesPath), false)
	} finally {
		env.cleanup()
	}
})

test('public Item projections redact knowledge-backed input while privileged detail exposes exact evidence', async () => {
	const env = fixture()
	try {
		const config = testConfig(env.root)
		const commands = new ItemCommands(env.db.items, config)
		const item = commands.createSolveItem({
			title: 'Preserve evidence privacy',
			projectSlug: 'sample-project',
			prompt: 'Keep provider context private.',
		})
		const snapshot = env.db.knowledge.createSnapshot({
			itemId: item.id,
			projectSlug: 'sample-project',
			purpose: 'solve',
			query: item.title,
			characterBudget: 20_000,
			context: KNOWLEDGE_CONTEXT,
			manifest: manifest(),
			provider: {
				bindingId: sha256('privacy-binding'),
				providerId: 'test-knowledge',
				providerType: 'fake',
				providerProjectId: 'hold-project-1',
				briefRef: sha256('privacy-selection'),
				revision: '1:catalog',
				generatedAt: '2026-01-01T00:00:00.000Z',
				contextHash: sha256(KNOWLEDGE_CONTEXT),
				protocolVersion: 1,
			},
		})
		const delivery = env.db.knowledge.enqueueCandidateBatch({
			itemId: item.id,
			projectSlug: 'sample-project',
			snapshotId: snapshot.id,
			binding: {
				bindingId: sha256('privacy-binding'),
				providerId: 'test-knowledge',
				providerProjectId: 'hold-project-1',
			},
			candidates: [
				{
					type: 'lesson',
					title: 'Private candidate title',
					content: 'Private unreviewed candidate content.',
				},
			],
		})
		env.db.knowledge.claimCandidateBatches(
			1,
			'2030-01-01T00:00:00.000Z',
			'privacy-test-owner',
			'2030-01-01T00:01:00.000Z',
		)
		env.db.knowledge.markCandidateBatchBlocked(
			delivery.id,
			'privacy-test-owner',
			'authorization',
			'Knowledge provider authorization failed',
		)
		commands.startItem(item.id)
		commands.recordKnowledgeSnapshot(item.id, snapshot.id)
		commands.recordSolveInputSnapshot(item.id, 'Private run input with selected project knowledge.')

		const planned = commands.createSolveItem({
			title: 'Preview public plan',
			projectSlug: 'sample-project',
			prompt: 'Keep generated context private.',
		})
		commands.beginPlanning(planned.id)
		const planWorkspace = new PlanWorkspace(env.root, 'public-plan')
		planWorkspace.ensureDir()
		writeFileSync(planWorkspace.contextPath, 'Private generated provider context.')
		writeFileSync(planWorkspace.readmePath, 'Generated planning instructions.')
		writeFileSync(planWorkspace.knowledgeContextPath, KNOWLEDGE_CONTEXT)
		writeFileSync(join(planWorkspace.dir, 'prd.md'), '# Public plan\n')
		assert.equal(planWorkspace.readArtifacts()?.includes(KNOWLEDGE_CONTEXT), false)
		commands.recordPlanPrepared(planned.id, {
			worktreePath: env.root,
			branchName: 'feat/public-plan',
			planDirName: 'public-plan',
			spawner: 'default',
		})

		const spawner = new PlanningStub(env.root)
		const knowledge = fakeKnowledge(config)
		const app = createApp(
			config,
			join(env.root, 'helm.config.json'),
			env.db,
			{} as never,
			{} as never,
			provider,
			spawner,
			{} as never,
			{
				store: { activeProfile: () => ({ id: 'work' }) } as never,
				runtime: {} as never,
				localControlToken: LOCAL_CONTROL_TOKEN,
				knowledge,
			},
		)

		const publicPlan = (await (await app.request(`/api/items/${planned.id}`)).json()).data
		assert.deepEqual(
			publicPlan.planArtifacts.map((artifact: { name: string }) => artifact.name),
			['prd.md'],
		)
		const publicDetail = (await (await app.request(`/api/items/${item.id}`)).json()).data
		assert.equal(publicDetail.knowledgeSnapshot, undefined)
		assert.equal(publicDetail.knowledgeDeliveries, undefined)
		assert.equal(publicDetail.solveInputSnapshot, null)
		const list = (await (await app.request('/api/items')).json()).data
		assert.equal(list.find((candidate: { id: string }) => candidate.id === item.id)?.solveInputSnapshot, null)

		const mismatchedPrivateDetail = await app.request(`/api/items/${item.id}`, {
			headers: {
				authorization: `Bearer ${LOCAL_CONTROL_TOKEN}`,
				'x-helm-profile-id': 'profile-aaaaaaaaaaaa',
			},
		})
		assert.equal(mismatchedPrivateDetail.status, 409)
		const privateDetail = (
			await (
				await app.request(`/api/items/${item.id}`, {
					headers: { authorization: `Bearer ${LOCAL_CONTROL_TOKEN}`, 'x-helm-profile-id': 'work' },
				})
			).json()
		).data
		assert.equal(privateDetail.knowledgeSnapshot.context, KNOWLEDGE_CONTEXT)
		assert.deepEqual(privateDetail.knowledgeDeliveries, [
			{
				id: privateDetail.knowledgeDeliveries[0].id,
				state: 'blocked',
				providerId: 'test-knowledge',
				candidateCount: 1,
				attemptCount: 0,
				lastErrorCode: 'authorization',
				lastErrorMessage: 'Knowledge provider authorization failed',
				updatedAt: privateDetail.knowledgeDeliveries[0].updatedAt,
				deliveredAt: null,
			},
		])
		assert.equal(JSON.stringify(privateDetail).includes('Private unreviewed candidate content.'), false)
		assert.match(privateDetail.solveInputSnapshot, /Private run input/)

		assert.equal(
			(
				await app.request(`/api/items/${item.id}/knowledge-deliveries/${delivery.id}/retry`, {
					method: 'POST',
				})
			).status,
			401,
		)
		const retried = await app.request(`/api/items/${item.id}/knowledge-deliveries/${delivery.id}/retry`, {
			method: 'POST',
			headers: { authorization: `Bearer ${LOCAL_CONTROL_TOKEN}`, 'x-helm-profile-id': 'work' },
		})
		assert.equal(retried.status, 200)
		assert.equal(env.db.knowledge.listCandidateBatches(item.id)[0]?.state, 'pending')
	} finally {
		env.cleanup()
	}
})
