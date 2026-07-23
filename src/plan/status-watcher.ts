import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import type { ItemRecord, PlanStatus, TicketQueueSummary } from '../items/schema.js'
import type { ItemKeysetCursor } from '../items/store.js'
import { log } from '../util/logger.js'
import { PlanWorkspace } from './workspace.js'

const execFileAsync = promisify(execFile)
const DEFAULT_INTERVAL_MS = 15_000
export const PLAN_ITEM_BUDGET_PER_TICK = 400
export const PLAN_PROJECT_FETCH_BUDGET_PER_TICK = 25
export const PLAN_GITHUB_CONCURRENCY = 4

interface GhIssue {
	state?: string
	labels?: Array<{ name?: string }>
	body?: string
}

const emptyQueue = (): TicketQueueSummary => ({ total: 0, open: 0, readyForAgent: 0, readyForHuman: 0 })
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true

export function parseGithubPlanQueues(stdout: string): Map<string, TicketQueueSummary> {
	let decoded: unknown
	try {
		decoded = JSON.parse(stdout)
	} catch (err) {
		throw new Error(`gh returned invalid issue JSON: ${err instanceof Error ? err.message : err}`)
	}
	if (!Array.isArray(decoded)) throw new Error('gh returned a non-array issue response')
	const queues = new Map<string, TicketQueueSummary>()
	for (const issue of decoded as GhIssue[]) {
		const labels = (issue.labels ?? []).map(label => label.name ?? '')
		const specPath = /docs\/plans\/([^/`\s]+)\/(?:spec|prd)\.md/.exec(issue.body ?? '')
		const queueLabel = labels.map(label => /^(?:loop|ralph)\((.+)\)$/.exec(label)).find(match => match !== null)
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

export async function fetchGithubPlanQueues(
	repoPath: string,
	options: { signal?: AbortSignal } = {},
): Promise<Map<string, TicketQueueSummary>> {
	const { stdout } = await execFileAsync(
		'gh',
		['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'state,labels,body'],
		{ cwd: repoPath, timeout: 10_000, maxBuffer: 20 * 1024 * 1024, signal: options.signal },
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

interface PlanCandidate {
	profileId: string
	item: ItemRecord
	/** Original list key; plan-status writes change updatedAt. */
	cursor: ItemKeysetCursor
	commands: ItemCommands
	completed: boolean
	deferred: boolean
}

/** Bounded, fair plan/spec/ticket observer. Lifecycle remains in ItemCommands. */
export class PlanStatusWatcher {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running = false
	private currentTick: Promise<void> | null = null
	private currentAbort: AbortController | null = null
	private stopDrain: Promise<void> | null = null
	private profileStart = 0
	private projectStart = 0
	private readonly cursors = new Map<string, ItemKeysetCursor>()
	private readonly fetchGithubQueues: typeof fetchGithubPlanQueues
	private readonly intervalMs: number
	private readonly githubFailures = new Set<string>()
	private readonly profileIds: () => string[]

	constructor(
		private readonly config: HelmConfig,
		private readonly db: DB,
		depsOrProfileIds: PlanStatusWatcherDeps | (() => string[]) = {},
		profileIds: () => string[] = () => [db.currentProfileId()],
	) {
		const deps = typeof depsOrProfileIds === 'function' ? {} : depsOrProfileIds
		this.profileIds = typeof depsOrProfileIds === 'function' ? depsOrProfileIds : profileIds
		this.fetchGithubQueues = deps.fetchGithubQueues ?? fetchGithubPlanQueues
		this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
	}

	start(): void {
		if (this.running) return
		this.running = true
		this.stopDrain = null
		log.info('plan-status', `Starting plan status watcher (interval: ${Math.round(this.intervalMs / 1000)}s)`)
		void this.tick()
	}

	stop(): Promise<void> {
		if (this.stopDrain) return this.stopDrain
		this.running = false
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		this.currentAbort?.abort()
		this.stopDrain = (this.currentTick ?? Promise.resolve()).then(() => undefined)
		log.info('plan-status', 'Plan status watcher stopped')
		return this.stopDrain
	}

	async pollOnce(signal?: AbortSignal): Promise<void> {
		if (this.currentTick) return this.currentTick
		const controller = new AbortController()
		const abortExternal = () => controller.abort()
		signal?.addEventListener('abort', abortExternal, { once: true })
		this.currentAbort = controller
		this.currentTick = this.runPoll(controller.signal).finally(() => {
			signal?.removeEventListener('abort', abortExternal)
			this.currentAbort = null
			this.currentTick = null
		})
		return this.currentTick
	}

	private inventory(): string[] {
		const ids = [...new Set(this.profileIds())]
		if (ids.length === 0) return []
		const offset = this.profileStart % ids.length
		this.profileStart = (offset + 1) % ids.length
		return [...ids.slice(offset), ...ids.slice(0, offset)]
	}

	private async runPoll(signal: AbortSignal): Promise<void> {
		const candidates = this.collectCandidates(this.inventory())
		if (aborted(signal)) return
		const githubByProject = await this.fetchProjects(candidates, signal)
		if (aborted(signal)) return
		for (const candidate of candidates) {
			if (aborted(signal)) return
			const queues = githubByProject.get(candidate.item.projectSlug)
			if (queues === undefined) {
				// The project budget, not GitHub, deferred this Item. Leave its cursor.
				candidate.deferred = true
				continue
			}
			this.observeItem(candidate, queues, signal)
		}
		if (!aborted(signal)) this.advanceCursors(candidates)
	}

	private collectCandidates(profiles: string[]): PlanCandidate[] {
		const queues = new Map<string, PlanCandidate[]>()
		for (const profileId of profiles) {
			const profileDb = this.db.forProfile(profileId)
			const commands = new ItemCommands(profileDb.items, this.config)
			const items = this.listWithWrap(profileId, cursor =>
				profileDb.items.listPlanWatchable(PLAN_ITEM_BUDGET_PER_TICK, cursor),
			)
			queues.set(
				profileId,
				items.map(item => ({
					profileId,
					item,
					cursor: { updatedAt: item.updatedAt, id: item.id },
					commands,
					completed: false,
					deferred: false,
				})),
			)
		}
		const selected: PlanCandidate[] = []
		let progress = true
		while (progress && selected.length < PLAN_ITEM_BUDGET_PER_TICK) {
			progress = false
			for (const profileId of profiles) {
				const candidate = queues.get(profileId)?.shift()
				if (!candidate) continue
				selected.push(candidate)
				progress = true
				if (selected.length === PLAN_ITEM_BUDGET_PER_TICK) break
			}
		}
		return selected
	}

	private listWithWrap(profileId: string, list: (cursor?: ItemKeysetCursor) => ItemRecord[]): ItemRecord[] {
		const page = list(this.cursors.get(profileId))
		if (page.length > 0 || !this.cursors.has(profileId)) return page
		this.cursors.delete(profileId)
		return list()
	}

	private async fetchProjects(
		candidates: PlanCandidate[],
		signal: AbortSignal,
	): Promise<Map<string, Map<string, TicketQueueSummary> | null>> {
		const slugs = [...new Set(candidates.map(candidate => candidate.item.projectSlug))]
		const offset = slugs.length === 0 ? 0 : this.projectStart % slugs.length
		this.projectStart = slugs.length === 0 ? 0 : (offset + PLAN_PROJECT_FETCH_BUDGET_PER_TICK) % slugs.length
		const orderedSlugs = [...slugs.slice(offset), ...slugs.slice(0, offset)]
		const selectedSlugs = orderedSlugs.slice(0, PLAN_PROJECT_FETCH_BUDGET_PER_TICK)
		const results = new Map<string, Map<string, TicketQueueSummary> | null>()
		let cursor = 0
		const worker = async () => {
			while (!aborted(signal)) {
				const slug = selectedSlugs[cursor++]
				if (!slug) return
				const project = this.config.projects.find(candidate => candidate.slug === slug)
				if (!project) {
					results.set(slug, null)
					continue
				}
				try {
					results.set(slug, await this.fetchGithubQueues(project.repoPath, { signal }))
					this.githubFailures.delete(slug)
				} catch (err) {
					if (aborted(signal)) return
					results.set(slug, null)
					if (!this.githubFailures.has(slug)) {
						this.githubFailures.add(slug)
						log.warn(
							'plan-status',
							`Could not read GitHub ticket queues for ${slug}: ${err instanceof Error ? err.message : err}`,
						)
					}
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(PLAN_GITHUB_CONCURRENCY, selectedSlugs.length) }, worker))
		return results
	}

	private observeItem(
		candidate: PlanCandidate,
		githubQueues: Map<string, TicketQueueSummary> | null,
		signal: AbortSignal,
	): void {
		const { item } = candidate
		if (!item.worktreePath || !item.planDirName || !existsSync(item.worktreePath)) {
			candidate.completed = true
			return
		}
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
			if (!sameStatus(item.planStatus, next) && !aborted(signal)) {
				candidate.item = candidate.commands.recordPlanStatus(item.id, next)
			}
			if (!aborted(signal)) candidate.completed = true
		} catch (err) {
			// Local worktree damage is handled for cursor progress; retrying it forever
			// would starve every later plan in this tenant.
			if (!aborted(signal)) {
				candidate.completed = true
				log.warn(
					'plan-status',
					`Could not inspect plan for Item ${item.id}: ${err instanceof Error ? err.message : err}`,
				)
			}
		}
	}

	private advanceCursors(candidates: PlanCandidate[]): void {
		for (const profileId of [...new Set(candidates.map(candidate => candidate.profileId))]) {
			for (const candidate of candidates.filter(candidate => candidate.profileId === profileId)) {
				// Keep a budget-deferred head candidate eligible on the next tick.
				if (!candidate.completed || candidate.deferred) break
				this.cursors.set(profileId, candidate.cursor)
			}
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
