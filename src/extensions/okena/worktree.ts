import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { SolverWorkspace } from '../../solver/workspace.js'
import { errorPhase, phaseError } from '../../util/errors.js'
import { log } from '../../util/logger.js'
import { sameFilesystemPath } from '../../util/path-identity.js'
import {
	assertWorkspaceReuse,
	excludeHelmFiles,
	inspectRemoteBranch,
	localBranchExists,
	resolveWorktreeStartPoint,
	withRepoLock,
	worktreeRegistrationForBranch,
} from '../../worktree/manager.js'
import type { OkenaClient, OkenaLayoutNode, OkenaState } from './client.js'

interface CreateWorktreeResponse {
	project_id: string
	/** Absent while `pending`: the optimistic row has no PTY yet. */
	terminal_id?: string | null
	path: string
	/**
	 * Okena answers `create_worktree` optimistically unless asked to `wait`: the
	 * row exists but the background `git worktree add` (and its terminal) does not yet.
	 */
	pending?: boolean
}

/** How long Start waits for an Okena worktree checkout + terminal before failing. */
const DEFAULT_WORKTREE_READY_TIMEOUT_MS = 3 * 60 * 1000
const DEFAULT_WORKTREE_READY_POLL_MS = 500

export interface OkenaWorktreeReadinessOptions {
	/** Bound on waiting for a created worktree to be checked out with a live terminal. */
	readyTimeoutMs?: number
	readyPollMs?: number
	sleep?: (ms: number) => Promise<unknown>
	now?: () => number
}

