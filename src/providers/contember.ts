import { log } from '../util/logger.js'
import type { DescriptionBlock, DiscoveredTask, TaskContext, TaskProvider, TaskSummary } from './provider.js'

// -- GraphQL queries/mutations --

const LIST_NEW_TASKS = `
query ListNewTasks($projectSlug: String!, $createdAfter: DateTime!, $statuses: [TaskStatus!]!) {
  listTask(
    filter: {
      project: { slug: { eq: $projectSlug } }
      createdAt: { gte: $createdAfter }
      archivedAt: { isNull: true }
      status: { in: $statuses }
    }
    orderBy: [{ createdAt: asc }]
    limit: 50
  ) {
    id
    title
    status
    priority
    createdAt
    dueDate
    timeEstimate
    module { name }
    project { id slug name repositoryUrl aiMode }
  }
}
`

const GET_TASK_SUMMARY = `
query GetTaskSummary($taskId: UUID!) {
  getTask(by: { id: $taskId }) {
    title
    project { slug }
  }
}
`

const GET_TASK_CONTEXT = `
query GetTaskContext($taskId: UUID!) {
  getTask(by: { id: $taskId }) {
    id
    title
    status
    priority
    dueDate
    timeEstimate
    module { name }
    description {
      data
      references { id file { url fileName fileType } }
    }
    comments(
      orderBy: [{ createdAt: asc }]
    ) {
      id
      createdAt
      sourceType
      isPublic
      content { data }
      person { tenantPerson { name email } }
    }
    project {
      id name slug repositoryUrl aiMode
      description { data }
      contexts(orderBy: [{ updatedAt: desc }]) { title markdown }
    }
  }
}
`

const CREATE_COMMENT = `
mutation CreateComment($taskId: UUID!, $contentData: Json!, $isPublic: Boolean!) {
  createComment(data: {
    task: { connect: { id: $taskId } }
    isPublic: $isPublic
    sourceType: ai_generated
    content: { create: { data: $contentData } }
  }) {
    ok
    node { id }
  }
}
`

// -- Config --

export interface ContemberProviderConfig {
	type: 'contember'
	apiBaseUrl: string
	projectSlug: string
	apiToken: string
	taskBaseUrl?: string
	statuses: string[]
}

// -- Provider --

export class ContemberProvider implements TaskProvider {
	readonly name = 'Contember'
	private url: string
	private token: string
	private statuses: string[]

	constructor(config: ContemberProviderConfig) {
		this.url = `${config.apiBaseUrl}/content/${config.projectSlug}/live`
		this.token = config.apiToken
		this.statuses = config.statuses
	}

	async pollNewTasks(projectSlug: string, since: string): Promise<DiscoveredTask[]> {
		const data = await this.query<{ listTask: RawTask[] }>(LIST_NEW_TASKS, {
			projectSlug,
			createdAfter: since,
			statuses: this.statuses,
		})

		return data.listTask.map(t => ({
			externalId: t.id,
			title: t.title,
			createdAt: t.createdAt,
			projectSlug,
		}))
	}

	async resolveTaskSummary(externalId: string): Promise<TaskSummary | null> {
		const data = await this.query<{
			getTask: { title?: string | null; project?: { slug?: string | null } | null } | null
		}>(GET_TASK_SUMMARY, { taskId: externalId })
		const slug = data.getTask?.project?.slug
		const title = data.getTask?.title
		if (!slug || !title) return null
		return { projectSlug: slug, title }
	}

