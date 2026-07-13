import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCancellation } from '../util/errors.js'
import type { SolverAgent } from './agent.js'
import { spawnClaude } from './spawn-claude.js'

/** A base64-encoded image to attach to a (claude-only) one-shot vision call. */
export interface OneShotImage {
	/** base64 (no data: prefix). */
	data: string
	/** e.g. "image/png", "image/jpeg". */
	mediaType: string
}

export interface OneShotOptions {
	agent: SolverAgent
	model: string
	prompt: string
	timeoutMs?: number
	signal?: AbortSignal
	/**
	 * Optional images for a multimodal completion (e.g. reading a screenshot
	 * during triage). Only honoured for the `claude` agent — it switches the
	 * invocation to the streaming-JSON input format so the image rides along with
	 * the prompt. Ignored for `codex` (falls back to text-only).
	 */
	images?: OneShotImage[]
}

// Generous enough to absorb agent-CLI cold start (auth + config/MCP load) plus a
// short completion; naming is best-effort, so a slow host should still get a name
// rather than silently falling back.
const DEFAULT_ONE_SHOT_TIMEOUT_MS = 30_000
// Vision calls ship a base64 image and take longer (upload + multimodal decode).
const VISION_ONE_SHOT_TIMEOUT_MS = 60_000

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
	const { agent, model, prompt, signal } = opts
	// A claude call with images goes multimodal via the streaming-JSON input
	// format; images are heavier, so allow a longer default timeout.
	const vision = agent === 'claude' && (opts.images?.length ?? 0) > 0
	const timeoutMs = opts.timeoutMs ?? (vision ? VISION_ONE_SHOT_TIMEOUT_MS : DEFAULT_ONE_SHOT_TIMEOUT_MS)
	const { command, args } = vision ? buildVisionInvocation(model) : buildOneShotInvocation(agent, model)
	// For vision the stdin is a streaming-JSON user message carrying text + image
	// blocks; for text it's the raw prompt. spawnClaude writes stdin verbatim.
	const stdin = vision ? buildStreamJsonInput(prompt, opts.images ?? []) : prompt
	const cwd = mkdtempSync(join(tmpdir(), 'helm-naming-'))
	try {
		const result = await spawnClaude({
			command,
			args,
			cwd,
			prompt: stdin,
			timeoutMs,
			signal,
			label: `${command}-oneshot`,
			displayName: `${command} (one-shot${vision ? ', vision' : ''})`,
		})
		if (result.exitCode !== 0) return null
		// Vision uses stream-json output — the answer is the final `result` event;
		// text output is the raw stdout.
		const text = vision ? parseStreamJsonResult(result.stdout) : result.stdout.trim()
		return text && text.length > 0 ? text : null
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

// Attaching an image to `claude -p` requires the streaming-JSON input format,
// which in turn REQUIRES streaming-JSON output (+ `--verbose`). The answer is
// then the final `result` event rather than raw stdout.
function buildVisionInvocation(model: string): { command: string; args: string[] } {
	return {
		command: 'claude',
		args: [
			'-p',
			'--model',
			model,
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--verbose',
			'--dangerously-skip-permissions',
		],
	}
}

/** One streaming-JSON user message carrying the prompt text plus image blocks. */
function buildStreamJsonInput(prompt: string, images: OneShotImage[]): string {
	const content: unknown[] = [{ type: 'text', text: prompt }]
	for (const img of images) {
		content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
	}
	return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
}

/**
 * Pull the assistant's answer out of `--output-format stream-json` stdout: it's a
 * stream of newline-delimited JSON events; the final `{ type: 'result' }` event
 * carries the text in `result`. Returns null on error or if none is found.
 */
function parseStreamJsonResult(stdout: string): string | null {
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		let ev: { type?: string; is_error?: boolean; result?: unknown }
		try {
			ev = JSON.parse(trimmed)
		} catch {
			continue
		}
		if (ev.type === 'result' && !ev.is_error && typeof ev.result === 'string') {
			return ev.result.trim()
		}
	}
	return null
}