interface RegisterWorktreeResponse {
	project_id?: string
	terminal_id?: string | null
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
				throw phaseError(
					'worktree',
					`Git retains a missing worktree registration for ${branchName}: ${registration.path}. Preserve the branch and any files, resolve the stale registration explicitly with Git, then retry.`,
				)
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

/** Okena daemons before 0.36 lack `wait` and deny unknown action fields. */
function rejectsWaitFlag(err: unknown): boolean {
	return /unknown field\W+wait\b/.test(err instanceof Error ? err.message : String(err))
}

function isTimeout(err: unknown): boolean {
	return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

/**
 * Ask Okena to create the worktree and answer only once its checkout exists and
 * its terminal runs (`wait: true`). An Okena that predates `wait` rejects the
 * field before doing anything, so the request is resent without it; that reply
 * may be optimistic (`pending: true`) and the caller must await readiness.
 */
export async function createOkenaWorktreeForBranch(
	client: OkenaClient,
	projectId: string,
	branchName: string,
	branchExists: () => Promise<boolean>,
	options: { waitTimeoutMs?: number } = {},
): Promise<CreateWorktreeResponse> {
	const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WORKTREE_READY_TIMEOUT_MS
	const createBranch = !(await branchExists())
	// One budget for the whole create, including the opposite-mode retry: a
	// slow failure must not restart the clock and double the bounded wait.
	const waitSignal = AbortSignal.timeout(waitTimeoutMs)
	let waitSupported = true
	const create = async (createBranch: boolean): Promise<CreateWorktreeResponse> => {
		const payload = {
			action: 'create_worktree',
			project_id: projectId,
			branch: branchName,
			create_branch: createBranch,
		}
		if (waitSupported) {
			try {
				return await client.action<CreateWorktreeResponse>({ ...payload, wait: true }, { signal: waitSignal })
			} catch (err) {
				if (!rejectsWaitFlag(err)) throw err
				waitSupported = false
			}
		}
		return client.action<CreateWorktreeResponse>(payload)
	}
	// A timed-out wait may still finish in Okena; creating again would race it.
	const notReady = () =>
		phaseError(
			'worktree',
			`Okena worktree for ${branchName} was not ready after ${Math.round(waitTimeoutMs / 1000)}s. Wait for it to appear in Okena, then press Start again.`,
		)

	try {
		return await create(createBranch)
	} catch (firstErr) {
		if (isTimeout(firstErr)) throw notReady()
		log.warn(
			'okena',
			`create_branch=${createBranch} failed: ${firstErr instanceof Error ? firstErr.message : firstErr}`,
		)
		// The branch can appear/disappear between the preflight and Okena's git
		// call. Retry the opposite mode for that race, but avoid an expected first
		// failure in the normal "branch already exists" path.
		try {
			return await create(!createBranch)
		} catch (retryErr) {
			if (isTimeout(retryErr)) throw notReady()
			throw retryErr
		}
	}
}

export class OkenaWorktreeManager {
	constructor(
		private readonly client: OkenaClient,
		private readonly readiness: OkenaWorktreeReadinessOptions = {},
	) {}

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
		mode: SolverWorkspace = 'worktree',
	): Promise<EnsuredOkenaWorktree> {
		if (mode === 'main') {
			await assertWorkspaceReuse(repoPath, branchName, existingWorktreePath ?? repoPath, mode)
			return this.ensureMainRepoProject(repoPath)
		}
		if (existingWorktreePath) {
			return this.ensureExistingWorktreeProject(repoPath, branchName, existingWorktreePath)
		}

		const { state, okenaProject } = await this.findOkenaProject(repoPath)
		log.info('okena', `Matched Okena project: ${okenaProject.name} (${okenaProject.id})`)
		// An Okena label or cached git_status is not proof that its path is still
		// this branch's live worktree. Git owns that association, including when
		// planning saved no Item path before a rollback.
		const registration = await worktreeRegistrationForBranch(repoPath, branchName)
		if (registration?.exists) return this.ensureExistingWorktreeProject(repoPath, branchName, registration.path)
		if (registration)
			throw phaseError(
				'worktree',
				`Git retains a missing worktree registration for ${branchName}: ${registration.path}. Resolve the stale registration explicitly with Git before retrying.`,
			)

		await this.ensureBaseBranchReady(repoPath, baseBranch)
		log.info('okena', `Creating worktree for branch: ${branchName}`)
		const readyDeadline = this.now() + this.readyTimeoutMs()
		let wt: CreateWorktreeResponse
		try {
			wt = await createOkenaWorktreeForBranch(
				this.client,
				okenaProject.id,
				branchName,
				() => prepareExistingOkenaBranch(repoPath, branchName),
				{ waitTimeoutMs: this.readyTimeoutMs() },
			)
		} catch (err) {
			// Already a user-facing worktree-phase message (e.g. the bounded wait).
			if (errorPhase(err) === 'worktree') throw err
			throw phaseError('worktree', `Okena worktree creation failed: ${err instanceof Error ? err.message : err}`)
		}

		const worktreePath = wt.path
		const wtProjectId =
			wt.project_id ??
			state.projects.find(p => p.path === worktreePath)?.id ??
			(await this.client.getState()).projects.find(p => p.path === worktreePath)?.id
		if (!wtProjectId) throw phaseError('worktree', 'Worktree project ID could not be resolved')

		// An optimistic reply names a path that is not checked out yet and a row
		// with no terminal. Validating it now fails the first Start, and typing
		// into a not-yet-spawned pane loses the command.
		let autoTerminalId = wt.terminal_id ?? null
		if (wt.pending === true) {
			autoTerminalId = await this.awaitWorktreeReady(wtProjectId, worktreePath, branchName, readyDeadline)
		}

		await assertWorkspaceReuse(repoPath, branchName, worktreePath)
		log.success('okena', `Worktree at ${worktreePath}`)
		await excludeHelmFiles(worktreePath)
		return { worktreePath, wtProjectId, autoTerminalId }
	}

	private readyTimeoutMs(): number {
		return this.readiness.readyTimeoutMs ?? DEFAULT_WORKTREE_READY_TIMEOUT_MS
	}

	private now(): number {
		return (this.readiness.now ?? Date.now)()
	}

	/**
	 * Poll Okena until an optimistically created worktree row is checked out
	 * (`is_creating` cleared, path on disk). Okena spawns the row's terminals in
	 * the same step, so the first live terminal is returned when there is one.
	 * Fails with a `worktree`-phase error when Okena rolls the row back or the
	 * bounded deadline passes.
	 */
	private async awaitWorktreeReady(
		wtProjectId: string,
		worktreePath: string,
		branchName: string,
		deadline: number,
	): Promise<string | null> {
		const pollMs = this.readiness.readyPollMs ?? DEFAULT_WORKTREE_READY_POLL_MS
		const sleep = this.readiness.sleep ?? delay
		log.info('okena', `Waiting for Okena to finish creating worktree ${worktreePath}`)
		for (;;) {
			let project: OkenaState['projects'][number] | undefined
			let observed = false
			try {
				project = (await this.client.getState()).projects.find(p => p.id === wtProjectId)
				observed = true
			} catch (err) {
				log.warn('okena', `Could not read Okena state while waiting for ${worktreePath}`, {
					error: err instanceof Error ? err.message : String(err),
				})
			}
			if (observed && !project) {
				throw phaseError(
					'worktree',
					`Okena rolled back the worktree for ${branchName} (${worktreePath}); see Okena's error toast, then press Start again.`,
				)
			}
			if (project && !project.is_creating && existsSync(worktreePath)) {
				return liveTerminalIds(project.layout)[0] ?? null
			}
			if (this.now() >= deadline) {
				throw phaseError(
					'worktree',
					`Okena worktree for ${branchName} was not ready after ${Math.round(this.readyTimeoutMs() / 1000)}s (checkout or terminal still pending at ${worktreePath}). Wait for it to appear in Okena, then press Start again.`,
				)
			}
			await sleep(pollMs)
		}
	}

	private async ensureExistingWorktreeProject(
		repoPath: string,
		branchName: string,
		worktreePath: string,
	): Promise<EnsuredOkenaWorktree> {
		const { state, okenaProject } = await this.findOkenaProject(repoPath)
		const wtProject = state.projects.find(
			project =>
				project.worktree_info?.parent_project_id === okenaProject.id && sameFilesystemPath(project.path, worktreePath),
		)
		// A Start that lands while an earlier optimistic create is still checking
		// out must wait for it: the row has no PTY yet and Git's view is partial.
		if (wtProject?.is_creating) {
			await this.awaitWorktreeReady(wtProject.id, wtProject.path, branchName, this.now() + this.readyTimeoutMs())
		}
		await assertWorkspaceReuse(repoPath, branchName, worktreePath)
		if (wtProject) {
			await excludeHelmFiles(worktreePath)
			return { worktreePath, wtProjectId: wtProject.id, autoTerminalId: null }
		}
		const standalone = state.projects.find(project => sameFilesystemPath(project.path, worktreePath))
		if (standalone) {
			throw phaseError('worktree', `Okena tracks this worktree outside its parent project: ${worktreePath}`)
		}

		const registration = await worktreeRegistrationForBranch(repoPath, branchName)
		if (!registration?.exists || !sameFilesystemPath(registration.path, worktreePath)) {
			throw phaseError(
				'worktree',
				`Stored worktree path is no longer an active Git worktree for ${branchName}: ${worktreePath}. Preserve any planning files, then remove or rename the stale directory and retry.`,
			)
		}

		let added: RegisterWorktreeResponse
		try {
			added = await this.client.action<RegisterWorktreeResponse>({
				action: 'add_discovered_worktree',
				parent_project_id: okenaProject.id,
				worktree_path: worktreePath,
				branch: branchName,
			})
		} catch (err) {
			throw phaseError('worktree', `Okena worktree registration failed: ${err instanceof Error ? err.message : err}`)
		}
		if (!added.project_id) {
			throw phaseError('worktree', 'Okena did not return the registered worktree project ID')
		}
		log.success('okena', `Registered existing worktree project: ${added.project_id}`)
		await excludeHelmFiles(worktreePath)
		return {
			worktreePath,
			wtProjectId: added.project_id,
			autoTerminalId: added.terminal_id ?? null,
		}
	}

	async findPlanTerminal(wtProjectId: string, itemId: string): Promise<string | null> {
		const state = await this.client.getState()
		const wtProject = state.projects.find(p => p.id === wtProjectId)
		const liveIds = new Set(liveTerminalIds(wtProject?.layout))
		const ownership = `[helm:${itemId}]`
		const entry = Object.entries(wtProject?.terminal_names ?? {}).find(
			([terminalId, name]) => liveIds.has(terminalId) && name.endsWith(ownership),
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
