import type { VigilConfig } from '../config.js'
import type { ItemCommands } from '../items/commands.js'
import type { ItemRecord } from '../items/schema.js'
import type { TaskProvider } from '../providers/provider.js'
import type { SolverResult } from '../types.js'
import { log } from '../util/logger.js'
import { pushBranch } from '../worktree/manager.js'
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
}

const DEFAULT_SIDE_EFFECTS: DispatchSideEffects = {
	pushBranch,
	createPr: createPR,
}

function dispatchSideEffects(overrides?: Partial<DispatchSideEffects>): DispatchSideEffects {
	return { ...DEFAULT_SIDE_EFFECTS, ...overrides }
}

export interface DispatchSolveItemArgs {
	itemId: string
	result: SolverResult
	config: VigilConfig
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
	const branchName = item.branchName
	if (!worktreePath || !branchName) {
		throw new Error(`Item ${args.itemId} is missing worktree or branch for dispatch`)
	}

	const sideEffects = dispatchSideEffects(args.sideEffects)
	await sideEffects.pushBranch(worktreePath, branchName)

	const prUrl = await sideEffects.createPr({
		worktreePath,
		branchName,
		baseBranch: item.baseRef,
		title: `${args.config.github.prPrefix} ${args.result.prTitle ?? item.title}`,
		body: args.result.prBody ?? args.result.summary,
		draft: false,
	})
	args.commands.recordDispatchPr(args.itemId, { prUrl })

	if (shouldPostItemComment(args.config, item, args.provider)) {
		const commentId = await args.provider.postComment(item.source.externalId, `**Vigil**: Solved. PR: ${prUrl}`)
		if (commentId) args.commands.recordDispatchComment(args.itemId, commentId)
	}

	args.commands.recordActionCompleted(args.itemId)
}

function shouldPostItemComment(
	config: VigilConfig,
	item: ItemRecord,
	provider: TaskProvider,
): item is ItemRecord & {
	source: NonNullable<ItemRecord['source']>
} {
	return config.github.postComments && item.source !== null && item.source.provider === provider.name
}
