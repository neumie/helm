import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { dispatchSolveItem } from '../actions/dispatcher.js'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { isItemAssigned, requireItemAssignment } from '../items/assignment.js'
import { ItemCommands } from '../items/commands.js'
import { buildItemExecutionContext, prepareItemExecutionContext } from '../items/context.js'
import { loopPayloadForItem } from '../items/execution.js'
import { resolveItemWorkspace } from '../items/identity.js'
import { ensureItemDisplayName, ensureItemWorkspaceName } from '../items/naming.js'
import type { EnsureItemDisplayNameDeps, EnsureItemNameDeps } from '../items/naming.js'
import type { ItemRecord } from '../items/schema.js'
import type { ResolvedKnowledgeBinding } from '../knowledge/bindings.js'
import type { KnowledgeIntegration } from '../knowledge/integration.js'
import { KnowledgeProviderError } from '../knowledge/provider.js'
import type { KnowledgeSnapshot } from '../knowledge/schema.js'
import { PlanWorkspace } from '../plan/workspace.js'
import { profileRuntimeRoot } from '../profiles/runtime.js'
import { ProviderUnavailableError, type TaskContext, type TaskProvider } from '../providers/provider.js'
import { assertAgentBudget } from '../solver/agent-adapter.js'
import { effectiveSolverModel } from '../solver/models.js'
import type { SolveResult, Solver } from '../solver/solver.js'
import { type ErrorPhase, errorPhase, isCancellation, phaseError } from '../util/errors.js'
import { log } from '../util/logger.js'
import { sameFilesystemPath } from '../util/path-identity.js'
import {
	assertWorkspaceReuse,
	createWorktree,
	excludeHelmFiles,
	worktreeRegistrationForBranch,
} from '../worktree/manager.js'
import { AlmanacLoopRunner } from './loop-runner.js'
import type { LoopRunner } from './loop-runner.js'

const logsDir = (profileId: string) => resolve(profileRuntimeRoot(profileId), 'logs')

const execFileAsync = promisify(execFile)

function knowledgeFailurePhase(error: unknown): ErrorPhase {
	return error instanceof KnowledgeProviderError && (error.retryable || error.outcomeUnknown)
		? 'knowledge_retryable'
		: 'knowledge'
}

function beginItemKnowledgeAttempt(
	commands: ItemCommands,
	item: ItemRecord,
	admittedBinding: ResolvedKnowledgeBinding | null,
): void {
	if (item.worktreePath && item.planDirName) {
		const previousWorkspace = new PlanWorkspace(item.worktreePath, item.planDirName)
		if (previousWorkspace.knowledgeCandidatesExist()) {
			const candidates = previousWorkspace.readKnowledgeCandidates()
			if (candidates.length > 0 && (item.knowledgeSnapshotId || admittedBinding)) {
				throw phaseError('knowledge', 'Unrecovered knowledge candidates must be delivered before another run attempt')
			}
			// A sidecar without prior evidence or a current binding is not deliverable
			// knowledge. Clear it rather than permanently blocking an ordinary Item.
			previousWorkspace.clearKnowledgeCandidates()
		}
	}
	commands.recordKnowledgeSnapshot(item.id, null)
}

async function ensureItemWorktree(
	projectConfig: HelmConfig['projects'][number],
	baseRef: string,
	branchName: string,
	existingWorktreePath: string | undefined,
): Promise<string> {
	if (existingWorktreePath) {
		await assertWorkspaceReuse(projectConfig.repoPath, branchName, existingWorktreePath)
		log.info('worker', `Reusing existing worktree: ${existingWorktreePath}`)
		await excludeHelmFiles(existingWorktreePath)
		return existingWorktreePath
	}

	try {
		const worktreePath = await createWorktree(projectConfig.repoPath, baseRef, branchName, projectConfig.worktreeDir)
		await excludeHelmFiles(worktreePath)
		return worktreePath
	} catch (err) {
		throw phaseError('worktree', `Worktree creation failed: ${err instanceof Error ? err.message : err}`)
	}
}

