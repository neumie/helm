import type { ProjectConfig, VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { TaskProvider } from '../providers/provider.js'
import type { SolverResult } from '../types.js'
import { log } from '../util/logger.js'
import { pushBranch } from '../worktree/manager.js'
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

	// If claude already shipped (created PR via /vigil-ship), just record it
	if (result.prUrl) {
		log.info('dispatcher', `Claude already shipped PR: ${result.prUrl}`)
		db.updateTask(taskId, { prUrl: result.prUrl, prDraft: 0 })
		db.insertEvent(taskId, 'pr_created', { url: result.prUrl, draft: false, shippedByClaude: true })
		return
	}

	switch (result.tier) {
		case 'trivial': {
			pushBranch(worktreePath, branchName)
			if (config.github.createPrs) {
				const prUrl = createPR({
					worktreePath,
					branchName,
					baseBranch: projectConfig.baseBranch,
					title: `${config.github.prPrefix} ${result.prTitle ?? task.title}`,
					body: result.prBody ?? result.summary,
					draft: false,
				})
				db.updateTask(taskId, { prUrl, prDraft: 0 })
				db.insertEvent(taskId, 'pr_created', { url: prUrl, draft: false })

				if (config.github.postComments) {
					const commentId = await provider.postComment(task.clientcareId, `**Vigil**: Solved (trivial). PR: ${prUrl}`)
					if (commentId) {
						db.updateTask(taskId, { commentId })
						db.insertEvent(taskId, 'comment_posted', { commentId })
					}
				}
			}
			break
		}

		case 'simple': {
			pushBranch(worktreePath, branchName)
			if (config.github.createPrs) {
				const prUrl = createPR({
					worktreePath,
					branchName,
					baseBranch: projectConfig.baseBranch,
					title: `${config.github.prPrefix} ${result.prTitle ?? task.title}`,
					body: result.prBody ?? result.summary,
					draft: true,
				})
				db.updateTask(taskId, { prUrl, prDraft: 1 })
				db.insertEvent(taskId, 'pr_created', { url: prUrl, draft: true })

				if (config.github.postComments) {
					const commentId = await provider.postComment(
						task.clientcareId,
						`**Vigil**: Solved (draft PR for review). PR: ${prUrl}`,
					)
					if (commentId) {
						db.updateTask(taskId, { commentId })
						db.insertEvent(taskId, 'comment_posted', { commentId })
					}
				}
			}
			break
		}

		case 'complex': {
			pushBranch(worktreePath, branchName)

			if (config.github.postComments) {
				let md = `**Vigil**: Partial solution on branch \`${branchName}\`.\n\n`
				md += `**Summary**: ${result.summary}\n\n`
				if (result.analysis) md += `**Analysis**:\n${result.analysis}\n\n`
				if (result.remainingWork?.length) {
					md += '**Remaining work**:\n'
					for (const item of result.remainingWork) md += `- ${item}\n`
				}

				const commentId = await provider.postComment(task.clientcareId, md)
				if (commentId) {
					db.updateTask(taskId, { commentId })
					db.insertEvent(taskId, 'comment_posted', { commentId })
				}
			}
			break
		}

		case 'unclear': {
			if (config.github.postComments) {
				let md = '**Vigil**: Cannot proceed — task needs clarification.\n\n'
				if (result.analysis) md += `**Analysis**:\n${result.analysis}\n\n`
				if (result.questionsForRequester?.length) {
					md += '**Questions**:\n'
					for (const q of result.questionsForRequester) md += `- ${q}\n`
				}

				const commentId = await provider.postComment(task.clientcareId, md)
				if (commentId) {
					db.updateTask(taskId, { commentId })
					db.insertEvent(taskId, 'comment_posted', { commentId })
				}
			}
			break
		}

		default:
			log.warn('dispatcher', `Unknown tier: ${result.tier}`)
	}
}
