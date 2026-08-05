import { existsSync } from 'node:fs'
import type { HelmConfig } from '../config.js'
import { isItemAssigned, requireItemAssignment } from '../items/assignment.js'
import type { ItemCommands } from '../items/commands.js'
import { buildItemExecutionContext, prepareItemExecutionContext, resolveItemSourceContext } from '../items/context.js'
import { resolveItemWorkspace } from '../items/identity.js'
import { ensureItemWorkspaceName } from '../items/naming.js'
import type { EnsureItemNameDeps } from '../items/naming.js'
import type { ItemRecord } from '../items/schema.js'
import type { KnowledgeIntegration } from '../knowledge/integration.js'
import type { KnowledgeStore } from '../knowledge/store.js'
import { PlanWorkspace } from '../plan/workspace.js'
import type { TaskProvider } from '../providers/provider.js'
import type { SolverAgent } from '../solver/agent.js'
import type { SolverWorkspace } from '../solver/workspace.js'
import type { SpawnerName } from '../spawner/registry.js'
import type { PlanningSessionResult, Spawner } from '../spawner/spawner.js'
import { isCancellation } from '../util/errors.js'
import { log } from '../util/logger.js'
import { sameFilesystemPath } from '../util/path-identity.js'

export type PlanningErrorCode =
	| 'not_found'
	| 'not_plannable'
	| 'unknown_project'
	| 'missing_checkout'
	| 'source_unavailable'
	| 'knowledge_unavailable'
	| 'invalid_spawner'
	| 'planning_conflict'
	| 'cancelled'
	| 'launch_failed'
	| 'finalization_failed'

export class PlanningError extends Error {
	constructor(
		readonly code: PlanningErrorCode,
		message: string,
		readonly sessionMayExist = false,
	) {
		super(message)
	}
}

export interface PlanningInput {
	itemId: string
	solverAgent?: SolverAgent
	solverModel?: string | null
	solverWorkspace?: SolverWorkspace | null
	signal?: AbortSignal
}

export interface PlanningResult {
	worktreePath: string
	branchName: string | null
	planDirName: string
	readmePath: string
	spawner: string
	solverAgent: SolverAgent
	hint: string
}

function readmeBody(item: ItemRecord, branchName: string | null, planDirName: string, agent: SolverAgent): string {
	const planningOptions =
		agent === 'pi'
			? [
					'- `/skill:grilling` — stress-test decisions interactively.',
					'- `/skill:domain-model` — challenge the plan against the domain model.',
					'- Ask Pi to synthesize the decisions into `prd.md` under this directory.',
				]
			: [
					`- \`/almanac:grill-me ${planDirName}\` — stress-test decisions interactively (in-conversation, no file).`,
					`- \`/almanac:grill-with-docs ${planDirName}\` — challenge the plan against the domain model.`,
					'- `/almanac:prd-create` — synthesize the decisions into `prd.md`.',
				]
	return [
		`# ${item.title}`,
		'',
		`**Kind:** ${item.kind}`,
		`**Status:** ${item.status}`,
		`**BaseRef:** ${item.baseRef}`,
		`**Branch:** ${branchName ?? '(main checkout — the agent creates the branch at run time)'}`,
		`**Item ID:** ${item.id}`,
		'',
		'## Plan this Item',
		'',
		'Planning agent started in this worktree. Tell it what you want to do, or invoke one of:',
		'',
		...planningOptions,
		'',
		'Anything committed under this directory is loaded into the autonomous run when the Item executes.',
		'',
	].join('\n')
}

/** Focused owner for interactive planning; persistence and file layout remain in their existing seams. */
export class PlanningApplication {
	private readonly claims = new Set<string>()

