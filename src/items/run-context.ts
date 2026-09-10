import { z } from 'zod'
import { descriptionBlockSchema, descriptionImageBlockSchema } from '../providers/provider.js'
import type { TaskContext } from '../providers/provider.js'

export const MAX_RUN_CONTEXT_MARKDOWN_LENGTH = 200_000
export const MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH = 750_000

/**
 * Lossless editor state plus the Markdown projection sent to planning and
 * execution. The daemon treats `blocks` as opaque JSON owned by the desktop
 * editor; only `markdown` crosses into the agent prompt.
 */
export const runContextDraftSchema = z
	.object({
		version: z.literal(1),
		blocks: z.array(z.record(z.string(), z.unknown())).max(2_000),
		markdown: z.string().max(MAX_RUN_CONTEXT_MARKDOWN_LENGTH),
	})
	.strict()

const runContextImageSchema = descriptionImageBlockSchema

export const plainRunContextDocumentSchema = z
	.object({
		version: z.literal(2),
		text: z.string().max(MAX_RUN_CONTEXT_MARKDOWN_LENGTH),
		images: z.array(runContextImageSchema).max(2_000),
		updatedAt: z.string().datetime(),
	})
	.strict()

export const runContextDocumentSchema = z.union([
	runContextDraftSchema.extend({ updatedAt: z.string().datetime() }).strict(),
	plainRunContextDocumentSchema,
])

export type RunContextDraft = z.infer<typeof runContextDraftSchema>
export type PlainRunContextDocument = z.infer<typeof plainRunContextDocumentSchema>
export type RunContextDocument = z.infer<typeof runContextDocumentSchema>

export class RunContextConflictError extends Error {
	constructor() {
		super('Run context changed in another editor')
		this.name = 'RunContextConflictError'
	}
}

export function parseRunContextDraft(input: unknown): RunContextDraft {
	const draft = runContextDraftSchema.parse(input)
	if (JSON.stringify(draft.blocks).length > MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH) {
		throw new Error(`Run context editor state exceeds ${MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH} characters`)
	}
	return draft
}

export function parseRunContextDocument(input: unknown): RunContextDocument {
	const document = runContextDocumentSchema.parse(input)
	if (document.version === 1) {
		if (JSON.stringify(document.blocks).length > MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH)
			throw new Error(`Run context editor state exceeds ${MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH} characters`)
		return document
	}
	if (JSON.stringify(document).length > MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH)
		throw new Error(`Run context document exceeds ${MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH} characters`)
	return document
}

export function plainRunContextFromSource(source: TaskContext, text: string): PlainRunContextDocument {
	const images = (source.descriptionBlocks ?? []).filter(
		(block): block is Extract<NonNullable<TaskContext['descriptionBlocks']>[number], { type: 'image' }> =>
			block.type === 'image',
	)
	const document = {
		version: 2 as const,
		text,
		images,
		updatedAt: new Date().toISOString(),
	}
	return parseRunContextDocument(document) as PlainRunContextDocument
}

/**
 * A saved run-context document replaces only source-authored narrative and
 * comments. Identity, project metadata, source URL, and attachments remain
 * server-owned so an editor operation cannot silently detach the run from its
 * Item or files.
 */
export function applyRunContextDocument(task: TaskContext, document: RunContextDocument | null): TaskContext {
	if (!document) return task
	if (document.version === 2) {
		const imageFacts = document.images.map(image => `Image reference: ${image.name ?? 'unnamed'} -> ${image.url}`)
		const text = document.text.trim()
		return {
			...task,
			description: [text, ...imageFacts].filter(Boolean).join('\n\n') || undefined,
			descriptionBlocks: undefined,
			comments: undefined,
		}
	}
	const markdown = document.markdown.trim()
	return {
		...task,
		description: markdown || undefined,
		descriptionBlocks: undefined,
		comments: undefined,
	}
}
