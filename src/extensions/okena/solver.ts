import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VigilConfig } from '../../config.js'
import { buildPlanningPrompt, buildPrompt } from '../../solver/prompt-builder.js'
import type {
	PlanningSessionParams,
	PlanningSessionResult,
	SolveParams,
	SolveResult,
	Solver,
} from '../../solver/solver.js'
import { formatTaskContext } from '../../task-context.js'
import { log } from '../../util/logger.js'
import { excludeVigilFiles } from '../../worktree/manager.js'
import { OkenaClient } from './client.js'

interface CreateWorktreeResponse {
	project_id: string
	terminal_id: string | null
	path: string
}

interface EnsuredWorktree {
	worktreePath: string
	wtProjectId: string
	/** A terminal created as a side effect of worktree creation, if any. */
	autoTerminalId: string | null
}

export class OkenaSolver implements Solver {
	private client: OkenaClient
	private config: VigilConfig

	constructor(client: OkenaClient, config: VigilConfig) {
		this.client = client
		this.config = config
	}

	private async findOkenaProject(repoPath: string) {
		const state = await this.client.getState()
		const okenaProject = state.projects.find(p => p.path === repoPath)
		if (!okenaProject) {
			throw Object.assign(new Error(`Project not found in Okena for path: ${repoPath}`), { phase: 'worktree' })
		}
		return { state, okenaProject }
	}

	private async createTerminal(projectId: string): Promise<string | null> {
		try {
			const result = await this.client.action<{ terminal_ids?: string[] }>({
				action: 'create_terminal',
				project_id: projectId,
			})
			return result.terminal_ids?.[0] ?? null
		} catch {
			return null
		}
	}

	private async ensureBaseBranchReady(repoPath: string, baseBranch: string): Promise<void> {
		try {
			log.info('okena', `Fetching origin/${baseBranch}...`)
			execSync(`git fetch origin "${baseBranch}"`, { cwd: repoPath, stdio: 'pipe', timeout: 30_000 })
		} catch {
			log.warn('okena', `Could not fetch origin/${baseBranch}`)
		}
		try {
			execSync(`git remote set-head origin "${baseBranch}"`, { cwd: repoPath, stdio: 'pipe', timeout: 10_000 })
		} catch {
			// Non-critical
		}
		try {
			execSync(`git checkout "${baseBranch}"`, { cwd: repoPath, stdio: 'pipe', timeout: 10_000 })
		} catch {
			// Non-critical — may already be on the right branch
		}
	}

	/**
	 * Resolve the Okena worktree PROJECT (create, reuse-by-branch-name, or reuse
	 * by explicit path). Does NOT decide terminal policy — callers create/find
	 * the terminal they need (planning reuses a "plan:" terminal; solve wants a
	 * fresh one). `autoTerminalId` exposes the terminal Okena makes on new-worktree
	 * creation so the caller can reuse it instead of orphaning it.
	 */
	private async ensureWorktreeProject(
		repoPath: string,
		baseBranch: string,
		branchName: string,
		existingWorktreePath: string | undefined,
	): Promise<EnsuredWorktree> {
		if (existingWorktreePath) {
			const { state } = await this.findOkenaProject(repoPath)
			const wtProject = state.projects.find(p => p.path === existingWorktreePath)
			if (!wtProject) {
				throw Object.assign(new Error(`Okena project not found for worktree path: ${existingWorktreePath}`), {
					phase: 'worktree',
				})
			}
			excludeVigilFiles(existingWorktreePath)
			return { worktreePath: existingWorktreePath, wtProjectId: wtProject.id, autoTerminalId: null }
		}

		const { state, okenaProject } = await this.findOkenaProject(repoPath)
		log.info('okena', `Matched Okena project: ${okenaProject.name} (${okenaProject.id})`)
		await this.ensureBaseBranchReady(repoPath, baseBranch)

		const safeBranch = branchName.replace(/\//g, '-')
		const existing = state.projects.find(p => p.name === branchName && p.path.includes(safeBranch))
		if (existing) {
			log.info('okena', `Reusing existing worktree project: ${existing.id}`)
			excludeVigilFiles(existing.path)
			return { worktreePath: existing.path, wtProjectId: existing.id, autoTerminalId: null }
		}

		log.info('okena', `Creating worktree for branch: ${branchName}`)
		let wt: CreateWorktreeResponse
		try {
			wt = await this.client.action<CreateWorktreeResponse>({
				action: 'create_worktree',
				project_id: okenaProject.id,
				branch: branchName,
				create_branch: true,
			})
		} catch (firstErr) {
			log.warn('okena', `create_branch=true failed: ${firstErr instanceof Error ? firstErr.message : firstErr}`)
			try {
				log.info('okena', 'Branch already exists, reusing')
				wt = await this.client.action<CreateWorktreeResponse>({
					action: 'create_worktree',
					project_id: okenaProject.id,
					branch: branchName,
					create_branch: false,
				})
			} catch (err) {
				throw Object.assign(new Error(`Okena worktree creation failed: ${err instanceof Error ? err.message : err}`), {
					phase: 'worktree',
				})
			}
		}

		const worktreePath = wt.path
		const wtProjectId =
			wt.project_id ??
			state.projects.find(p => p.path === worktreePath)?.id ??
			(await this.client.getState()).projects.find(p => p.path === worktreePath)?.id
		if (!wtProjectId) {
			throw Object.assign(new Error('Worktree project ID could not be resolved'), { phase: 'worktree' })
		}

		log.success('okena', `Worktree at ${worktreePath}`)
		excludeVigilFiles(worktreePath)
		return { worktreePath, wtProjectId, autoTerminalId: wt.terminal_id }
	}

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		const { projectConfig, branchName, planDirName, taskTitle, taskContext, solverConfig, existingWorktreePath } = params

		const ensured = await this.ensureWorktreeProject(
			projectConfig.repoPath,
			projectConfig.baseBranch,
			branchName,
			existingWorktreePath,
		)

		// Reuse an existing "plan: " terminal if present (so repeated Plan clicks
		// don't pile up terminals); else use the auto-created one; else spawn fresh.
		const terminalId = (await this.findPlanTerminal(ensured.wtProjectId))
			?? ensured.autoTerminalId
			?? (await this.createTerminal(ensured.wtProjectId))
		if (!terminalId) {
			throw new Error('Failed to obtain a planning terminal')
		}

		try {
			await this.client.action({
				action: 'rename_terminal',
				project_id: ensured.wtProjectId,
				terminal_id: terminalId,
				name: `plan: ${taskTitle}`,
			})
		} catch {
			// Non-critical
		}

		// Write task context to docs/plans/<planDirName>/context.md; the planning
		// prompt instructs the agent to read it first.
		const planDir = join(ensured.worktreePath, 'docs', 'plans', planDirName)
		mkdirSync(planDir, { recursive: true })
		writeFileSync(join(planDir, 'context.md'), formatTaskContext(taskContext), 'utf-8')

		// Stage the prompt as a file ($(cat ...) keeps the run_command on one line —
		// okena types it into the terminal, and embedded newlines would break it).
		const promptRelPath = `docs/plans/${planDirName}/.planning-prompt.txt`
		writeFileSync(join(ensured.worktreePath, promptRelPath), buildPlanningPrompt(planDirName), 'utf-8')

		const command = `${this.claudeArgs(solverConfig).join(' ')} "$(cat ${promptRelPath})"`
		log.info('okena', `Starting planning session in terminal ${terminalId}`)
		try {
			await this.client.action({ action: 'run_command', terminal_id: terminalId, command })
		} catch (err) {
			throw new Error(`Failed to start planning session: ${err instanceof Error ? err.message : err}`)
		}

		return {
			worktreePath: ensured.worktreePath,
			branchName,
			hint: `Switch to Okena → open the project for branch ${branchName}. The planning session is running in the "plan: ${taskTitle}" terminal.`,
		}
	}

