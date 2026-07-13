import type { HelmConfig } from '../config.js'
import type { ClaudeEvent } from '../types.js'
import type { SolverAgent } from './agent.js'
import { solverAgentLabel } from './agent.js'
import { parseClaudeOutput } from './output-parser.js'

export interface AgentInvocation {
	command: string
	args: string[]
	label: string
}

export interface AgentAdapter {
	agent: SolverAgent
	label: string
	buildHeadlessInvocation(): AgentInvocation
	buildInteractiveCommand(promptPath: string, worktreePath: string): string
	parseTimeline(stdout: string): ClaudeEvent[]
}

export function createAgentAdapter(solverConfig: HelmConfig['solver']): AgentAdapter {
	const agent = resolveSolverAgent(solverConfig)
	return agent === 'codex' ? new CodexAgentAdapter(solverConfig) : new ClaudeAgentAdapter(solverConfig)
}

export function resolveSolverAgent(solverConfig: HelmConfig['solver']): SolverAgent {
	return solverConfig.agent ?? 'claude'
}

export function buildHeadlessAgentInvocation(solverConfig: HelmConfig['solver']): AgentInvocation {
	return createAgentAdapter(solverConfig).buildHeadlessInvocation()
}

/**
 * Build the one-line shell command Okena or the default spawner types into a terminal.
 *
 * `promptPath` is resolved relative to `worktreePath`, so the command `cd`s into
 * the worktree first. This is load-bearing: a terminal Okena auto-creates with a
 * worktree starts in the worktree, but one made later via `create_terminal`
 * (every re-run of an existing task) does NOT. Without the `cd`, the relative
 * `cat` fails with "No such file or directory" and the agent would edit the
 * wrong tree. Always pass the worktree path; never rely on the terminal's cwd.
 */
export function buildInteractiveAgentCommand(
	solverConfig: HelmConfig['solver'],
	promptPath: string,
	worktreePath: string,
): string {
	return createAgentAdapter(solverConfig).buildInteractiveCommand(promptPath, worktreePath)
}

export function agentLabelFromConfig(solverConfig: HelmConfig['solver']): string {
	return createAgentAdapter(solverConfig).label
}

class ClaudeAgentAdapter implements AgentAdapter {
	readonly agent = 'claude'
	readonly label = solverAgentLabel(this.agent)

	constructor(private readonly solverConfig: HelmConfig['solver']) {}

	buildHeadlessInvocation(): AgentInvocation {
		const args: string[] = ['-p', '--output-format', 'json', '--dangerously-skip-permissions']
		if (this.solverConfig.model) {
			args.push('--model', this.solverConfig.model)
		}
		if (this.solverConfig.maxBudgetUsd) {
			args.push('--max-turns', '100')
		}
		return { command: 'claude', args, label: 'claude-invoker' }
	}

	buildInteractiveCommand(promptPath: string, worktreePath: string): string {
		return buildInteractiveCommand(
			['claude', '--dangerously-skip-permissions'],
			this.solverConfig,
			promptPath,
			worktreePath,
		)
	}

	parseTimeline(stdout: string): ClaudeEvent[] {
		return parseClaudeOutput(stdout)
	}
}

class CodexAgentAdapter implements AgentAdapter {
	readonly agent = 'codex'
	readonly label = solverAgentLabel(this.agent)

	constructor(private readonly solverConfig: HelmConfig['solver']) {}

	buildHeadlessInvocation(): AgentInvocation {
		const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'danger-full-access', '-']
		if (this.solverConfig.model) args.push('--model', this.solverConfig.model)
		return { command: 'codex', args, label: 'codex-invoker' }
	}

	buildInteractiveCommand(promptPath: string, worktreePath: string): string {
		return buildInteractiveCommand(
			['codex', '--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'danger-full-access'],
			this.solverConfig,
			promptPath,
			worktreePath,
		)
	}

	parseTimeline(): ClaudeEvent[] {
		return []
	}
}

function buildInteractiveCommand(
	baseArgs: string[],
	solverConfig: HelmConfig['solver'],
	promptPath: string,
	worktreePath: string,
): string {
	const args = [...baseArgs]
	if (solverConfig.model) {
		args.push('--model', solverConfig.model)
	}

	const invocation = [...args.map(shellQuote), `"$(cat ${shellQuote(promptPath)})"`].join(' ')
	return `cd ${shellQuote(worktreePath)} && ${invocation}`
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}
