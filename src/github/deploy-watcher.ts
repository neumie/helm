import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { HelmConfig } from '../config.js'
import type { DB } from '../db/client.js'
import { ItemCommands } from '../items/commands.js'
import type { DeployState, DeploymentEntry, ItemRecord } from '../items/schema.js'
import type { ItemKeysetCursor } from '../items/store.js'
import { log } from '../util/logger.js'

const execFileAsync = promisify(execFile)

export const DEPLOY_REMOTE_CONCURRENCY = 4
export const DEPLOY_MAX_REMOTE_COMMANDS_PER_TICK = 160
export const DEPLOY_MAX_DEPLOYMENTS_PER_PR = 20

/** owner/repo from a GitHub PR URL (the deploy lookups key off these). */
export function parsePrUrl(url: string): { owner: string; repo: string } | null {
	const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/)
	return m ? { owner: m[1], repo: m[2] } : null
}

/** Only http(s) deployment URLs are safe to render as a clickable link. */
export function httpUrlOrNull(url: string | null | undefined): string | null {
	if (!url) return null
	try {
		const parsed = new URL(url)
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null
	} catch {
		return null
	}
}

function aborted(signal?: AbortSignal): boolean {
	return signal?.aborted === true
}

class RemoteBudget {
	private used = 0
	private active = 0
	private readonly waiters: Array<() => void> = []

	candidate(signal: AbortSignal): RemoteCandidate {
		return new RemoteCandidate(this, signal)
	}

	async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T | undefined> {
		if (aborted(signal) || this.used >= DEPLOY_MAX_REMOTE_COMMANDS_PER_TICK) return undefined
		this.used += 1
		if (this.active >= DEPLOY_REMOTE_CONCURRENCY) {
			await new Promise<void>(resolve => this.waiters.push(resolve))
		}
		if (aborted(signal)) return undefined
		this.active += 1
		try {
			return await operation()
		} finally {
			this.release()
		}
	}

	private release(): void {
		if (this.active > 0) this.active -= 1
		const next = this.waiters.shift()
		if (next) next()
	}
}

/** Per-candidate view of a tick budget; deferred work must not move its cursor. */
export class RemoteCandidate {
	deferred = false

	constructor(
		private readonly budget: RemoteBudget,
		readonly signal: AbortSignal,
	) {}

	async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
		const result = await this.budget.run(this.signal, operation)
		if (result === undefined) this.deferred = true
		return result
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

export interface DeployObservationProgress {
	deployments?: GhDeployment[]
	statuses: Map<number, GhDeploymentStatus | null>
	incomplete: boolean
}

export interface DeployCommandOptions {
	signal?: AbortSignal
}

/** Low-level seam: every production gh spawn still passes through ghJson's permit. */
export type DeployCommandRunner = (file: 'gh', args: string[], options: DeployCommandOptions) => Promise<string>

export interface DeployFetchOptions {
	signal?: AbortSignal
	remote?: RemoteCandidate
	/** Process-local continuation; incomplete observations are never persisted. */
	progress?: DeployObservationProgress
	command?: DeployCommandRunner
}

/** Run `gh` and JSON-parse stdout. Failure is a no-result, not a lifecycle failure. */
async function ghJson<T = unknown>(args: string[], options: DeployFetchOptions = {}): Promise<T | null> {
	if (aborted(options.signal)) return null
	const execute = async () => {
		try {
			const stdout = options.command
				? await options.command('gh', args, { signal: options.signal })
				: (await execFileAsync('gh', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, signal: options.signal }))
						.stdout
			return JSON.parse(stdout) as T
		} catch {
			return null
		}
	}
	return options.remote ? ((await options.remote.run(execute)) ?? null) : execute()
}

