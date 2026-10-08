import type {
	ReviewAnnotation,
	ReviewDocument,
	ReviewMessage,
	ReviewPassage,
	ReviewSession,
} from '../../document-review/types'
import type { ReviewBlock } from './markdown'
import { validateDocumentPassage } from './passage-validation'

export interface PassageThread {
	id: string
	quote: string
	messages: ReviewMessage[]
	providerName?: string
}

/** Current-source display projection only. Never relocate quotes or infer a reply from proximity. */
export function projectPassageThreads(
	document: ReviewDocument | null,
	session: ReviewSession | null,
	blocks: Pick<ReviewBlock, 'id' | 'start' | 'end'>[],
	annotations: ReviewAnnotation[] = document?.archive?.annotations ?? [],
): Map<string, PassageThread[]> {
	const result = new Map<string, PassageThread[]>()
	if (!document) return result
	const blockFor = (passage: ReviewPassage) =>
		blocks.find(block =>
			document.format === 'jsx' && passage.kind === 'block'
				? block.id === passage.canvasId && block.start === passage.start && block.end === passage.end
				: passage.start >= block.start && passage.start < block.end,
		)
	const liveArchives = new Set(session?.messages.map(message => message.archiveThreadId).filter(Boolean) ?? [])
	for (const thread of document.archive?.threads ?? []) {
		if (!thread.passage || liveArchives.has(thread.id)) continue
		try {
			validateDocumentPassage(document, thread.passage)
		} catch {
			continue
		}
		const block = blockFor(thread.passage)
		if (!block) continue
		const group = result.get(block.id) ?? []
		group.push({
			id: `archive:${thread.id}`,
			quote: thread.passage.quote,
			providerName: thread.name,
			messages: [
				{ id: `${thread.id}:user`, role: 'user', text: thread.instruction },
				...(thread.reply ? [{ id: `${thread.id}:assistant`, role: 'assistant' as const, text: thread.reply }] : []),
				{
					id: `${thread.id}:state`,
					role: 'activity',
					text: archiveThreadStatus(thread.state) + (thread.detail ? ` · ${thread.detail}` : ''),
				},
			],
		})
		result.set(block.id, group)
	}
	for (const annotation of annotations) {
		if (annotation.resolved) continue
		try {
			validateDocumentPassage(document, annotation.passage)
		} catch {
			continue
		}
		const block = blockFor(annotation.passage)
		if (!block) continue
		const group = result.get(block.id) ?? []
		group.push({
			id: `annotation:${annotation.id}`,
			quote: annotation.passage.quote,
			messages: [
				{ id: annotation.id, role: 'user', text: annotation.note },
				{ id: `${annotation.id}:local`, role: 'activity', text: 'Local comment · not sent' },
			],
		})
		result.set(block.id, group)
	}
	if (!session) return result
	for (const message of session.messages) {
		const context = message.passageContext
		if (message.role !== 'user' || !context || context.documentId !== document.id || !message.id.endsWith(':user'))
			continue
		try {
			validateDocumentPassage(document, context.passage)
		} catch {
			continue
		}
		const block = blockFor(context.passage)
		if (!block) continue
		const requestId = message.id.slice(0, -5)
		const messages = session.messages.filter(
			value => value.id === message.id || value.id === `${requestId}:assistant` || value.id === `${requestId}:error`,
		)
		const group = result.get(block.id) ?? []
		group.push({ id: message.id, quote: context.passage.quote, messages })
		result.set(block.id, group)
	}
	return result
}

export function archiveThreadStatus(state: string): string {
	return state === 'complete'
		? 'Saved reply · read-only'
		: state === 'unconfirmed'
			? 'Outcome not confirmed · nothing replayed'
			: state === 'rejected'
				? 'Not sent · saved history'
				: state === 'unknown'
					? 'Outcome unknown · nothing replayed'
					: 'Reply failed · saved history'
}