/**
 * The worktree an execution may reuse. A Worktree run never reuses the canonical
 * checkout: an Item still pointing there was run or planned in Main earlier, and
 * that pointer only says where the old attempt happened. Drop it so the run gets
 * its own linked worktree (`carryMainPlan` brings a Main plan's documents along).
 */
function reusableWorktreePath(
	recorded: string | undefined,
	repoPath: string,
	mainMode: boolean,
	itemId: string,
): string | undefined {
	if (mainMode || !recorded || !sameFilesystemPath(recorded, repoPath)) return recorded
	log.info('worker', `Item ${itemId} last ran or planned in the main checkout; creating its own worktree`)
	return undefined
}

/**
 * Whether the branch an Item records beside a canonical pointer is its own: an
 * earlier Worktree attempt that failed before readiness reserved it and created
 * its linked worktree. Anything else (a branch a legacy Main plan kept, i.e.
 * whatever the checkout was on, possibly the base) is not this run's branch.
 */
async function ownsLinkedBranch(repoPath: string, branchName: string | null, baseRef: string): Promise<boolean> {
	if (!branchName || branchName === baseRef) return false
	const registration = await worktreeRegistrationForBranch(repoPath, branchName)
	return registration?.exists === true && !sameFilesystemPath(registration.path, repoPath)
}

function pointsAtCheckout(item: ItemRecord, repoPath: string): boolean {
	return item.worktreePath !== null && sameFilesystemPath(item.worktreePath, repoPath)
}

/** A Main plan to carry into this Worktree run's new worktree, if the Item has one. */
function mainPlanSource(item: ItemRecord, repoPath: string, mainMode: boolean): PlanWorkspace | null {
	if (mainMode || !item.plannedAt || !item.planDirName || !pointsAtCheckout(item, repoPath)) return null
	return new PlanWorkspace(repoPath, item.planDirName)
}

/**
 * Copy a Main plan's documents into the run's new worktree. Reads the canonical
 * checkout only; writes only into the new worktree and never replaces a file there.
 */
function carryMainPlan(source: PlanWorkspace, target: PlanWorkspace, repoPath: string, worktreePath: string): void {
	if (sameFilesystemPath(worktreePath, repoPath)) {
		throw phaseError('worktree', 'Worktree execution cannot run in the canonical project checkout.')
	}
	if (!existsSync(source.dir)) {
		log.warn('worker', `The plan prepared in the main checkout is gone (${source.dir}); running without it`)
		return
	}
	let carried: ReturnType<PlanWorkspace['carryPlanFrom']>
	try {
		carried = target.carryPlanFrom(source)
	} catch (error) {
		// Deterministic (plan too large, unreadable): retrying cannot help, so this is
		// not a transient worktree failure.
		throw phaseError(
			'solve',
			`Could not copy the plan from the main checkout (${source.dir}) into the new worktree: ${error instanceof Error ? error.message : error}. Fix the plan files there, then retry.`,
		)
	}
	log.info('worker', `Copied the main-checkout plan into ${worktreePath}`, { ...carried })
	if (carried.kept.length > 0) {
		log.warn('worker', `Kept the worktree's own copy of plan files: ${carried.kept.join(', ')}`)
	}
}

/**
 * After a solve run errors, detect whether the agent left shippable work on the
 * branch — committed locally (commits ahead of base) and/or an open PR. A run
 * that errored or wrote no result file may still have done real work; in that
 * case "failed" is a lie. Best-effort and fail-safe: any detection error returns
 * `false`, so the Item just fails normally. Returns the PR url when one exists.
 *
 * `branchName` is null for main-workspace runs (the Item row never carries a
 * branch there): the commits-ahead check vs `baseRef` still applies, only the
 * by-branch PR lookup is skipped.
 */
