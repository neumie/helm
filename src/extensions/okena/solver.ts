import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VigilConfig } from '../../config.js'
import { PlanWorkspace } from '../../plan/workspace.js'
import { agentLabelFromConfig, buildInteractiveAgentCommand } from '../../solver/agent-command.js'
import { buildPrompt } from '../../solver/prompt-builder.js'
import type { SolveParams, SolveResult, Solver } from '../../solver/solver.js'
import { phaseError, taskCancelled } from '../../util/errors.js'
import { log } from '../../util/logger.js'
import { OkenaClient } from './client.js'
import { OkenaWorktreeManager } from './worktree.js'

/** Absolute ceiling on a single okena solve, however lively the terminal looks. */
const HARD_TIMEOUT_MS = 6 * 60 * 60 * 1000
/** Screen-sample cadence in units of the 2s poll tick (5 → every ~10s). */
const SCREEN_SAMPLE_EVERY = 5

export class OkenaSolver implements Solver {
	private client: OkenaClient
	private worktrees: OkenaWorktreeManager

	constructor(client: OkenaClient) {
		this.client = client
		this.worktrees = new OkenaWorktreeManager(client)
	}

	async solve(params: SolveParams): Promise<SolveResult> {
		const {
			projectConfig,
			branchName,
			planDirName,
			taskContext,
			taskTitle,
			solverConfig,
			signal,
			existingWorktreePath,
		} = params

		if (signal?.aborted) {
			throw taskCancelled()
		}

		const ensured = await this.worktrees.ensureWorktreeProject(
			projectConfig.repoPath,
			projectConfig.baseBranch,
			branchName,
			existingWorktreePath,
		)
		// Solve always runs in its own fresh terminal — never the user's planning
		// terminal. Use the auto-created terminal only for a brand-new worktree.
		const terminalId = ensured.autoTerminalId ?? (await this.worktrees.createTerminal(ensured.wtProjectId))
		if (!terminalId) {
			throw phaseError('worktree', 'Failed to create terminal for solve')
		}
		const worktreePath = ensured.worktreePath
		params.onWorktreeReady?.(worktreePath)

		try {
			await this.client.action({
				action: 'rename_terminal',
				project_id: ensured.wtProjectId,
				terminal_id: terminalId,
				name: taskTitle,
			})
		} catch {
			// Non-critical
		}

		// Build the prompt now so the task-context builder sees any
		// docs/plans/<planDirName>/ artifacts present in the worktree.
		const workspace = new PlanWorkspace(worktreePath, planDirName)
		// A reused worktree may still hold a prior run's solver-result.json. Clear it
		// before launching, or the poll loop below exits instantly on the stale file
		// and unlinks .vigil-prompt.txt out from under the just-launched agent.
		workspace.clearResult()
		const promptFile = join(worktreePath, '.vigil-prompt.txt')
		const solverPrompt = buildPrompt(taskContext, { planDirName, worktreePath }, solverConfig)
		params.onPromptSnapshot?.(solverPrompt)
		writeFileSync(promptFile, solverPrompt, 'utf-8')

		const command = buildInteractiveAgentCommand(solverConfig, '.vigil-prompt.txt', worktreePath)
		const agentLabel = agentLabelFromConfig(solverConfig)
		log.info('okena', `Running ${agentLabel} in terminal ${terminalId}`)
		try {
			// Solve always uses a fresh/auto terminal — let it settle and clear the
			// prompt line so leftover input can't merge into the command.
			await this.client.runCommand(terminalId, command, { freshTerminal: true })
		} catch (err) {
			throw phaseError('solve', `Failed to run command in Okena terminal: ${err instanceof Error ? err.message : err}`)
		}

		// Poll for solver-result.json — the agent writes this when done solving.
		//
		// The timeout is IDLE-based, not wall-clock: real runs regularly exceed any
		// fixed budget (a 30m wall-clock cap once "timed out" an agent that shipped
		// a PR 80 minutes later), and vigil can't kill the agent anyway — it runs in
		// okena's terminal. `timeoutMinutes` means "no terminal activity for this
		// long": the screen is sampled via okena's `read_content` and any repaint
		// (Claude Code's spinner/output) counts as life. A dead agent leaves a
		// static prompt and still trips it. A generous hard cap bounds pathological
		// screens that never settle.
		const idleTimeoutMs = solverConfig.timeoutMinutes * 60 * 1000
		const startTime = Date.now()
		let lastActivity = startTime
		let lastScreen: string | null = null
		let poll = 0

		log.info('okena', `Waiting for solver-result.json (idle timeout: ${solverConfig.timeoutMinutes}m)`)
		while (!workspace.resultExists()) {
			if (signal?.aborted) {
				try {
					await this.client.action({ action: 'send_special_key', terminal_id: terminalId, key: 'ctrl_c' })
				} catch {
					/* best effort */
				}
				throw taskCancelled()
			}
			const now = Date.now()
			if (now - startTime > HARD_TIMEOUT_MS) {
				throw phaseError(
					'solve',
					`${agentLabel} exceeded the ${HARD_TIMEOUT_MS / 3_600_000}h hard cap in Okena terminal`,
				)
			}
			if (now - lastActivity > idleTimeoutMs) {
				throw phaseError(
					'solve',
					`${agentLabel} idle in Okena terminal for ${solverConfig.timeoutMinutes}m (no screen activity) — assuming it stalled`,
				)
			}
			// Sample the screen every ~10s; a failed read (terminal closed) earns no
			// activity credit, so a vanished terminal still idles out.
			if (poll % SCREEN_SAMPLE_EVERY === 0) {
				try {
					const res = await this.client.action<{ content?: string }>({
						action: 'read_content',
						terminal_id: terminalId,
					})
					const screen = res?.content ?? ''
					if (screen !== lastScreen) {
						lastScreen = screen
						lastActivity = Date.now()
					}
				} catch {
					/* no activity credit */
				}
			}
			poll++
			await sleep(2000)
		}

		await sleep(500)
		log.success('okena', `${agentLabel} finished — solver-result.json detected`)

		try {
			if (existsSync(promptFile)) unlinkSync(promptFile)
		} catch {
			// Non-critical
		}

		// Okena runs the agent in its own terminal — no stdout is captured here, so
		// there is no event timeline or raw output to report.
		return {
			worktreePath,
			branchName,
			outcome: { events: [], exitCode: 0 },
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

export async function createOkenaSolver(_config: VigilConfig): Promise<Solver> {
	const client = new OkenaClient()
	// Warn but DON'T fall back: the operator configured okena, so okena stays the
	// active solver. If it's unreachable now, tasks/plan sessions fail with the
	// real okena error (visible in logs + dashboard) and recover on their own once
	// okena is back — the client reloads its token per call, so no restart needed.
	if (!(await client.isAvailable())) {
		log.warn(
			'okena',
			'Okena not reachable at startup — okena tasks/plan sessions will fail until it is. No fallback (solver.type=okena). Run `okena state` to check/refresh the CLI token.',
		)
	}
	return new OkenaSolver(client)
}
