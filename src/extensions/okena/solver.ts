import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VigilConfig } from '../../config.js'
import { log } from '../../util/logger.js'
import type {
	PlanningSessionParams,
	PlanningSessionResult,
	PrepareWorktreeParams,
	PrepareWorktreeResult,
	SolveParams,
	SolveResult,
	Solver,
} from '../../solver/solver.js'
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
	terminalId: string
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
			throw Object.assign(
				new Error(`Project not found in Okena for path: ${repoPath}`),
				{ phase: 'worktree' },
			)
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

	private async ensureWorktree(
		repoPath: string,
		baseBranch: string,
		branchName: string,
	): Promise<EnsuredWorktree> {
		const { state, okenaProject } = await this.findOkenaProject(repoPath)
		log.info('okena', `Matched Okena project: ${okenaProject.name} (${okenaProject.id})`)
		await this.ensureBaseBranchReady(repoPath, baseBranch)

		const safeBranch = branchName.replace(/\//g, '-')
		const existing = state.projects.find(p => p.name === branchName && p.path.includes(safeBranch))

		let worktreePath: string
		let terminalId: string | null = null
		let wtProjectId: string | undefined

		if (existing) {
			log.info('okena', `Reusing existing worktree project: ${existing.id}`)
			worktreePath = existing.path
			wtProjectId = existing.id
			terminalId = await this.createTerminal(existing.id)
			if (!terminalId) {
				throw Object.assign(new Error('Failed to create terminal in existing worktree'), { phase: 'worktree' })
			}
		} else {
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
					throw Object.assign(
						new Error(`Okena worktree creation failed: ${err instanceof Error ? err.message : err}`),
						{ phase: 'worktree' },
					)
				}
			}
			worktreePath = wt.path
			terminalId = wt.terminal_id

			if (!terminalId) {
				log.info('okena', 'No terminal from create_worktree, creating one explicitly')
				const wtProject = (await this.client.getState()).projects.find(p => p.path === worktreePath)
				if (!wtProject) {
					throw Object.assign(new Error('Worktree project not found after creation'), { phase: 'worktree' })
				}
				wtProjectId = wtProject.id
				terminalId = await this.createTerminal(wtProject.id)
			}
			if (!terminalId) {
				throw Object.assign(new Error('Failed to create terminal in new worktree'), { phase: 'worktree' })
			}
			if (!wtProjectId) {
				wtProjectId =
					state.projects.find(p => p.path === worktreePath)?.id
					?? (await this.client.getState()).projects.find(p => p.path === worktreePath)?.id
			}
		}

		if (!wtProjectId) {
			throw Object.assign(new Error('Worktree project ID could not be resolved'), { phase: 'worktree' })
		}

		log.success('okena', `Worktree at ${worktreePath} (terminal: ${terminalId})`)
		excludeVigilFiles(worktreePath)

		return { worktreePath, wtProjectId, terminalId }
	}

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		const { projectConfig, branchName, planDirName, taskTitle, solverConfig, prompt, contextMarkdown, existingWorktreePath } = params

		// Ensure the worktree + a terminal exist. Mirror the solve() path:
		// if there's already a worktree project at this path, reuse it and
		// pick (or create) a terminal in it; otherwise create the project +
		// terminal in one shot via ensureWorktree.
		let worktreePath: string
		let wtProjectId: string
		let terminalId: string

		if (existingWorktreePath) {
			const state = await this.client.getState()
			const wtProject = state.projects.find(p => p.path === existingWorktreePath)
			if (!wtProject) {
				throw new Error(`Okena project not found for worktree path: ${existingWorktreePath}`)
			}
			worktreePath = existingWorktreePath
			wtProjectId = wtProject.id
			// Reuse an existing planning terminal if present (name starts with
			// "plan: "); otherwise spawn a fresh one. Prevents N stale terminals
			// piling up when the user clicks Plan repeatedly.
			const planTerminalEntry = Object.entries(wtProject.terminal_names ?? {})
				.find(([, name]) => name.startsWith('plan: '))
			if (planTerminalEntry) {
				terminalId = planTerminalEntry[0]
				log.info('okena', `Reusing existing planning terminal ${terminalId}`)
			} else {
				const fresh = await this.createTerminal(wtProject.id)
				if (!fresh) throw new Error('Failed to create planning terminal in existing worktree')
				terminalId = fresh
			}
		} else {
			const ensured = await this.ensureWorktree(projectConfig.repoPath, projectConfig.baseBranch, branchName)
			worktreePath = ensured.worktreePath
			wtProjectId = ensured.wtProjectId
			terminalId = ensured.terminalId
		}

		try {
			await this.client.action({
				action: 'rename_terminal',
				project_id: wtProjectId,
				terminal_id: terminalId,
				name: `plan: ${taskTitle}`,
			})
		} catch {
			// Non-critical
		}

		// Write task context to docs/plans/<planDirName>/context.md so the
		// planning agent (and the user) can read it. The prompt below tells
		// the agent to read this file as its first action.
		const planDir = join(worktreePath, 'docs', 'plans', planDirName)
		mkdirSync(planDir, { recursive: true })
		writeFileSync(join(planDir, 'context.md'), contextMarkdown, 'utf-8')

		// Stage the planning prompt in the plan dir (dot-prefixed + .txt so the
		// transformer skips it). We deliberately do NOT embed the multi-line
		// prompt directly in the shell command: okena's run_command types the
		// command into the terminal character-by-character, and embedded newlines
		// break the shell's tokenization mid-stream. `$(cat path)` keeps the
		// command on a single line.
		const promptRelPath = `docs/plans/${planDirName}/.planning-prompt.txt`
		writeFileSync(join(worktreePath, promptRelPath), prompt, 'utf-8')

		const args = ['claude', '--dangerously-skip-permissions']
		if (solverConfig.model) {
			args.push('--model', solverConfig.model)
		}
		const command = `${args.join(' ')} "$(cat ${promptRelPath})"`

		log.info('okena', `Starting planning session in terminal ${terminalId}`)
		try {
			await this.client.action({
				action: 'run_command',
				terminal_id: terminalId,
				command,
			})
		} catch (err) {
			throw new Error(`Failed to start planning session: ${err instanceof Error ? err.message : err}`)
		}

		return {
			worktreePath,
			branchName,
			hint: `Switch to Okena → open the project for branch ${branchName}. The planning session is running in the "plan: ${taskTitle}" terminal.`,
		}
	}

	async prepareWorktree(params: PrepareWorktreeParams): Promise<PrepareWorktreeResult> {
		const { projectConfig, branchName, taskTitle, signal } = params
		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
		}
		const ensured = await this.ensureWorktree(projectConfig.repoPath, projectConfig.baseBranch, branchName)
		try {
			await this.client.action({
				action: 'rename_terminal',
				project_id: ensured.wtProjectId,
				terminal_id: ensured.terminalId,
				name: taskTitle,
			})
		} catch {
			// Non-critical
		}
		return { worktreePath: ensured.worktreePath, branchName }
	}

	async solve(params: SolveParams): Promise<SolveResult> {
		const { projectConfig, branchName, planDirName, buildPrompt, taskTitle, solverConfig, signal, existingWorktreePath } = params

		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
		}

		// Resolve worktree + a fresh terminal for the autonomous run.
		// If existingWorktreePath is set (plan phase happened), find the project
		// by path and spawn a NEW terminal in it — don't disturb the user's
		// planning terminal. Otherwise go through the normal ensureWorktree.
		let worktreePath: string
		let terminalId: string
		let wtProjectId: string

		if (existingWorktreePath) {
			log.info('okena', `Reusing existing worktree: ${existingWorktreePath}`)
			const state = await this.client.getState()
			const wtProject = state.projects.find(p => p.path === existingWorktreePath)
			if (!wtProject) {
				throw Object.assign(
					new Error(`Okena project not found for worktree path: ${existingWorktreePath}`),
					{ phase: 'worktree' },
				)
			}
			const fresh = await this.createTerminal(wtProject.id)
			if (!fresh) {
				throw Object.assign(new Error('Failed to create terminal in existing worktree'), { phase: 'worktree' })
			}
			worktreePath = existingWorktreePath
			wtProjectId = wtProject.id
			terminalId = fresh
			excludeVigilFiles(worktreePath)
		} else {
			const ensured = await this.ensureWorktree(projectConfig.repoPath, projectConfig.baseBranch, branchName)
			worktreePath = ensured.worktreePath
			wtProjectId = ensured.wtProjectId
			terminalId = ensured.terminalId
		}

		// Rename terminal with task title
		try {
			await this.client.action({
				action: 'rename_terminal',
				project_id: wtProjectId,
				terminal_id: terminalId,
				name: taskTitle,
			})
		} catch {
			// Non-critical
		}

		// Wait for hook setup (e.g. hatch/MCP servers) if configured
		const delayMs = solverConfig.setupDelaySeconds * 1000
		if (delayMs > 0) {
			log.info('okena', `Waiting ${solverConfig.setupDelaySeconds}s for setup to finish...`)
			await sleep(delayMs)
		}

		// Write prompt to file in worktree. Built now so the transformer sees
		// any docs/plans/<planDirName>/ artifacts present in the worktree.
		const promptFile = join(worktreePath, '.vigil-prompt.txt')
		const resultFile = join(worktreePath, 'docs', 'plans', planDirName, 'solver-result.json')
		writeFileSync(promptFile, buildPrompt(worktreePath), 'utf-8')

		// Run claude in the terminal
		const args = ['claude', '--dangerously-skip-permissions']
		if (solverConfig.model) {
			args.push('--model', solverConfig.model)
		}
		const command = `${args.join(' ')} "$(cat .vigil-prompt.txt)"`

		log.info('okena', `Running claude in terminal ${terminalId}`)
		try {
			await this.client.action({
				action: 'run_command',
				terminal_id: terminalId,
				command,
			})
		} catch (err) {
			throw Object.assign(
				new Error(`Failed to run command in Okena terminal: ${err instanceof Error ? err.message : err}`),
				{ phase: 'solve' },
			)
		}

		// Poll for solver-result.json — Claude writes this when done solving
		const timeoutMs = solverConfig.timeoutMinutes * 60 * 1000
		const startTime = Date.now()

		log.info('okena', `Waiting for solver-result.json (timeout: ${solverConfig.timeoutMinutes}m)`)
		while (!existsSync(resultFile)) {
			if (signal?.aborted) {
				try {
					await this.client.action({ action: 'send_special_key', terminal_id: terminalId, key: 'ctrl_c' })
				} catch { /* best effort */ }
				throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
			}
			if (Date.now() - startTime > timeoutMs) {
				throw Object.assign(new Error('Claude timed out in Okena terminal'), { phase: 'solve' })
			}
			await sleep(2000)
		}

		// Small delay to ensure file is fully written
		await sleep(500)

		log.success('okena', 'Claude finished — solver-result.json detected')

		// Cleanup prompt file
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
