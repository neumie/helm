import type { HelmConfig } from '../config.js'
import { log } from '../util/logger.js'
import { createAgentAdapter } from './agent-adapter.js'
import type { SolverAgent } from './agent.js'
import { type SpawnClaudeResult, spawnClaude } from './spawn-claude.js'

export type InvokeResult = SpawnClaudeResult & { agent: SolverAgent }

export async function invokeAgent(
	worktreePath: string,
	prompt: string,
	solver: HelmConfig['solver'],
	signal?: AbortSignal,
	outputLogPath?: string,
): Promise<InvokeResult> {
	const agentAdapter = createAgentAdapter(solver)
	const invocation = agentAdapter.buildHeadlessInvocation()
	const displayName = agentAdapter.label

	log.info('invoker', `Spawning ${displayName} in ${worktreePath}`, { model: solver.model ?? 'default' })

	const result = await spawnClaude({
		command: invocation.command,
		args: invocation.args,
		cwd: worktreePath,
		prompt,
		timeoutMs: solver.timeoutMinutes * 60 * 1000,
		signal,
		logPath: outputLogPath,
		label: invocation.label,
		displayName,
	})
	return { ...result, agent: agentAdapter.agent }
}
