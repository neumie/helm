import type { HelmConfig } from '../config.js'
import type { TaskContext } from '../providers/provider.js'
import type { SolverAgent } from '../solver/agent.js'
import { resolveHelperInvocation } from '../solver/models.js'
import { runOneShot } from '../solver/one-shot.js'
import type { OneShotOptions } from '../solver/one-shot.js'
import { isCancellation } from '../util/errors.js'
import { log } from '../util/logger.js'
import { slugify } from '../util/slug.js'
import { localBranchExists, remoteBranchExists } from '../worktree/manager.js'
import type { ItemCommands } from './commands.js'
import { derivedItemPlanDirName, itemSuffix } from './identity.js'
import type { ItemRecord } from './schema.js'

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

// ---------------------------------------------------------------------------
// Display naming — compress the raw provider title into a short human label for
// the dashboard. Cosmetic only; shares the cheap one-shot infra with branch
// naming but produces free text (a title), not a slug.
// ---------------------------------------------------------------------------

/** Titles at/under this length already read fine — skip the model call. */
const MIN_TITLE_LEN_TO_NAME = 40
const MAX_DISPLAY_WORDS = 8
const MAX_DISPLAY_LEN = 60

/** Default instruction block for display naming (the editable `solver.displayName.prompt`). */
export const DEFAULT_DISPLAY_INSTRUCTIONS = [
	'You write short, human-readable titles for software tasks. Reply with ONLY the title on a single line — no quotes, no surrounding punctuation, no explanation.',
	'',
	'Rules:',
	'- Imperative mood, like a pull-request title (e.g. "Unify invoice recipient logic")',
	'- At most 6 words',
	'- Drop ticket ids, bracketed prefixes (e.g. "[Echo]"), and any trailing period',
	"- Preserve the task's original language",
].join('\n')

export function buildDisplayNamePrompt(title: string, instructions: string = DEFAULT_DISPLAY_INSTRUCTIONS): string {
	return [instructions, '', `Task: ${title.slice(0, 500)}`, '', 'Short title:'].join('\n')
}

/**
 * True when a display name SHOULD exist but doesn't — i.e. `ensureItemDisplayName`
 * would attempt the model call but it hasn't landed. Mirrors the skip gates so a
 * deliberately-skipped short title is NOT treated as "missing" (it never wanted a
 * name). The enricher uses this to decide whether an enrichment genuinely failed
 * and is worth retrying.
 */
export function itemWantsDisplayName(item: ItemRecord, config: HelmConfig): boolean {
	const feature = config.solver.displayName
	return feature.enabled && !item.displayName && item.title.length > MIN_TITLE_LEN_TO_NAME
}

/**
 * Pull a clean short title out of raw model stdout. The answer is the last
 * non-empty line (agent preamble/log noise precedes it); strip wrapping
 * quotes/backticks, a leading bullet or `Title:` label, collapse whitespace,
 * drop a trailing period, and clamp to the word/char budget. Returns `null`
 * when nothing usable remains.
 */
