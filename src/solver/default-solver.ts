import { existsSync } from 'node:fs'
import type { VigilConfig } from '../config.js'
import { PlanWorkspace } from '../plan/workspace.js'
import { formatTaskContext } from '../task-context.js'
import { isCancellation, phaseError, taskCancelled } from '../util/errors.js'
import { log } from '../util/logger.js'
import { createWorktree, excludeVigilFiles } from '../worktree/manager.js'
import { invokeChatSession } from './chat-invoker.js'
import type { InvokeResult } from './invoker.js'
import { invokeClaude } from './invoker.js'
import { parseClaudeOutput } from './output-parser.js'
import { buildChatPrompt, buildPlanningPrompt, buildPrompt } from './prompt-builder.js'
import type { PlanningSessionParams, PlanningSessionResult, SolveParams, SolveResult, Solver } from './solver.js'

export class DefaultSolver implements Solver {
	private config: VigilConfig

	constructor(config: VigilConfig) {
		this.config = config
	}

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
		// return a hint for the user to run claude themselves.
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
			hint: `Open a terminal in ${worktreePath} and run:\n  claude --dangerously-skip-permissions "$(cat ${workspace.rel.planningPrompt})"`,
		}
	}

	async solve(params: SolveParams): Promise<SolveResult> {
		const {
			projectConfig,
			branchName,
			planDirName,
			taskContext,
			taskId,
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

		// Clarification chat is a DefaultSolver-only concern (sandboxed, read-only).
		// Built and run entirely here — not part of the shared Solver protocol.
		let chatTranscript: string | null = null
		if (this.config.chat?.enabled) {
			log.info('solver', 'Starting sandboxed chat session for task clarification')
			try {
				const chatPrompt = buildChatPrompt(taskContext, taskId, { planDirName, worktreePath })
				const chatResult = await invokeChatSession(worktreePath, chatPrompt, this.config, signal)
				if (chatResult.chatNeeded && chatResult.transcript) {
					chatTranscript = chatResult.transcript
					log.success('solver', 'Chat session completed — transcript obtained')
				} else {
					log.info('solver', 'Chat session determined task is clear — proceeding to solve')
				}
			} catch (err) {
				if (isCancellation(err)) throw err
				log.warn('solver', `Chat session failed: ${err instanceof Error ? err.message : err}`)
				// Continue to solve without chat transcript
			}
		}

		if (signal?.aborted) {
			throw taskCancelled()
		}

		// Build the solver prompt now — task-context builder reads worktree-resident plan artifacts.
		const basePrompt = buildPrompt(taskContext, { planDirName, worktreePath })
		const solverPrompt = chatTranscript
			? `${basePrompt}\n\n## Clarification from Requester\n\nThe following is a conversation with the task requester that clarified the requirements:\n\n${chatTranscript}`
			: basePrompt

		// Invoke Claude Code (full access)
		log.info('solver', `Invoking Claude Code in ${worktreePath}`)
		let invokeResult: InvokeResult
		try {
			invokeResult = await invokeClaude(worktreePath, solverPrompt, solverConfig, signal, outputLogPath)
		} catch (err) {
			if (isCancellation(err)) throw err
			throw phaseError('solve', `Claude invocation failed: ${err instanceof Error ? err.message : err}`)
		}

		return {
			worktreePath,
			branchName,
			outcome: {
				events: parseClaudeOutput(invokeResult.stdout),
				exitCode: invokeResult.exitCode,
				rawOutput: invokeResult.stdout,
			},
		}
	}
}
