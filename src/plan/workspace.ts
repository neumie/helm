import { randomUUID } from 'node:crypto'
import {
	constants,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { type AgentKnowledgeCandidate, agentKnowledgeCandidatesSchema } from '../knowledge/schema.js'
import { type SolverResult, solverResultSchema } from '../solver/result-schema.js'
import { log } from '../util/logger.js'

const KNOWLEDGE_CANDIDATE_FILE_MAX_BYTES = 25_000

function lstatIfPresent(path: string) {
	try {
		return lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}

function assertReplaceableRuntimeFile(path: string): void {
	const stat = lstatIfPresent(path)
	if (!stat) return
	if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
		throw new Error(`Refusing unsafe Helm runtime file: ${path}`)
	}
}

/** Replace an auto-written artifact without ever following the destination. */
function writeRuntimeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true })
	assertReplaceableRuntimeFile(path)
	const temporary = join(dirname(path), `.${basename(path)}.helm-${randomUUID()}.tmp`)
	try {
		writeFileSync(temporary, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
		// Re-check after writing the private temp file. A same-user replacement can
		// only be replaced by rename; its bytes are never followed or truncated.
		assertReplaceableRuntimeFile(path)
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
}

function isPublicPlanMarkdown(name: string): boolean {
	return name.endsWith('.md') && !name.startsWith('.')
}

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
		loopPrompt: `${dir}/prompt.md`,
		result: `${dir}/solver-result.json`,
		knowledgeCandidates: `${dir}/.helm-knowledge-candidates.json`,
		knowledgeContext: `${dir}/.helm-knowledge-context.md`,
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
	get loopPromptPath(): string {
		return join(this.worktreePath, this.rel.loopPrompt)
	}
	get resultPath(): string {
		return join(this.worktreePath, this.rel.result)
	}
	get knowledgeCandidatesPath(): string {
		return join(this.worktreePath, this.rel.knowledgeCandidates)
	}
	get knowledgeContextPath(): string {
		return join(this.worktreePath, this.rel.knowledgeContext)
	}
	get readmePath(): string {
		return join(this.worktreePath, this.rel.readme)
	}

	ensureDir(): void {
		mkdirSync(this.dir, { recursive: true })
	}

	/** Write `context.md` (caller passes already-formatted markdown). */
	writeContext(content: string): void {
		writeRuntimeFile(this.contextPath, content)
	}
	writePlanningPrompt(content: string): void {
		writeRuntimeFile(this.planningPromptPath, content)
	}
	writeKnowledgeContext(content: string): void {
		writeRuntimeFile(this.knowledgeContextPath, content)
	}
	clearKnowledgeContext(): void {
		rmSync(this.knowledgeContextPath, { force: true })
	}
	appendLoopPromptOnce(marker: string, content: string): void {
		if (!this.loopPromptExists()) throw new Error(`Loop prompt not found: ${this.loopPromptPath}`)
		const current = readFileSync(this.loopPromptPath, 'utf-8')
		if (current.includes(marker)) return
		writeRuntimeFile(this.loopPromptPath, `${current.trimEnd()}\n\n${content.trim()}\n`)
	}
	setLoopPromptBlock(startMarker: string, endMarker: string, content: string | null): void {
		if (!this.loopPromptExists()) throw new Error(`Loop prompt not found: ${this.loopPromptPath}`)
		const current = readFileSync(this.loopPromptPath, 'utf-8')
		const start = current.indexOf(startMarker)
		let withoutBlock = current
		if (start !== -1) {
			const end = current.indexOf(endMarker, start + startMarker.length)
			// Development builds emitted this managed block without an end marker and
			// always appended it last; treat that legacy shape as extending to EOF.
			const after = end === -1 ? current.length : end + endMarker.length
			withoutBlock = `${current.slice(0, start).trimEnd()}\n${current.slice(after).trimStart()}`.trimEnd()
		}
		const next = content
			? `${withoutBlock.trimEnd()}\n\n${startMarker}\n${content.trim()}\n${endMarker}\n`
			: `${withoutBlock.trimEnd()}\n`
		writeRuntimeFile(this.loopPromptPath, next)
	}
	writeReadme(content: string): void {
		writeRuntimeFile(this.readmePath, content)
	}

	loopPromptExists(): boolean {
		return existsSync(this.loopPromptPath)
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
		// Candidate evidence is attempt-local and must never replay from a reused
		// worktree. Its `.helm-*` name keeps it out of git/PRs. Also clear the
		// pre-Hold filename left by development builds.
		rmSync(this.knowledgeCandidatesPath, { force: true })
		this.clearKnowledgeContext()
		rmSync(join(this.dir, '.helm-knowledge-proposals.json'), { force: true })
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

	knowledgeCandidatesExist(): boolean {
		return existsSync(this.knowledgeCandidatesPath)
	}

	/** Optional, gitignored candidate sidecar. Invalid content never fails solved work. */
	readKnowledgeCandidates(): AgentKnowledgeCandidate[] {
		if (!existsSync(this.knowledgeCandidatesPath)) return []
		let descriptor: number | null = null
		try {
			descriptor = openSync(
				this.knowledgeCandidatesPath,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			)
			const stat = fstatSync(descriptor)
			if (!stat.isFile() || stat.nlink !== 1) throw new Error('Candidate sidecar must be a single-link regular file')
			if (stat.size > KNOWLEDGE_CANDIDATE_FILE_MAX_BYTES) {
				throw new Error(`Candidate sidecar exceeds ${KNOWLEDGE_CANDIDATE_FILE_MAX_BYTES} bytes`)
			}
			const bytes = Buffer.alloc(KNOWLEDGE_CANDIDATE_FILE_MAX_BYTES + 1)
			let length = 0
			while (length < bytes.length) {
				const count = readSync(descriptor, bytes, length, bytes.length - length, null)
				if (count === 0) break
				length += count
			}
			if (length > KNOWLEDGE_CANDIDATE_FILE_MAX_BYTES) {
				throw new Error(`Candidate sidecar exceeds ${KNOWLEDGE_CANDIDATE_FILE_MAX_BYTES} bytes`)
			}
			return agentKnowledgeCandidatesSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf-8')))
		} catch (err) {
			log.warn('plan-workspace', `Could not read ${this.knowledgeCandidatesPath}`, err)
			return []
		} finally {
			if (descriptor !== null) closeSync(descriptor)
		}
	}

	/** Remove candidate bytes only after durable enqueue or deliberate unmapped discard. */
	clearKnowledgeCandidates(): void {
		rmSync(this.knowledgeCandidatesPath, { force: true })
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
			? readdirSync(this.dir).filter(name => isPublicPlanMarkdown(name) && !ignored.has(name))
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
	 * Each non-hidden `*.md` artifact in the plan dir as `{ name, content }`
	 * (oldest-first by mtime) for the dashboard plan preview. Private `.helm-*`
	 * evidence never crosses this boundary. Empty if the dir is absent/empty.
	 * Unlike `readArtifacts`, this keeps files separate (no `<plan_artifact>`
	 * wrapping) so the UI can list/expand them individually.
	 */
	listArtifacts(): Array<{ name: string; content: string }> {
		if (!existsSync(this.dir)) return []
		// Cap per-file content so one pathologically large plan doc can't bloat the
		// detail response — this is a preview, not the full prompt feed (readArtifacts).
		const MAX_PREVIEW_BYTES = 80_000
		return readdirSync(this.dir)
			.filter(isPublicPlanMarkdown)
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
	 * Concatenate every non-hidden `*.md` artifact in the plan dir (oldest-first
	 * by mtime), each wrapped in a `<plan_artifact>` block. Private `.helm-*`
	 * evidence is injected only through its attempt snapshot, never as an artifact.
	 * Null if the dir is absent/empty.
	 */
	readArtifacts(): string | null {
		if (!existsSync(this.dir)) return null

		const entries = readdirSync(this.dir)
			.filter(isPublicPlanMarkdown)
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
