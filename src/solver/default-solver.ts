import { existsSync } from 'node:fs'
import { PlanWorkspace } from '../plan/workspace.js'
import { formatTaskContext } from '../task-context.js'
import { isCancellation, phaseError, taskCancelled } from '../util/errors.js'
import { log } from '../util/logger.js'
import { createWorktree, excludeVigilFiles } from '../worktree/manager.js'
import { agentLabelFromConfig, buildInteractiveAgentCommand } from './agent-command.js'
import type { InvokeResult } from './invoker.js'
import { invokeAgent } from './invoker.js'
import { parseClaudeOutput } from './output-parser.js'
import { buildPlanningPrompt, buildPrompt } from './prompt-builder.js'
import type { PlanningSessionParams, PlanningSessionResult, SolveParams, SolveResult, Solver } from './solver.js'

export class DefaultSolver implements Solver {
	/** Create the worktree, or reuse an existing one on disk. */
	private ensureWorktree(
		projectConfig: SolveParams['projectConfig'],
		branchName: string,
		existingWorktreePath: string | undefined,
		signal: AbortSignal | undefined,
	): string {
		if (signal?.aborted) {
			throw taskCancelled()
		}
		if (existingWorktreePath && existsSync(existingWorktreePath)) {
			log.info('solver', `Reusing existing worktree: ${existingWorktreePath}`)
			excludeVigilFiles(existingWorktreePath)
			return existingWorktreePath
		}
		log.info('solver', `Creating worktree for branch: ${branchName}`)
		let worktreePath: string
		try {
			worktreePath = createWorktree(
				projectConfig.repoPath,
				projectConfig.baseBranch,
				branchName,
				projectConfig.worktreeDir,
			)
		} catch (err) {
			throw phaseError('worktree', `Worktree creation failed: ${err instanceof Error ? err.message : err}`)
		}
		excludeVigilFiles(worktreePath)
		return worktreePath
	}

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		// DefaultSolver has no terminal of its own to spawn into. Ensure the
		// worktree, write the task context + planning prompt into the plan dir,
		// return a hint for the user to run the configured agent themselves.
		const worktreePath = this.ensureWorktree(
			params.projectConfig,
			params.branchName,
			params.existingWorktreePath,
			params.signal,
		)

		const workspace = new PlanWorkspace(worktreePath, params.planDirName)
		workspace.writeContext(formatTaskContext(params.taskContext))
		workspace.writePlanningPrompt(buildPlanningPrompt(params.planDirName))

		return {
			worktreePath,
			branchName: params.branchName,
			hint: `Run in any terminal:\n  ${buildInteractiveAgentCommand(params.solverConfig, workspace.rel.planningPrompt, worktreePath)}`,
		}
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

		const worktreePath = this.ensureWorktree(projectConfig, branchName, existingWorktreePath, signal)

		if (signal?.aborted) {
			throw taskCancelled()
		}

		// Build the solver prompt now — task-context builder reads worktree-resident plan artifacts.
		const solverPrompt = buildPrompt(taskContext, { planDirName, worktreePath })

		// Drop any prior run's solver-result.json from a reused worktree so a crashed
		// agent isn't reported as success on the stale result (phase 4 reads it back).
		new PlanWorkspace(worktreePath, planDirName).clearResult()

		// Invoke configured agent (full access).
		log.info('solver', `Invoking ${agentLabelFromConfig(solverConfig)} in ${worktreePath}`)
		let invokeResult: InvokeResult
		try {
			invokeResult = await invokeAgent(worktreePath, solverPrompt, solverConfig, signal, outputLogPath)
		} catch (err) {
			if (isCancellation(err)) throw err
			throw phaseError(
				'solve',
				`${agentLabelFromConfig(solverConfig)} invocation failed: ${err instanceof Error ? err.message : err}`,
			)
		}

		return {
			worktreePath,
			branchName,
			outcome: {
				events: invokeResult.agent === 'claude' ? parseClaudeOutput(invokeResult.stdout) : [],
				exitCode: invokeResult.exitCode,
				rawOutput: invokeResult.stdout,
			},
		}
	}
}
