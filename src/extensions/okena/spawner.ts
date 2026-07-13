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

	constructor(private readonly client: OkenaClient) {
		this.worktrees = new OkenaWorktreeManager(client)
	}

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		const ensured = await this.worktrees.ensureWorktreeProject(
			params.projectConfig.repoPath,
			params.projectConfig.baseBranch,
			params.branchName,
			params.existingWorktreePath,
		)

		const reusedTerminal = await this.worktrees.findPlanTerminal(ensured.wtProjectId)
		const terminalId =
			reusedTerminal ?? ensured.autoTerminalId ?? (await this.worktrees.createTerminal(ensured.wtProjectId))
		if (!terminalId) throw new Error('Failed to obtain a planning terminal')

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

		const command = buildInteractiveAgentCommand(
			params.solverConfig,
			workspace.rel.planningPrompt,
			ensured.worktreePath,
		)
		const agentLabel = agentLabelFromConfig(params.solverConfig)
		log.info('okena', `Starting planning session in terminal ${terminalId}`)
		try {
			// A fresh/auto terminal needs settling + line-clear; a reused plan
			// terminal must NOT get ctrl_c (it may have a running agent).
			await this.client.runCommand(terminalId, command, { freshTerminal: !reusedTerminal })
		} catch (err) {
			throw new Error(`Failed to start planning session: ${err instanceof Error ? err.message : err}`)
		}

		return {
			worktreePath: ensured.worktreePath,
			branchName: params.branchName,
			hint: `Switch to Okena -> open the project for branch ${params.branchName}. ${agentLabel} planning is running in the "plan: ${params.taskTitle}" terminal.`,
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