async function detectShippableWork(
	worktreePath: string,
	baseRef: string,
	branchName: string | null,
): Promise<{ prUrl: string | null } | false> {
	let commitsAhead = 0
	try {
		const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'rev-list', '--count', `${baseRef}..HEAD`], {
			timeout: 10_000,
		})
		commitsAhead = Number.parseInt(stdout.trim(), 10) || 0
	} catch {
		return false
	}
	if (commitsAhead <= 0) return false

	let prUrl: string | null = null
	if (branchName) {
		try {
			const { stdout } = await execFileAsync('gh', ['pr', 'view', branchName, '--json', 'url,state'], {
				cwd: worktreePath,
				timeout: 10_000,
			})
			const pr: unknown = JSON.parse(stdout)
			if (
				pr !== null &&
				typeof pr === 'object' &&
				'state' in pr &&
				(pr.state === 'OPEN' || pr.state === 'MERGED') &&
				'url' in pr &&
				typeof pr.url === 'string' &&
				pr.url.trim().length > 0
			)
				prUrl = pr.url.trim()
		} catch {
			// No PR (or gh unavailable) — committed work alone is enough to reconcile.
		}
	}
	return { prUrl }
}

/**
 * Terminal handling for a non-cancelled solve failure: reconcile to `review`
 * when the branch holds shippable work (solve phase only — poll/worktree
 * failures mean no work was done), otherwise mark `failed`.
 */
async function failOrReconcileSolve(
	commands: ItemCommands,
	itemId: string,
	item: ItemRecord,
	error: Error,
	phase: ErrorPhase,
	workspace: { repoPath: string; mainMode: boolean },
	signal?: AbortSignal,
): Promise<void> {
	if (phase === 'solve') {
		const current = commands.getItem(itemId)
		// A Worktree run that failed before its worktree was recorded still points
		// at the canonical checkout; whatever that checkout holds is not this run's work.
		const leftInCheckout =
			!workspace.mainMode &&
			current?.worktreePath != null &&
			sameFilesystemPath(current.worktreePath, workspace.repoPath)
		// branchName may be null (main-workspace run) — commits-ahead detection
		// still applies; only the by-branch PR lookup degrades away.
		if (current?.worktreePath && isItemAssigned(current) && !leftInCheckout) {
			const { baseRef } = resolveItemWorkspace(current)
			const work = await detectShippableWork(current.worktreePath, baseRef, current.branchName)
			// A cancel can land while detection awaits (the Item is still `running`
			// and the cancel route already answered 200); honor it instead of
			// overwriting the user's cancel with failed/review.
			if (signal?.aborted) {
				commands.cancelProcessingItem(itemId, 'Item cancelled by user', phase)
				log.warn('worker', `Solve Item cancelled: ${item.title}`)
				return
			}
			if (work) {
				commands.reconcileFailedSolve(itemId, { message: error.message, phase, prUrl: work.prUrl })
				log.warn('worker', `Solve Item errored but has shippable work — moved to review: ${item.title}`)
				return
			}
		}
	}
	commands.failItem(itemId, error.message, phase)
	log.error('worker', `Solve Item failed: ${item.title}`, error)
}

async function buildSolveItemTaskContext(item: ItemRecord, provider: TaskProvider): Promise<TaskContext> {
	if (item.payload.kind !== 'solve') {
		throw phaseError('solve', `Item ${item.id} is ${item.kind}, not solve`)
	}

	// Frozen captured context (ingested email etc.) wins. It stays canonical here;
	// the required Solver readiness callback localizes it only after bytes exist.
	if (item.capturedContext) return buildItemExecutionContext(item, item.capturedContext)

	if (item.source) {
		let sourceContext: TaskContext | null
		try {
			sourceContext = await provider.getTaskContext(item.source.externalId)
		} catch (err) {
			// A provider outage before any agent session is a transient read
			// failure: tag it `poll` so the Drainer's bounded auto-retry applies.
			if (err instanceof ProviderUnavailableError) throw phaseError('poll', err.message)
			throw err
		}
		if (!sourceContext) {
			throw phaseError('poll', 'Item source not found in source system')
		}
		return buildItemExecutionContext(item, sourceContext)
	}

	return buildItemExecutionContext(item)
}

