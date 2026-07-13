import { WORKTREE_ATTACHMENT_SUBDIR } from '../attachments/store.js'
import type { TaskContext, TaskProvider } from '../providers/provider.js'
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

/**
 * Rewrite a captured task's attachment URLs from their served HTTP path to the
 * worktree-relative `.helm-attachments/<name>` path, so a prompt rendered with
 * the worktree as cwd points the agent at the local copies (placed by
 * `copyAttachmentsToWorktree`). MUST be paired with that copy. No-op when there
 * are no attachments. Used by BOTH the solve worker and the plan route — keep
 * them symmetric (localize + copy together) or the agent gets unfetchable URLs.
 */
export function localizeCapturedAttachments(ctx: TaskContext): TaskContext {
	if (!ctx.attachments?.length) return ctx
	return {
		...ctx,
		attachments: ctx.attachments.map(a => ({ ...a, url: `${WORKTREE_ATTACHMENT_SUBDIR}/${a.url.split('/').pop()}` })),
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
		case 'ralph':
			return {
				title: item.title,
				description: `Run almanac ralph for PRD: ${item.payload.prdPath}`,
				metadata: { ...metadata, PRD: item.payload.prdPath },
			}
		case 'harden':
			return {
				title: item.title,
				description: `Run almanac harden for target: ${item.payload.target}`,
				metadata: { ...metadata, Target: item.payload.target },
			}
	}
}
