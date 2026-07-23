import {
	materializePreparedAttachmentsToWorktree,
	sanitizeAttachmentName,
	snapshotDeclaredAttachments,
	worktreeAttachmentRelativePath,
} from '../attachments/store.js'
import type { TaskContext, TaskProvider } from '../providers/provider.js'
import { applyRunContextDocument } from './run-context.js'
import type { ItemRecord } from './schema.js'

/**
 * The source-task content for an Item, captured-context first: a frozen
 * `capturedContext` (ingested email etc. — no live provider to re-poll) wins;
 * otherwise a live `provider.getTaskContext` for a provider-backed source; null
 * for a source-less Item. The single seam that lets a non-provider source
 * ('Email') skip the active provider — used by the worker, the detail/plan
 * routes, and the enricher so none of them branch on `capturedContext` by hand.
 */
export async function resolveItemSourceContext(item: ItemRecord, provider: TaskProvider): Promise<TaskContext | null> {
	if (item.capturedContext) return item.capturedContext
	if (item.source) return provider.getTaskContext(item.source.externalId)
	return null
}

function declaredAttachmentNames(item: ItemRecord, context: TaskContext): string[] {
	return (context.attachments ?? []).map(attachment => {
		if (!attachment.url.startsWith('/api/')) throw new Error('Captured attachment has an invalid declared served URL')
		const url = new URL(attachment.url, 'http://helm.local')
		const segments = url.pathname.split('/')
		if (
			segments.length !== 6 ||
			segments[1] !== 'api' ||
			segments[2] !== 'items' ||
			segments[3] !== item.id ||
			segments[4] !== 'attachments' ||
			!segments[5] ||
			url.search ||
			url.hash
		) {
			throw new Error('Captured attachment has an invalid declared served URL')
		}
		const name = sanitizeAttachmentName(segments[5])
		if (name !== segments[5]) throw new Error('Captured attachment has an invalid final filename')
		return name
	})
}

function localizeCapturedAttachments(item: ItemRecord, ctx: TaskContext): TaskContext {
	if (!ctx.attachments?.length) return ctx
	return {
		...ctx,
		attachments: ctx.attachments.map((a, index) => ({
			...a,
			url: worktreeAttachmentRelativePath(item.id, declaredAttachmentNames(item, ctx)[index]),
		})),
	}
}

/** The adapter-facing half of an execution context, available only after a workspace is ready. */
export interface PreparedItemExecutionContext {
	onWorktreeReady(worktreePath: string): TaskContext
}

/**
 * Keep execution context canonical until a Solver/Spawner has created its
 * workspace. Naming and other model helpers must receive this unlocalized
 * context; captured attachment bytes are validated and materialized only in the
 * required adapter readiness callback.
 */
export function prepareItemExecutionContext(
	item: ItemRecord,
	canonicalContext: TaskContext,
): PreparedItemExecutionContext {
	if (!item.capturedContext) {
		return { onWorktreeReady: () => canonicalContext }
	}
	const profileId = item.profileId
	const itemId = item.id
	const filenames = declaredAttachmentNames(item, canonicalContext)
	// Snapshot before any adapter can create a worktree/terminal. Buffers are not
	// re-read at readiness, closing source filesystem TOCTOU.
	const files = filenames.length > 0 ? snapshotDeclaredAttachments(itemId, filenames, profileId) : []
	const localized = localizeCapturedAttachments(item, canonicalContext)
	return {
		onWorktreeReady(worktreePath) {
			materializePreparedAttachmentsToWorktree(itemId, files, worktreePath)
			return localized
		},
	}
}

function itemMetadata(item: ItemRecord): Record<string, string> {
	const metadata: Record<string, string> = {
		'Item ID': item.id,
		Kind: item.kind,
		BaseRef: item.baseRef,
	}
	if (item.source) {
		metadata.Source = item.source.externalId
		// Clickable source URL so the agent can link it when it ships the PR itself.
		if (item.source.url) metadata['Source URL'] = item.source.url
	}
	return metadata
}

/** Canonical source/Item context. AI enrichment intentionally reads this raw
 * view; operator edits apply only through buildItemExecutionContext below. */
export function buildItemTaskContext(item: ItemRecord, sourceContext?: TaskContext | null): TaskContext {
	const metadata = itemMetadata(item)

	switch (item.payload.kind) {
		case 'solve':
			if (item.source && sourceContext) {
				return {
					...sourceContext,
					title: sourceContext.title || item.title,
					metadata: { ...(sourceContext.metadata ?? {}), ...metadata },
				}
			}
			return {
				title: item.title,
				description: item.payload.prompt,
				metadata,
			}
		case 'loop':
			return {
				title: item.title,
				description: `Run almanac loop for PRD: ${item.payload.prdPath}`,
				metadata: { ...metadata, PRD: item.payload.prdPath },
			}
	}
}

/** Planning and execution share this one overlay seam. A saved editor document
 * replaces narrative/comments while retaining server-owned identity and files. */
export function buildItemExecutionContext(item: ItemRecord, sourceContext?: TaskContext | null): TaskContext {
	return applyRunContextDocument(buildItemTaskContext(item, sourceContext), item.runContext)
}
