import { execSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VigilConfig } from '../../config.js'
import { log } from '../../util/logger.js'
import { installSkillsIntoWorktree } from '../../skills/installer.js'
import type { SolveParams, SolveResult, Solver } from '../../solver/solver.js'
import { excludeVigilFiles } from '../../worktree/manager.js'
import { OkenaClient } from './client.js'

interface CreateWorktreeResponse {
	project_id: string
	terminal_id: string | null
	path: string
}

export class OkenaSolver implements Solver {
	private client: OkenaClient
	private config: VigilConfig

	constructor(client: OkenaClient, config: VigilConfig) {
		this.client = client
		this.config = config
	}

	async solve(params: SolveParams): Promise<SolveResult> {
		const { projectConfig, branchName, prompt, taskTitle, solverConfig, signal, outputLogPath } = params

		if (signal?.aborted) {
			throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
		}

		// Find the Okena project matching this repo
		const state = await this.client.getState()
		const okenaProject = state.projects.find(p => p.path === projectConfig.repoPath)
		if (!okenaProject) {
			throw Object.assign(
				new Error(`Project not found in Okena for path: ${projectConfig.repoPath}`),
				{ phase: 'worktree' },
			)
		}

		// Fetch and switch to base branch (previous attempts may have left it on a vigil branch)
		log.info('okena', `Matched Okena project: ${okenaProject.name} (${okenaProject.id})`)
		try {
			log.info('okena', `Fetching origin/${projectConfig.baseBranch}...`)
			execSync(`git fetch origin "${projectConfig.baseBranch}"`, { cwd: projectConfig.repoPath, stdio: 'pipe', timeout: 30_000 })
		} catch {
			log.warn('okena', `Could not fetch origin/${projectConfig.baseBranch}`)
		}
		// Ensure origin/HEAD points to the configured base branch (Okena uses this to determine start point)
		try {
			execSync(`git remote set-head origin "${projectConfig.baseBranch}"`, { cwd: projectConfig.repoPath, stdio: 'pipe', timeout: 10_000 })
		} catch {
			// Non-critical
		}
		try {
			execSync(`git checkout "${projectConfig.baseBranch}"`, { cwd: projectConfig.repoPath, stdio: 'pipe', timeout: 10_000 })
		} catch {
			// Non-critical — may already be on the right branch
		}

		// Check if a worktree project already exists in Okena from a previous attempt
		const safeBranch = branchName.replace(/\//g, '-')
		const existingWorktree = state.projects.find(
			p => p.name === branchName && p.path.includes(safeBranch),
		)

		let worktreePath: string
		let terminalId: string | null = null

		if (existingWorktree) {
			// Reuse existing worktree — just need a terminal
			log.info('okena', `Reusing existing worktree project: ${existingWorktree.id}`)
			worktreePath = existingWorktree.path
			// Create a fresh terminal in the existing project
			try {
				const result = await this.client.action<{ terminal_ids?: string[] }>({
					action: 'create_terminal',
					project_id: existingWorktree.id,
				})
				terminalId = result.terminal_ids?.[0] ?? null
			} catch {
				terminalId = null
			}

			if (!terminalId) {
				throw Object.assign(new Error('Failed to create terminal in existing worktree'), { phase: 'worktree' })
			}
		} else {
			// Create new worktree via Okena
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

			// If the default worktree had 0 terminals, create_worktree returns no terminal
			if (!terminalId) {
				log.info('okena', 'No terminal from create_worktree, creating one explicitly')
				const wtProject = (await this.client.getState()).projects.find(p => p.path === worktreePath)
				if (!wtProject) {
					throw Object.assign(new Error('Worktree project not found after creation'), { phase: 'worktree' })
				}
				const result = await this.client.action<{ terminal_ids?: string[] }>({
					action: 'create_terminal',
					project_id: wtProject.id,
				})
				terminalId = result.terminal_ids?.[0] ?? null
			}

			if (!terminalId) {
				throw Object.assign(new Error('Failed to create terminal in new worktree'), { phase: 'worktree' })
			}
		}

		// Find the worktree project ID for rename/commands
		const wtProjectId = existingWorktree?.id
			?? state.projects.find(p => p.path === worktreePath)?.id
			?? (await this.client.getState()).projects.find(p => p.path === worktreePath)?.id

		log.success('okena', `Worktree at ${worktreePath} (terminal: ${terminalId})`)
		excludeVigilFiles(worktreePath)

		// Install bundled skills (vigil-*) into the worktree — OkenaSolver still
		// drives the claude CLI internally, so the target is 'claude'. Fatal on
		// failure: the solver prompt references vigil-* skills.
		try {
			installSkillsIntoWorktree(worktreePath, 'claude')
		} catch (err) {
			throw Object.assign(new Error(`Skill install failed: ${err instanceof Error ? err.message : err}`), {
				phase: 'worktree',
			})
		}

		// Rename terminal with task title
		if (wtProjectId) {
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
		}

		// Wait for hook setup (e.g. hatch/MCP servers) if configured
		const delayMs = solverConfig.setupDelaySeconds * 1000
		if (delayMs > 0) {
			log.info('okena', `Waiting ${solverConfig.setupDelaySeconds}s for setup to finish...`)
			await sleep(delayMs)
		}

		// Write prompt to file in worktree
		const promptFile = join(worktreePath, '.vigil-prompt.txt')
		const resultFile = join(worktreePath, '.solver-result.json')
		writeFileSync(promptFile, prompt, 'utf-8')

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

		// Poll for .solver-result.json — Claude writes this when done solving
		const timeoutMs = solverConfig.timeoutMinutes * 60 * 1000
		const startTime = Date.now()

		log.info('okena', `Waiting for .solver-result.json (timeout: ${solverConfig.timeoutMinutes}m)`)
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

		log.success('okena', 'Claude finished — .solver-result.json detected')

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
