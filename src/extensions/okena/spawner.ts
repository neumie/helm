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
		const terminalId =
			reusedTerminal ?? ensured.autoTerminalId ?? (await this.worktrees.createTerminal(ensured.wtProjectId))
		if (!terminalId) {
			throw new Error(
				`Failed to obtain a planning terminal for Okena project ${ensured.wtProjectId} at ${ensured.worktreePath}`,
			)
		}
		log.info('okena', 'Resolved planning terminal', {
			projectId: ensured.wtProjectId,
			terminalId,
			source: reusedTerminal ? 'reused-plan' : ensured.autoTerminalId ? 'worktree-auto' : 'created',
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
		if (reusedTerminal) {
			// A named live plan terminal may contain a running interactive agent.
			// Repeated Plan clicks reuse it without sending ctrl_c OR another shell
			// command into the agent's input prompt.
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

		return {
			worktreePath: ensured.worktreePath,
			branchName: params.branchName,
			hint: reusedTerminal
				? `Switch to Okena -> the existing ${agentLabel} planning session is open in the "plan: ${params.taskTitle}" terminal.`
				: `Switch to Okena -> open the project for branch ${params.branchName}. ${agentLabel} planning is running in the "plan: ${params.taskTitle}" terminal.`,
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