export function parseDisplayName(raw: string): string | null {
	const lines = raw
		.split('\n')
		.map(l => l.trim())
		.filter(Boolean)
	if (lines.length === 0) return null

	let line = lines[lines.length - 1]
	line = line.replace(/^["'`]+|["'`]+$/g, '').trim()
	line = line
		.replace(/^[-*]\s+/, '')
		.replace(/^(short\s+)?title:\s*/i, '')
		.trim()
	line = line.replace(/^["'`]+|["'`]+$/g, '').trim()
	line = line
		.replace(/\s+/g, ' ')
		.replace(/[.\s]+$/, '')
		.trim()
	if (!line) return null

	const words = line.split(' ')
	let out = words.slice(0, MAX_DISPLAY_WORDS).join(' ')
	if (out.length > MAX_DISPLAY_LEN)
		out = out
			.slice(0, MAX_DISPLAY_LEN)
			.replace(/\s+\S*$/, '')
			.trim()
	return out || null
}

export interface EnsureItemDisplayNameDeps {
	runOneShot?: (opts: OneShotOptions) => Promise<string | null>
}

export interface EnsureItemDisplayNameParams {
	commands: ItemCommands
	item: ItemRecord
	config: HelmConfig
	/** Effective solver agent; defaults to the configured `solver.agent`. */
	agent?: SolverAgent
	signal?: AbortSignal
	deps?: EnsureItemDisplayNameDeps
	/**
	 * Manual (re)run from the dashboard: bypass the skip gates (feature-enabled,
	 * already-named, short-title) so the user can force a fresh name, and SURFACE
	 * failures (throw) instead of swallowing them — the automatic enricher path
	 * leaves `force` unset and stays best-effort.
	 */
	force?: boolean
	/**
	 * Solve-start guarantee: when enabled and unnamed, run even for an already-
	 * short title while keeping automatic best-effort failure behavior.
	 */
	generateWhenMissing?: boolean
}

/**
 * Optionally derive a short display name from the Item's raw `title` via a cheap
 * one-shot model call and persist it through `ItemCommands.recordDisplayName`.
 * Gated by `solver.displayName.enabled` (provider/model/prompt overridable on the
 * same block). No-op (returns the input Item) when disabled, already named, or the
 * title is already short. Solve startup may set `generateWhenMissing` to bypass
 * only that short-title optimization. Best-effort: a model failure, timeout, or
 * empty/unparseable answer degrades silently to the input Item so the dashboard
 * keeps showing the raw title. Re-throws only cancellation. A forced (manual)
 * run skips the gates and throws on failure so the caller can report it.
 */
export async function ensureItemDisplayName(params: EnsureItemDisplayNameParams): Promise<ItemRecord> {
	const { commands, item, config, signal, deps, force, generateWhenMissing } = params
	const feature = config.solver.displayName
	const current = force ? item : (commands.getItem(item.id) ?? item)
	if (!force && !feature.enabled) return current
	if (!force && current.displayName) return current
	if (!force && !generateWhenMissing && current.title.length <= MIN_TITLE_LEN_TO_NAME) return current

	const { agent, model } = resolveHelperInvocation(feature.agent, params.agent ?? config.solver.agent, feature.model)
	try {
		const run = deps?.runOneShot ?? runOneShot
		const raw = await run({ agent, model, prompt: buildDisplayNamePrompt(current.title, feature.prompt), signal })
		if (!raw) {
			if (force) throw new Error('Display naming model returned no output')
			return commands.getItem(item.id) ?? current
		}

		const name = parseDisplayName(raw)
		if (!name) {
			if (force) throw new Error('Could not parse a display name from the model output')
			return commands.getItem(item.id) ?? current
		}

		// The background Enricher may finish while this one-shot is in flight. Re-read
		// synchronously before writing so the first successful name wins.
		const latest = commands.getItem(item.id) ?? current
		if (!force && latest.displayName) return latest
		const named = commands.recordDisplayName(item.id, name)
		log.info('naming', `Derived display name for Item ${item.id}: "${name}" (${agent}/${model})`)
		return named
	} catch (err) {
		if (force || isCancellation(err, signal)) throw err
		log.warn(
			'naming',
			`Display naming failed for Item ${item.id}, keeping raw title: ${err instanceof Error ? err.message : err}`,
		)
		return commands.getItem(item.id) ?? current
	}
}

/** Default instruction block for branch naming (the editable `solver.branchNaming.prompt`). */
export const DEFAULT_NAMING_INSTRUCTIONS = [
	'You name git branches for a software task. Reply with ONLY the branch name on a single line — no quotes, no backticks, no explanation.',
	'',
	'Rules:',
	'- Format: <type>/<summary>',
	'- <type> is exactly one of: feat, fix, chore, refactor, docs, test, perf, build, ci',
	'- <summary> is 2-5 lowercase words joined by hyphens, describing the change',
	'- Use only the characters a-z, 0-9, hyphen and one slash',
	'- Keep the whole name under 50 characters',
].join('\n')

export function buildNamingPrompt(
	taskContext: TaskContext,
	instructions: string = DEFAULT_NAMING_INSTRUCTIONS,
): string {
	const lines = [instructions, '', `Task title: ${taskContext.title}`]
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
 * (codex) precedes it. Preference is purely positional: the FIRST allowed-type
 * token found scanning upward (= the last in the output) wins, regardless of
 * whether it's a clean whole line or shares a line with trailing text. A
 * whole-line token with a non-standard type is a weak last-resort fallback (slug
 * kept, type dropped). Returns `null` when nothing branch-shaped is found.
 */
export function parseBranchName(raw: string): ParsedName | null {
	const lines = raw
		.split('\n')
		.map(l => l.trim().toLowerCase())
		.filter(Boolean)

	let unknownFallback: ParsedName | null = null
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		// Allowed-type token anywhere on the line (tolerates trailing text). The
		// first one found bottom-up is the model's last answer line — positional
		// preference beats match shape, so a later labeled/trailing answer wins
		// over an earlier clean preamble line.
		const loose = line.match(NAME_TOKEN)
		if (loose && ALLOWED_TYPES.has(loose[1])) {
			const slug = slugify(loose[2])
			if (slug) return { type: loose[1], descriptionSlug: slug }
		}
		// Require the WHOLE line for a non-standard type so a slash buried in prose
		// (e.g. "and/or") is ignored; keep the last such line as a weak fallback.
		if (!unknownFallback) {
			const whole = line.match(WHOLE_TOKEN)
			if (whole && !ALLOWED_TYPES.has(whole[1])) {
				const slug = slugify(whole[2])
				if (slug) unknownFallback = { descriptionSlug: slug }
			}
		}
	}
	return unknownFallback
}

/** Trim a slug to `max` chars without leaving a trailing hyphen. */
function clampSlug(slug: string, max: number): string {
	if (slug.length <= max) return slug
	const cut = slug.slice(0, max).replace(/-+$/, '')
	return cut || slug.slice(0, max)
}

export interface EnsureItemNameDeps {
	runOneShot?: (opts: OneShotOptions) => Promise<string | null>
	branchExists?: (branch: string) => boolean | Promise<boolean>
}

export interface EnsureItemNameParams {
	commands: ItemCommands
	item: ItemRecord
	taskContext: TaskContext
	config: HelmConfig
	repoPath: string
	/** Effective solver agent, resolved by the caller (selected agent ?? config). */
	agent: SolverAgent
	signal?: AbortSignal
	deps?: EnsureItemNameDeps
	/**
	 * Manual (re)run from the dashboard: bypass the feature-enabled and
	 * already-named gates so the user can force a fresh branch name, and throw on
	 * failure instead of silently keeping the default. The solve-only structural
	 * gate still applies; callers must additionally ensure no worktree exists yet
	 * (renaming the branch after a worktree is created would desync it).
	 */
	force?: boolean
}

/**
 * Optionally replace the default `helm/item/<slug>` branch with a conventional,
 * model-derived name (`feat/…`, `fix/…`) when `solver.nameModel.enabled`. Persists
 * through `ItemCommands` and returns the resulting Item (the updated row, or the
 * input unchanged when naming is disabled/declined) so callers can pass it
 * straight to `resolveItemWorkspace` without a reload. A model failure, timeout,
 * or unparseable answer degrades silently to the input Item, so the deterministic
 * default still applies. Cancellation is re-thrown (callers run inside the
 * pipeline's abort-aware catch); nothing else throws.
 */
export async function ensureItemWorkspaceName(params: EnsureItemNameParams): Promise<ItemRecord> {
	const { commands, item, taskContext, config, repoPath, signal, deps, force } = params
	const feature = config.solver.branchNaming
	if (!force && !feature.enabled) return item
	// Solve-only: enforced here (not just at call sites) so the plan route can't
	// name a loop Item — loop Items keep the deterministic helm/item name.
	// Structural; applies even to a forced manual run.
	if (item.kind !== 'solve') return item
	if (!force && item.branchName) return item // already planned / forked / named

	// A curated model implies its owning CLI; custom model ids retain the
	// per-feature provider override or effective solve agent.
	const { agent, model } = resolveHelperInvocation(feature.agent, params.agent, feature.model)
	try {
		const run = deps?.runOneShot ?? runOneShot
		const raw = await run({
			agent,
			model,
			prompt: buildNamingPrompt(taskContext, feature.prompt),
			signal,
		})
		if (!raw) {
			if (force) throw new Error('Branch naming model returned no output')
			return item
		}

		const parsed = parseBranchName(raw)
		if (!parsed) {
			if (force) throw new Error('Could not parse a branch name from the model output')
			return item
		}

		// Clamp the slug so the assembled `type/slug` honors the whole-name budget
		// the prompt advertises (the model's answer is untrusted and may be long).
		const prefix = parsed.type ? `${parsed.type}/` : ''
		const descriptionSlug = clampSlug(parsed.descriptionSlug, Math.max(8, MAX_BRANCH_LEN - prefix.length))
		const base = `${prefix}${descriptionSlug}`
		const planDirName = derivedItemPlanDirName(item, descriptionSlug)

		// Git existence is checked here (not transactional); the DB existence check +
		// suffix decision + write happen atomically inside recordDerivedWorkspaceName
		// so two concurrent solves can't both reserve the same derived branch.
		const gitTaken = deps?.branchExists
			? await deps.branchExists(base)
			: (await localBranchExists(repoPath, base)) || (await remoteBranchExists(repoPath, base))

		const named = commands.recordDerivedWorkspaceName(item.id, {
			base,
			suffix: itemSuffix(item),
			planDirName,
			gitTaken,
			force,
		})
		log.info('naming', `Derived branch name for Item ${item.id}: ${named.branchName} (${agent}/${model})`)
		return named
	} catch (err) {
		if (force || isCancellation(err, signal)) throw err
		log.warn(
			'naming',
			`Branch naming failed for Item ${item.id}, using default: ${err instanceof Error ? err.message : err}`,
		)
		return item
	}
}
