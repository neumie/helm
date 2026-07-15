import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type SolverResult, solverResultSchema } from '../solver/result-schema.js'
import { log } from '../util/logger.js'

/**
 * Relative-to-worktree paths (POSIX separators — safe to embed in prompts and
 * `$(cat ...)` shell commands) for a task's plan directory.
 */
export interface LocalPlanReadiness {
	specName: string | null
	tickets: {
		total: number
		open: number
		readyForAgent: number
		readyForHuman: number
	}
}

export function planPaths(planDirName: string) {
	const dir = `docs/plans/${planDirName}`
	return {
		dir,
		context: `${dir}/context.md`,
		planningPrompt: `${dir}/.planning-prompt.txt`,
		result: `${dir}/solver-result.json`,
		readme: `${dir}/README.md`,
	}
}

/**
 * Deep module owning the on-disk `docs/plans/<planDirName>/` layout. The single
 * place that knows where `context.md` / `.planning-prompt.txt` /
 * `solver-result.json` / `README.md` live, so the solver prompt, the result
 * reader, and the okena poll path can never disagree about paths.
 *
 * Concerns the on-disk layout only — formatting of file *contents*
 * (`formatTaskContext`, prompt building) stays with the caller, which keeps this
 * module free of upward dependencies.
 */
export class PlanWorkspace {
	/** Relative-to-worktree paths, for prompts and shell commands. */
	readonly rel: ReturnType<typeof planPaths>

	constructor(
		private readonly worktreePath: string,
		readonly planDirName: string,
	) {
		this.rel = planPaths(planDirName)
	}

	get dir(): string {
		return join(this.worktreePath, this.rel.dir)
	}
	get contextPath(): string {
		return join(this.worktreePath, this.rel.context)
	}
	get planningPromptPath(): string {
		return join(this.worktreePath, this.rel.planningPrompt)
	}
	get resultPath(): string {
		return join(this.worktreePath, this.rel.result)
	}
	get readmePath(): string {
		return join(this.worktreePath, this.rel.readme)
	}

	ensureDir(): void {
		mkdirSync(this.dir, { recursive: true })
	}

	/** Write `context.md` (caller passes already-formatted markdown). */
	writeContext(content: string): void {
		this.ensureDir()
		writeFileSync(this.contextPath, content, 'utf-8')
	}
	writePlanningPrompt(content: string): void {
		this.ensureDir()
		writeFileSync(this.planningPromptPath, content, 'utf-8')
	}
	writeReadme(content: string): void {
		this.ensureDir()
		writeFileSync(this.readmePath, content, 'utf-8')
	}

	resultExists(): boolean {
		return existsSync(this.resultPath)
	}

	/**
	 * Delete any stale `solver-result.json` left in a reused worktree by a prior
	 * run. Call BEFORE solving: okena's poll loop waits on `resultExists()`, and a
	 * leftover result makes it exit instantly — reporting the old result as success
	 * and (worse) racing the freshly-launched agent's `cat` of the prompt file to
	 * deletion. `force: true` no-ops when absent.
	 */
	clearResult(): void {
		rmSync(this.resultPath, { force: true })
	}

	/** Read + validate `solver-result.json`. Null if absent or invalid. */
	readResult(): SolverResult | null {
		try {
			return solverResultSchema.parse(JSON.parse(readFileSync(this.resultPath, 'utf-8')))
		} catch (err) {
			log.warn('plan-workspace', `Could not read ${this.resultPath}`, err)
			return null
		}
	}

