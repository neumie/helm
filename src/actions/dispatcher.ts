import type { HelmConfig } from '../config.js'
import type { ItemCommands } from '../items/commands.js'
import type { ItemRecord } from '../items/schema.js'
import type { TaskProvider } from '../providers/provider.js'
import type { SolverResult } from '../types.js'
import { log } from '../util/logger.js'
import { getCurrentBranch, pushBranch } from '../worktree/manager.js'
import { createPR } from './pr-creator.js'

export interface DispatchPrOptions {
	worktreePath: string
	branchName: string
	baseBranch: string
	title: string
	body: string
	draft: boolean
}

export interface DispatchSideEffects {
	pushBranch(worktreePath: string, branchName: string): void | Promise<void>
	createPr(opts: DispatchPrOptions): string | Promise<string>
	/** Branch currently checked out at the workspace (main-workspace branch discovery). */
	currentBranch(worktreePath: string): string | null | Promise<string | null>
}

const DEFAULT_SIDE_EFFECTS: DispatchSideEffects = {
	pushBranch,
	createPr: createPR,
	currentBranch: getCurrentBranch,
}

function dispatchSideEffects(overrides?: Partial<DispatchSideEffects>): DispatchSideEffects {
	return { ...DEFAULT_SIDE_EFFECTS, ...overrides }
}

export interface DispatchSolveItemArgs {
	itemId: string
	result: SolverResult
	config: HelmConfig
	commands: ItemCommands
	provider: TaskProvider
	sideEffects?: Partial<DispatchSideEffects>
}

export async function dispatchSolveItem(args: DispatchSolveItemArgs): Promise<void> {
	const item = args.commands.getItem(args.itemId)
	if (!item) throw new Error(`Item ${args.itemId} not found`)
	if (item.kind !== 'solve') throw new Error(`Item ${args.itemId} is ${item.kind}, not solve`)

	if (args.result.prUrl) {
		log.info('dispatcher', `Agent already shipped PR: ${args.result.prUrl}`)
		args.commands.recordDispatchPr(args.itemId, { prUrl: args.result.prUrl, shippedByAgent: true })
		args.commands.recordActionCompleted(args.itemId)
		return
	}

	if (!args.config.github.createPrs) {
		args.commands.recordDispatchSkipped(args.itemId, 'github.createPrs disabled')
		args.commands.recordActionCompleted(args.itemId)
		return
	}

	const worktreePath = item.worktreePath
	if (!worktreePath) {
		throw new Error(`Item ${args.itemId} is missing worktree or branch for dispatch`)
	}

	const sideEffects = dispatchSideEffects(args.sideEffects)

	// Main-workspace runs never carry a pre-created branch on the row: discover
	// the agent-created branch from the checkout at dispatch time. Refuse to
	// dispatch the base branch itself — if the agent never branched, pushing
	// would ship straight onto the user's main.
	const mainMode =
		item.payload.kind === 'solve' && (item.payload.solverWorkspace ?? args.config.solver.workspace) === 'main'
	let branchName: string | null
	if (mainMode) {
		branchName = await sideEffects.currentBranch(worktreePath)
		if (!branchName) {
			throw new Error(`Item ${args.itemId} has no current branch to dispatch (main-workspace run, detached HEAD?)`)
		}
		const base = item.baseRef.replace(/^origin\//, '')
		if (branchName === base) {
			throw new Error(
				`Item ${args.itemId} is still on the base branch "${branchName}" — the agent did not create a task branch; refusing to push it`,
			)
		}
	} else {
		branchName = item.branchName
		if (!branchName) {
			throw new Error(`Item ${args.itemId} is missing worktree or branch for dispatch`)
		}
	}

	await sideEffects.pushBranch(worktreePath, branchName)

	const baseBody = args.result.prBody ?? args.result.summary
	const sourceLink = item.source?.url ? `\n\n---\n**Source:** ${item.source.url}` : ''
	const prUrl = await sideEffects.createPr({
		worktreePath,
		branchName,
		baseBranch: item.baseRef,
		title: `${args.config.github.prPrefix} ${args.result.prTitle ?? item.title}`,
		body: `${baseBody}${sourceLink}`,
		draft: false,
	})
	args.commands.recordDispatchPr(args.itemId, { prUrl })

	if (shouldPostItemComment(args.config, item, args.provider)) {
		const commentId = await args.provider.postComment(item.source.externalId, `**Helm**: Solved. PR: ${prUrl}`)
		if (commentId) args.commands.recordDispatchComment(args.itemId, commentId)
	}

	args.commands.recordActionCompleted(args.itemId)
}

function shouldPostItemComment(
	config: HelmConfig,
	item: ItemRecord,
	provider: TaskProvider,
): item is ItemRecord & {
	source: NonNullable<ItemRecord['source']>
} {
	// A captured-context Item (ingested email etc.) is provider-LESS — its
	// `source.externalId` (`email:<uuid>`) is not a real provider task. Never post
	// a comment for it, even if its `source.provider` label happens to collide with
	// the active provider name (a caller-supplied label must not re-attach it).
	if (item.capturedContext) return false
	return config.github.postComments && item.source !== null && item.source.provider === provider.name
}
