import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import type { ItemRecord, PlanStatus, TicketQueueSummary } from '../items/schema.js'
import { log } from '../util/logger.js'
import { PlanWorkspace } from './workspace.js'

const execFileAsync = promisify(execFile)
const DEFAULT_INTERVAL_MS = 15_000

interface GhIssue {
	state?: string
	labels?: Array<{ name?: string }>
	body?: string
}

const emptyQueue = (): TicketQueueSummary => ({ total: 0, open: 0, readyForAgent: 0, readyForHuman: 0 })

export function parseGithubPlanQueues(stdout: string): Map<string, TicketQueueSummary> {
	let decoded: unknown
	try {
		decoded = JSON.parse(stdout)
	} catch (err) {
		throw new Error(`gh returned invalid issue JSON: ${err instanceof Error ? err.message : err}`)
	}
	if (!Array.isArray(decoded)) throw new Error('gh returned a non-array issue response')
	const issues = decoded as GhIssue[]
	const queues = new Map<string, TicketQueueSummary>()
	for (const issue of issues) {
		const labels = (issue.labels ?? []).map(label => label.name ?? '')
		const specPath = /docs\/plans\/([^/`\s]+)\/(?:spec|prd)\.md/.exec(issue.body ?? '')
		const queueLabel = labels.map(label => /^(?:loop|ralph)\((.+)\)$/.exec(label)).find(match => match !== null)
		// The issue body owns the canonical association: `/to-tickets` can choose
		// a concise queue label that differs from Helm's stable plan directory.
		const planDirName = specPath?.[1] ?? queueLabel?.[1]
		if (!planDirName) continue
		const summary = queues.get(planDirName) ?? emptyQueue()
		summary.total += 1
		if ((issue.state ?? '').toUpperCase() === 'OPEN') {
			summary.open += 1
			if (labels.includes('ready-for-human')) summary.readyForHuman += 1
			else summary.readyForAgent += 1
		}
		queues.set(planDirName, summary)
	}
	return queues
}

export async function fetchGithubPlanQueues(repoPath: string): Promise<Map<string, TicketQueueSummary>> {
	const { stdout } = await execFileAsync(
		'gh',
		['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'state,labels,body'],
		{ cwd: repoPath, timeout: 10_000, maxBuffer: 20 * 1024 * 1024 },
	)
	return parseGithubPlanQueues(stdout)
}

export interface PlanStatusWatcherDeps {
	fetchGithubQueues?: typeof fetchGithubPlanQueues
	intervalMs?: number
}

function semanticStatus(status: PlanStatus): Omit<PlanStatus, 'checkedAt'> {
	const { checkedAt: _checkedAt, ...semantic } = status
	return semantic
}

function sameStatus(left: PlanStatus | null, right: PlanStatus): boolean {
	return left !== null && JSON.stringify(semanticStatus(left)) === JSON.stringify(semanticStatus(right))
}

/**
 * Observes plan/spec/ticket readiness off the request path and caches it on the
 * Item row. List contracts remain cheap; GitHub failures degrade to the last
 * known counts and never affect lifecycle or execution.
 */
export class PlanStatusWatcher {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running = false
	private readonly fetchGithubQueues: typeof fetchGithubPlanQueues
	private readonly intervalMs: number
	private readonly githubFailures = new Set<string>()

	constructor(
		private readonly config: HelmConfig,
		private readonly db: DB,
		deps: PlanStatusWatcherDeps = {},
	) {
		this.fetchGithubQueues = deps.fetchGithubQueues ?? fetchGithubPlanQueues
		this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
	}

	start(): void {
		if (this.running) return
		this.running = true
		log.info('plan-status', `Starting plan status watcher (interval: ${Math.round(this.intervalMs / 1000)}s)`)
		void this.tick()
	}

	stop(): void {
		this.running = false
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		log.info('plan-status', 'Plan status watcher stopped')
	}

	async pollOnce(): Promise<void> {
		const items = this.db.items.listPlanWatchable()
		const projectSlugs = [...new Set(items.map(item => item.projectSlug))]
		const githubByProject = new Map<string, Map<string, TicketQueueSummary> | null>()
		await Promise.all(
			projectSlugs.map(async slug => {
				const project = this.config.projects.find(candidate => candidate.slug === slug)
				if (!project) {
					githubByProject.set(slug, null)
					return undefined
				}
				try {
					githubByProject.set(slug, await this.fetchGithubQueues(project.repoPath))
					this.githubFailures.delete(slug)
				} catch (err) {
					githubByProject.set(slug, null)
					if (!this.githubFailures.has(slug)) {
						this.githubFailures.add(slug)
						log.warn(
							'plan-status',
							`Could not read GitHub ticket queues for ${slug}: ${err instanceof Error ? err.message : err}`,
						)
					}
				}
				return undefined
			}),
		)

		for (const item of items) this.observeItem(item, githubByProject.get(item.projectSlug) ?? null)
	}

	private observeItem(item: ItemRecord, githubQueues: Map<string, TicketQueueSummary> | null): void {
		if (!item.worktreePath || !item.planDirName || !existsSync(item.worktreePath)) return
		try {
			const local = new PlanWorkspace(item.worktreePath, item.planDirName).readLocalReadiness()
			const githubAvailable = githubQueues !== null
			const githubTickets = githubAvailable
				? (githubQueues.get(item.planDirName) ?? emptyQueue())
				: (item.planStatus?.githubTickets ?? emptyQueue())
			const ticketTotal = local.tickets.total + githubTickets.total
			const next: PlanStatus = {
				stage: ticketTotal > 0 ? 'tickets_ready' : local.specName ? 'plan_ready' : 'planning',
				specName: local.specName,
				localTickets: local.tickets,
				githubTickets,
				githubAvailable,
				checkedAt: new Date().toISOString(),
			}
			if (!sameStatus(item.planStatus, next)) {
				new ItemCommands(this.db.forProfile(item.profileId).items, this.config).recordPlanStatus(item.id, next)
			}
		} catch (err) {
			log.warn('plan-status', `Could not inspect plan for Item ${item.id}: ${err instanceof Error ? err.message : err}`)
		}
	}

	private async tick(): Promise<void> {
		if (!this.running) return
		try {
			await this.pollOnce()
		} catch (err) {
			log.error('plan-status', 'Plan status watcher failed', err)
		}
		if (this.running) {
			this.timer = setTimeout(() => void this.tick(), this.intervalMs)
			this.timer.unref?.()
		}
	}
}
