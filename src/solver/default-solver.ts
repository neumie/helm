import { existsSync } from 'node:fs'
import { PlanWorkspace } from '../plan/workspace.js'
import { isCancellation, phaseError, taskCancelled } from '../util/errors.js'
import { log } from '../util/logger.js'
import { createWorktree, excludeVigilFiles } from '../worktree/manager.js'
import { createAgentAdapter } from './agent-adapter.js'
import type { InvokeResult } from './invoker.js'
import { invokeAgent } from './invoker.js'
import { buildPrompt } from './prompt-builder.js'
import type { SolveParams, SolveResult, Solver } from './solver.js'

export class DefaultSolver implements Solver {
	/** Create the worktree, or reuse an existing one on disk. */
	private async ensureWorktree(
		projectConfig: SolveParams['projectConfig'],
		branchName: string,
		existingWorktreePath: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<string> {
		if (signal?.aborted) {
			throw taskCancelled()
		}
		if (existingWorktreePath && existsSync(existingWorktreePath)) {
			log.info('solver', `Reusing existing worktree: ${existingWorktreePath}`)
			await excludeVigilFiles(existingWorktreePath)
			return existingWorktreePath
		}
		log.info('solver', `Creating worktree for branch: ${branchName}`)
		let worktreePath: string
		try {
			worktreePath = await createWorktree(
				projectConfig.repoPath,
				projectConfig.baseBranch,
				branchName,
				projectConfig.worktreeDir,
			)
		} catch (err) {
			throw phaseError('worktree', `Worktree creation failed: ${err instanceof Error ? err.message : err}`)
		}
		await excludeVigilFiles(worktreePath)
		return worktreePath
	}

	async solve(params: SolveParams): Promise<SolveResult> {
		const {
			projectConfig,
			branchName,
			planDirName,
			taskContext,
			solverConfig,
			signal,
			outputLogPath,
			existingWorktreePath,
		} = params

		if (signal?.aborted) {
			throw taskCancelled()
		}

		const worktreePath = await this.ensureWorktree(projectConfig, branchName, existingWorktreePath, signal)
		params.onWorktreeReady?.(worktreePath)

		if (signal?.aborted) {
			throw taskCancelled()
		}

		// Build the solver prompt now — task-context builder reads worktree-resident plan artifacts.
		const solverPrompt = buildPrompt(taskContext, { planDirName, worktreePath })
		params.onPromptSnapshot?.(solverPrompt)

		// Drop any prior run's solver-result.json from a reused worktree so a crashed
		// agent isn't reported as success on the stale result (phase 4 reads it back).
		new PlanWorkspace(worktreePath, planDirName).clearResult()

		// Invoke configured agent (full access).
		const agentAdapter = createAgentAdapter(solverConfig)
		log.info('solver', `Invoking ${agentAdapter.label} in ${worktreePath}`)
		let invokeResult: InvokeResult
		try {
			invokeResult = await invokeAgent(worktreePath, solverPrompt, solverConfig, signal, outputLogPath)
		} catch (err) {
			if (isCancellation(err)) throw err
			throw phaseError('solve', `${agentAdapter.label} invocation failed: ${err instanceof Error ? err.message : err}`)
		}

		return {
			worktreePath,
			branchName,
			outcome: {
				events: agentAdapter.parseTimeline(invokeResult.stdout),
				exitCode: invokeResult.exitCode,
				rawOutput: invokeResult.stdout,
			},
		}
	}
}
