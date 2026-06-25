import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCancellation } from '../util/errors.js'
import type { SolverAgent } from './agent.js'
import { spawnClaude } from './spawn-claude.js'

export interface OneShotOptions {
	agent: SolverAgent
	model: string
	prompt: string
	timeoutMs?: number
	signal?: AbortSignal
}

// Generous enough to absorb agent-CLI cold start (auth + config/MCP load) plus a
// short completion; naming is best-effort, so a slow host should still get a name
// rather than silently falling back.
const DEFAULT_ONE_SHOT_TIMEOUT_MS = 30_000

/**
 * Run the agent CLI once for a short, non-agentic completion (e.g. deriving a
 * branch name) and return its trimmed stdout, or `null` on any failure/timeout.
 *
 * Runs in a throwaway temp dir, NOT the repo: naming needs no repo context (all
 * input is in the prompt), and an isolated cwd means an agentic CLI granted broad
 * permissions/sandbox can't mutate the canonical working tree before the real
 * worktree exists. Both agents get their permission/approval bypass so a no-tool
 * naming call can't stall on an interactive prompt that piped stdin can't answer.
 * Reuses the sanctioned `spawnClaude` primitive. Callers MUST treat `null` as
 * "fall back to the deterministic default". Cancellation (an aborted `signal`) is
 * re-thrown, not swallowed, so callers can abort the pipeline promptly.
 */
export async function runOneShot(opts: OneShotOptions): Promise<string | null> {
	const { agent, model, prompt, timeoutMs = DEFAULT_ONE_SHOT_TIMEOUT_MS, signal } = opts
	const { command, args } = buildOneShotInvocation(agent, model)
	const cwd = mkdtempSync(join(tmpdir(), 'vigil-naming-'))
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
	} finally {
		try {
			rmSync(cwd, { recursive: true, force: true })
		} catch {
			// best-effort cleanup; OS temp reaping covers a leaked dir
		}
	}
}

function buildOneShotInvocation(agent: SolverAgent, model: string): { command: string; args: string[] } {
	if (agent === 'codex') {
		// Bypass approvals/sandbox so a non-interactive exec can't hang on a prompt
		// (it does no tool work, and runs in a throwaway cwd, so full access is moot).
		// `-` reads the prompt from stdin and stays last.
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
	// `--dangerously-skip-permissions` mirrors the codex bypass so a permission
	// prompt (hooks/MCP/non-bypassing default mode) can't stall the call.
	return {
		command: 'claude',
		args: ['-p', '--model', model, '--output-format', 'text', '--dangerously-skip-permissions'],
	}
}
