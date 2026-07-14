import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { HelmConfig } from '../config.js'
import { taskContextSchema } from '../providers/provider.js'
import { solverAgentSchema } from '../solver/agent.js'
import type { SolverAgent } from '../solver/agent.js'
import type { SolverWorkspace } from '../solver/workspace.js'
import type { ErrorPhase } from '../types.js'
import { itemSourceSchema } from './schema.js'
import type { Assessment, DeployState, ItemKind, ItemRecord, ItemSource, RunOutcome } from './schema.js'
import type { ItemStore } from './store.js'

const createItemInitialStatusSchema = z.enum(['ready', 'triage'])
type CreateItemInitialStatus = z.infer<typeof createItemInitialStatusSchema>

const createSolveItemInputSchema = z
	.object({
		// Caller-supplied id: used by ingest so the Item row, its on-disk attachment
		// dir, and the frozen capturedContext are written in ONE atomic create (no
		// zombie window). Only valid with parallelism 1 (a shared id can't fan out).
		id: z.string().min(1).optional(),
		title: z.string().min(1),
		projectSlug: z.string().min(1),
		prompt: z.string().min(1),
		baseRef: z.string().min(1).optional(),
		baseItemId: z.string().min(1).optional(),
		spawner: z.string().min(1).optional(),
		solverAgent: solverAgentSchema.optional(),
		initialStatus: createItemInitialStatusSchema.optional(),
		source: itemSourceSchema.nullable().optional(),
		// Frozen task content for a provider-less Item (ingested email etc.).
		capturedContext: taskContextSchema.nullable().optional(),
	})
	.strict()

export type CreateSolveItemInput = z.infer<typeof createSolveItemInputSchema>

const createSolveItemsInputSchema = createSolveItemInputSchema
	.extend({
		parallelism: z.number().int().positive().optional(),
	})
	.strict()

export type CreateSolveItemsInput = z.infer<typeof createSolveItemsInputSchema>

const createLoopItemInputSchema = z
	.object({
		title: z.string().min(1),
		projectSlug: z.string().min(1),
		prdPath: z.string().min(1),
		baseRef: z.string().min(1).optional(),
		baseItemId: z.string().min(1).optional(),
		spawner: z.string().min(1).optional(),
		initialStatus: createItemInitialStatusSchema.optional(),
		mode: z.enum(['once', 'afk']).optional(),
		provider: z.enum(['claude', 'codex']).optional(),
		model: z.string().min(1).optional(),
		effort: z.string().min(1).optional(),
		iterations: z.number().int().positive().optional(),
		noOversee: z.boolean().optional(),
	})
	.strict()

export type CreateLoopItemInput = z.infer<typeof createLoopItemInputSchema>

const createLoopItemsInputSchema = createLoopItemInputSchema
	.extend({
		parallelism: z.number().int().positive().optional(),
	})
	.strict()

export type CreateLoopItemsInput = z.infer<typeof createLoopItemsInputSchema>

const RETRYABLE_STATUSES = new Set<ItemRecord['status']>(['failed', 'cancelled', 'done', 'review'])
const ITEM_KINDS: ItemKind[] = ['solve', 'loop']
const RESERVED_EVENT_TYPES = new Set([
	'item_approved',
	'item_rejected',
	'item_started',
	'item_retried',
	'item_recovered',
	'item_reconciled',
	'item_reopened',
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
	'deploy_merged',
	'deploy_succeeded',
	'item_merged',
	'item_status_set',
])

const COMPLETED_AT_STATUSES = new Set<ItemRecord['status']>(['review', 'done', 'failed', 'cancelled'])

function successfulEnvironments(state: DeployState | null): Set<string> {
	const envs = new Set<string>()
	if (!state) return envs
	for (const d of state.deployments) {
		if (d.state === 'success') envs.add(d.environment)
	}
	return envs
}

interface BaseRefSelection {
	projectSlug: string
	baseRef?: string
	baseItemId?: string
}

function initialStatus(input: {
	source?: ItemSource | null
	initialStatus?: CreateItemInitialStatus
}): ItemRecord['status'] {
	if (input.source) return 'triage'
	return input.initialStatus ?? 'ready'
}

