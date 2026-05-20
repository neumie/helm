import type { VigilConfig } from '../config.js'
import { installSkillsIntoWorktree } from '../skills/installer.js'
import { log } from '../util/logger.js'
import { createWorktree, excludeVigilFiles } from '../worktree/manager.js'
import { invokeChatSession } from './chat-invoker.js'
import type { InvokeResult } from './invoker.js'
import { invokeClaude } from './invoker.js'
import type { SolveParams, SolveResult, Solver } from './solver.js'

export class DefaultSolver implements Solver {
	private config: VigilConfig

	constructor(config: VigilConfig) {
		this.config = config
	}

	async solve(params: SolveParams): Promise<SolveResult> {
		const { projectConfig, branchName, prompt, solverConfig, signal, outputLogPath } = params

		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
		}

		// Create git worktree
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

		// Install bundled skills (vigil-*) into the worktree so the spawned
		// Claude agent can load them via /vigil-task-start, /vigil-ship, etc.
		// Fatal on failure: the solver prompt references vigil-* skills, so a
		// missing bundle would silently degrade to runtime errors inside the agent.
		try {
			installSkillsIntoWorktree(worktreePath, 'claude')
		} catch (err) {
			throw Object.assign(new Error(`Skill install failed: ${err instanceof Error ? err.message : err}`), {
				phase: 'worktree',
			})
		}

		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
		}

		// Chat session (sandboxed, read-only) — if chat is enabled and a chat prompt is provided
		let chatTranscript: string | null = null
		if (this.config.chat?.enabled && params.chatPrompt) {
			log.info('solver', 'Starting sandboxed chat session for task clarification')
			try {
				const chatResult = await invokeChatSession(worktreePath, params.chatPrompt, this.config, signal)
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

		// Append chat transcript to the solver prompt if available
		const solverPrompt = chatTranscript
			? `${prompt}\n\n## Clarification from Requester\n\nThe following is a conversation with the task requester that clarified the requirements:\n\n${chatTranscript}`
			: prompt

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
