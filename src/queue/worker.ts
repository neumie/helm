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
import type { TaskContext, TaskProvider } from '../providers/provider.js'
import type { SolveResult, Solver } from '../solver/solver.js'
import { type ErrorPhase, errorPhase, isCancellation, phaseError } from '../util/errors.js'
import { log } from '../util/logger.js'
import { sameFilesystemPath } from '../util/path-identity.js'
import { createWorktree, excludeHelmFiles } from '../worktree/manager.js'
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
	if (existingWorktreePath && existsSync(existingWorktreePath)) {
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
			const { stdout } = await execFileAsync('gh', ['pr', 'view', branchName, '--json', 'url', '-q', '.url'], {
				timeout: 10_000,
			})
			const trimmed = stdout.trim()
			if (trimmed) prUrl = trimmed
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
	signal?: AbortSignal,
): Promise<void> {
	if (phase === 'solve') {
		const current = commands.getItem(itemId)
		// branchName may be null (main-workspace run) — commits-ahead detection
		// still applies; only the by-branch PR lookup degrades away.
		if (current?.worktreePath && isItemAssigned(current)) {
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
		const sourceContext = await provider.getTaskContext(item.source.externalId)
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
		const freshest = commands.getItem(itemId) ?? displayNamed

		// Source Items precompute AI branch names in ItemEnricher while they wait in
		// Inbox/Queue. Never put that optional model call back on Start agent's hot
		// path: if prewarming has not finished, use the deterministic branch now so
		// the Okena workspace can appear immediately. Source-less manual Items have
		// no background dwell, so they retain the start-time naming attempt.
		// Main-workspace runs skip naming entirely; the agent branches itself.
		const named = mainMode
			? { ...freshest, branchName: null }
			: freshest.source
				? freshest
				: await ensureItemWorkspaceName({
						commands,
						item: freshest,
						taskContext,
						config,
						repoPath: projectConfig.repoPath,
						agent: selectedAgent ?? config.solver.agent,
						signal,
						deps: deps.workspaceName,
					})

		requireItemAssignment(named)
		const { baseRef, planDirName, branchName, existingWorktreePath } = resolveItemWorkspace(named)
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
		if (mainMode) commands.recordExecutionWorkspaceIdentity(itemId, { planDirName, branchName: null })
		const solverConfig = {
			...config.solver,
			agent: selectedAgent ?? config.solver.agent,
			model: selectedModel ?? config.solver.model,
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
			await failOrReconcileSolve(commands, itemId, item, error, phase, signal)
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
					model: item.payload.solverModel ?? config.solver.model,
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
		const { baseRef, planDirName, branchName, existingWorktreePath } = resolveItemWorkspace(item)
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
			if (!mainMode && !existingWorktreePath) {
				throw phaseError('solve', 'Planned worktree is missing. Re-plan the Item before starting a loop.')
			}
		}
		const worktreePath = mainMode
			? projectConfig.repoPath
			: await ensureItemWorktree(projectConfig, baseRef, branchName, existingWorktreePath)
		if (mainMode) {
			if (!existsSync(worktreePath)) throw phaseError('worktree', `Project checkout does not exist: ${worktreePath}`)
			await excludeHelmFiles(worktreePath)
		}
		commands.recordExecutionWorkspaceIdentity(
			itemId,
			mainMode ? { worktreePath, planDirName } : { worktreePath, branchName, planDirName },
		)

		log.info('worker', 'Starting almanac loop with effective Item selection', {
			itemId,
			provider: loopProvider,
			model: loopPayload.model ?? config.solver.model ?? 'default',
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