/** Observe a PR merge and its bounded deployment status fan-out. */
export async function fetchDeployState(
	prUrl: string,
	checkedAt: string,
	options: DeployFetchOptions = {},
): Promise<DeployState | null> {
	const repo = parsePrUrl(prUrl)
	if (!repo || aborted(options.signal)) return null
	const pr = await ghJson<GhPrView>(['pr', 'view', prUrl, '--json', 'state,mergedAt,mergeCommit'], options)
	if (!pr || aborted(options.signal)) return null

	const merged = pr.state === 'MERGED'
	const mergedAt = pr.mergedAt ?? null
	const mergeSha = pr.mergeCommit?.oid ?? null
	const deployments: DeploymentEntry[] = []
	const progress = options.progress
	if (merged && mergeSha) {
		const base = `repos/${repo.owner}/${repo.repo}`
		const fetched = await ghJson<GhDeployment[]>(['api', `${base}/deployments?sha=${mergeSha}&per_page=100`], options)
		if (options.remote?.deferred || !Array.isArray(fetched)) return null
		if (progress) {
			progress.deployments = fetched.filter(deployment => deployment.id !== undefined)
			const ids = new Set(progress.deployments.map(deployment => deployment.id as number))
			for (const id of progress.statuses.keys()) if (!ids.has(id)) progress.statuses.delete(id)
			let remaining = DEPLOY_MAX_DEPLOYMENTS_PER_PR
			for (const deployment of progress.deployments) {
				if (remaining === 0 || progress.statuses.has(deployment.id as number)) continue
				if (aborted(options.signal)) return null
				const statuses = await ghJson<GhDeploymentStatus[]>(
					['api', `${base}/deployments/${deployment.id}/statuses?per_page=1`],
					options,
				)
				if (options.remote?.deferred) return null
				progress.statuses.set(deployment.id as number, Array.isArray(statuses) ? statuses[0] : null)
				remaining -= 1
			}
			progress.incomplete = progress.statuses.size < progress.deployments.length
			if (progress.incomplete) return null
			for (const deployment of progress.deployments) {
				const latest = progress.statuses.get(deployment.id as number) ?? null
				deployments.push({
					environment: String(deployment.environment ?? 'unknown'),
					state: latest?.state ? String(latest.state) : 'pending',
					url: httpUrlOrNull(latest?.environment_url) ?? httpUrlOrNull(latest?.target_url),
					updatedAt: latest?.updated_at ?? deployment.updated_at ?? null,
				})
			}
		} else {
			for (const deployment of fetched.slice(0, DEPLOY_MAX_DEPLOYMENTS_PER_PR)) {
				const statuses = await ghJson<GhDeploymentStatus[]>(
					['api', `${base}/deployments/${deployment.id}/statuses?per_page=1`],
					options,
				)
				if (options.remote?.deferred) return null
				const latest = Array.isArray(statuses) ? statuses[0] : null
				deployments.push({
					environment: String(deployment.environment ?? 'unknown'),
					state: latest?.state ? String(latest.state) : 'pending',
					url: httpUrlOrNull(latest?.environment_url) ?? httpUrlOrNull(latest?.target_url),
					updatedAt: latest?.updated_at ?? deployment.updated_at ?? null,
				})
			}
		}
	}
	if (progress) progress.incomplete = false
	return options.remote?.deferred ? null : { merged, mergedAt, mergeSha, deployments, checkedAt }
}

async function discoverPrUrlByBranch(
	repoPath: string,
	branchName: string,
	options: DeployFetchOptions = {},
): Promise<string | null> {
	if (aborted(options.signal)) return null
	const execute = async () => {
		try {
			const { stdout } = await execFileAsync('gh', ['pr', 'view', branchName, '--json', 'url,state'], {
				cwd: repoPath,
				timeout: 10_000,
				signal: options.signal,
			})
			const parsed = JSON.parse(stdout) as { url?: unknown; state?: unknown }
			if (parsed.state !== 'OPEN' && parsed.state !== 'MERGED') return null
			return typeof parsed.url === 'string' && parsed.url ? parsed.url : null
		} catch {
			return null
		}
	}
	return options.remote ? ((await options.remote.run(execute)) ?? null) : execute()
}

async function readWorktreeBranch(worktreePath: string, options: DeployFetchOptions = {}): Promise<string | null> {
	if (!existsSync(worktreePath) || aborted(options.signal)) return null
	const execute = async () => {
		try {
			const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
				cwd: worktreePath,
				timeout: 10_000,
				signal: options.signal,
			})
			return stdout.trim() || null
		} catch {
			return null
		}
	}
	return options.remote ? ((await options.remote.run(execute)) ?? null) : execute()
}

export interface DeployWatcherDeps {
	fetchDeployState?: typeof fetchDeployState
	discoverPrUrl?: typeof discoverPrUrlByBranch
	readWorktreeBranch?: typeof readWorktreeBranch
}

type CandidateKind = 'late-pr' | 'deploy'
interface Candidate {
	kind: CandidateKind
	profileId: string
	item: ItemRecord
	/** Original key from the list query; writes may change updatedAt. */
	cursor: ItemKeysetCursor
	commands: ItemCommands
	remote: RemoteCandidate
	completed: boolean
	incomplete: boolean
}

/** Bounded, fair, profile-scoped post-ship observer. */
export class DeployWatcher {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running = false
	private currentTick: Promise<void> | null = null
	private currentAbort: AbortController | null = null
	private stopDrain: Promise<void> | null = null
	private profileStart = 0
	private readonly lateCursors = new Map<string, ItemKeysetCursor>()
	private readonly deployCursors = new Map<string, ItemKeysetCursor>()
	private readonly deployProgress = new Map<string, DeployObservationProgress>()
	private readonly intervalSeconds: number
	private readonly fetchState: typeof fetchDeployState
	private readonly discoverPr: typeof discoverPrUrlByBranch
	private readonly readBranch: typeof readWorktreeBranch
	private readonly profileIds: () => string[]
	private readonly injectedFetch: boolean
	private readonly injectedDiscover: boolean
	private readonly injectedReadBranch: boolean

