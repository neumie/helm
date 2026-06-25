import type { VigilConfig } from '../config.js'
import type { TaskContext } from '../providers/provider.js'
import type { SolverAgent } from '../solver/agent.js'
import { runOneShot } from '../solver/one-shot.js'
import type { OneShotOptions } from '../solver/one-shot.js'
import { isCancellation } from '../util/errors.js'
import { log } from '../util/logger.js'
import { slugify } from '../util/slug.js'
import { localBranchExists } from '../worktree/manager.js'
import type { ItemCommands } from './commands.js'
import { derivedItemPlanDirName, itemSuffix } from './identity.js'
import type { ItemRecord } from './schema.js'
import type { ItemStore } from './store.js'

const ALLOWED_TYPES = new Set([
	'feat',
	'fix',
	'chore',
	'refactor',
	'docs',
	'test',
	'perf',
	'build',
	'ci',
	'style',
	'revert',
])

/** Cheap per-agent default when `solver.nameModel.model` is unset. */
function defaultNameModel(agent: SolverAgent): string {
	return agent === 'codex' ? 'gpt-5-mini' : 'claude-haiku-4-5'
}

export function buildNamingPrompt(taskContext: TaskContext): string {
	const lines = [
		'You name git branches for a software task. Reply with ONLY the branch name on a single line — no quotes, no backticks, no explanation.',
		'',
		'Rules:',
		'- Format: <type>/<summary>',
		'- <type> is exactly one of: feat, fix, chore, refactor, docs, test, perf, build, ci',
		'- <summary> is 2-5 lowercase words joined by hyphens, describing the change',
		'- Use only the characters a-z, 0-9, hyphen and one slash',
		'- Keep the whole name under 50 characters',
		'',
		`Task title: ${taskContext.title}`,
	]
	if (taskContext.description) {
		lines.push('', 'Task details:', taskContext.description.slice(0, 1500))
	}
	lines.push('', 'Branch name:')
	return lines.join('\n')
}

interface ParsedName {
	type?: string
	descriptionSlug: string
}

// Strip wrapping decorations a model may add around the answer: quotes, backticks,
// markdown emphasis/bullets/blockquotes and brackets on the left; the same plus
// sentence punctuation (`.`, `,`, `)` …) on the right, so a line ending in
// punctuation still matches the branch regex instead of silently falling back.
const WRAP_START = /^[\s`'"*>([{-]+/
const WRAP_END = /[\s`'"*.,;:!?)\]}]+$/

/** Strip wrapping decorations and a leading "Branch name:" echo. */
function cleanCandidateLine(line: string): string {
	const unwrapped = line.replace(WRAP_START, '').replace(WRAP_END, '')
	const unlabelled = unwrapped.replace(/^branch\s*name\s*:?\s*/i, '')
	return unlabelled.replace(WRAP_START, '').replace(WRAP_END, '').trim()
}

/**
 * Pull a `<type>/<slug>` branch name out of raw model stdout. Tolerant of agent
 * preamble/log noise (codex): scans every line for a conventional pattern rather
 * than trusting the last line. Returns `null` when nothing branch-shaped is found
 * so the caller can fall back to the deterministic default.
 */
export function parseBranchName(raw: string): ParsedName | null {
	const lines = raw.split('\n').map(cleanCandidateLine).filter(Boolean)

	let flatFallback: ParsedName | null = null
	for (const line of lines) {
		const match = line.toLowerCase().match(/^([a-z]+)\/([a-z0-9][a-z0-9-]*)$/)
		if (!match) continue
		const type = match[1]
		const descriptionSlug = slugify(match[2])
		if (!descriptionSlug) continue
		if (ALLOWED_TYPES.has(type)) return { type, descriptionSlug }
		// Looks like type/slug but the type is unknown — keep the slug, drop the type.
		flatFallback ??= { descriptionSlug }
	}
	return flatFallback
}

export interface EnsureItemNameDeps {
	runOneShot?: (opts: OneShotOptions) => Promise<string | null>
	branchExists?: (branch: string) => boolean
}

export interface EnsureItemNameParams {
	commands: ItemCommands
	store: ItemStore
	item: ItemRecord
	taskContext: TaskContext
	config: VigilConfig
	repoPath: string
	/** Effective solver agent, resolved by the caller (selected agent ?? config). */
	agent: SolverAgent
	signal?: AbortSignal
	deps?: EnsureItemNameDeps
}

/**
 * Optionally replace the default `vigil/item/<slug>` branch with a conventional,
 * model-derived name (`feat/…`, `fix/…`) when `solver.nameModel.enabled`. Persists
 * through `ItemCommands` and returns the resulting Item (the updated row, or the
 * input unchanged when naming is disabled/declined) so callers can pass it
 * straight to `resolveItemWorkspace` without a reload. A model failure, timeout,
 * or unparseable answer degrades silently to the input Item, so the deterministic
 * default still applies. Cancellation is re-thrown (callers run inside the
 * pipeline's abort-aware catch); nothing else throws.
 */
export async function ensureItemWorkspaceName(params: EnsureItemNameParams): Promise<ItemRecord> {
	const { commands, store, item, taskContext, config, repoPath, agent, signal, deps } = params
	if (!config.solver.nameModel.enabled) return item
	if (item.branchName) return item // already planned / forked / named

	try {
		const model = config.solver.nameModel.model ?? defaultNameModel(agent)
		const run = deps?.runOneShot ?? runOneShot
		const raw = await run({
			agent,
			model,
			prompt: buildNamingPrompt(taskContext),
			cwd: repoPath,
			signal,
		})
		if (!raw) return item

		const parsed = parseBranchName(raw)
		if (!parsed) return item

		const isTaken =
			deps?.branchExists ??
			((branch: string) => localBranchExists(repoPath, branch) || store.branchNameExists(branch, item.id))

		const base = parsed.type ? `${parsed.type}/${parsed.descriptionSlug}` : parsed.descriptionSlug
		const branchName = isTaken(base) ? `${base}-${itemSuffix(item)}` : base
		const planDirName = derivedItemPlanDirName(item, parsed.descriptionSlug)

		const named = commands.recordDerivedWorkspaceName(item.id, { branchName, planDirName })
		log.info('naming', `Derived branch name for Item ${item.id}: ${branchName} (${agent}/${model})`)
		return named
	} catch (err) {
		if (isCancellation(err, signal)) throw err
		log.warn(
			'naming',
			`Branch naming failed for Item ${item.id}, using default: ${err instanceof Error ? err.message : err}`,
		)
		return item
	}
}
