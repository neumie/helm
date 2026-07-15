import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { dispatchSolveItem } from '../actions/dispatcher.js'
import { copyAttachmentsToWorktree } from '../attachments/store.js'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import { buildItemTaskContext, localizeCapturedAttachments } from '../items/context.js'
import { resolveItemWorkspace } from '../items/identity.js'
import { ensureItemDisplayName, ensureItemWorkspaceName } from '../items/naming.js'
import type { EnsureItemDisplayNameDeps } from '../items/naming.js'
import type { ItemRecord } from '../items/schema.js'
import { PlanWorkspace } from '../plan/workspace.js'
import type { TaskContext, TaskProvider } from '../providers/provider.js'
import type { Solver } from '../solver/solver.js'
import { type ErrorPhase, errorPhase, isCancellation, phaseError } from '../util/errors.js'
import { log } from '../util/logger.js'
import { createWorktree, excludeHelmFiles } from '../worktree/manager.js'
import { AlmanacLoopRunner } from './loop-runner.js'
import type { LoopRunner } from './loop-runner.js'

const LOGS_DIR = resolve(process.cwd(), 'logs')

const execFileAsync = promisify(execFile)

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
		if (current?.worktreePath) {
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

	// Frozen captured context (ingested email etc.) wins — its attachments are
	// worktree-local files, not remote URLs.
	if (item.capturedContext) {
		return localizeCapturedAttachments(buildItemTaskContext(item, item.capturedContext))
	}

	if (item.source) {
		const sourceContext = await provider.getTaskContext(item.source.externalId)
		if (!sourceContext) {
			throw phaseError('poll', 'Item source not found in source system')
		}
		return buildItemTaskContext(item, sourceContext)
	}

	return buildItemTaskContext(item)
}

export interface ProcessSolveItemDeps {
	displayName?: EnsureItemDisplayNameDeps
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

	const projectConfig = config.projects.find(p => p.slug === pending.projectSlug)
	if (!projectConfig) throw new Error(`No project config for slug: ${pending.projectSlug}`)

	const item = commands.startItem(itemId)

	mkdirSync(LOGS_DIR, { recursive: true })
	const outputLogPath = resolve(LOGS_DIR, `${itemId}.log`)

	try {
		const selectedAgent = item.payload.kind === 'solve' ? item.payload.solverAgent : undefined
		const selectedModel = item.payload.kind === 'solve' ? item.payload.solverModel : undefined
		const selectedWorkspace = item.payload.kind === 'solve' ? item.payload.solverWorkspace : undefined

		// A solve is the final guarantee that an enabled AI display name gets one
		// generation attempt. Poll/startup enrichment is intentionally asynchronous;
		// the naming seam re-reads before writing so the first successful name wins.
		const displayNamed = await ensureItemDisplayName({
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

		// Main-workspace runs skip AI branch naming entirely: no branch is
		// pre-created — the agent manages branching itself in the main checkout.
		const named = mainMode
			? displayNamed
			: await ensureItemWorkspaceName({
					commands,
					item: displayNamed,
					taskContext,
					config,
					repoPath: projectConfig.repoPath,
					agent: selectedAgent ?? config.solver.agent,
					signal,
				})

		const { baseRef, planDirName, branchName, existingWorktreePath } = resolveItemWorkspace(named)
		// Main mode: the Item's branchName stays NULL until dispatch discovers the
		// agent-created branch; only the plan dir is recorded up front.
		commands.recordExecutionWorkspaceIdentity(itemId, mainMode ? { planDirName } : { planDirName, branchName })
		const solverConfig = {
			...config.solver,
			agent: selectedAgent ?? config.solver.agent,
			model: selectedModel ?? config.solver.model,
			workspace: workspaceMode,
		}

		const { worktreePath, outcome } = await solver.solve({
			projectConfig: { ...projectConfig, baseBranch: baseRef },
			branchName,
			planDirName,
			taskContext,
			taskId: item.id,
			taskTitle: item.title,
			solverConfig,
			workspaceMode,
			signal,
			outputLogPath,
			existingWorktreePath,
			onWorktreeReady: worktreePath => {
				// Drop ingested-task attachments into the (gitignored) worktree so the
				// agent can open them as local files. No-op for provider-backed Items.
				if (item.capturedContext) copyAttachmentsToWorktree(item.id, worktreePath)
				commands.recordExecutionWorkspaceIdentity(
					itemId,
					mainMode ? { worktreePath, planDirName } : { worktreePath, branchName, planDirName },
				)
			},
			onPromptSnapshot: prompt => {
				commands.recordSolveInputSnapshot(itemId, prompt)
			},
		})

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

		commands.completeSolveItem(itemId, {
			worktreePath,
			branchName: mainMode ? null : branchName,
			planDirName,
			resultSummary: solverResult.summary,
		})

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

export async function processLoopItem(
	itemId: string,
	config: HelmConfig,
	db: DB,
	loopRunner: LoopRunner = new AlmanacLoopRunner(),
	signal?: AbortSignal,
): Promise<void> {
	const commands = new ItemCommands(db.items, config)
	const item = commands.getItem(itemId)
	if (!item) throw new Error(`Item ${itemId} not found in DB`)
	if (item.kind !== 'loop' || item.payload.kind !== item.kind) {
		throw new Error(`Item ${itemId} is ${item.kind}, not a loop Item`)
	}

	const projectConfig = config.projects.find(p => p.slug === item.projectSlug)
	if (!projectConfig) throw new Error(`No project config for slug: ${item.projectSlug}`)

	commands.startItem(itemId)
	mkdirSync(LOGS_DIR, { recursive: true })
	const outputLogPath = resolve(LOGS_DIR, `${itemId}.log`)

	try {
		// Loop Items keep the deterministic helm/item name: their title is a PRD
		// path, not a single conventional change, so
		// AI naming is scoped to solve Items only.
		const { baseRef, planDirName, branchName, existingWorktreePath } = resolveItemWorkspace(item)
		commands.recordExecutionWorkspaceIdentity(itemId, { planDirName, branchName })
		const worktreePath = await ensureItemWorktree(projectConfig, baseRef, branchName, existingWorktreePath)
		commands.recordExecutionWorkspaceIdentity(itemId, { worktreePath, branchName, planDirName })

		const result = await loopRunner.runLoop({
			projectConfig: { ...projectConfig, baseBranch: baseRef },
			solverConfig: config.solver,
			itemId,
			itemTitle: item.title,
			payload: item.payload,
			worktreePath,
			branchName,
			planDirName,
			outputLogPath,
			signal,
			onRunId: runId => {
				commands.recordAlmanacRunId(itemId, runId)
			},
		})

		if (result.runId) commands.recordAlmanacRunId(itemId, result.runId)
		commands.completeLoopItem(itemId, { resultSummary: `almanac ${item.kind} run completed` })
		log.success('worker', `${item.kind} Item complete: ${item.title}`)
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
