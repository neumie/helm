import { existsSync } from 'node:fs'
import type { HelmConfig } from '../config.js'
import { PlanWorkspace } from '../plan/workspace.js'
import { buildInteractiveAgentCommand } from '../solver/agent-command.js'
import { buildPlanningPrompt } from '../solver/prompt-builder.js'
import { formatTaskContext } from '../task-context.js'
import { phaseError, taskCancelled } from '../util/errors.js'
import { log } from '../util/logger.js'
import { createWorktree, excludeHelmFiles } from '../worktree/manager.js'
import type { PlanningSessionParams, PlanningSessionResult, Spawner } from './spawner.js'

export class DefaultSpawner implements Spawner {
	readonly name = 'default'

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		const worktreePath = await this.ensureWorktree(
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
			hint: `Run in any terminal:\n  ${buildInteractiveAgentCommand(params.solverConfig, workspace.rel.planningPrompt, worktreePath)}`,
		}
	}

	private async ensureWorktree(
		projectConfig: PlanningSessionParams['projectConfig'],
		branchName: string,
		existingWorktreePath: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<string> {
		if (signal?.aborted) throw taskCancelled()
		if (existingWorktreePath && existsSync(existingWorktreePath)) {
			log.info('spawner', `Reusing existing worktree: ${existingWorktreePath}`)
			await excludeHelmFiles(existingWorktreePath)
			return existingWorktreePath
		}

		log.info('spawner', `Creating planning worktree for branch: ${branchName}`)
		try {
			const worktreePath = await createWorktree(
				projectConfig.repoPath,
				projectConfig.baseBranch,
				branchName,
				projectConfig.worktreeDir,
			)
			await excludeHelmFiles(worktreePath)
			return worktreePath
		} catch (err) {
			throw phaseError('worktree', `Worktree creation failed: ${err instanceof Error ? err.message : err}`)
		}
	}
}

export function createDefaultSpawner(_config: HelmConfig): Spawner {
	return new DefaultSpawner()
}

export { createDefaultSpawner as createSpawner }