	async getTaskContext(externalId: string): Promise<TaskContext | null> {
		const data = await this.query<{ getTask: RawTaskFull | null }>(GET_TASK_CONTEXT, {
			taskId: externalId,
		})

		const t = data.getTask
		if (!t) return null

		const metadata: Record<string, string> = {}
		if (t.status) metadata.status = t.status
		if (t.priority) metadata.priority = t.priority
		if (t.dueDate) metadata['due date'] = t.dueDate
		if (t.timeEstimate) metadata['time estimate'] = `${t.timeEstimate}h`
		if (t.module?.name) metadata.module = t.module.name

		const comments =
			t.comments
				?.map(c => ({
					author: c.person?.tenantPerson?.name ?? c.person?.tenantPerson?.email ?? 'Unknown',
					createdAt: c.createdAt ?? '',
					body: c.content?.data ? extractPlainText(c.content.data) : '',
				}))
				.filter(c => c.body) ?? []

		const attachments: Array<{ name: string; url: string; contentType?: string }> = []
		if (t.description?.references) {
			for (const ref of t.description.references) {
				if (ref?.file?.url) {
					attachments.push({
						name: ref.file.fileName ?? 'file',
						url: ref.file.url,
						contentType: ref.file.fileType ?? undefined,
					})
				}
			}
		}

		let projectContext: string | undefined
		if (t.project) {
			const parts: string[] = []
			parts.push(`Project: ${t.project.name ?? ''} (slug: ${t.project.slug ?? ''})`)
			if (t.project.description?.data) {
				const desc = extractPlainText(t.project.description.data)
				if (desc) parts.push(`\nProject Description:\n${desc}`)
			}
			const contexts = t.project.contexts ?? []
			if (contexts.length > 0) {
				parts.push('\nProject Context Documents:')
				for (const ctx of contexts) {
					if (ctx.markdown) {
						const body = ctx.markdown.slice(0, 3000) + (ctx.markdown.length > 3000 ? '...' : '')
						parts.push(`\n### ${ctx.title ?? 'Untitled'}\n${body}`)
					}
				}
			}
			projectContext = parts.join('\n')
		}

		const descriptionBlocks = t.description?.data
			? extractDescriptionBlocks(t.description.data, t.description.references)
			: []

		return {
			title: t.title ?? '',
			description: t.description?.data ? extractPlainText(t.description.data) : undefined,
			descriptionBlocks: descriptionBlocks.length > 0 ? descriptionBlocks : undefined,
			metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
			comments: comments.length > 0 ? comments : undefined,
			attachments: attachments.length > 0 ? attachments : undefined,
			projectContext,
		}
	}

	async postComment(externalId: string, markdown: string): Promise<string | null> {
		const contentData = markdownToSlateJS(markdown)

		const result = await this.query<{
			createComment: { ok: boolean; node?: { id: string } }
		}>(CREATE_COMMENT, {
			taskId: externalId,
			contentData,
			isPublic: false,
		})

		if (result.createComment.ok) {
			const commentId = result.createComment.node?.id ?? null
			log.success('contember', `Posted comment on task ${externalId}`)
			return commentId
		}

		log.error('contember', `Failed to post comment on task ${externalId}`)
		return null
	}

	// -- Internal GraphQL --

	private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
		log.info('contember', `GraphQL → ${this.url}`, variables)
		const res = await fetch(this.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({ query, variables }),
		})

		log.info('contember', `GraphQL ← ${res.status}`)

		if (!res.ok) {
			const text = await res.text()
			throw new Error(`GraphQL request failed (${res.status}): ${text}`)
		}

		const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }

		if (json.errors?.length) {
			throw new Error(`GraphQL errors: ${json.errors.map(e => e.message).join(', ')}`)
		}

		return json.data as T
	}
}

// -- Raw Contember types --

interface RawTask {
	id: string
	title: string
	status: string
	priority: string | null
	createdAt: string
}

interface RawTaskFull {
	id: string
	title?: string | null
	status?: string | null
	priority?: string | null
	dueDate?: string | null
	timeEstimate?: number | null
	module?: { name?: string | null } | null
	description?: {
		data?: unknown
		references?: Array<{
			id?: string | null
			file?: { url?: string | null; fileName?: string | null; fileType?: string | null } | null
		}> | null
	} | null
	comments?: Array<{
		id: string
		createdAt?: string | null
		sourceType?: string | null
		isPublic?: boolean | null
		content?: { data?: unknown } | null
		person?: { tenantPerson?: { name?: string | null; email?: string | null } | null } | null
	}> | null
	project?: {
		id: string
		name?: string | null
		slug?: string | null
		repositoryUrl?: string | null
		aiMode?: string | null
		description?: { data?: unknown } | null
		contexts?: Array<{ title?: string | null; markdown?: string | null }> | null
	} | null
}