	constructor(
		private readonly config: HelmConfig,
		private readonly db: DB,
		depsOrProfileIds: DeployWatcherDeps | (() => string[]) = {},
		profileIds: () => string[] = () => [db.currentProfileId()],
	) {
		const deps = typeof depsOrProfileIds === 'function' ? {} : depsOrProfileIds
		this.profileIds = typeof depsOrProfileIds === 'function' ? depsOrProfileIds : profileIds
		this.intervalSeconds = config.github.deployPollSeconds
		this.fetchState = deps.fetchDeployState ?? fetchDeployState
		this.discoverPr = deps.discoverPrUrl ?? discoverPrUrlByBranch
		this.readBranch = deps.readWorktreeBranch ?? readWorktreeBranch
		this.injectedFetch = deps.fetchDeployState !== undefined
		this.injectedDiscover = deps.discoverPrUrl !== undefined
		this.injectedReadBranch = deps.readWorktreeBranch !== undefined
	}

	start(): void {
		if (this.running) return
		if (!this.config.github.trackDeployments) {
			log.info('deploy', 'Deploy tracking disabled (github.trackDeployments=false)')
			return
		}
		this.running = true
		this.stopDrain = null
		log.info('deploy', `Starting deploy watcher (interval: ${this.intervalSeconds}s)`)
		void this.tick()
	}

	stop(): Promise<void> {
		if (this.stopDrain) return this.stopDrain
		this.running = false
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		this.currentAbort?.abort()
		this.stopDrain = (this.currentTick ?? Promise.resolve()).then(() => undefined)
		log.info('deploy', 'Deploy watcher stopped')
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
		const profiles = this.inventory()
		const budget = new RemoteBudget()
		const candidates = this.collectCandidates(profiles, budget, signal)
		const memo = new Map<string, Promise<DeployState | null>>()
		await this.runCandidateWorkers(candidates, memo)
		if (aborted(signal)) return
		this.advanceCursors(candidates)
	}

	private collectCandidates(profiles: string[], budget: RemoteBudget, signal: AbortSignal): Candidate[] {
		const byProfile = new Map<string, { late: Candidate[]; deploy: Candidate[] }>()
		for (const profileId of profiles) {
			const profileDb = this.db.forProfile(profileId)
			const commands = new ItemCommands(profileDb.items, this.config)
			const late = this.listWithWrap(profileId, this.lateCursors, cursor =>
				profileDb.items.listPrBackfillable(DEPLOY_MAX_REMOTE_COMMANDS_PER_TICK, cursor),
			)
			const deploy = this.listWithWrap(profileId, this.deployCursors, cursor =>
				profileDb.items.listDeployWatchable(DEPLOY_MAX_REMOTE_COMMANDS_PER_TICK, cursor),
			)
			byProfile.set(profileId, {
				late: late.map(item => this.candidate('late-pr', profileId, item, commands, budget, signal)),
				deploy: deploy.map(item => this.candidate('deploy', profileId, item, commands, budget, signal)),
			})
		}
		const selected: Candidate[] = []
		let progress = true
		while (progress && selected.length < DEPLOY_MAX_REMOTE_COMMANDS_PER_TICK) {
			progress = false
			for (const profileId of profiles) {
				const queue = byProfile.get(profileId)
				if (!queue) continue
				for (const kind of ['late', 'deploy'] as const) {
					const candidate = queue[kind].shift()
					if (!candidate) continue
					selected.push(candidate)
					progress = true
					if (selected.length === DEPLOY_MAX_REMOTE_COMMANDS_PER_TICK) break
				}
				if (selected.length === DEPLOY_MAX_REMOTE_COMMANDS_PER_TICK) break
			}
		}
		return selected
	}

	private listWithWrap(
		profileId: string,
		cursors: Map<string, ItemKeysetCursor>,
		list: (cursor?: ItemKeysetCursor) => ItemRecord[],
	): ItemRecord[] {
		const page = list(cursors.get(profileId))
		if (page.length > 0 || !cursors.has(profileId)) return page
		cursors.delete(profileId)
		return list()
	}

	private candidate(
		kind: CandidateKind,
		profileId: string,
		item: ItemRecord,
		commands: ItemCommands,
		budget: RemoteBudget,
		signal: AbortSignal,
	): Candidate {
		return {
			kind,
			profileId,
			item,
			cursor: { updatedAt: item.updatedAt, id: item.id },
			commands,
			remote: budget.candidate(signal),
			completed: false,
			incomplete: false,
		}
	}

