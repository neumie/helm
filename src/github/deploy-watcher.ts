import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import type { DeployState, DeploymentEntry } from '../items/schema.js'
import { log } from '../util/logger.js'

const execFileAsync = promisify(execFile)

/** owner/repo from a GitHub PR URL (the deploy lookups key off these). */
export function parsePrUrl(url: string): { owner: string; repo: string } | null {
	const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/)
	return m ? { owner: m[1], repo: m[2] } : null
}

/**
 * Only http(s) deployment URLs are safe to render as a clickable link — a
 * deployment status's environment_url/target_url is set by whoever created the
 * deployment (an attacker-controlled workflow could inject a `javascript:` URI),
 * so anything else is dropped at the source before it's persisted.
 */
export function httpUrlOrNull(url: string | null | undefined): string | null {
	if (!url) return null
	try {
		const parsed = new URL(url)
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null
	} catch {
		return null
	}
}

/** Run `gh` and JSON-parse stdout. Best-effort: any failure (gh missing, auth,
 *  network, non-JSON) returns null so the watcher degrades to a no-op. */
async function ghJson<T = unknown>(args: string[]): Promise<T | null> {
	try {
		const { stdout } = await execFileAsync('gh', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
		return JSON.parse(stdout) as T
	} catch {
		return null
	}
}

interface GhPrView {
	state?: string
	mergedAt?: string | null
	mergeCommit?: { oid?: string } | null
}
interface GhDeployment {
	id?: number
	environment?: string
	updated_at?: string
}
interface GhDeploymentStatus {
	state?: string
	environment_url?: string
	target_url?: string
	updated_at?: string
}

/**
 * Observe the post-ship lifecycle of a PR from GitHub: is it merged, and which
 * environments has its merge commit been deployed to (+ each deployment's latest
 * status). Returns null when the repo can't be derived or the PR can't be read.
 */
export async function fetchDeployState(prUrl: string, checkedAt: string): Promise<DeployState | null> {
	const repo = parsePrUrl(prUrl)
	if (!repo) return null
	const pr = await ghJson<GhPrView>(['pr', 'view', prUrl, '--json', 'state,mergedAt,mergeCommit'])
	if (!pr) return null

	const merged = pr.state === 'MERGED'
	const mergedAt = pr.mergedAt ?? null
	const mergeSha = pr.mergeCommit?.oid ?? null

	const deployments: DeploymentEntry[] = []
	if (merged && mergeSha) {
		const base = `repos/${repo.owner}/${repo.repo}`
		const deps = await ghJson<GhDeployment[]>(['api', `${base}/deployments?sha=${mergeSha}&per_page=100`])
		if (Array.isArray(deps)) {
			for (const d of deps) {
				if (d.id === undefined) continue
				const statuses = await ghJson<GhDeploymentStatus[]>(['api', `${base}/deployments/${d.id}/statuses?per_page=1`])
				const latest = Array.isArray(statuses) ? statuses[0] : null
				deployments.push({
					environment: String(d.environment ?? 'unknown'),
					state: latest?.state ? String(latest.state) : 'pending',
					url: httpUrlOrNull(latest?.environment_url) ?? httpUrlOrNull(latest?.target_url),
					updatedAt: latest?.updated_at ?? d.updated_at ?? null,
				})
			}
		}
	}

	return { merged, mergedAt, mergeSha, deployments, checkedAt }
}

/**
 * Ask gh whether the branch has an OPEN or MERGED PR in the repo at `repoPath`.
 * CLOSED (unmerged, abandoned) PRs are deliberately ignored — gh's branch
 * lookup falls back to the most recent closed PR when no open one exists, and
 * recording a dead PR would poll it forever and block a real late PR from ever
 * being recorded. Best-effort: returns null on no PR / gh failure.
 */
async function discoverPrUrlByBranch(repoPath: string, branchName: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('gh', ['pr', 'view', branchName, '--json', 'url,state'], {
			cwd: repoPath,
			timeout: 10_000,
		})
		const parsed = JSON.parse(stdout) as { url?: unknown; state?: unknown }
		if (parsed.state !== 'OPEN' && parsed.state !== 'MERGED') return null
		return typeof parsed.url === 'string' && parsed.url ? parsed.url : null
	} catch {
		return null
	}
}

/**
 * The branch the worktree is ACTUALLY on. Old runs (and rogue agents) renamed
 * the branch mid-run, so the stored `branchName` can be stale while the PR
 * lives on the worktree's current branch. Best-effort: null when the worktree
 * is gone or git fails.
 */
