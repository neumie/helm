import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { dispatchSolveItem } from '../actions/dispatcher.js'
import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import { buildItemTaskContext } from '../items/context.js'
import { resolveItemWorkspace } from '../items/identity.js'
import { ensureItemWorkspaceName } from '../items/naming.js'
import type { ItemRecord } from '../items/schema.js'
import { PlanWorkspace } from '../plan/workspace.js'
import type { TaskContext, TaskProvider } from '../providers/provider.js'
import type { Solver } from '../solver/solver.js'
import { errorPhase, isCancellation, phaseError } from '../util/errors.js'
import { log } from '../util/logger.js'
import { createWorktree, excludeVigilFiles } from '../worktree/manager.js'
import { AlmanacLoopRunner } from './loop-runner.js'
import type { LoopRunner } from './loop-runner.js'

const LOGS_DIR = resolve(process.cwd(), 'logs')

function ensureItemWorktree(
	projectConfig: VigilConfig['projects'][number],
	baseRef: string,
	branchName: string,
	existingWorktreePath: string | undefined,
): string {
	if (existingWorktreePath && existsSync(existingWorktreePath)) {
		log.info('worker', `Reusing existing worktree: ${existingWorktreePath}`)
		excludeVigilFiles(existingWorktreePath)
		return existingWorktreePath
	}

	try {
		const worktreePath = createWorktree(projectConfig.repoPath, baseRef, branchName, projectConfig.worktreeDir)
		excludeVigilFiles(worktreePath)
		return worktreePath
	} catch (err) {
		throw phaseError('worktree', `Worktree creation failed: ${err instanceof Error ? err.message : err}`)
	}
}

async function buildSolveItemTaskContext(item: ItemRecord, provider: TaskProvider): Promise<TaskContext> {
	if (item.payload.kind !== 'solve') {
		throw phaseError('solve', `Item ${item.id} is ${item.kind}, not solve`)
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

export async function processSolveItem(
	itemId: string,
	config: VigilConfig,
	db: DB,
	provider: TaskProvider,
	solver: Solver,
	signal?: AbortSignal,
): Promise<void> {
	const commands = new ItemCommands(db.items, config)
	const item = commands.getItem(itemId)
	if (!item) throw new Error(`Item ${itemId} not found in DB`)
	if (item.kind !== 'solve') throw new Error(`Item ${itemId} is ${item.kind}, not solve`)

	const projectConfig = config.projects.find(p => p.slug === item.projectSlug)
	if (!projectConfig) throw new Error(`No project config for slug: ${item.projectSlug}`)

	commands.startItem(itemId)

	mkdirSync(LOGS_DIR, { recursive: true })
	const outputLogPath = resolve(LOGS_DIR, `${itemId}.log`)

	try {
		log.info('worker', `Building context for solve Item: ${item.title}`)
		const taskContext = await buildSolveItemTaskContext(item, provider)

		const selectedAgent = item.payload.kind === 'solve' ? item.payload.solverAgent : undefined
		const named = await ensureItemWorkspaceName({
			commands,
			item,
			taskContext,
			config,
			repoPath: projectConfig.repoPath,
			agent: selectedAgent ?? config.solver.agent,
			signal,
		})

		const { baseRef, planDirName, branchName, existingWorktreePath } = resolveItemWorkspace(named)
		commands.recordExecutionWorkspaceIdentity(itemId, { planDirName, branchName })
		const solverConfig = { ...config.solver, agent: selectedAgent ?? config.solver.agent }

		const { worktreePath, outcome } = await solver.solve({
			projectConfig: { ...projectConfig, baseBranch: baseRef },
			branchName,
			planDirName,
			taskContext,
			taskId: item.id,
			taskTitle: item.title,
			solverConfig,
			signal,
			outputLogPath,
			existingWorktreePath,
			onWorktreeReady: worktreePath => {
				commands.recordExecutionWorkspaceIdentity(itemId, { worktreePath, branchName, planDirName })
			},
			onPromptSnapshot: prompt => {
				commands.recordSolveInputSnapshot(itemId, prompt)
			},
		})

		commands.recordExecutionWorkspaceIdentity(itemId, { worktreePath, branchName, planDirName })

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
			branchName,
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
			commands.failItem(itemId, error.message, phase)
			log.error('worker', `Solve Item failed: ${item.title}`, err)
		}
	}
}

export async function processLoopItem(
	itemId: string,
	config: VigilConfig,
	db: DB,
	loopRunner: LoopRunner = new AlmanacLoopRunner(),
	signal?: AbortSignal,
): Promise<void> {
	const commands = new ItemCommands(db.items, config)
	const item = commands.getItem(itemId)
	if (!item) throw new Error(`Item ${itemId} not found in DB`)
	if ((item.kind !== 'ralph' && item.kind !== 'harden') || item.payload.kind !== item.kind) {
		throw new Error(`Item ${itemId} is ${item.kind}, not a loop Item`)
	}

	const projectConfig = config.projects.find(p => p.slug === item.projectSlug)
	if (!projectConfig) throw new Error(`No project config for slug: ${item.projectSlug}`)

	commands.startItem(itemId)
	mkdirSync(LOGS_DIR, { recursive: true })
	const outputLogPath = resolve(LOGS_DIR, `${itemId}.log`)

	try {
		// Loop (ralph/harden) Items keep the deterministic vigil/item name: their
		// title is a PRD path / harden target, not a single conventional change, so
		// AI naming is scoped to solve Items only.
		const { baseRef, planDirName, branchName, existingWorktreePath } = resolveItemWorkspace(item)
		commands.recordExecutionWorkspaceIdentity(itemId, { planDirName, branchName })
		const worktreePath = ensureItemWorktree(projectConfig, baseRef, branchName, existingWorktreePath)
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

export async function processRalphItem(
	itemId: string,
	config: VigilConfig,
	db: DB,
	loopRunner: LoopRunner = new AlmanacLoopRunner(),
	signal?: AbortSignal,
): Promise<void> {
	return processLoopItem(itemId, config, db, loopRunner, signal)
}
