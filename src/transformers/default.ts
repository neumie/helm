import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskContext } from '../providers/provider.js'
import type { TransformerContext } from './transformer.js'

export function defaultTransformer(task: TaskContext, ctx: TransformerContext): string {
	let context = ''

	if (task.projectContext) {
		context += `Project Context:\n${task.projectContext}\n\n`
	}

	context += `Task: ${task.title}\n`

	if (task.metadata && Object.keys(task.metadata).length > 0) {
		for (const [key, value] of Object.entries(task.metadata)) {
			context += `${key}: ${value}\n`
		}
	}

	if (task.description) {
		context += `\nDescription:\n${task.description}\n`
	}

	if (task.attachments && task.attachments.length > 0) {
		context += '\nAttachments:\n'
		for (const a of task.attachments) {
			context += `- ${a.name} -> ${a.url}\n`
		}
	}

	if (task.comments && task.comments.length > 0) {
		context += `\nComments (${task.comments.length}):\n`
		for (const c of task.comments) {
			context += `\n- [${c.createdAt}] ${c.author}\n${c.body || '(no text)'}\n`
		}
	}

	const planArtifacts = readPlanArtifacts(ctx.worktreePath, ctx.planDirName)
	if (planArtifacts) {
		context += `\n## Plan Artifacts\n\nThe requester (or a prior planning session) wrote the following files to docs/plans/${ctx.planDirName}/ before this task ran. Treat them as authoritative scoping — they reflect decisions already made.\n\n${planArtifacts}`
	}

	return context
}

function readPlanArtifacts(worktreePath: string, planDirName: string): string | null {
	const plansDir = join(worktreePath, 'docs', 'plans', planDirName)
	if (!existsSync(plansDir)) return null

	const entries = readdirSync(plansDir)
		.filter(name => name.endsWith('.md'))
		.map(name => {
			const fullPath = join(plansDir, name)
			return { name, fullPath, mtime: statSync(fullPath).mtimeMs }
		})
		.sort((a, b) => a.mtime - b.mtime)

	if (entries.length === 0) return null

	let out = ''
	for (const entry of entries) {
		const content = readFileSync(entry.fullPath, 'utf-8')
		const mtimeIso = new Date(entry.mtime).toISOString()
		out += `<plan_artifact path="docs/plans/${planDirName}/${entry.name}" mtime="${mtimeIso}">\n${content}\n</plan_artifact>\n\n`
	}
	return out
}