	async solve(params: SolveParams): Promise<SolveResult> {
		const { projectConfig, branchName, planDirName, taskContext, taskTitle, solverConfig, signal, existingWorktreePath } = params

		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
		}

		const ensured = await this.ensureWorktreeProject(
			projectConfig.repoPath,
			projectConfig.baseBranch,
			branchName,
			existingWorktreePath,
		)
		// Solve always runs in its own fresh terminal — never the user's planning
		// terminal. Use the auto-created terminal only for a brand-new worktree.
		const terminalId = ensured.autoTerminalId ?? (await this.createTerminal(ensured.wtProjectId))
		if (!terminalId) {
			throw Object.assign(new Error('Failed to create terminal for solve'), { phase: 'worktree' })
		}
		const worktreePath = ensured.worktreePath

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
		const promptFile = join(worktreePath, '.vigil-prompt.txt')
		const resultFile = join(worktreePath, 'docs', 'plans', planDirName, 'solver-result.json')
		writeFileSync(promptFile, buildPrompt(taskContext, { planDirName, worktreePath }), 'utf-8')

		const command = `${this.claudeArgs(solverConfig).join(' ')} "$(cat .vigil-prompt.txt)"`
		log.info('okena', `Running claude in terminal ${terminalId}`)
		try {
			await this.client.action({ action: 'run_command', terminal_id: terminalId, command })
		} catch (err) {
			throw Object.assign(new Error(`Failed to run command in Okena terminal: ${err instanceof Error ? err.message : err}`), {
				phase: 'solve',
			})
		}

		// Poll for solver-result.json — Claude writes this when done solving
		const timeoutMs = solverConfig.timeoutMinutes * 60 * 1000
		const startTime = Date.now()

		log.info('okena', `Waiting for solver-result.json (timeout: ${solverConfig.timeoutMinutes}m)`)
		while (!existsSync(resultFile)) {
			if (signal?.aborted) {
				try {
					await this.client.action({ action: 'send_special_key', terminal_id: terminalId, key: 'ctrl_c' })
				} catch {
					/* best effort */
				}
				throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
			}
			if (Date.now() - startTime > timeoutMs) {
				throw Object.assign(new Error('Claude timed out in Okena terminal'), { phase: 'solve' })
			}
			await sleep(2000)
		}

		await sleep(500)
		log.success('okena', 'Claude finished — solver-result.json detected')

		try {
			if (existsSync(promptFile)) unlinkSync(promptFile)
		} catch {
			// Non-critical
		}

		return {
			worktreePath,
			branchName,
			invokeResult: { exitCode: 0, stdout: '', stderr: '' },
		}
	}

	private claudeArgs(solverConfig: VigilConfig['solver']): string[] {
		const args = ['claude', '--dangerously-skip-permissions']
		if (solverConfig.model) {
			args.push('--model', solverConfig.model)
		}
		return args
	}

	private async findPlanTerminal(wtProjectId: string): Promise<string | null> {
		const state = await this.client.getState()
		const wtProject = state.projects.find(p => p.id === wtProjectId)
		const entry = Object.entries(wtProject?.terminal_names ?? {}).find(([, name]) => name.startsWith('plan: '))
		return entry?.[0] ?? null
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

export async function createOkenaSolver(config: VigilConfig): Promise<Solver> {
	const client = new OkenaClient()
	if (!(await client.isAvailable())) {
		throw new Error('Okena is not available')
	}
	return new OkenaSolver(client, config)
}
