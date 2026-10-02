import type { HelmConfig } from '../config.js'
import type { SolverEffort } from '../items/schema.js'
import type { ClaudeEvent } from '../types.js'
import type { SolverAgent } from './agent.js'
import { solverAgentLabel } from './agent.js'
import { parseClaudeOutput } from './output-parser.js'

export interface AgentInvocation {
	command: string
	args: string[]
	label: string
}

export interface ReviewInvocationOptions {
	conversationId: string
	resume: boolean
	discuss: boolean
}

export interface ReviewCapabilities {
	transport: 'cli-jsonl'
	continuation: 'resume-id' | 'exact-session-id'
	readOnlyPolicy: 'tool-allowlist' | 'sandbox'
	interactiveQuestions: false
	interrupt: 'terminate-owned-cli'
	providerAcknowledgement: false
	minimumVersion: string | null
}

export interface AgentAdapter {
	readonly reviewCapabilities: ReviewCapabilities
	agent: SolverAgent
	label: string
	buildHeadlessInvocation(effort?: SolverEffort): AgentInvocation
	/** Structured interactive argv for daemon-owned terminals; the scheduled host appends its validated prompt exactly once. */
	buildInteractiveInvocation(effort?: SolverEffort): AgentInvocation
	buildInteractiveCommand(promptPath: string, worktreePath: string, effort?: SolverEffort): string
	parseTimeline(stdout: string): ClaudeEvent[]
	buildReviewInvocation(options: ReviewInvocationOptions): AgentInvocation
}

export function createAgentAdapter(solverConfig: HelmConfig['solver']): AgentAdapter {
	switch (resolveSolverAgent(solverConfig)) {
		case 'claude':
			return new ClaudeAgentAdapter(solverConfig)
		case 'codex':
			return new CodexAgentAdapter(solverConfig)
		case 'pi':
			return new PiAgentAdapter(solverConfig)
	}
}

export function resolveSolverAgent(solverConfig: HelmConfig['solver']): SolverAgent {
	return solverConfig.agent ?? 'claude'
}

export function buildHeadlessAgentInvocation(
	solverConfig: HelmConfig['solver'],
	effort?: SolverEffort,
): AgentInvocation {
	return createAgentAdapter(solverConfig).buildHeadlessInvocation(effort)
}

/** Prompt-free argv for a scheduled interactive agent. The scheduled host owns prompt composition. */
export function buildInteractiveAgentInvocation(
	solverConfig: HelmConfig['solver'],
	effort?: SolverEffort,
): AgentInvocation {
	return createAgentAdapter(solverConfig).buildInteractiveInvocation(effort)
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
	effort?: SolverEffort,
): string {
	return createAgentAdapter(solverConfig).buildInteractiveCommand(promptPath, worktreePath, effort)
}

export function agentLabelFromConfig(solverConfig: HelmConfig['solver']): string {
	return createAgentAdapter(solverConfig).label
}

class ClaudeAgentAdapter implements AgentAdapter {
	readonly reviewCapabilities: ReviewCapabilities = {
		transport: 'cli-jsonl',
		continuation: 'resume-id',
		readOnlyPolicy: 'tool-allowlist',
		interactiveQuestions: false,
		interrupt: 'terminate-owned-cli',
		providerAcknowledgement: false,
		minimumVersion: null,
	}
	readonly agent = 'claude'
	readonly label = solverAgentLabel(this.agent)

	constructor(private readonly solverConfig: HelmConfig['solver']) {}

	buildHeadlessInvocation(effort?: SolverEffort): AgentInvocation {
		const args: string[] = ['-p', '--output-format', 'json', '--dangerously-skip-permissions']
		if (this.solverConfig.model) {
			args.push('--model', this.solverConfig.model)
		}
		if (this.solverConfig.maxBudgetUsd) {
			args.push('--max-turns', '100')
		}
		if (effort) args.push('--effort', effort)
		return { command: 'claude', args, label: 'claude-invoker' }
	}

	buildInteractiveInvocation(effort?: SolverEffort): AgentInvocation {
		const args = ['--dangerously-skip-permissions']
		if (this.solverConfig.model) args.push('--model', this.solverConfig.model)
		if (effort) args.push('--effort', effort)
		return { command: 'claude', args, label: 'claude-interactive' }
	}

	buildInteractiveCommand(promptPath: string, worktreePath: string, effort?: SolverEffort): string {
		return buildInteractiveCommand(
			['claude', '--dangerously-skip-permissions', ...(effort ? ['--effort', effort] : [])],
			this.solverConfig,
			promptPath,
			worktreePath,
		)
	}

	buildReviewInvocation({ conversationId, resume, discuss }: ReviewInvocationOptions): AgentInvocation {
		const args = [
			'-p',
			'--output-format',
			'stream-json',
			'--verbose',
			'--include-partial-messages',
			'--permission-prompts',
			'none',
			resume ? '--resume' : '--session-id',
			conversationId,
		]
		if (discuss) args.push('--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk')
		else args.push('--dangerously-skip-permissions')
		if (this.solverConfig.model) args.push('--model', this.solverConfig.model)
		return { command: 'claude', args, label: 'claude-review' }
	}