	/** Read the local spec + ticket queue without interpreting Item lifecycle. */
	readLocalReadiness(): LocalPlanReadiness {
		const specName = existsSync(join(this.dir, 'spec.md'))
			? 'spec.md'
			: existsSync(join(this.dir, 'prd.md'))
				? 'prd.md'
				: null
		const issuesDir = join(this.dir, 'issues')
		const names = existsSync(issuesDir) ? readdirSync(issuesDir).filter(name => name.endsWith('.md')) : []
		const tickets = { total: names.length, open: 0, readyForAgent: 0, readyForHuman: 0 }
		for (const name of names) {
			const content = readFileSync(join(issuesDir, name), 'utf-8')
			const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? ''
			const status = /^status:\s*([^\s#]+)/im.exec(frontmatter)?.[1]?.toLowerCase() ?? 'open'
			const legacyType = /^type:\s*([^\s#]+)/im.exec(frontmatter)?.[1]?.toLowerCase() ?? null
			if (['done', 'closed', 'complete', 'completed'].includes(status)) continue
			tickets.open += 1
			if (status === 'ready-for-human' || legacyType === 'hitl') tickets.readyForHuman += 1
			else if (status === 'ready-for-agent' || status === 'open') tickets.readyForAgent += 1
		}
		return { specName, tickets }
	}

	/**
	 * Resolve the plan file Almanac should execute. Prefer the conventional PRD,
	 * then spec.md; otherwise accept exactly one user-authored markdown file.
	 */
	loopArtifactPath(): string {
		const ignored = new Set(['README.md', 'context.md'])
		const names = existsSync(this.dir)
			? readdirSync(this.dir).filter(name => name.endsWith('.md') && !ignored.has(name))
			: []
		const selected = names.includes('prd.md')
			? 'prd.md'
			: names.includes('spec.md')
				? 'spec.md'
				: names.length === 1
					? names[0]
					: null
		if (!selected) {
			throw new Error(
				names.length === 0
					? 'No runnable plan artifact found. Create prd.md or spec.md in the plan.'
					: 'Multiple plan artifacts found. Add prd.md or spec.md to choose what the loop should run.',
			)
		}
		return `${this.rel.dir}/${selected}`
	}

	/**
	 * Each `*.md` artifact in the plan dir as `{ name, content }` (oldest-first by
	 * mtime) for the dashboard plan preview. Empty if the dir is absent/empty.
	 * Unlike `readArtifacts`, this keeps files separate (no `<plan_artifact>`
	 * wrapping) so the UI can list/expand them individually.
	 */
	listArtifacts(): Array<{ name: string; content: string }> {
		if (!existsSync(this.dir)) return []
		// Cap per-file content so one pathologically large plan doc can't bloat the
		// detail response — this is a preview, not the full prompt feed (readArtifacts).
		const MAX_PREVIEW_BYTES = 80_000
		return readdirSync(this.dir)
			.filter(name => name.endsWith('.md'))
			.map(name => {
				const fullPath = join(this.dir, name)
				const raw = readFileSync(fullPath, 'utf-8')
				const content =
					raw.length > MAX_PREVIEW_BYTES ? `${raw.slice(0, MAX_PREVIEW_BYTES)}\n\n… (truncated for preview)` : raw
				return { name, content, mtime: statSync(fullPath).mtimeMs }
			})
			.sort((a, b) => a.mtime - b.mtime)
			.map(({ name, content }) => ({ name, content }))
	}

	/**
	 * Concatenate every `*.md` artifact in the plan dir (oldest-first by mtime),
	 * each wrapped in a `<plan_artifact>` block. Null if the dir is absent/empty.
	 */
	readArtifacts(): string | null {
		if (!existsSync(this.dir)) return null

		const entries = readdirSync(this.dir)
			.filter(name => name.endsWith('.md'))
			.map(name => {
				const fullPath = join(this.dir, name)
				return { name, fullPath, mtime: statSync(fullPath).mtimeMs }
			})
			.sort((a, b) => a.mtime - b.mtime)

		if (entries.length === 0) return null

		let out = ''
		for (const entry of entries) {
			const content = readFileSync(entry.fullPath, 'utf-8')
			const mtimeIso = new Date(entry.mtime).toISOString()
			out += `<plan_artifact path="${this.rel.dir}/${entry.name}" mtime="${mtimeIso}">\n${content}\n</plan_artifact>\n\n`
		}
		return out
	}
}
