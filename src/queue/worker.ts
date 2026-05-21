import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { dispatch } from '../actions/dispatcher.js'
import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { TaskProvider } from '../providers/provider.js'
import type { ErrorPhase } from '../types.js'
import { parseClaudeOutput } from '../solver/output-parser.js'
import { buildPrompt } from '../solver/prompt-builder.js'
import { parseResultFile, parseTierFromOutput } from '../solver/result-parser.js'
import type { Solver } from '../solver/solver.js'
import { log } from '../util/logger.js'
import { computePlanDirName, slugify } from '../util/slug.js'

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
	db.insertEvent(taskId, 'solver_started')

	// Prepare output log path
	mkdirSync(LOGS_DIR, { recursive: true })
	const outputLogPath = resolve(LOGS_DIR, `${taskId}.log`)

	try {
		// Phase 1: Fetch full context via provider
		log.info('worker', `Fetching context for task: ${task.title}`)
		const taskContext = await provider.getTaskContext(task.clientcareId)

		if (!taskContext) {
			throw Object.assign(new Error('Task not found in source system'), { phase: 'poll' })
		}

		// Ensure the task has a plan-dir name — computed once from the task
		// title the first time we need it (plan endpoint or autonomous run),
		// then persisted on the task row so subsequent reads stay stable
		// across renames / title edits upstream.
		const planDirName = task.planDirName ?? computePlanDirName(task.title)
		if (!task.planDirName) {
			db.updateTask(taskId, { planDirName })
		}

		// Phase 2+3: Create worktree + invoke Claude (delegated to solver).
		// The solver assembles its own prompt from the raw task context (it
		// builds it AFTER worktree creation so the task-context builder can read
		// worktree-resident docs/plans/<planDirName>/*.md). Reuse a worktree if
		// one was created earlier by the plan endpoint.
		const branchName = task.branchName ?? `vigil/${slugify(task.title)}`
		const existingWorktreePath = task.worktreePath ?? undefined
		const { worktreePath, invokeResult } = await solver.solve({
			projectConfig,
			branchName,
			planDirName,
			taskContext,
			taskId,
			taskTitle: task.title,
			solverConfig: config.solver,
			signal,
			outputLogPath,
			existingWorktreePath,
		})
		// Snapshot the rendered prompt for the dashboard's "task context" view.
		db.updateTask(taskId, { taskContext: buildPrompt(taskContext, { planDirName, worktreePath }) })
		db.updateTask(taskId, { worktreePath, branchName })
		db.updateTask(taskId, {
			claudeExitCode: invokeResult.exitCode,
			claudeRawOutput: invokeResult.stdout,
		})

		// Parse Claude's output into events for the dashboard
		const events = parseClaudeOutput(invokeResult.stdout)
		for (const event of events) {
			db.insertEvent(taskId, `claude_${event.type}`, { detail: event.detail, file: event.file })
		}

		// Phase 4: Parse result
		let solverResult = parseResultFile(worktreePath, planDirName)
		if (!solverResult) {
			log.warn('worker', 'No solver-result.json found, trying to parse from output')
			solverResult = parseTierFromOutput(invokeResult.stdout)
		}
		if (!solverResult) {
			throw Object.assign(
				new Error('Could not determine solver result — no solver-result.json and no tier in output'),
				{ phase: 'solve' },
			)
		}

		db.updateTask(taskId, {
			tier: solverResult.tier,
			solverSummary: solverResult.summary,
			solverConfidence: solverResult.confidence,
			filesChanged: JSON.stringify(solverResult.filesChanged),
			solverRawResult: JSON.stringify(solverResult),
		})
		db.insertEvent(taskId, 'solver_completed', {
			tier: solverResult.tier,
			confidence: solverResult.confidence,
		})

		// Phase 5: Dispatch tier-appropriate action
		log.info('worker', `Task assessed as ${solverResult.tier} (confidence: ${solverResult.confidence})`)
		try {
			await dispatch(taskId, solverResult, config, db, provider, projectConfig)
		} catch (err) {
			log.warn('worker', `Action dispatch failed: ${err instanceof Error ? err.message : err}`)
			db.insertEvent(taskId, 'dispatch_failed', { error: (err as Error).message })
		}

		db.updateTask(taskId, { status: 'review', completedAt: new Date().toISOString() })
		db.insertEvent(taskId, 'action_completed')
		log.success('worker', `Task ready for review: ${task.title} [${solverResult.tier}]`)
	} catch (err) {
		const error = err as Error & { phase?: ErrorPhase }
		const isCancelled = error.name === 'AbortError' || signal?.aborted
		db.updateTask(taskId, {
			status: isCancelled ? 'cancelled' : 'failed',
			errorMessage: isCancelled ? 'Task cancelled by user' : error.message,
			errorPhase: error.phase ?? 'solve',
			completedAt: new Date().toISOString(),
		})
		db.insertEvent(taskId, isCancelled ? 'task_cancelled' : 'solver_failed', {
			error: error.message,
			phase: error.phase,
		})
		if (isCancelled) {
			log.warn('worker', `Task cancelled: ${task.title}`)
		} else {
			log.error('worker', `Task failed: ${task.title}`, err)
		}
	}
}
