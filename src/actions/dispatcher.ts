import type { ProjectConfig, VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { TaskProvider } from '../providers/provider.js'
import type { SolverResult, TaskRecord } from '../types.js'
import { log } from '../util/logger.js'
import { pushBranch } from '../worktree/manager.js'
import { clarificationComment, partialSolutionComment } from './comment-format.js'
import { createPR } from './pr-creator.js'

export async function dispatch(
	taskId: string,
	result: SolverResult,
	config: VigilConfig,
	db: DB,
	provider: TaskProvider,
	projectConfig: ProjectConfig,
): Promise<void> {
	const task = db.getTask(taskId)
	if (!task) throw new Error(`Task ${taskId} not found`)

	const worktreePath = task.worktreePath ?? ''
	const branchName = task.branchName ?? ''

	// If claude already shipped (created PR via /almanac:ship), just record it.
	if (result.prUrl) {
		log.info('dispatcher', `Claude already shipped PR: ${result.prUrl}`)
		db.updateTask(taskId, { prUrl: result.prUrl, prDraft: 0 })
		db.insertEvent(taskId, 'pr_created', { url: result.prUrl, draft: false, shippedByClaude: true })
		return
	}

	switch (result.tier) {
		case 'trivial':
			await openPrAndRecord({
				taskId,
				db,
				provider,
				config,
				projectConfig,
				task,
				worktreePath,
				branchName,
				result,
				draft: false,
				label: 'Solved (trivial)',
			})
			break

		case 'simple':
			await openPrAndRecord({
				taskId,
				db,
				provider,
				config,
				projectConfig,
				task,
				worktreePath,
				branchName,
				result,
				draft: true,
				label: 'Solved (draft PR for review)',
			})
			break

		case 'complex':
			pushBranch(worktreePath, branchName)
			if (config.github.postComments) {
				await postCommentAndRecord(taskId, db, provider, task.clientcareId, partialSolutionComment(result, branchName))
			}
			break

		case 'unclear':
			if (config.github.postComments) {
				await postCommentAndRecord(taskId, db, provider, task.clientcareId, clarificationComment(result))
			}
			break

		default:
			log.warn('dispatcher', `Unknown tier: ${result.tier}`)
	}
}

interface OpenPrArgs {
	taskId: string
	db: DB
	provider: TaskProvider
	config: VigilConfig
	projectConfig: ProjectConfig
	task: TaskRecord
	worktreePath: string
	branchName: string
	result: SolverResult
	draft: boolean
	label: string
}

/** Push the branch, open a PR (if enabled), record it, and post a comment. */
async function openPrAndRecord(a: OpenPrArgs): Promise<void> {
	pushBranch(a.worktreePath, a.branchName)
	if (!a.config.github.createPrs) return

	const prUrl = createPR({
		worktreePath: a.worktreePath,
		branchName: a.branchName,
		baseBranch: a.projectConfig.baseBranch,
		title: `${a.config.github.prPrefix} ${a.result.prTitle ?? a.task.title}`,
		body: a.result.prBody ?? a.result.summary,
		draft: a.draft,
	})
	a.db.updateTask(a.taskId, { prUrl, prDraft: a.draft ? 1 : 0 })
	a.db.insertEvent(a.taskId, 'pr_created', { url: prUrl, draft: a.draft })

	if (a.config.github.postComments) {
		await postCommentAndRecord(a.taskId, a.db, a.provider, a.task.clientcareId, `**Vigil**: ${a.label}. PR: ${prUrl}`)
	}
}

/** Post a comment via the provider and record the comment id on the task. */
async function postCommentAndRecord(
	taskId: string,
	db: DB,
	provider: TaskProvider,
	externalId: string,
	markdown: string,
): Promise<void> {
	const commentId = await provider.postComment(externalId, markdown)
	if (commentId) {
		db.updateTask(taskId, { commentId })
		db.insertEvent(taskId, 'comment_posted', { commentId })
	}
}
