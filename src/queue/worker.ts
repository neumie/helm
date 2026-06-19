import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { dispatch } from '../actions/dispatcher.js'
import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { resolveTaskWorkspace } from '../plan/identity.js'
import { PlanWorkspace } from '../plan/workspace.js'
import type { TaskProvider } from '../providers/provider.js'
import { buildPrompt } from '../solver/prompt-builder.js'
import type { Solver } from '../solver/solver.js'
import { errorPhase, isCancellation, phaseError } from '../util/errors.js'
import { log } from '../util/logger.js'

const LOGS_DIR = resolve(process.cwd(), 'logs')

export async function processTask(
	taskId: string,
	config: VigilConfig,
	db: DB,
	provider: TaskProvider,
	solver: Solver,
	signal?: AbortSignal,
): Promise<void> {
	const task = db.getTask(taskId)
	if (!task) throw new Error(`Task ${taskId} not found in DB`)

	const projectConfig = config.projects.find(p => p.slug === task.projectSlug)
	if (!projectConfig) throw new Error(`No project config for slug: ${task.projectSlug}`)

	db.updateTask(taskId, { status: 'processing', startedAt: new Date().toISOString() })
	const solverConfig = { ...config.solver, agent: task.solverAgent ?? config.solver.agent }
	db.insertEvent(taskId, 'solver_started', { agent: solverConfig.agent })

	// Prepare output log path
	mkdirSync(LOGS_DIR, { recursive: true })
	const outputLogPath = resolve(LOGS_DIR, `${taskId}.log`)

	try {
		// Phase 1: Fetch full context via provider
		log.info('worker', `Fetching context for task: ${task.title}`)
		const taskContext = await provider.getTaskContext(task.clientcareId)

		if (!taskContext) {
			throw phaseError('poll', 'Task not found in source system')
		}

		// Resolve the task's workspace identity (plan dir, branch, existing
		// worktree). planDirName is computed from the title the first time and
		// persisted so it stays stable across upstream renames / title edits.
		const { planDirName, branchName, existingWorktreePath } = resolveTaskWorkspace(task)
		if (!task.planDirName) {
			db.updateTask(taskId, { planDirName })
		}

		// Phase 2+3: Create worktree + invoke configured agent (delegated to solver).
		// The solver assembles its own prompt from the raw task context (it
		// builds it AFTER worktree creation so the task-context builder can read
		// worktree-resident docs/plans/<planDirName>/*.md). Reuse a worktree if
		// one was created earlier by the plan endpoint.
		const { worktreePath, outcome } = await solver.solve({
			projectConfig,
			branchName,
			planDirName,
			taskContext,
			taskId,
			taskTitle: task.title,
			solverConfig,
			signal,
			outputLogPath,
			existingWorktreePath,
		})
		// Snapshot the rendered prompt for the dashboard's "task context" view.
		db.updateTask(taskId, { taskContext: buildPrompt(taskContext, { planDirName, worktreePath }) })
		db.updateTask(taskId, { worktreePath, branchName })
		db.updateTask(taskId, {
			claudeExitCode: outcome.exitCode,
			claudeRawOutput: outcome.rawOutput ?? null,
		})

		// Persist the solver-produced event timeline for the dashboard.
		for (const event of outcome.events) {
			db.insertEvent(taskId, `claude_${event.type}`, { detail: event.detail, file: event.file })
		}

		// Phase 4: Parse result. The agent writes solver-result.json — that file is
		// the only source of the result. No stdout fallback: a missing file is a hard
		// failure (the okena solver produces no stdout anyway).
		const workspace = new PlanWorkspace(worktreePath, planDirName)
		const solverResult = workspace.readResult()
		if (!solverResult) {
			throw phaseError('solve', `No solver-result.json at ${workspace.rel.result}`)
		}

		db.updateTask(taskId, {
			solverSummary: solverResult.summary,
			filesChanged: JSON.stringify(solverResult.filesChanged),
			solverRawResult: JSON.stringify(solverResult),
		})
		db.insertEvent(taskId, 'solver_completed', { summary: solverResult.summary })

		// Phase 5: Dispatch — record the pre-shipped PR or push branch + open one.
		log.info('worker', 'Solve complete — dispatching')
		try {
			await dispatch(taskId, solverResult, config, db, provider, projectConfig)
		} catch (err) {
			log.warn('worker', `Action dispatch failed: ${err instanceof Error ? err.message : err}`)
			db.insertEvent(taskId, 'dispatch_failed', { error: (err as Error).message })
		}

		db.updateTask(taskId, { status: 'review', completedAt: new Date().toISOString() })
		db.insertEvent(taskId, 'action_completed')
		log.success('worker', `Task ready for review: ${task.title}`)
	} catch (err) {
		const error = err as Error
		const isCancelled = isCancellation(error, signal)
		const phase = errorPhase(error)
		db.updateTask(taskId, {
			status: isCancelled ? 'cancelled' : 'failed',
			errorMessage: isCancelled ? 'Task cancelled by user' : error.message,
			errorPhase: phase,
			completedAt: new Date().toISOString(),
		})
		db.insertEvent(taskId, isCancelled ? 'task_cancelled' : 'solver_failed', {
			error: error.message,
			phase,
		})
		if (isCancelled) {
			log.warn('worker', `Task cancelled: ${task.title}`)
		} else {
			log.error('worker', `Task failed: ${task.title}`, err)
		}
	}
}
