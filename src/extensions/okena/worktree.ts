import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { phaseError } from '../../util/errors.js'
import { log } from '../../util/logger.js'
import {
	excludeHelmFiles,
	inspectRemoteBranch,
	localBranchExists,
	resolveWorktreeStartPoint,
	withRepoLock,
	worktreeRegistrationForBranch,
} from '../../worktree/manager.js'
import type { OkenaClient, OkenaLayoutNode } from './client.js'

interface CreateWorktreeResponse {
	project_id: string
	terminal_id: string | null
	path: string
}

export interface EnsuredOkenaWorktree {
	worktreePath: string
	wtProjectId: string
	/** A terminal created as a side effect of worktree creation, if any. */
	autoTerminalId: string | null
}

export interface CreateTerminalOptions {
	/** Poll delays for observing a terminal after one accepted Okena action. */
	retryDelaysMs?: readonly number[]
	sleep?: (ms: number) => Promise<unknown>
}

interface TerminalActionResponse {
	terminal_id?: string | null
	terminal_ids?: string[]
	data?: { terminal_id?: string | null; terminal_ids?: string[] }
}

function terminalIdFromResponse(response: TerminalActionResponse): string | null {
	return (
		response.terminal_id ??
		response.terminal_ids?.[0] ??
		response.data?.terminal_id ??
		response.data?.terminal_ids?.[0] ??
		null
	)
}

function liveTerminalIds(layout: OkenaLayoutNode | null | undefined): string[] {
	if (!layout) return []
	if (layout.type === 'terminal') return layout.detached || !layout.terminal_id ? [] : [layout.terminal_id]
	return layout.children.flatMap(liveTerminalIds)
}

export type OkenaBranchSource = 'local' | 'remote' | 'new' | 'unavailable'

export async function inspectOkenaBranchSource(repoPath: string, branchName: string): Promise<OkenaBranchSource> {
	if (await localBranchExists(repoPath, branchName)) return 'local'
	const remote = await inspectRemoteBranch(repoPath, branchName)
	if (remote === 'exists') return 'remote'
	return remote === 'absent' ? 'new' : 'unavailable'
}

interface OkenaBranchPreparationDeps {
	localBranchExists: typeof localBranchExists
	inspectRemoteBranch: typeof inspectRemoteBranch
	worktreeRegistrationForBranch: typeof worktreeRegistrationForBranch
	execGit: (args: string[], options: { cwd: string; timeout: number }) => Promise<void>
}

const defaultBranchPreparationDeps: OkenaBranchPreparationDeps = {
	localBranchExists,
	inspectRemoteBranch,
	worktreeRegistrationForBranch,
	execGit: async (args, options) => {
		await promisify(execFile)('git', args, options)
	},
}

export async function prepareExistingOkenaBranch(
	repoPath: string,
	branchName: string,
	deps: OkenaBranchPreparationDeps = defaultBranchPreparationDeps,
): Promise<boolean> {
	if (await deps.localBranchExists(repoPath, branchName)) {
		return withRepoLock(repoPath, async () => {
			const registration = await deps.worktreeRegistrationForBranch(repoPath, branchName)
			if (registration && !registration.exists) {
				await deps.execGit(['worktree', 'prune'], { cwd: repoPath, timeout: 10_000 })
			}
			return true
		})
	}
	const remote = await deps.inspectRemoteBranch(repoPath, branchName)
	if (remote === 'unavailable') throw phaseError('worktree', `Could not check origin for branch ${branchName}`)
	if (remote === 'absent') return false

	return withRepoLock(repoPath, async () => {
		if (await deps.localBranchExists(repoPath, branchName)) return true
		const remoteRef = `refs/remotes/origin/${branchName}`
		await deps.execGit(['fetch', 'origin', `+refs/heads/${branchName}:${remoteRef}`], {
			cwd: repoPath,
			timeout: 30_000,
		})
		if (!(await deps.localBranchExists(repoPath, branchName))) {
			try {
				await deps.execGit(['branch', '--track', branchName, remoteRef], {
					cwd: repoPath,
					timeout: 10_000,
				})
			} catch (err) {
				if (!(await deps.localBranchExists(repoPath, branchName))) throw err
			}
		}
		return true
	})
}

