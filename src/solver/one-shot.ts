import { isCancellation } from '../util/errors.js'
import type { SolverAgent } from './agent.js'
import { spawnClaude } from './spawn-claude.js'

export interface OneShotOptions {
	agent: SolverAgent
	model: string
	prompt: string
	/** Directory to run in. Naming needs no worktree — pass the repo path. */
	cwd: string
	timeoutMs?: number
	signal?: AbortSignal
}

const DEFAULT_ONE_SHOT_TIMEOUT_MS = 15_000

/**
 * Run the agent CLI once for a short, non-agentic completion (e.g. deriving a
 * branch name) and return its trimmed stdout, or `null` on any failure/timeout.
 *
 * This is deliberately NOT the agentic `AgentAdapter.buildHeadlessInvocation()`
 * envelope, but it does keep codex's approval/sandbox bypass flags so a no-tool
 * naming call can't stall on an approval prompt and run out the clock. It reuses
 * the sanctioned `spawnClaude` primitive so the "never spawn an agent CLI outside
 * this path" invariant holds. Callers MUST treat `null` as "fall back to the
 * deterministic default". Cancellation (an aborted `signal`) is re-thrown, not
 * swallowed, so callers can abort the pipeline promptly instead of doing extra
 * work after a late `null`.
 */
export async function runOneShot(opts: OneShotOptions): Promise<string | null> {
	const { agent, model, prompt, cwd, timeoutMs = DEFAULT_ONE_SHOT_TIMEOUT_MS, signal } = opts
	const { command, args } = buildOneShotInvocation(agent, model)
	try {
		const result = await spawnClaude({
			command,
			args,
			cwd,
			prompt,
			timeoutMs,
			signal,
			label: `${command}-oneshot`,
			displayName: `${command} (one-shot)`,
		})
		if (result.exitCode !== 0) return null
		const stdout = result.stdout.trim()
		return stdout.length > 0 ? stdout : null
	} catch (err) {
		if (isCancellation(err, signal)) throw err
		return null
	}
}

function buildOneShotInvocation(agent: SolverAgent, model: string): { command: string; args: string[] } {
	if (agent === 'codex') {
		// Mirror the solve invocation's bypass/sandbox flags so a non-interactive
		// naming call can't hang on an approval prompt (it does no tool work, so
		// full access is moot). `-` reads the prompt from stdin and stays last.
		return {
			command: 'codex',
			args: [
				'exec',
				'--dangerously-bypass-approvals-and-sandbox',
				'--sandbox',
				'danger-full-access',
				'--model',
				model,
				'-',
			],
		}
	}
	// `-p` print mode reads the prompt from stdin; `text` output is the raw answer.
	return { command: 'claude', args: ['-p', '--model', model, '--output-format', 'text'] }
}