export interface ProcessSolveItemDeps {
	displayName?: EnsureItemDisplayNameDeps
	workspaceName?: EnsureItemNameDeps
	knowledge?: KnowledgeIntegration
}

export async function processSolveItem(
	itemId: string,
	config: HelmConfig,
	db: DB,
	provider: TaskProvider,
	solver: Solver,
	signal?: AbortSignal,
	deps: ProcessSolveItemDeps = {},
): Promise<void> {
	const commands = new ItemCommands(db.items, config)
	const pending = commands.getItem(itemId)
	if (!pending) throw new Error(`Item ${itemId} not found in DB`)
	if (pending.kind !== 'solve') throw new Error(`Item ${itemId} is ${pending.kind}, not solve`)
	requireItemAssignment(pending)

	const projectConfig = config.projects.find(p => p.slug === pending.projectSlug)
	if (!projectConfig) throw new Error(`No project config for slug: ${pending.projectSlug}`)

	const item = commands.startItem(itemId)
	requireItemAssignment(item)
	const runDb = db.forProfile(item.profileId)
	const admittedKnowledgeBinding = deps.knowledge?.bindingFor(item.profileId, item.projectSlug) ?? null

	const logRoot = logsDir(item.profileId)
	mkdirSync(logRoot, { recursive: true })
	const outputLogPath = resolve(logRoot, `${itemId}.log`)

	try {
		beginItemKnowledgeAttempt(commands, item, admittedKnowledgeBinding)
		const selectedAgent = item.payload.kind === 'solve' ? item.payload.solverAgent : undefined
		const selectedModel = item.payload.kind === 'solve' ? item.payload.solverModel : undefined
		const selectedEffort = item.payload.kind === 'solve' ? item.payload.solverEffort : undefined
		const selectedWorkspace = item.payload.kind === 'solve' ? item.payload.solverWorkspace : undefined
		assertAgentBudget(
			{ ...config.solver, agent: selectedAgent ?? config.solver.agent },
			config.solver.type === 'default' ? 'headless' : 'interactive',
		)

		// Source Items precompute cosmetic display names in ItemEnricher. Never put
		// that optional model call on Start agent's hot path; an in-flight result can
		// safely land while running because displayName does not affect identity.
		// Source-less manual Items have no background dwell, so solve startup remains
		// their final best-effort generation attempt.
		const displayNamed = item.source
			? item
			: await ensureItemDisplayName({
					commands,
					item,
					config,
					agent: selectedAgent ?? config.solver.agent,
					signal,
					deps: deps.displayName,
					generateWhenMissing: true,
				})

		log.info('worker', `Building context for solve Item: ${item.title}`)
		const taskContext = await buildSolveItemTaskContext(displayNamed, provider)
		const workspaceMode = selectedWorkspace ?? config.solver.workspace ?? 'worktree'
		const mainMode = workspaceMode === 'main'
		let freshest = commands.getItem(itemId) ?? displayNamed
		// Left over from a Main run or plan. Captured before naming, which may give a
		// Main plan a new dir name.
		const leftMain = !mainMode && pointsAtCheckout(freshest, projectConfig.repoPath)
		const mainPlan = mainPlanSource(freshest, projectConfig.repoPath, mainMode)
		if (
			leftMain &&
			freshest.branchName !== null &&
			!(await ownsLinkedBranch(projectConfig.repoPath, freshest.branchName, item.baseRef))
		) {
			freshest = commands.recordExecutionWorkspaceIdentity(itemId, { branchName: null })
		}

		// The background Enricher prewarms source and Queue Items, but an immediate
		// Start can race that pass. Wait for one bounded, best-effort naming attempt
		// here before resolving the workspace; a timeout/failure leaves `freshest`
		// unchanged so the deterministic helm/item identity remains the fallback.
		// Main-workspace runs skip naming entirely; the agent branches itself.
		const named = mainMode
			? { ...freshest, branchName: null }
			: await ensureItemWorkspaceName({
					commands,
					item: freshest,
					taskContext,
					config,
					repoPath: projectConfig.repoPath,
					agent: selectedAgent ?? config.solver.agent,
					signal,
					deps: deps.workspaceName,
					// A Main run or plan left no branch; this run names its own.
					transitionFromMain: leftMain && freshest.branchName === null,
					keepPlanDirName: mainPlan !== null,
				})

		requireItemAssignment(named)
		const resolvedWorkspace = resolveItemWorkspace(named)
		const { baseRef, planDirName, branchName } = resolvedWorkspace
		const existingWorktreePath = reusableWorktreePath(
			resolvedWorkspace.existingWorktreePath,
			projectConfig.repoPath,
			mainMode,
			itemId,
		)
		let executionContext = taskContext
		let knowledgeSnapshot: KnowledgeSnapshot | null = null
		let knowledgeBinding: ResolvedKnowledgeBinding | null = null
		if (deps.knowledge) {
			try {
				const preparedKnowledge = await deps.knowledge.prepareContext(runDb.knowledge, {
					profileId: item.profileId,
					itemId,
					projectSlug: named.projectSlug,
					purpose: 'solve',
					taskContext,
					binding: admittedKnowledgeBinding,
					...(signal === undefined ? {} : { signal }),
				})
				executionContext = preparedKnowledge.taskContext
				knowledgeSnapshot = preparedKnowledge.snapshot
				knowledgeBinding = preparedKnowledge.binding
				commands.recordKnowledgeSnapshot(itemId, preparedKnowledge.snapshot?.id ?? null)
			} catch (error) {
				if (isCancellation(error, signal)) throw error
				throw phaseError(
					knowledgeFailurePhase(error),
					`Project knowledge unavailable: ${error instanceof Error ? error.message : error}`,
				)
			}
		}
		const preparedContext = prepareItemExecutionContext(named, executionContext)
		if (!mainMode && existingWorktreePath) {
			await assertWorkspaceReuse(projectConfig.repoPath, branchName, existingWorktreePath, workspaceMode)
		}
		if (mainMode) commands.recordExecutionWorkspaceIdentity(itemId, { planDirName, branchName: null })
		const solverConfig = {
			...config.solver,
			agent: selectedAgent ?? config.solver.agent,
			model: effectiveSolverModel(selectedAgent ?? config.solver.agent, selectedModel, config.solver),
			workspace: workspaceMode,
		}

		let readinessCalls = 0
		let readinessPath: string | undefined
		let readinessSealed = false
		const onWorktreeReady = (worktreePath: string): TaskContext => {
			// A solver may retain this callback beyond solve() resolution. Do not let
			// that detached continuation write Item state or throw asynchronously.
			if (readinessSealed) {
				log.warn('worker', `Ignoring late workspace readiness callback for ${itemId}`)
				return executionContext
			}
			if (++readinessCalls !== 1)
				throw phaseError('worktree', 'Solver violated the required workspace readiness contract')
			readinessPath = worktreePath
			if (mainPlan && !existingWorktreePath) {
				carryMainPlan(mainPlan, new PlanWorkspace(worktreePath, planDirName), projectConfig.repoPath, worktreePath)
			}
			const adapterContext = preparedContext.onWorktreeReady(worktreePath)
			commands.recordExecutionWorkspaceIdentity(
				itemId,
				mainMode ? { worktreePath, planDirName } : { worktreePath, branchName, planDirName },
			)
			return adapterContext
		}
		let solveResult: SolveResult
		try {
			solveResult = await solver.solve({
				projectConfig: { ...projectConfig, baseBranch: baseRef },
				branchName,
				planDirName,
				canonicalContext: executionContext,
				taskId: item.id,
				taskTitle: item.title,
				taskDisplayName: (commands.getItem(itemId) ?? named).displayName,
				okenaTerminals: runDb.okenaTerminals.forItem(item.id),
				solverConfig,
				knowledgeCandidatesEnabled: knowledgeBinding !== null,
				solverEffort: selectedEffort,
				workspaceMode,
				signal,
				outputLogPath,
				existingWorktreePath,
				onWorktreeReady,
				onPromptSnapshot: prompt => {
					commands.recordSolveInputSnapshot(itemId, prompt)
				},
			})
		} finally {
			readinessSealed = true
		}
		const { worktreePath, outcome } = solveResult
		if (
			readinessCalls !== 1 ||
			!readinessPath ||
			!sameFilesystemPath(readinessPath, worktreePath) ||
			(!mainMode && solveResult.branchName !== branchName)
		) {
			throw phaseError('worktree', 'Solver violated the required workspace readiness contract')
		}

		commands.recordExecutionWorkspaceIdentity(
			itemId,
			mainMode ? { worktreePath, planDirName } : { worktreePath, branchName, planDirName },
		)

		for (const event of outcome.events) {
			commands.recordEvent(itemId, `solve_${event.type}`, { detail: event.detail, file: event.file })
		}

		const workspace = new PlanWorkspace(worktreePath, planDirName)
		const solverResult = workspace.readResult()
		if (!solverResult) {
			throw phaseError('solve', `No solver-result.json at ${workspace.rel.result}`)
		}
		const knowledgeCandidates = workspace.readKnowledgeCandidates()
		let candidatesQueued = false
		runDb.items.transaction(() => {
			commands.completeSolveItem(itemId, {
				worktreePath,
				branchName: mainMode ? null : branchName,
				planDirName,
				resultSummary: solverResult.summary,
			})
			if (knowledgeCandidates.length && knowledgeBinding && deps.knowledge) {
				try {
					deps.knowledge.enqueueCandidates(runDb.knowledge, {
						itemId,
						projectSlug: named.projectSlug,
						snapshotId: knowledgeSnapshot?.id ?? null,
						binding: knowledgeBinding,
						candidates: knowledgeCandidates,
					})
					candidatesQueued = true
				} catch {
					// Candidate publication is post-run enrichment. It must never turn
					// successfully solved work into a false failure. Keep the private
					// sidecar for operator recovery when durable enqueue itself fails.
					log.warn('worker', `Could not durably queue knowledge candidates for ${itemId}`)
				}
			}
		})
		if (knowledgeCandidates.length === 0 || !knowledgeBinding || candidatesQueued) {
			workspace.clearKnowledgeCandidates()
		}

		log.info('worker', 'Solve Item complete - dispatching')
		try {
			await dispatchSolveItem({
				itemId,
				result: solverResult,
				config,
				commands,
				provider,
			})
		} catch (err) {
			log.warn('worker', `Item action dispatch failed: ${err instanceof Error ? err.message : err}`)
			commands.recordEvent(itemId, 'dispatch_failed', { error: (err as Error).message })
		}
		log.success('worker', `Solve Item ready for review: ${item.title}`)
	} catch (err) {
		const error = err as Error
		const isCancelled = isCancellation(error, signal)
		const phase = errorPhase(error)
		if (isCancelled) {
			commands.cancelProcessingItem(itemId, 'Item cancelled by user', phase)
			log.warn('worker', `Solve Item cancelled: ${item.title}`)
		} else {
			const mainRun =
				((item.payload.kind === 'solve' ? item.payload.solverWorkspace : undefined) ??
					config.solver.workspace ??
					'worktree') === 'main'
			await failOrReconcileSolve(
				commands,
				itemId,
				item,
				error,
				phase,
				{ repoPath: projectConfig.repoPath, mainMode: mainRun },
				signal,
			)
		}
	}
}