	private async runCandidateWorkers(
		candidates: Candidate[],
		memo: Map<string, Promise<DeployState | null>>,
	): Promise<void> {
		let next = 0
		const worker = async () => {
			while (next < candidates.length) {
				const candidate = candidates[next++]
				await this.processCandidate(candidate, memo)
			}
		}
		await Promise.all(Array.from({ length: DEPLOY_REMOTE_CONCURRENCY }, worker))
	}

	private async processCandidate(candidate: Candidate, memo: Map<string, Promise<DeployState | null>>): Promise<void> {
		const { item, remote } = candidate
		try {
			if (candidate.kind === 'late-pr') {
				await this.backfillLatePr(candidate)
			} else if (item.prUrl) {
				const observed = memo.get(item.prUrl) ?? this.observePr(item.prUrl, remote)
				memo.set(item.prUrl, observed)
				const state = await observed
				candidate.incomplete = item.prUrl ? this.deployProgress.get(item.prUrl)?.incomplete === true : false
				if (!state || remote.deferred || candidate.incomplete || aborted(remote.signal)) return
				const updated = candidate.commands.recordDeployState(item.id, state)
				candidate.item = updated
				if (state.merged && updated.status === 'review' && !aborted(remote.signal)) {
					candidate.item = candidate.commands.markItemMerged(item.id)
				}
			}
			if (!remote.deferred && !aborted(remote.signal)) candidate.completed = true
		} catch (err) {
			// A failed lookup is a handled no-result. It must not strand a noisy Item
			// at the head of a profile's keyset forever.
			if (!aborted(remote.signal)) {
				candidate.completed = true
				log.warn('deploy', `Observer failed for Item ${item.id}: ${err instanceof Error ? err.message : err}`)
			}
		}
	}

	private observePr(prUrl: string, remote: RemoteCandidate): Promise<DeployState | null> {
		if (this.injectedFetch) {
			return remote
				.run(() => this.fetchState(prUrl, new Date().toISOString(), { signal: remote.signal, remote }))
				.then(value => value ?? null)
		}
		const progress = this.deployProgress.get(prUrl) ?? { statuses: new Map(), incomplete: false }
		this.deployProgress.set(prUrl, progress)
		return this.fetchState(prUrl, new Date().toISOString(), { signal: remote.signal, remote, progress }).then(state => {
			if (state && !progress.incomplete) this.deployProgress.delete(prUrl)
			return state
		})
	}

	private async backfillLatePr(candidate: Candidate): Promise<void> {
		const { item, remote } = candidate
		const project = this.config.projects.find(entry => entry.slug === item.projectSlug)
		if (!project || !item.branchName) return
		let prUrl = await this.lookupPr(project.repoPath, item.branchName, remote)
		if (!prUrl && !remote.deferred && item.worktreePath) {
			const liveBranch = await this.lookupBranch(item.worktreePath, remote)
			if (liveBranch && liveBranch !== item.branchName)
				prUrl = await this.lookupPr(project.repoPath, liveBranch, remote)
		}
		if (!prUrl || remote.deferred || aborted(remote.signal)) return
		candidate.item = candidate.commands.recordDispatchPr(item.id, { prUrl, shippedByAgent: true })
		log.info('deploy', `Backfilled late PR for Item ${item.id}: ${prUrl}`)
	}

	private lookupPr(repoPath: string, branch: string, remote: RemoteCandidate): Promise<string | null> {
		if (this.injectedDiscover) {
			return remote
				.run(() => this.discoverPr(repoPath, branch, { signal: remote.signal, remote }))
				.then(value => value ?? null)
		}
		return this.discoverPr(repoPath, branch, { signal: remote.signal, remote })
	}

	private lookupBranch(worktreePath: string, remote: RemoteCandidate): Promise<string | null> {
		if (this.injectedReadBranch) {
			return remote
				.run(() => this.readBranch(worktreePath, { signal: remote.signal, remote }))
				.then(value => value ?? null)
		}
		return this.readBranch(worktreePath, { signal: remote.signal, remote })
	}

	private advanceCursors(candidates: Candidate[]): void {
		for (const kind of ['late-pr', 'deploy'] as const) {
			const cursors = kind === 'late-pr' ? this.lateCursors : this.deployCursors
			for (const profileId of [...new Set(candidates.map(candidate => candidate.profileId))]) {
				for (const candidate of candidates.filter(entry => entry.kind === kind && entry.profileId === profileId)) {
					// Never leap over a budget-deferred candidate in this profile stream.
					if (!candidate.completed) break
					cursors.set(profileId, candidate.cursor)
				}
			}
		}
	}

	private async tick(): Promise<void> {
		if (!this.running) return
		try {
			await this.pollOnce()
		} catch (err) {
			log.error('deploy', 'Deploy watcher failed', err)
		}
		if (this.running) {
			this.timer = setTimeout(() => void this.tick(), this.intervalSeconds * 1000)
			this.timer.unref?.()
		}
	}
}