// A run that finished without writing solver-result.json is the classic
// false-fail (the agent may still have committed shippable work); flag it
// `no_result` so reconciliation/UI can distinguish it from a hard error.
function runOutcomeForFailure(message: string): RunOutcome {
	return message.includes('No solver-result.json') ? 'no_result' : 'errored'
}

export class ItemCommands {
	constructor(
		private readonly store: ItemStore,
		private readonly config: HelmConfig,
	) {}

	createSolveItem(input: CreateSolveItemInput): ItemRecord {
		return this.createSolveItems({ ...input, parallelism: 1 })[0]
	}

	createSolveItems(input: CreateSolveItemsInput): ItemRecord[] {
		const parsed = createSolveItemsInputSchema.safeParse(input)
		if (!parsed.success) throw new Error(`Invalid solve Item input: ${parsed.error.message}`)

		const project = this.config.projects.find(p => p.slug === parsed.data.projectSlug)
		if (!project) throw new Error(`Unknown project slug: ${parsed.data.projectSlug}`)
		const baseRef = this.resolveBaseRef(parsed.data, project.baseBranch)

		const count = parsed.data.parallelism ?? 1
		if (parsed.data.id && count > 1) throw new Error('A caller-supplied id is incompatible with parallelism > 1')
		const groupId = count > 1 ? randomUUID() : null
		return Array.from({ length: count }, () =>
			this.store.create({
				...(parsed.data.id ? { id: parsed.data.id } : {}),
				kind: 'solve',
				status: initialStatus(parsed.data),
				projectSlug: parsed.data.projectSlug,
				title: parsed.data.title,
				source: parsed.data.source ?? null,
				capturedContext: parsed.data.capturedContext ?? null,
				baseRef,
				spawner: parsed.data.spawner ?? null,
				groupId,
				payload: {
					kind: 'solve',
					prompt: parsed.data.prompt,
					...(parsed.data.solverAgent ? { solverAgent: parsed.data.solverAgent } : {}),
				},
			}),
		)
	}

