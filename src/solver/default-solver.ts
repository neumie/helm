import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VigilConfig } from '../config.js'
import { log } from '../util/logger.js'
import { createWorktree, excludeVigilFiles } from '../worktree/manager.js'
import { invokeChatSession } from './chat-invoker.js'
import type { InvokeResult } from './invoker.js'
import { invokeClaude } from './invoker.js'
import type {
	PlanningSessionParams,
	PlanningSessionResult,
	PrepareWorktreeParams,
	PrepareWorktreeResult,
	SolveParams,
	SolveResult,
	Solver,
} from './solver.js'

export class DefaultSolver implements Solver {
	private config: VigilConfig

	constructor(config: VigilConfig) {
		this.config = config
	}

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		// DefaultSolver has no terminal of its own to spawn into. Ensure the
		// worktree exists, write the task context to docs/plans/<id>/context.md
		// so the planning agent can read it from disk, return a hint for the
		// user to run claude themselves.
		let worktreePath: string
		if (params.existingWorktreePath && existsSync(params.existingWorktreePath)) {
			worktreePath = params.existingWorktreePath
		} else {
			const prep = await this.prepareWorktree({
				projectConfig: params.projectConfig,
				branchName: params.branchName,
				taskTitle: params.taskTitle,
				signal: params.signal,
			})
			worktreePath = prep.worktreePath
		}

		const planDir = join(worktreePath, 'docs', 'plans', params.planDirName)
		mkdirSync(planDir, { recursive: true })
		writeFileSync(join(planDir, 'context.md'), params.contextMarkdown, 'utf-8')
		const promptRelPath = `docs/plans/${params.planDirName}/.planning-prompt.txt`
		writeFileSync(join(worktreePath, promptRelPath), params.prompt, 'utf-8')

		return {
			worktreePath,
			branchName: params.branchName,
			hint: `Open a terminal in ${worktreePath} and run:\n  claude --dangerously-skip-permissions "$(cat ${promptRelPath})"`,
		}
	}

	async prepareWorktree(params: PrepareWorktreeParams): Promise<PrepareWorktreeResult> {
		const { projectConfig, branchName, signal } = params
		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
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
			throw Object.assign(new Error(`Worktree creation failed: ${err instanceof Error ? err.message : err}`), {
				phase: 'worktree',
			})
		}
		excludeVigilFiles(worktreePath)
		return { worktreePath, branchName }
	}

	async solve(params: SolveParams): Promise<SolveResult> {
		const { projectConfig, branchName, buildPrompt, buildChatPrompt, solverConfig, signal, outputLogPath, existingWorktreePath } = params

		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
		}

		let worktreePath: string
		if (existingWorktreePath && existsSync(existingWorktreePath)) {
			log.info('solver', `Reusing existing worktree: ${existingWorktreePath}`)
			worktreePath = existingWorktreePath
			excludeVigilFiles(worktreePath)
		} else {
			const prep = await this.prepareWorktree({
				projectConfig,
				branchName,
				taskTitle: params.taskTitle,
				signal,
			})
			worktreePath = prep.worktreePath
		}

		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
		}

		// Chat session (sandboxed, read-only) — if chat is enabled and a chat prompt builder is provided
		let chatTranscript: string | null = null
		if (this.config.chat?.enabled && buildChatPrompt) {
			log.info('solver', 'Starting sandboxed chat session for task clarification')
			try {
				const chatPrompt = buildChatPrompt(worktreePath)
				const chatResult = await invokeChatSession(worktreePath, chatPrompt, this.config, signal)
				if (chatResult.chatNeeded && chatResult.transcript) {
					chatTranscript = chatResult.transcript
					log.success('solver', 'Chat session completed — transcript obtained')
				} else {
					log.info('solver', 'Chat session determined task is clear — proceeding to solve')
				}
			} catch (err) {
				if ((err as Error).name === 'AbortError') throw err
				log.warn('solver', `Chat session failed: ${err instanceof Error ? err.message : err}`)
				// Continue to solve without chat transcript
			}
		}

		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
		}

		// Build the solver prompt now — transformer reads worktree-resident plan artifacts.
		// Append chat transcript if the optional clarification session produced one.
		const basePrompt = buildPrompt(worktreePath)
		const solverPrompt = chatTranscript
			? `${basePrompt}\n\n## Clarification from Requester\n\nThe following is a conversation with the task requester that clarified the requirements:\n\n${chatTranscript}`
			: basePrompt

		// Invoke Claude Code (full access)
		log.info('solver', `Invoking Claude Code in ${worktreePath}`)
		let invokeResult: InvokeResult
		try {
			invokeResult = await invokeClaude(worktreePath, solverPrompt, solverConfig, signal, outputLogPath)
		} catch (err) {
			if ((err as Error).name === 'AbortError') throw err
			throw Object.assign(new Error(`Claude invocation failed: ${err instanceof Error ? err.message : err}`), {
				phase: 'solve',
			})
		}

		return { worktreePath, branchName, invokeResult }
	}
}