	constructor(
		private readonly config: HelmConfig,
		private readonly commands: ItemCommands,
		private readonly provider: TaskProvider,
		private readonly defaultSpawner: Spawner,
		private readonly createPlanningSpawner: (config: HelmConfig, name: SpawnerName) => Promise<Spawner>,
		private readonly namingDeps?: EnsureItemNameDeps,
		/** Captures profile-bound persistence seams before Planning's first await. */
		private readonly commandsForProfile?: (profileId: string) => ItemCommands,
		private readonly knowledge?: KnowledgeIntegration,
		private readonly knowledgeStoreForProfile?: (profileId: string) => KnowledgeStore,
	) {}

	/** Synchronous first-mutation exclusion used by Start. */
	assertStartAllowed(itemId: string): void {
		const item = this.commands.getItem(itemId)
		const commands = item ? (this.commandsForProfile?.(item.profileId) ?? this.commands) : this.commands
		const claim = `${item?.profileId ?? 'unknown'}:${itemId}`
		if (this.claims.has(claim) || commands.isPlanningRecoveryBlocked(itemId)) {
			throw new PlanningError(
				'planning_conflict',
				'Planning is incomplete for this Item; re-plan successfully before starting',
			)
		}
	}

	async prepare(input: PlanningInput): Promise<PlanningResult> {
		const item = this.commands.getItem(input.itemId)
		if (!item) throw new PlanningError('not_found', 'Not found')
		// All lifecycle reads/writes after this point belong to the Item's origin
		// tenant, even if profile activation changes while source/naming awaits.
		const commands = this.commandsForProfile?.(item.profileId) ?? this.commands
		const knowledgeStore = this.knowledge ? this.knowledgeStoreForProfile?.(item.profileId) : undefined
		if (this.knowledge && !knowledgeStore) {
			throw new PlanningError('knowledge_unavailable', 'Project knowledge evidence store is not available')
		}
		const claim = `${item.profileId}:${item.id}`
		if (item.status === 'running' || !['inbox', 'ready', 'active'].includes(item.status)) {
			throw new PlanningError('not_plannable', 'Running Items cannot be planned')
		}
		if (item.status === 'active' && item.workMode !== 'manual') {
			throw new PlanningError('not_plannable', 'Only human-owned active Items can be re-planned')
		}
		if (!isItemAssigned(item)) throw new PlanningError('not_plannable', 'Assign a project before planning this Item')
		const projectConfig = this.config.projects.find(project => project.slug === item.projectSlug)
		if (!projectConfig) throw new PlanningError('unknown_project', `Unknown project slug: ${item.projectSlug}`)
		const admittedKnowledgeBinding = this.knowledge?.bindingFor(item.profileId, item.projectSlug) ?? null
		const workspaceMode =
			input.solverWorkspace ??
			(item.payload.kind === 'solve' ? item.payload.solverWorkspace : undefined) ??
			this.config.solver.workspace ??
			'worktree'
		if (workspaceMode === 'main' && !existsSync(projectConfig.repoPath)) {
			throw new PlanningError('missing_checkout', `Project checkout does not exist: ${projectConfig.repoPath}`)
		}
		if (item.worktreePath && item.planDirName) {
			const previousWorkspace = new PlanWorkspace(item.worktreePath, item.planDirName)
			if (previousWorkspace.knowledgeCandidatesExist()) {
				const candidates = previousWorkspace.readKnowledgeCandidates()
				if (candidates.length > 0 && (item.knowledgeSnapshotId || admittedKnowledgeBinding)) {
					throw new PlanningError(
						'knowledge_unavailable',
						'Recover pending knowledge candidates before starting another planning attempt',
					)
				}
				previousWorkspace.clearKnowledgeCandidates()
			}
		}
		if (this.claims.has(claim)) throw new PlanningError('planning_conflict', 'Planning is already preparing this Item')
		this.claims.add(claim)
		const previous = item
		let began = false
		try {
			commands.beginPlanning(item.id)
			commands.recordKnowledgeSnapshot(item.id, null)
			began = true
			const transitionFromIdentity = {
				worktreePath: item.worktreePath,
				// Legacy Main plans may have retained an old branch; Main identity is
				// semantically branchless for an authorized mode transition.
				branchName:
					item.worktreePath && sameFilesystemPath(item.worktreePath, projectConfig.repoPath) ? null : item.branchName,
				planDirName: item.planDirName,
			}
			const sourceContext =
				item.capturedContext || item.source ? await resolveItemSourceContext(item, this.provider) : null
			if ((item.capturedContext || item.source) && !sourceContext) {
				throw new PlanningError('source_unavailable', 'Item source not found in source system')
			}
			const canonicalContext = buildItemExecutionContext(item, sourceContext)
			const agent = input.solverAgent ?? this.config.solver.agent
			const named =
				workspaceMode === 'main'
					? (commands.getItem(item.id) ?? item)
					: await ensureItemWorkspaceName({
							commands,
							item: commands.getItem(item.id) ?? item,
							taskContext: canonicalContext,
							config: this.config,
							repoPath: projectConfig.repoPath,
							agent,
							signal: input.signal,
							deps: this.namingDeps,
							transitionFromMain: Boolean(
								item.worktreePath && sameFilesystemPath(item.worktreePath, projectConfig.repoPath),
							),
						})
			requireItemAssignment(named)
			const expectedIdentity = {
				worktreePath: named.worktreePath,
				branchName: named.branchName,
				planDirName: named.planDirName,
			}
			const identity = resolveItemWorkspace(named)
			const planningInMain = workspaceMode === 'main'
			const existingWorktreePath = planningInMain
				? projectConfig.repoPath
				: identity.existingWorktreePath && !sameFilesystemPath(identity.existingWorktreePath, projectConfig.repoPath)
					? identity.existingWorktreePath
					: undefined
			const transition = planningInMain
				? expectedIdentity.worktreePath && !sameFilesystemPath(expectedIdentity.worktreePath, projectConfig.repoPath)
					? 'worktree-to-main'
					: 'none'
				: expectedIdentity.worktreePath && sameFilesystemPath(expectedIdentity.worktreePath, projectConfig.repoPath)
					? 'main-to-worktree'
					: 'none'
			let planningKnowledgeContext: string | null = null
			if (this.knowledge && knowledgeStore) {
				try {
					const preparedKnowledge = await this.knowledge.prepareContext(knowledgeStore, {
						profileId: item.profileId,
						itemId: item.id,
						projectSlug: named.projectSlug,
						purpose: 'planning',
						taskContext: canonicalContext,
						binding: admittedKnowledgeBinding,
						...(input.signal === undefined ? {} : { signal: input.signal }),
					})
					planningKnowledgeContext = preparedKnowledge.snapshot?.context ?? null
					commands.recordKnowledgeSnapshot(item.id, preparedKnowledge.snapshot?.id ?? null)
				} catch (error) {
					if (isCancellation(error, input.signal)) throw error
					throw new PlanningError(
						'knowledge_unavailable',
						`Project knowledge unavailable: ${error instanceof Error ? error.message : error}`,
					)
				}
			}
			const prepared = prepareItemExecutionContext(named, canonicalContext)
			let spawner: Spawner
			try {
				if (!named.spawner || named.spawner === this.defaultSpawner.name) spawner = this.defaultSpawner
				else spawner = await this.createPlanningSpawner(this.config, named.spawner as SpawnerName)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				// A bad or unavailable configured name is a client/configuration error;
				// importing or constructing an installed adapter is a launch failure.
				if (/^(Invalid Spawner adapter name|Spawner adapter not installed):/.test(message)) {
					throw new PlanningError('invalid_spawner', message)
				}
				throw new PlanningError('launch_failed', `Planning Spawner could not load: ${message}`)
			}
			let callbackCount = 0
			let callbackPath: string | undefined
			let callbackSealed = false
			let sessionMayExist = false
			const recordedBranchName = planningInMain ? null : identity.branchName
			let session: PlanningSessionResult
			try {
				session = await spawner.startPlanningSession({
					projectConfig: { ...projectConfig, baseBranch: identity.baseRef },
					itemId: item.id,
					branchName: identity.branchName,
					planDirName: identity.planDirName,
					taskTitle: item.title,
					canonicalContext,
					knowledgeContext: planningKnowledgeContext,
					onWorktreeReady: worktreePath => {
						// From this boundary onward an adapter may have a workspace or terminal.
						sessionMayExist = true
						// A callback from a detached adapter continuation cannot change a
						// completed planning transaction. Throwing here would instead escape
						// asynchronously and crash the daemon; log and return the canonical
						// context without materializing or persisting anything.
						if (callbackSealed) {
							log.warn('planning', `Ignoring late workspace readiness callback for ${item.id}`)
							return canonicalContext
						}
						if (++callbackCount !== 1) throw new Error('Spawner called onWorktreeReady more than once')
						callbackPath = worktreePath
						const context = prepared.onWorktreeReady(worktreePath)
						commands.recordPlanningWorkspaceIdentity(
							item.id,
							{ worktreePath, branchName: recordedBranchName, planDirName: identity.planDirName },
							{ expectedIdentity, transitionFromIdentity, authorizedTransition: transition },
						)
						new PlanWorkspace(worktreePath, identity.planDirName).writeReadme(
							readmeBody(item, recordedBranchName, identity.planDirName, agent),
						)
						return context
					},
					solverConfig: {
						...this.config.solver,
						agent,
						model: input.solverModel ?? this.config.solver.model,
						workspace: workspaceMode,
					},
					existingWorktreePath,
					replaceExistingSession: item.plannedAt !== null,
					signal: input.signal,
				})
			} catch (err) {
				// Cancellation remains the primary truth even if an adapter observes it
				// after creating a session; the caller still gets the honest hint.
				if (isCancellation(err, input.signal)) throw new PlanningError('cancelled', 'Request aborted', sessionMayExist)
				throw new PlanningError(
					'launch_failed',
					`Planning session failed to start: ${err instanceof Error ? err.message : err}`,
					sessionMayExist,
				)
			} finally {
				callbackSealed = true
			}
			sessionMayExist = true
			if (
				callbackCount !== 1 ||
				!callbackPath ||
				!sameFilesystemPath(callbackPath, session.worktreePath) ||
				(!planningInMain && session.branchName !== identity.branchName)
			) {
				throw new PlanningError('launch_failed', 'Spawner violated the required workspace readiness contract', true)
			}
			try {
				commands.recordPlanPrepared(item.id, {
					worktreePath: session.worktreePath,
					branchName: recordedBranchName,
					planDirName: identity.planDirName,
					spawner: spawner.name,
				})
			} catch (err) {
				throw new PlanningError(
					'finalization_failed',
					`Planning session may exist but could not be finalized: ${err instanceof Error ? err.message : err}`,
					true,
				)
			}
			return {
				worktreePath: session.worktreePath,
				branchName: recordedBranchName,
				planDirName: identity.planDirName,
				readmePath: new PlanWorkspace(session.worktreePath, identity.planDirName).readmePath,
				spawner: spawner.name,
				solverAgent: agent,
				hint: session.hint,
			}
		} catch (err) {
			if (began) {
				try {
					commands.abortPlanning(item.id, previous)
				} catch (abortErr) {
					log.error(
						'planning',
						`Could not abort planning for ${item.id}: ${abortErr instanceof Error ? abortErr.message : abortErr}`,
					)
				}
			}
			if (err instanceof PlanningError) throw err
			if (isCancellation(err, input.signal)) throw new PlanningError('cancelled', 'Request aborted')
			throw new PlanningError(
				'source_unavailable',
				`Item source context failed to load: ${err instanceof Error ? err.message : err}`,
			)
		} finally {
			this.claims.delete(claim)
		}
	}
}
