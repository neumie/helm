import type { HelmConfig } from '../../config.js'
import { PlanWorkspace } from '../../plan/workspace.js'
import { agentLabelFromConfig, buildInteractiveAgentCommand } from '../../solver/agent-command.js'
import { buildPlanningPrompt } from '../../solver/prompt-builder.js'
import type { PlanningSessionParams, PlanningSessionResult, Spawner } from '../../spawner/spawner.js'
import { formatTaskContext } from '../../task-context.js'
import { log } from '../../util/logger.js'
import { OkenaClient } from './client.js'
import { OkenaWorktreeManager } from './worktree.js'

export class OkenaSpawner implements Spawner {
	readonly name = 'okena'
	private readonly worktrees: OkenaWorktreeManager

	constructor(
		private readonly client: OkenaClient,
		worktrees?: OkenaWorktreeManager,
	) {
		this.worktrees = worktrees ?? new OkenaWorktreeManager(client)
	}

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		const ensured = await this.worktrees.ensureWorktreeProject(
			params.projectConfig.repoPath,
			params.projectConfig.baseBranch,
			params.branchName,
			params.existingWorktreePath,
		)

		const reusedTerminal = await this.worktrees.findPlanTerminal(ensured.wtProjectId)
		log.info('okena', 'Resolving planning terminal', {
			projectId: ensured.wtProjectId,
			worktreePath: ensured.worktreePath,
			reusedTerminal,
			autoTerminalId: ensured.autoTerminalId,
		})
		let replacedTerminal = false
		let terminalId: string | null
		if (reusedTerminal && params.replaceExistingSession) {
			log.info('okena', `Replacing planning session in terminal ${reusedTerminal}`)
			try {
				await this.client.action({
					action: 'close_terminal',
					project_id: ensured.wtProjectId,
					terminal_id: reusedTerminal,
				})
			} catch (err) {
				throw new Error(`Failed to stop existing planning session: ${err instanceof Error ? err.message : err}`)
			}
			terminalId = await this.worktrees.createTerminal(ensured.wtProjectId)
			replacedTerminal = true
		} else {
			terminalId =
				reusedTerminal ?? ensured.autoTerminalId ?? (await this.worktrees.createTerminal(ensured.wtProjectId))
		}
		if (!terminalId) {
			throw new Error(
				`Failed to obtain a planning terminal for Okena project ${ensured.wtProjectId} at ${ensured.worktreePath}`,
			)
		}
		let terminalSource = 'created'
		if (replacedTerminal) terminalSource = 'replaced-plan'
		else if (reusedTerminal) terminalSource = 'reused-plan'
		else if (ensured.autoTerminalId) terminalSource = 'worktree-auto'
		log.info('okena', 'Resolved planning terminal', {
			projectId: ensured.wtProjectId,
			terminalId,
			source: terminalSource,
		})

		try {
			await this.client.action({
				action: 'rename_terminal',
				project_id: ensured.wtProjectId,
				terminal_id: terminalId,
				name: `plan: ${params.taskTitle}`,
			})
		} catch {
			// Non-critical
		}

		const workspace = new PlanWorkspace(ensured.worktreePath, params.planDirName)
		workspace.writeContext(formatTaskContext(params.taskContext))
		workspace.writePlanningPrompt(buildPlanningPrompt(params.planDirName))

		const agentLabel = agentLabelFromConfig(params.solverConfig)
		if (reusedTerminal && !replacedTerminal) {
			// A named live plan terminal may contain a running interactive agent.
			// An ordinary repeated Plan call reuses it without sending ctrl_c OR
			// another shell command into the agent's input prompt. Explicit Re-plan
			// takes the replacement path above instead.
			log.info('okena', `Planning session already open in terminal ${terminalId}`)
		} else {
			const command = buildInteractiveAgentCommand(
				params.solverConfig,
				workspace.rel.planningPrompt,
				ensured.worktreePath,
			)
			log.info('okena', `Starting planning session in terminal ${terminalId}`)
			try {
				await this.client.runCommand(terminalId, command, { freshTerminal: true })
			} catch (err) {
				throw new Error(`Failed to start planning session: ${err instanceof Error ? err.message : err}`)
			}
		}

		let hint = `Switch to Okena -> open the project for branch ${params.branchName}. ${agentLabel} planning is running in the "plan: ${params.taskTitle}" terminal.`
		if (replacedTerminal) {
			hint = `Switch to Okena -> ${agentLabel} planning restarted in the "plan: ${params.taskTitle}" terminal.`
		} else if (reusedTerminal) {
			hint = `Switch to Okena -> the existing ${agentLabel} planning session is open in the "plan: ${params.taskTitle}" terminal.`
		}
		return {
			worktreePath: ensured.worktreePath,
			branchName: params.branchName,
			hint,
		}
	}
}

export async function createOkenaSpawner(_config: HelmConfig): Promise<Spawner> {
	const client = new OkenaClient()
	if (!(await client.isAvailable())) {
		log.warn(
			'okena',
			'Okena not reachable at startup — okena planning sessions will fail until it is. No fallback (spawner=okena). Run `okena state` to check/refresh the CLI token.',
		)
	}
	return new OkenaSpawner(client)
}

export { createOkenaSpawner as createSpawner }