async function readWorktreeBranch(worktreePath: string): Promise<string | null> {
	if (!existsSync(worktreePath)) return null
	try {
		const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
			cwd: worktreePath,
			timeout: 10_000,
		})
		return stdout.trim() || null
	} catch {
		return null
	}
}

/** Injectable seams so tests can run the watcher without a real `gh`/`git`. */
export interface DeployWatcherDeps {
	fetchDeployState?: typeof fetchDeployState
	discoverPrUrl?: typeof discoverPrUrlByBranch
	readWorktreeBranch?: typeof readWorktreeBranch
}

/**
 * Periodically reconciles each shipped Item's deploy lifecycle from GitHub
 * (PR merge + GitHub Deployments per environment) and persists it through
 * `ItemCommands.recordDeployState`, which records `deploy_merged` /
 * `deploy_succeeded` transition events. Mirrors the provider `Poller`. Read-only
 * w.r.t. GitHub; runs independently of the Drainer (safe while paused).
 *
 * Also backfills LATE PRs: a run that errored/timed out but was reconciled to
 * `review` may have had its agent ship a PR after helm stopped watching — the
 * Item then sits in review with a branch but no `prUrl`, invisible to deploy
 * tracking. Each poll asks gh for a PR on those branches and records a hit
 * through `recordDispatchPr`, after which normal deploy tracking picks it up.
 */
export class DeployWatcher {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running = false
	private readonly commands: ItemCommands
	private readonly intervalSeconds: number
	private readonly fetchState: typeof fetchDeployState
	private readonly discoverPr: typeof discoverPrUrlByBranch
	private readonly readBranch: typeof readWorktreeBranch

	constructor(
		private config: HelmConfig,
		private db: DB,
		deps: DeployWatcherDeps = {},
	) {
		this.commands = new ItemCommands(db.items, config)
		this.intervalSeconds = config.github.deployPollSeconds
		this.fetchState = deps.fetchDeployState ?? fetchDeployState
		this.discoverPr = deps.discoverPrUrl ?? discoverPrUrlByBranch
		this.readBranch = deps.readWorktreeBranch ?? readWorktreeBranch
	}

	start() {
		if (this.running) return
		if (!this.config.github.trackDeployments) {
			log.info('deploy', 'Deploy tracking disabled (github.trackDeployments=false)')
			return
		}
		this.running = true
		log.info('deploy', `Starting deploy watcher (interval: ${this.intervalSeconds}s)`)
		this.tick()
	}

	stop() {
		this.running = false
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
		log.info('deploy', 'Deploy watcher stopped')
	}

	async pollOnce() {
		await this.backfillLatePrs()
		const items = this.db.items.listDeployWatchable()
		for (const item of items) {
			if (!item.prUrl) continue
			try {
				const state = await this.fetchState(item.prUrl, new Date().toISOString())
				if (!state) continue
				const updated = this.commands.recordDeployState(item.id, state)
				// A merged PR means the work landed — drop it out of the review pile.
				if (state.merged && updated.status === 'review') this.commands.markItemMerged(item.id)
			} catch (err) {
				log.error('deploy', `Error checking deploy state for Item ${item.id}`, err)
			}
		}
	}

	/** Record PRs that appeared on an errored-run branch after the run ended. */
	private async backfillLatePrs() {
		for (const item of this.db.items.listPrBackfillable()) {
			const project = this.config.projects.find(p => p.slug === item.projectSlug)
			if (!project || !item.branchName) continue
			try {
				let prUrl = await this.discoverPr(project.repoPath, item.branchName)
				if (!prUrl && item.worktreePath) {
					// The agent may have renamed the branch mid-run — the PR then lives
					// on the worktree's CURRENT branch, not the stored one.
					const liveBranch = await this.readBranch(item.worktreePath)
					if (liveBranch && liveBranch !== item.branchName) {
						prUrl = await this.discoverPr(project.repoPath, liveBranch)
					}
				}
				if (!prUrl) continue
				this.commands.recordDispatchPr(item.id, { prUrl, shippedByAgent: true })
				log.info('deploy', `Backfilled late PR for Item ${item.id}: ${prUrl}`)
			} catch (err) {
				// Item may have raced out of `review` between list and write — skip.
				log.warn('deploy', `Late-PR backfill failed for Item ${item.id}: ${err instanceof Error ? err.message : err}`)
			}
		}
	}

	private async tick() {
		if (!this.running) return
		await this.pollOnce()
		if (this.running) {
			this.timer = setTimeout(() => this.tick(), this.intervalSeconds * 1000)
		}
	}
}