export async function createOkenaWorktreeForBranch(
	client: OkenaClient,
	projectId: string,
	branchName: string,
	branchExists: () => Promise<boolean>,
): Promise<CreateWorktreeResponse> {
	const createBranch = !(await branchExists())
	try {
		return await client.action<CreateWorktreeResponse>({
			action: 'create_worktree',
			project_id: projectId,
			branch: branchName,
			create_branch: createBranch,
		})
	} catch (firstErr) {
		log.warn(
			'okena',
			`create_branch=${createBranch} failed: ${firstErr instanceof Error ? firstErr.message : firstErr}`,
		)
		// The branch can appear/disappear between the preflight and Okena's git
		// call. Retry the opposite mode for that race, but avoid an expected first
		// failure in the normal "branch already exists" path.
		return client.action<CreateWorktreeResponse>({
			action: 'create_worktree',
			project_id: projectId,
			branch: branchName,
			create_branch: !createBranch,
		})
	}
}

export class OkenaWorktreeManager {
	constructor(private readonly client: OkenaClient) {}

	/**
	 * Add a terminal to a worktree window that already has one (e.g. starting a
	 * solve on a worktree whose plan/run terminal is still open).
	 *
	 * We split the layout STACKED (new pane below the existing one) instead of
	 * okena's default. okena's `create_terminal` action hardcodes a side-by-side
	 * split (its `SplitDirection::Vertical`, which divides WIDTH → left/right);
	 * we want the panes stacked top/bottom, which is okena's `Horizontal`
	 * (divides HEIGHT). So we drive `split_terminal` at the root path (`[]`) with
	 * `direction: 'horizontal'` — it wraps the current layout and adds the new
	 * terminal beneath it. Both actions return `{ terminal_ids: [...] }`.
	 *
	 * Falls back to `create_terminal` when the split is a no-op — an empty
	 * project (no layout) has nothing to split, so `split_terminal` returns no id.
	 */
	async createTerminal(projectId: string, options: CreateTerminalOptions = {}): Promise<string | null> {
		const pollDelaysMs = options.retryDelaysMs ?? [0, 100, 250, 500, 1_000, 2_000]
		const sleep = options.sleep ?? delay
		const failures: Array<{ action: string; error: string }> = []
		const projectTerminalIds = async () => {
			const state = await this.client.getState()
			return liveTerminalIds(state.projects.find(project => project.id === projectId)?.layout)
		}
		let knownIds = new Set(await projectTerminalIds())

		const performOnceAndObserve = async (
			action: 'split_terminal' | 'create_terminal',
			payload: Record<string, unknown>,
		): Promise<string | null> => {
			try {
				const response = await this.client.action<TerminalActionResponse>(payload)
				const responseId = terminalIdFromResponse(response)
				if (responseId) return responseId
				failures.push({
					action,
					error: `accepted without terminal ID (${JSON.stringify(response)})`,
				})
			} catch (err) {
				failures.push({ action, error: err instanceof Error ? err.message : String(err) })
			}

			// Okena may accept the action before the new terminal appears in its
			// state, and recent versions may answer { ok: true } without an id.
			// Poll the live layout; never repeat the mutating action itself.
			for (const pollDelay of pollDelaysMs) {
				if (pollDelay > 0) await sleep(pollDelay)
				try {
					const currentIds = await projectTerminalIds()
					const added = currentIds.find(id => !knownIds.has(id))
					if (added) return added
					knownIds = new Set(currentIds)
				} catch (err) {
					failures.push({
						action: `${action}:observe`,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			return null
		}

		const splitId = await performOnceAndObserve('split_terminal', {
			action: 'split_terminal',
			project_id: projectId,
			path: [],
			direction: 'horizontal',
		})
		if (splitId) return splitId

		// split_terminal is a no-op for an empty project. Only after observing
		// that no terminal appeared do we invoke create_terminal exactly once.
		const createdId = await performOnceAndObserve('create_terminal', {
			action: 'create_terminal',
			project_id: projectId,
		})
		if (createdId) return createdId

		log.warn('okena', 'Failed to create terminal after one split and one create action', { projectId, failures })
		return null
	}

	/**
	 * Resolve the Okena project for the CANONICAL repo checkout (main-workspace
	 * runs). Deliberately does NOT prepare anything: no base-branch fetch, no
	 * `checkout --detach`, no `create_worktree` — the user's working state in the
	 * main checkout is sacred; the agent manages its own branching inside the
	 * terminal. Callers add a terminal PANE to this existing project window.
	 */
	async ensureMainRepoProject(repoPath: string): Promise<EnsuredOkenaWorktree> {
		const { okenaProject } = await this.findOkenaProject(repoPath)
		log.info('okena', `Using main checkout project: ${okenaProject.name} (${okenaProject.id})`)
		await excludeHelmFiles(repoPath)
		return { worktreePath: repoPath, wtProjectId: okenaProject.id, autoTerminalId: null }
	}

	/**
	 * Resolve the Okena worktree PROJECT (create, reuse-by-branch-name, or reuse
	 * by explicit path). Does NOT decide terminal policy — callers create/find
	 * the terminal they need.
	 */
	async ensureWorktreeProject(
		repoPath: string,
		baseBranch: string,
		branchName: string,
		existingWorktreePath: string | undefined,
	): Promise<EnsuredOkenaWorktree> {
		if (existingWorktreePath) {
			const { state } = await this.findOkenaProject(repoPath)
			const wtProject = state.projects.find(p => p.path === existingWorktreePath)
			if (!wtProject) {
				throw phaseError('worktree', `Okena project not found for worktree path: ${existingWorktreePath}`)
			}
			await excludeHelmFiles(existingWorktreePath)
			return { worktreePath: existingWorktreePath, wtProjectId: wtProject.id, autoTerminalId: null }
		}

		const { state, okenaProject } = await this.findOkenaProject(repoPath)
		log.info('okena', `Matched Okena project: ${okenaProject.name} (${okenaProject.id})`)
		await this.ensureBaseBranchReady(repoPath, baseBranch)

		const safeBranch = branchName.replace(/\//g, '-')
		const existing = state.projects.find(p => p.name === branchName && p.path.includes(safeBranch))
		if (existing) {
			log.info('okena', `Reusing existing worktree project: ${existing.id}`)
			await excludeHelmFiles(existing.path)
			return { worktreePath: existing.path, wtProjectId: existing.id, autoTerminalId: null }
		}

		log.info('okena', `Creating worktree for branch: ${branchName}`)
		let wt: CreateWorktreeResponse
		try {
			wt = await createOkenaWorktreeForBranch(this.client, okenaProject.id, branchName, () =>
				prepareExistingOkenaBranch(repoPath, branchName),
			)
		} catch (err) {
			throw phaseError('worktree', `Okena worktree creation failed: ${err instanceof Error ? err.message : err}`)
		}

		const worktreePath = wt.path
		const wtProjectId =
			wt.project_id ??
			state.projects.find(p => p.path === worktreePath)?.id ??
			(await this.client.getState()).projects.find(p => p.path === worktreePath)?.id
		if (!wtProjectId) throw phaseError('worktree', 'Worktree project ID could not be resolved')

		log.success('okena', `Worktree at ${worktreePath}`)
		await excludeHelmFiles(worktreePath)
		return { worktreePath, wtProjectId, autoTerminalId: wt.terminal_id }
	}

	async findPlanTerminal(wtProjectId: string): Promise<string | null> {
		const state = await this.client.getState()
		const wtProject = state.projects.find(p => p.id === wtProjectId)
		const liveIds = new Set(liveTerminalIds(wtProject?.layout))
		const entry = Object.entries(wtProject?.terminal_names ?? {}).find(
			([terminalId, name]) => liveIds.has(terminalId) && name.startsWith('plan: '),
		)
		return entry?.[0] ?? null
	}

	private async findOkenaProject(repoPath: string) {
		const state = await this.client.getState()
		const okenaProject = state.projects.find(p => p.path === repoPath)
		if (!okenaProject) {
			throw phaseError('worktree', `Project not found in Okena for path: ${repoPath}`)
		}
		return { state, okenaProject }
	}

	private async ensureBaseBranchReady(repoPath: string, baseBranch: string): Promise<void> {
		await withRepoLock(repoPath, async () => {
			const startPoint = await resolveWorktreeStartPoint(repoPath, baseBranch)
			try {
				await promisify(execFile)('git', ['checkout', '--detach', startPoint], { cwd: repoPath, timeout: 10_000 })
			} catch (err) {
				log.warn('okena', `Could not checkout ${startPoint}: ${err instanceof Error ? err.message : err}`)
			}
		})
	}
}