// -- SlateJS utilities --

/**
 * Walk the top-level SlateJS blocks in document order, emitting text blocks and
 * inline image blocks (resolved via `referenceId` → references[].file.url), so
 * the dashboard can render images between the surrounding paragraphs instead of
 * collecting them all at the end. Non-image references stay out (they surface as
 * attachments); unrecognized shapes degrade to nothing.
 */
function extractDescriptionBlocks(
	data: unknown,
	references: NonNullable<RawTaskFull['description']>['references'],
): DescriptionBlock[] {
	const refMap = new Map<string, { url: string; name?: string; contentType?: string }>()
	for (const ref of references ?? []) {
		if (ref?.id && ref.file?.url) {
			refMap.set(ref.id, {
				url: ref.file.url,
				name: ref.file.fileName ?? undefined,
				contentType: ref.file.fileType ?? undefined,
			})
		}
	}

	const children = (data as { children?: unknown })?.children
	if (!Array.isArray(children)) return []

	const blocks: DescriptionBlock[] = []
	for (const child of children) {
		const node = child as { type?: string; level?: number; referenceId?: string }
		if (node?.type === 'image' && typeof node.referenceId === 'string' && refMap.has(node.referenceId)) {
			const file = refMap.get(node.referenceId)
			if (file) blocks.push({ type: 'image', ...file })
			continue
		}
		const text = extractPlainText(child)
		if (text) {
			const heading = node?.type === 'heading' && typeof node.level === 'number' ? node.level : undefined
			blocks.push(heading ? { type: 'text', text, heading } : { type: 'text', text })
		}
	}
	return blocks
}

/**
 * Extract plain text from SlateJS JSON data.
 */
function extractPlainText(value: unknown, depth = 0): string {
	if (depth > 10 || value === null || value === undefined) return ''
	if (typeof value === 'string') return value.trim()
	if (Array.isArray(value)) {
		return value
			.map(item => extractPlainText(item, depth + 1))
			.filter(Boolean)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim()
	}
	if (typeof value !== 'object') return ''

	const obj = value as Record<string, unknown>
	const chunks: string[] = []

	for (const key of ['text', 'title', 'caption', 'alt', 'markdown']) {
		const entry = obj[key]
		if (typeof entry === 'string' && entry.trim()) chunks.push(entry.trim())
	}

	for (const key of ['children', 'content', 'nodes', 'items', 'document', 'value', 'data']) {
		const nested = extractPlainText(obj[key], depth + 1)
		if (nested) chunks.push(nested)
	}

	if (chunks.length === 0) {
		for (const [key, entry] of Object.entries(obj)) {
			if (['url', 'href', 'src', 'id', 'type', '__typename'].includes(key)) continue
			const nested = extractPlainText(entry, depth + 1)
			if (nested) chunks.push(nested)
		}
	}

	return chunks.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Convert markdown to SlateJS format for Contember's content field.
 */
function markdownToSlateJS(markdown: string): { children: unknown[]; formatVersion: number } {
	const paragraphs = markdown.split(/\n\s*\n/).filter(p => p.trim().length > 0)

	const children = paragraphs.map(paragraph => {
		const paragraphChildren: unknown[] = []
		const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
		let lastIndex = 0
		let match: RegExpExecArray | null = linkRegex.exec(paragraph)

		while (match !== null) {
			if (match.index > lastIndex) {
				const textBefore = paragraph.substring(lastIndex, match.index)
				if (textBefore) paragraphChildren.push({ text: textBefore })
			}
			paragraphChildren.push({
				href: match[2],
				type: 'anchor',
				children: [{ text: match[1] }],
			})
			lastIndex = match.index + match[0].length
			match = linkRegex.exec(paragraph)
		}

		if (lastIndex < paragraph.length) {
			const textAfter = paragraph.substring(lastIndex)
			if (textAfter) paragraphChildren.push({ text: textAfter })
		}

		if (paragraphChildren.length === 0) {
			paragraphChildren.push({ text: paragraph })
		}

		return { type: 'paragraph', children: paragraphChildren }
	})

	return { children, formatVersion: 2 }
}