export interface ProcessLoopItemDeps {
	knowledge?: KnowledgeIntegration
	provider?: TaskProvider
}

export async function processLoopItem(
	itemId: string,
	config: HelmConfig,
	db: DB,
	loopRunner: LoopRunner = new AlmanacLoopRunner(),
	signal?: AbortSignal,
	deps: ProcessLoopItemDeps = {},
): Promise<void> {
	const commands = new ItemCommands(db.items, config)
	const item = commands.getItem(itemId)
	if (!item) throw new Error(`Item ${itemId} not found in DB`)
	const storedLoopPayload = loopPayloadForItem(item)
	if (!storedLoopPayload) throw new Error(`Item ${itemId} is not configured for loop execution`)
	requireItemAssignment(item)
	// Planned solve Items retain one stable execution descriptor, but the user may
	// change agent/model/effort when retrying. Resolve those fields from the
	// current Item at execution time so the first loop attempt cannot pin every
	// later retry to its original selection.
	const loopPayload =
		item.payload.kind === 'solve'
			? {
					...storedLoopPayload,
					provider: item.payload.solverAgent ?? config.solver.agent,
					model: effectiveSolverModel(
						item.payload.solverAgent ?? config.solver.agent,
						item.payload.solverModel,
						config.solver,
					),
					effort: item.payload.solverEffort,
				}
			: storedLoopPayload

	const projectConfig = config.projects.find(p => p.slug === item.projectSlug)
	if (!projectConfig) throw new Error(`No project config for slug: ${item.projectSlug}`)
	const workspaceMode =
		item.payload.kind === 'solve' ? (item.payload.solverWorkspace ?? config.solver.workspace ?? 'worktree') : 'worktree'
	const mainMode = workspaceMode === 'main'

	commands.startItem(itemId)
	const runDb = db.forProfile(item.profileId)
	const admittedKnowledgeBinding =
		item.kind === 'solve' ? (deps.knowledge?.bindingFor(item.profileId, item.projectSlug) ?? null) : null
	const logRoot = logsDir(item.profileId)
	mkdirSync(logRoot, { recursive: true })
	const outputLogPath = resolve(logRoot, `${itemId}.log`)

	try {
		assertAgentBudget(config.solver, 'loop')
		beginItemKnowledgeAttempt(commands, item, admittedKnowledgeBinding)
		let loopKnowledgeContext: string | null = null
		let knowledgeSnapshot: KnowledgeSnapshot | null = null
		let knowledgeBinding: ResolvedKnowledgeBinding | null = null
		if (item.kind === 'solve' && deps.knowledge) {
			if (!deps.provider) throw phaseError('knowledge', 'Knowledge-enabled loop execution requires a task provider')
			const taskContext = await buildSolveItemTaskContext(item, deps.provider)
			try {
				const preparedKnowledge = await deps.knowledge.prepareContext(runDb.knowledge, {
					profileId: item.profileId,
					itemId,
					projectSlug: item.projectSlug,
					purpose: 'solve',
					taskContext,
					binding: admittedKnowledgeBinding,
					...(signal === undefined ? {} : { signal }),
				})
				commands.recordKnowledgeSnapshot(itemId, preparedKnowledge.snapshot?.id ?? null)
				knowledgeSnapshot = preparedKnowledge.snapshot
				knowledgeBinding = preparedKnowledge.binding
				loopKnowledgeContext = preparedKnowledge.snapshot?.context ?? null
			} catch (error) {
				if (isCancellation(error, signal)) throw error
				throw phaseError(
					knowledgeFailurePhase(error),
					`Project knowledge unavailable: ${error instanceof Error ? error.message : error}`,
				)
			}
		}
		const loopProvider = loopPayload.provider ?? config.solver.agent
		if (loopProvider === 'pi') {
			throw phaseError('loop', 'Pi is supported for direct agent runs, not Almanac loop execution.')
		}
		const runnableLoopPayload = { ...loopPayload, provider: loopProvider }
		// Loop Items keep the deterministic helm/item name: their title is a PRD
		// path, not a single conventional change, so
		// AI naming is scoped to solve Items only.
		// A branch kept on a legacy Main plan is never this run's branch (see ownsLinkedBranch).
		const dropBranch =
			!mainMode &&
			pointsAtCheckout(item, projectConfig.repoPath) &&
			!(await ownsLinkedBranch(projectConfig.repoPath, item.branchName, item.baseRef))
		const resolvedWorkspace = resolveItemWorkspace(dropBranch ? { ...item, branchName: null } : item)
		const { baseRef, planDirName, branchName } = resolvedWorkspace
		const mainPlan = mainPlanSource(item, projectConfig.repoPath, mainMode)
		const existingWorktreePath = reusableWorktreePath(
			resolvedWorkspace.existingWorktreePath,
			projectConfig.repoPath,
			mainMode,
			itemId,
		)
		commands.recordExecutionWorkspaceIdentity(
			itemId,
			mainMode ? { planDirName, branchName: null } : { planDirName, branchName },
		)
		if (item.kind === 'solve' && item.plannedAt) {
			if (mainMode && (!item.worktreePath || !sameFilesystemPath(item.worktreePath, projectConfig.repoPath))) {
				throw phaseError(
					'solve',
					'This plan was prepared in a Worktree. Re-plan with Workspace set to Main before starting a loop in Main.',
				)
			}
			if (!mainMode && !existingWorktreePath && !mainPlan) {
				throw phaseError('solve', 'Planned worktree is missing. Re-plan the Item before starting a loop.')
			}
		}
		const worktreePath = mainMode
			? projectConfig.repoPath
			: await ensureItemWorktree(projectConfig, baseRef, branchName, existingWorktreePath)
		if (mainPlan && !existingWorktreePath) {
			carryMainPlan(mainPlan, new PlanWorkspace(worktreePath, planDirName), projectConfig.repoPath, worktreePath)
		}
		if (mainMode) {
			await assertWorkspaceReuse(projectConfig.repoPath, branchName, worktreePath, workspaceMode)
			await excludeHelmFiles(worktreePath)
		}
		commands.recordExecutionWorkspaceIdentity(
			itemId,
			mainMode ? { worktreePath, planDirName } : { worktreePath, branchName, planDirName },
		)

		log.info('worker', 'Starting almanac loop with effective Item selection', {
			itemId,
			provider: loopProvider,
			model: effectiveSolverModel(loopProvider, loopPayload.model, config.solver) ?? 'default',
			effort: loopPayload.effort ?? 'default',
			workspace: workspaceMode,
		})
		const result = await loopRunner.runLoop({
			projectConfig: { ...projectConfig, baseBranch: baseRef },
			solverConfig: config.solver,
			itemId,
			itemTitle: item.title,
			payload: runnableLoopPayload,
			worktreePath,
			branchName,
			planDirName,
			outputLogPath,
			knowledgeContext: loopKnowledgeContext,
			signal,
			onRunId: runId => {
				commands.recordAlmanacRunId(itemId, runId)
			},
		})

		if (result.runId) commands.recordAlmanacRunId(itemId, result.runId)
		const workspace = new PlanWorkspace(worktreePath, planDirName)
		const knowledgeCandidates = workspace.readKnowledgeCandidates()
		let candidatesQueued = false
		runDb.items.transaction(() => {
			commands.completeLoopItem(itemId, { resultSummary: 'almanac loop run completed' })
			if (knowledgeCandidates.length && knowledgeBinding && deps.knowledge) {
				try {
					deps.knowledge.enqueueCandidates(runDb.knowledge, {
						itemId,
						projectSlug: item.projectSlug,
						snapshotId: knowledgeSnapshot?.id ?? null,
						binding: knowledgeBinding,
						candidates: knowledgeCandidates,
					})
					candidatesQueued = true
				} catch {
					log.warn('worker', `Could not durably queue knowledge candidates for ${itemId}`)
				}
			}
		})
		if (knowledgeCandidates.length === 0 || !knowledgeBinding || candidatesQueued) {
			workspace.clearKnowledgeCandidates()
		}
		log.success('worker', `loop execution complete: ${item.title}`)
	} catch (err) {
		const error = err as Error
		const isCancelled = isCancellation(error, signal)
		const phase = errorPhase(error)
		if (isCancelled) {
			commands.cancelProcessingItem(itemId, 'Item cancelled by user', phase)
			log.warn('worker', `${item.kind} Item cancelled: ${item.title}`)
		} else {
			commands.failItem(itemId, error.message, phase)
			log.error('worker', `${item.kind} Item failed: ${item.title}`, err)
		}
	}
}