	setSolveItemAgent(id: string, solverAgent: SolverAgent): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve' || item.payload.kind !== 'solve') {
			throw new Error('Only solve Items can store a selected solver agent')
		}
		return this.store.updatePayload(id, { ...item.payload, solverAgent })
	}

	/** Per-item execution workspace override for the next solve run; null clears it. */
	setSolveItemWorkspace(id: string, solverWorkspace: SolverWorkspace | null): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve' || item.payload.kind !== 'solve') {
			throw new Error('Only solve Items can store a selected solver workspace')
		}
		const { solverWorkspace: _prev, ...payload } = item.payload
		return this.store.updatePayload(id, solverWorkspace ? { ...payload, solverWorkspace } : payload)
	}

	/** Per-item model override for the next solve run; null clears it. */
	setSolveItemModel(id: string, solverModel: string | null): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve' || item.payload.kind !== 'solve') {
			throw new Error('Only solve Items can store a selected solver model')
		}
		const { solverModel: _prev, ...payload } = item.payload
		return this.store.updatePayload(id, solverModel ? { ...payload, solverModel } : payload)
	}

	/**
	 * Promote a captured (ingested) Item into a real provider task: re-point its
	 * `source` at the task the provider just created and record
	 * `source_task_created`. Captured-only — a provider-discovered Item's
	 * provenance must never be rewritten — and refuses a second promotion to the
	 * same provider. The frozen `capturedContext` is deliberately KEPT: it still
	 * carries the email body + local attachments the solve should run against.
	 */
	linkSourceTask(id: string, source: ItemSource): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve') throw new Error('Only solve Items can be linked to a source task')
		if (!item.capturedContext) throw new Error('Only captured (ingested) Items can be linked to a source task')
		if (item.source?.provider === source.provider) {
			throw new Error(`Item is already linked to a ${source.provider} task`)
		}
		const updated = this.store.updateSource(id, source)
		this.store.insertEvent(id, 'source_task_created', {
			provider: source.provider,
			externalId: source.externalId,
			url: source.url ?? null,
			previousExternalId: item.source?.externalId ?? null,
		})
		return updated
	}

	createLoopItem(input: CreateLoopItemInput): ItemRecord {
		return this.createLoopItems({ ...input, parallelism: 1 })[0]
	}

	createLoopItems(input: CreateLoopItemsInput): ItemRecord[] {
		const parsed = createLoopItemsInputSchema.safeParse(input)
		if (!parsed.success) throw new Error(`Invalid loop Item input: ${parsed.error.message}`)

		const project = this.config.projects.find(p => p.slug === parsed.data.projectSlug)
		if (!project) throw new Error(`Unknown project slug: ${parsed.data.projectSlug}`)
		const baseRef = this.resolveBaseRef(parsed.data, project.baseBranch)

		const payload = {
			kind: 'loop' as const,
			prdPath: parsed.data.prdPath,
			...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
			...(parsed.data.provider ? { provider: parsed.data.provider } : {}),
			...(parsed.data.model ? { model: parsed.data.model } : {}),
			...(parsed.data.effort ? { effort: parsed.data.effort } : {}),
			...(parsed.data.iterations ? { iterations: parsed.data.iterations } : {}),
			...(parsed.data.noOversee !== undefined ? { noOversee: parsed.data.noOversee } : {}),
		}

		const count = parsed.data.parallelism ?? 1
		const groupId = count > 1 ? randomUUID() : null
		return Array.from({ length: count }, () =>
			this.store.create({
				kind: 'loop',
				status: initialStatus(parsed.data),
				projectSlug: parsed.data.projectSlug,
				title: parsed.data.title,
				source: null,
				baseRef,
				spawner: parsed.data.spawner ?? null,
				groupId,
				payload,
			}),
		)
	}

	approveItem(id: string): ItemRecord {
		const item = this.requireItem(id)
		if (item.status !== 'triage') throw new Error('Only triage Items can be approved')

		const now = new Date().toISOString()
		const approved = this.store.update(id, {
			status: 'ready',
			queuedAt: now,
			completedAt: null,
			errorMessage: null,
			errorPhase: null,
		})
		this.store.insertEvent(id, 'item_approved', { from: item.status, to: approved.status })
		return approved
	}

	rejectItem(id: string): ItemRecord {
		const item = this.requireItem(id)
		if (item.status !== 'triage') throw new Error('Only triage Items can be rejected')

		const now = new Date().toISOString()
		const rejected = this.store.update(id, {
			status: 'cancelled',
			completedAt: now,
			errorMessage: null,
			errorPhase: null,
		})
		this.store.insertEvent(id, 'item_rejected', { from: item.status, to: rejected.status })
		return rejected
	}

	startItem(id: string): ItemRecord {
		const item = this.requireItem(id)
		if (item.status !== 'ready' && item.status !== 'triage')
			throw new Error('Only ready or triage Items can be started')

		const started = this.store.update(id, {
			status: 'running',
			startedAt: new Date().toISOString(),
			completedAt: null,
			errorMessage: null,
			errorPhase: null,
		})
		this.store.insertEvent(id, 'item_started', { from: item.status, to: started.status })
		return started
	}

	retryItem(id: string): ItemRecord {
		const item = this.requireItem(id)
		if (!RETRYABLE_STATUSES.has(item.status)) {
			throw new Error('Only failed, cancelled, done, or review Items can be retried')
		}

		const retried = this.store.update(id, {
			status: 'ready',
			queuedAt: new Date().toISOString(),
			startedAt: null,
			completedAt: null,
			almanacRunId: null,
			errorMessage: null,
			errorPhase: null,
			resultSummary: null,
			solveInputSnapshot: null,
			prUrl: null,
			runOutcome: null,
		})
		this.store.insertEvent(id, 'item_retried', { from: item.status, to: retried.status })
		return retried
	}

	recoverStaleProcessingItems(): ItemRecord[] {
		const stale = ITEM_KINDS.flatMap(kind => this.store.listProcessingByKind(kind))
		return stale.map(item => {
			const recovered = this.store.update(item.id, {
				status: 'ready',
				queuedAt: item.queuedAt ?? new Date().toISOString(),
				startedAt: null,
				completedAt: null,
				almanacRunId: null,
				errorMessage: null,
				errorPhase: null,
				resultSummary: null,
				solveInputSnapshot: null,
				prUrl: null,
				runOutcome: null,
			})
			this.store.insertEvent(item.id, 'item_recovered', {
				from: item.status,
				to: recovered.status,
				reason: 'stale_processing',
			})
			return recovered
		})
	}

	cancelQueuedItem(id: string): ItemRecord {
		const item = this.requireItem(id)
		if (item.status !== 'ready' && item.status !== 'triage') {
			throw new Error('Only ready or triage Items can be cancelled before execution')
		}

		const cancelled = this.store.update(id, {
			status: 'cancelled',
			completedAt: new Date().toISOString(),
			errorMessage: 'Cancelled by user',
			errorPhase: null,
		})
		this.store.insertEvent(id, 'item_cancelled', { from: item.status, to: cancelled.status })
		return cancelled
	}

	cancelProcessingItem(id: string, message: string, phase: ErrorPhase): ItemRecord {
		const item = this.requireItem(id)
		if (item.status !== 'running') {
			throw new Error('Only running Items can be cancelled during execution')
		}

		const cancelled = this.store.update(id, {
			status: 'cancelled',
			completedAt: new Date().toISOString(),
			errorMessage: message,
			errorPhase: phase,
			runOutcome: 'cancelled',
		})
		this.store.insertEvent(id, 'item_cancelled', { from: item.status, to: cancelled.status, phase })
		return cancelled
	}

	failItem(id: string, message: string, phase: ErrorPhase): ItemRecord {
		const item = this.requireItem(id)
		if (item.status !== 'running') {
			throw new Error('Only running Items can fail during execution')
		}

		const failed = this.store.update(id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			errorMessage: message,
			errorPhase: phase,
			runOutcome: runOutcomeForFailure(message),
		})
		this.store.insertEvent(id, 'item_failed', { from: item.status, to: failed.status, phase, error: message })
		return failed
	}

	/**
	 * Reconcile a solve run that ERRORED (or wrote no result file) but left
	 * shippable work behind: instead of a false `failed`, land the Item in
	 * `review` so it joins the human-handling pile, while keeping the error
	 * context and an `errored`/`no_result` runOutcome flag. Called by the worker
	 * after it detects committed work / a PR on the branch. Processing solve only.
	 */
	reconcileFailedSolve(id: string, fields: { message: string; phase: ErrorPhase; prUrl?: string | null }): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve') throw new Error('Only solve Items can be reconciled to review')
		if (item.status !== 'running') throw new Error('Only running solve Items can be reconciled')

		const reconciled = this.store.update(id, {
			status: 'review',
			completedAt: new Date().toISOString(),
			errorMessage: fields.message,
			errorPhase: fields.phase,
			runOutcome: runOutcomeForFailure(fields.message),
			...(fields.prUrl ? { prUrl: fields.prUrl } : {}),
		})
		this.store.insertEvent(id, 'item_reconciled', {
			from: item.status,
			to: reconciled.status,
			phase: fields.phase,
			error: fields.message,
			reason: 'shippable_work_present',
		})
		return reconciled
	}

	/**
	 * Manual override for a false failure: the user verified the work is fine,
	 * so move a `failed` solve Item into `review` (the human-handling pile)
	 * without re-running. Keeps the prior runOutcome so the "run was messy"
	 * context survives; clears the error banner. For a genuine re-run use retry;
	 * a deliberate `cancelled` Item is left alone (retry it to resume).
	 */
	reopenItem(id: string): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve') throw new Error('Only solve Items can be reopened to review')
		if (item.status !== 'failed') {
			throw new Error('Only failed Items can be reopened to review')
		}

		const reopened = this.store.update(id, {
			status: 'review',
			completedAt: new Date().toISOString(),
			errorMessage: null,
			errorPhase: null,
		})
		this.store.insertEvent(id, 'item_reopened', { from: item.status, to: reopened.status })
		return reopened
	}

	completeSolveItem(
		id: string,
		fields: {
			worktreePath: string
			// Null for main-workspace runs: the agent branches itself in the canonical
			// checkout, so the Item row carries no pre-created branch identity.
			branchName: string | null
			planDirName: string
			resultSummary: string
		},
	): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve') throw new Error('Only solve Items can complete through Solver')
		if (item.status !== 'running') throw new Error('Only running solve Items can complete through Solver')

		const completed = this.store.update(id, {
			status: 'review',
			worktreePath: fields.worktreePath,
			branchName: fields.branchName,
			planDirName: fields.planDirName,
			resultSummary: fields.resultSummary,
			completedAt: new Date().toISOString(),
			errorMessage: null,
			errorPhase: null,
			runOutcome: 'ok',
		})
		this.store.insertEvent(id, 'solve_completed', { summary: fields.resultSummary })
		return completed
	}

	recordAlmanacRunId(id: string, runId: string): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'loop') throw new Error('Only loop Items can record AlmanacRunId')
		if (item.status !== 'running') throw new Error('Only running loop Items can record AlmanacRunId')
		if (item.almanacRunId === runId) return item

		const updated = this.store.update(id, { almanacRunId: runId })
		this.store.insertEvent(id, 'almanac_run_started', { runId })
		return updated
	}

	completeLoopItem(id: string, fields: { resultSummary: string }): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'loop') throw new Error('Only loop Items can complete through almanac')
		if (item.status !== 'running') throw new Error('Only running loop Items can complete through almanac')

		const completed = this.store.update(id, {
			status: 'done',
			completedAt: new Date().toISOString(),
			resultSummary: fields.resultSummary,
			errorMessage: null,
			errorPhase: null,
			runOutcome: 'ok',
		})
		this.store.insertEvent(id, 'loop_completed', { summary: fields.resultSummary })
		return completed
	}

	recordDispatchPr(id: string, fields: { prUrl: string; shippedByAgent?: boolean }): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve') throw new Error('Only solve Items can record PR dispatch')
		if (item.status !== 'review') throw new Error('Only review solve Items can record PR dispatch')

		const updated = this.store.update(id, { prUrl: fields.prUrl })
		this.store.insertEvent(id, 'pr_created', {
			url: fields.prUrl,
			draft: false,
			shippedByAgent: fields.shippedByAgent === true,
		})
		return updated
	}

	recordDispatchComment(id: string, commentId: string): void {
		this.requireReviewSolveItem(id, 'record dispatch comments')
		this.store.insertEvent(id, 'comment_posted', { commentId })
	}

	recordDispatchSkipped(id: string, reason: string): void {
		this.requireReviewSolveItem(id, 'record dispatch skips')
		this.store.insertEvent(id, 'dispatch_skipped', { reason })
	}

	recordActionCompleted(id: string): void {
		this.requireReviewSolveItem(id, 'record action completion')
		this.store.insertEvent(id, 'action_completed')
	}

	/**
	 * Seed a model-derived branch/plan-dir name before the worktree is created.
	 * Status-agnostic (naming happens at plan time on a queued/planned Item and at
	 * run time on a processing Item) and idempotent: a no-op if the Item already
	 * carries a `branchName` (planned, forked, or already named), so it never
	 * overrides a name the user has committed to. Writes no event — naming is
	 * identity seeding, not a lifecycle transition; `resolveItemWorkspace` reads
	 * the persisted columns via its `??` defaults.
	 *
	 * Owns the uniqueness reservation: the DB existence check, the suffix decision,
	 * and the write all run synchronously here (better-sqlite3 is synchronous, no
	 * await between them), so the reservation is atomic w.r.t. the single-threaded
	 * event loop — two concurrent solves that derive the same `base` can't both
	 * observe it as free before either persists; the second sees the first's row
	 * and falls back to `base-suffix`. `gitTaken` is the caller's (non-transactional)
	 * git-ref check folded in.
	 */
	recordDerivedWorkspaceName(
		id: string,
		// `force` is set only by a manual dashboard re-name: it overrides the
		// already-named idempotency guard (the automatic path leaves it unset). The
		// atomic uniqueness reservation still runs in both modes.
		fields: { base: string; suffix: string; planDirName: string; gitTaken: boolean; force?: boolean },
	): ItemRecord {
		const item = this.requireItem(id)
		// Never rename a branch once a worktree exists on it — not even forced.
		// This is the atomic backstop for the manual-rename TOCTOU: the route checks
		// worktreePath before its model await, but a concurrent solve could create
		// the worktree during that await; this re-fetched check (synchronous, no
		// await before the write) closes the window so the on-disk worktree can't
		// desync from the row's branchName. The automatic naming path runs before
		// any worktree exists, so this never blocks it.
		if (item.worktreePath) return item
		if (item.branchName && !fields.force) return item
		const taken = fields.gitTaken || this.store.branchNameExists(fields.base, id)
		const branchName = taken ? `${fields.base}-${fields.suffix}` : fields.base
		return this.store.update(id, { branchName, planDirName: fields.planDirName })
	}

	recordExecutionWorkspaceIdentity(
		id: string,
		fields: {
			worktreePath?: string
			branchName?: string
			planDirName?: string
		},
	): ItemRecord {
		const item = this.requireItem(id)
		if (item.status !== 'running') {
			throw new Error('Only running Items can record execution workspace identity')
		}
		return this.store.update(id, fields)
	}

	recordPlanPrepared(
		id: string,
		fields: {
			worktreePath: string
			// Null for main-workspace planning: the session runs in the canonical
			// checkout and no Item branch is pre-created.
			branchName: string | null
			planDirName: string
			spawner: string
		},
	): ItemRecord {
		const item = this.requireItem(id)
		if (item.status === 'running') throw new Error('Running Items cannot be planned')

		const planned = this.store.update(id, {
			worktreePath: fields.worktreePath,
			branchName: fields.branchName,
			planDirName: fields.planDirName,
			// Stamp the "planned" signal here (not on the worktree fields, which a
			// normal solve also sets) so the dashboard can tell planned from has-run.
			plannedAt: item.plannedAt ?? new Date().toISOString(),
		})
		this.store.insertEvent(id, 'plan_prepared', {
			worktreePath: fields.worktreePath,
			branchName: fields.branchName,
			planDirName: fields.planDirName,
			spawner: fields.spawner,
		})
		return planned
	}

	recordSolveInputSnapshot(id: string, prompt: string): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve') throw new Error('Only solve Items can record solve input snapshots')
		if (item.status !== 'running') throw new Error('Only running solve Items can record solve input snapshots')
		return this.store.update(id, { solveInputSnapshot: prompt })
	}

	/**
	 * Persist the AI-derived short display name (cosmetic; the dashboard shows
	 * `displayName ?? title`). Routed through commands so Item writes stay in one
	 * place, but it records no event and guards no status — it never touches the
	 * lifecycle and applies to an Item in any state.
	 */
	recordDisplayName(id: string, displayName: string): ItemRecord {
		this.requireItem(id)
		return this.store.updateDisplayName(id, displayName)
	}

	/**
	 * Persist the pre-solve intent triage (restated intent, verdict, clarifying
	 * questions, security note). Advisory only — routed through
	 * commands for a single write path, but records NO event and guards NO status;
	 * the user still approves/rejects. Applies to an Item in any state.
	 */
	recordAssessment(id: string, assessment: Assessment): ItemRecord {
		this.requireItem(id)
		return this.store.updateAssessment(id, assessment)
	}

	/**
	 * Persist the GitHub-observed deploy state (PR merge + per-environment
	 * deployments) and record transition events for newly-reached milestones —
	 * `deploy_merged` and `deploy_succeeded` (per environment). The event seam is
	 * what Phase 3's ClientCare status sync hooks into. Idempotent: no write when
	 * the state is unchanged, no duplicate events for already-reached milestones.
	 */
	recordDeployState(id: string, next: DeployState): ItemRecord {
		const item = this.requireItem(id)
		const prev = item.deployState

		const unchanged =
			prev &&
			prev.merged === next.merged &&
			prev.mergeSha === next.mergeSha &&
			JSON.stringify(prev.deployments) === JSON.stringify(next.deployments)
		if (unchanged) return item

		const updated = this.store.updateDeployState(id, next)

		if (next.merged && !prev?.merged) {
			this.store.insertEvent(id, 'deploy_merged', { sha: next.mergeSha, at: next.mergedAt })
		}
		const before = successfulEnvironments(prev)
		for (const d of next.deployments) {
			if (d.state === 'success' && !before.has(d.environment)) {
				this.store.insertEvent(id, 'deploy_succeeded', { environment: d.environment, url: d.url })
			}
		}
		return updated
	}

	/**
	 * A merged PR means the work landed — move a `review` solve Item out of the
	 * attention pile into `completed`. Called by the DeployWatcher when it sees a
	 * merged PR. Idempotent: a no-op once the Item has already left `review`, so
	 * it never re-fires on subsequent polls or stomps a manual transition.
	 */
	/**
	 * Manual status override — the deliberate escape hatch for "set this Item's
	 * status to X by hand", separate from the constrained lifecycle actions. Still
	 * a guarded command (not a raw status write): refuses to touch a `processing`
	 * Item (cancel it first) and refuses to fake `processing` (run-owned). Sets
	 * sensible timestamps (queuedAt on → queued, completedAt on terminal/review)
	 * and clears the error banner unless the target is `failed`. Non-destructive:
	 * keeps branch / prUrl / result so an override can be reverted.
	 */
	setItemStatus(id: string, status: ItemRecord['status']): ItemRecord {
		const item = this.requireItem(id)
		if (status === item.status) return item
		if (item.status === 'running') throw new Error('Cancel the running Item before changing its status')
		if (status === 'running') throw new Error('Cannot manually set an Item to running')

		const now = new Date().toISOString()
		const updated = this.store.update(id, {
			status,
			queuedAt: status === 'ready' ? now : item.queuedAt,
			completedAt: COMPLETED_AT_STATUSES.has(status) ? now : null,
			errorMessage: status === 'failed' ? item.errorMessage : null,
			errorPhase: status === 'failed' ? item.errorPhase : null,
		})
		this.store.insertEvent(id, 'item_status_set', { from: item.status, to: status })
		return updated
	}

	markItemMerged(id: string): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve') throw new Error('Only solve Items can be completed via merge')
		if (item.status !== 'review') return item

		const completed = this.store.update(id, { status: 'done', completedAt: new Date().toISOString() })
		this.store.insertEvent(id, 'item_merged', { from: item.status, to: completed.status })
		return completed
	}

	recordEvent(id: string, eventType: string, payload?: unknown): void {
		const item = this.requireItem(id)
		this.requireGenericEventLifecycle(item, eventType)
		this.store.insertEvent(id, eventType, payload)
	}

	nextQueuedItems(kind: ItemKind, limit?: number): ItemRecord[] {
		return this.store.listQueuedByKind(kind, limit)
	}

	countQueuedItems(kind: ItemKind): number {
		return this.store.countQueuedByKind(kind)
	}

	getItem(id: string): ItemRecord | null {
		return this.store.get(id)
	}

	getItemBySourceExternalId(externalId: string): ItemRecord | null {
		return this.store.findBySourceExternalId(externalId)
	}

	listGroupItems(groupId: string): ItemRecord[] {
		return this.store.listByGroupId(groupId)
	}

	listItems(opts?: {
		status?: ItemRecord['status']
		projectSlug?: string
		limit?: number
		offset?: number
	}): ItemRecord[] {
		return this.store.list(opts)
	}

	listDashboardItems(archiveLimit = 50): ItemRecord[] {
		return this.store.listDashboard(archiveLimit)
	}

	private resolveBaseRef(input: BaseRefSelection, defaultBaseRef: string): string {
		if (input.baseRef && input.baseItemId) {
			throw new Error('Specify either baseRef or baseItemId, not both')
		}
		if (!input.baseItemId) return input.baseRef ?? defaultBaseRef

		const baseItem = this.store.get(input.baseItemId)
		if (!baseItem) throw new Error(`Base Item not found: ${input.baseItemId}`)
		if (baseItem.projectSlug !== input.projectSlug) {
			throw new Error(
				`Base Item ${input.baseItemId} belongs to project "${baseItem.projectSlug}", not "${input.projectSlug}"`,
			)
		}
		if (!baseItem.branchName) throw new Error(`Base Item ${input.baseItemId} has no branch to fork from`)
		return baseItem.branchName
	}

	private requireItem(id: string): ItemRecord {
		const item = this.store.get(id)
		if (!item) throw new Error(`Item not found: ${id}`)
		return item
	}

	private requireReviewSolveItem(id: string, action: string): ItemRecord {
		const item = this.requireItem(id)
		if (item.kind !== 'solve' || item.status !== 'review') {
			throw new Error(`Only review solve Items can ${action}`)
		}
		return item
	}

	private requireGenericEventLifecycle(item: ItemRecord, eventType: string): void {
		if (RESERVED_EVENT_TYPES.has(eventType)) {
			throw new Error(`Use the dedicated ItemCommands method to record ${eventType}`)
		}
		if (eventType.startsWith('solve_') && (item.kind !== 'solve' || item.status !== 'running')) {
			throw new Error('Only running solve Items can record solve events')
		}
		if (eventType === 'dispatch_failed' && (item.kind !== 'solve' || item.status !== 'review')) {
			throw new Error('Only review solve Items can record dispatch failures')
		}
	}
}
