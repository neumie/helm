import type { VigilConfig } from '../config.js'
import type { TaskContext } from '../providers/provider.js'
import type { SolverAgent } from '../solver/agent.js'
import { runOneShot } from '../solver/one-shot.js'
import type { OneShotOptions } from '../solver/one-shot.js'
import { isCancellation } from '../util/errors.js'
import { log } from '../util/logger.js'
import { slugify } from '../util/slug.js'
import { localBranchExists, remoteBranchExists } from '../worktree/manager.js'
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

/** Whole branch name budget; the slug is clamped so the assembled name honors it. */
const MAX_BRANCH_LEN = 50

// A conventional token anywhere in a line. Non-anchored so wrapping quotes/
// backticks/bullets and trailing prose ("feat/x (recommended)", "- feat/x # note")
// don't defeat extraction.
const NAME_TOKEN = /([a-z]+)\/([a-z0-9][a-z0-9-]*)/
// A line that is EXACTLY a token — used to accept a non-standard type the model
// clearly meant as the whole answer, without matching a slash buried in prose.
const WHOLE_TOKEN = /^([a-z]+)\/([a-z0-9][a-z0-9-]*)$/

/**
 * Pull a `<type>/<slug>` branch name out of raw model stdout. Scans bottom-up —
 * the model's branch name is its last meaningful line; agent preamble/log noise
 * (codex) precedes it, so the last match is the answer. Priority: a clean whole-
 * line conventional name, else a conventional token sharing a line with extra
 * text, else a whole-line token with a non-standard type (slug kept, type
 * dropped). Returns `null` when nothing branch-shaped is found so the caller can
 * fall back to the deterministic default.
 */
export function parseBranchName(raw: string): ParsedName | null {
	const lines = raw
		.split('\n')
		.map(l => l.trim().toLowerCase())
		.filter(Boolean)

	let wholeAllowed: ParsedName | null = null
	let looseAllowed: ParsedName | null = null
	let wholeUnknown: ParsedName | null = null

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		const whole = line.match(WHOLE_TOKEN)
		if (whole) {
			const slug = slugify(whole[2])
			if (slug) {
				if (ALLOWED_TYPES.has(whole[1])) wholeAllowed ??= { type: whole[1], descriptionSlug: slug }
				else wholeUnknown ??= { descriptionSlug: slug }
			}
		}
		const loose = line.match(NAME_TOKEN)
		if (loose && ALLOWED_TYPES.has(loose[1])) {
			const slug = slugify(loose[2])
			if (slug) looseAllowed ??= { type: loose[1], descriptionSlug: slug }
		}
	}

	return wholeAllowed ?? looseAllowed ?? wholeUnknown
}

/** Trim a slug to `max` chars without leaving a trailing hyphen. */
function clampSlug(slug: string, max: number): string {
	if (slug.length <= max) return slug
	const cut = slug.slice(0, max).replace(/-+$/, '')
	return cut || slug.slice(0, max)
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
			signal,
		})
		if (!raw) return item

		const parsed = parseBranchName(raw)
		if (!parsed) return item

		const isTaken =
			deps?.branchExists ??
			((branch: string) =>
				localBranchExists(repoPath, branch) ||
				remoteBranchExists(repoPath, branch) ||
				store.branchNameExists(branch, item.id))

		// Clamp the slug so the assembled `type/slug` honors the whole-name budget
		// the prompt advertises (the model's answer is untrusted and may be long).
		const prefix = parsed.type ? `${parsed.type}/` : ''
		const descriptionSlug = clampSlug(parsed.descriptionSlug, Math.max(8, MAX_BRANCH_LEN - prefix.length))
		const base = `${prefix}${descriptionSlug}`
		const branchName = isTaken(base) ? `${base}-${itemSuffix(item)}` : base
		const planDirName = derivedItemPlanDirName(item, descriptionSlug)

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
