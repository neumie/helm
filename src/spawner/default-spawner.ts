import type { HelmConfig } from '../config.js'
import { PlanWorkspace } from '../plan/workspace.js'
import { buildInteractiveAgentCommand } from '../solver/agent-command.js'
import { buildPlanningPrompt } from '../solver/prompt-builder.js'
import { formatTaskContext } from '../task-context.js'
import { phaseError, taskCancelled } from '../util/errors.js'
import { log } from '../util/logger.js'
import { assertWorkspaceReuse, createWorktree, excludeHelmFiles } from '../worktree/manager.js'
import type { PlanningSessionParams, PlanningSessionResult, Spawner } from './spawner.js'

export class DefaultSpawner implements Spawner {
	readonly name = 'default'

	async startPlanningSession(params: PlanningSessionParams): Promise<PlanningSessionResult> {
		const worktreePath = await this.ensureWorktree(
			params.projectConfig,
			params.branchName,
			params.existingWorktreePath,
			params.signal,
			params.workspaceMode,
		)

		const taskContext = params.onWorktreeReady(worktreePath)
		const workspace = new PlanWorkspace(worktreePath, params.planDirName)
		workspace.writeContext(formatTaskContext(taskContext))
		if (params.knowledgeContext) workspace.writeKnowledgeContext(params.knowledgeContext)
		else workspace.clearKnowledgeContext()
		workspace.writePlanningPrompt(buildPlanningPrompt(params.planDirName, params.solverConfig.agent))

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
		mode: PlanningSessionParams['workspaceMode'] = 'worktree',
	): Promise<string> {
		if (signal?.aborted) throw taskCancelled()
		if (mode === 'main' || existingWorktreePath) {
			const path = existingWorktreePath ?? projectConfig.repoPath
			await assertWorkspaceReuse(projectConfig.repoPath, branchName, path, mode)
			log.info('spawner', `Reusing existing worktree: ${path}`)
			await excludeHelmFiles(path)
			return path
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