	parseTimeline(stdout: string): ClaudeEvent[] {
		return parseClaudeOutput(stdout)
	}
}

class CodexAgentAdapter implements AgentAdapter {
	readonly reviewCapabilities: ReviewCapabilities = {
		transport: 'cli-jsonl',
		continuation: 'resume-id',
		readOnlyPolicy: 'sandbox',
		interactiveQuestions: false,
		interrupt: 'terminate-owned-cli',
		providerAcknowledgement: false,
		minimumVersion: null,
	}
	readonly agent = 'codex'
	readonly label = solverAgentLabel(this.agent)

	constructor(private readonly solverConfig: HelmConfig['solver']) {}

	buildHeadlessInvocation(effort?: SolverEffort): AgentInvocation {
		const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'danger-full-access', '-']
		if (this.solverConfig.model) args.push('--model', this.solverConfig.model)
		if (effort) args.push('--config', `model_reasoning_effort="${effort}"`)
		return { command: 'codex', args, label: 'codex-invoker' }
	}

	buildInteractiveInvocation(effort?: SolverEffort): AgentInvocation {
		const args = ['--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'danger-full-access']
		if (this.solverConfig.model) args.push('--model', this.solverConfig.model)
		if (effort) args.push('--config', `model_reasoning_effort="${effort}"`)
		return { command: 'codex', args, label: 'codex-interactive' }
	}

	buildInteractiveCommand(promptPath: string, worktreePath: string, effort?: SolverEffort): string {
		return buildInteractiveCommand(
			[
				'codex',
				'--dangerously-bypass-approvals-and-sandbox',
				'--sandbox',
				'danger-full-access',
				...(effort ? ['--config', `model_reasoning_effort="${effort}"`] : []),
			],
			this.solverConfig,
			promptPath,
			worktreePath,
		)
	}

	buildReviewInvocation({ conversationId, resume, discuss }: ReviewInvocationOptions): AgentInvocation {
		const args = ['exec', ...(discuss ? ['--sandbox', 'read-only'] : ['--dangerously-bypass-approvals-and-sandbox'])]
		if (this.solverConfig.model) args.push('--model', this.solverConfig.model)
		if (resume) args.push('resume', '--json', conversationId, '-')
		else args.push('--json', '-')
		return { command: 'codex', args, label: 'codex-review' }
	}

	parseTimeline(): ClaudeEvent[] {
		return []
	}
}

class PiAgentAdapter implements AgentAdapter {
	readonly reviewCapabilities: ReviewCapabilities = {
		transport: 'cli-jsonl',
		continuation: 'exact-session-id',
		readOnlyPolicy: 'tool-allowlist',
		interactiveQuestions: false,
		interrupt: 'terminate-owned-cli',
		providerAcknowledgement: false,
		minimumVersion: '0.99',
	}
	readonly agent = 'pi'
	readonly label = solverAgentLabel(this.agent)

	constructor(private readonly solverConfig: HelmConfig['solver']) {}

	buildHeadlessInvocation(effort?: SolverEffort): AgentInvocation {
		// Pi's JSON mode is itself non-interactive (not merely an output flag): it
		// consumes the piped stdin prompt, emits JSONL, and exits. Runtime-attested.
		const args = ['--mode', 'json', '--no-session', '--approve']
		if (this.solverConfig.model) args.push('--model', this.solverConfig.model)
		if (effort) args.push('--thinking', effort)
		return { command: 'pi', args, label: 'pi-invoker' }
	}

	buildInteractiveInvocation(effort?: SolverEffort): AgentInvocation {
		const args = ['--no-session', '--approve']
		if (this.solverConfig.model) args.push('--model', this.solverConfig.model)
		if (effort) args.push('--thinking', effort)
		return { command: 'pi', args, label: 'pi-interactive' }
	}

	buildInteractiveCommand(promptPath: string, worktreePath: string, effort?: SolverEffort): string {
		return buildInteractiveCommand(
			['pi', '--no-session', '--approve', ...(effort ? ['--thinking', effort] : [])],
			this.solverConfig,
			promptPath,
			worktreePath,
		)
	}

	buildReviewInvocation({ conversationId, discuss }: ReviewInvocationOptions): AgentInvocation {
		// Pi >=0.99 exposes exact create-or-open IDs. Older versions fail preflight,
		// never substitute --continue or silently target a different conversation.
		const args = ['--mode', 'json', '--session-id', conversationId, '--approve']
		if (discuss) args.push('--tools', 'read,grep,find,ls', '--no-extensions')
		if (this.solverConfig.model) args.push('--model', this.solverConfig.model)
		return { command: 'pi', args, label: 'pi-review' }
	}

	// Pi emits JSONL, but Helm does not yet project those events into the legacy
	// ClaudeEvent timeline. The run log still contains the complete stream.
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
