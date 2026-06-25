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
 * envelope (which forces `--dangerously-skip-permissions` / sandbox bypass for a
 * full solve). It builds a minimal print-mode invocation and reuses the sanctioned
 * `spawnClaude` primitive so the "never spawn an agent CLI outside this path"
 * invariant holds. Callers MUST treat `null` as "fall back to the deterministic
 * default" — this helper never throws.
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
	} catch {
		return null
	}
}

function buildOneShotInvocation(agent: SolverAgent, model: string): { command: string; args: string[] } {
	if (agent === 'codex') {
		// `-` reads the prompt from stdin; no sandbox/approval flags — no tools needed.
		return { command: 'codex', args: ['exec', '--model', model, '-'] }
	}
	// `-p` print mode reads the prompt from stdin; `text` output is the raw answer.
	return { command: 'claude', args: ['-p', '--model', model, '--output-format', 'text'] }
}
