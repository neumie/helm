import { createHash } from 'node:crypto'
import type { HelmConfig } from '../config.js'
import type { HelmProfile } from '../profiles/store.js'
import type { TaskContext } from '../providers/provider.js'
import { type ResolvedKnowledgeBinding, resolveKnowledgeBinding } from './bindings.js'
import { KnowledgeProviderError, type KnowledgeProviderRegistry } from './provider.js'
import {
	type AgentKnowledgeCandidate,
	type KnowledgeCandidateOutboxEntry,
	type KnowledgeSnapshot,
	MAX_KNOWLEDGE_CONTEXT_CHARACTERS,
	providerKnowledgeBriefSchema,
} from './schema.js'
import { type KnowledgeStore, frozenBinding } from './store.js'

export interface PrepareKnowledgeContextInput {
	profileId: string
	itemId: string
	projectSlug: string
	purpose: 'planning' | 'solve'
	taskContext: TaskContext
	binding: ResolvedKnowledgeBinding | null
	signal?: AbortSignal
}

export interface PreparedKnowledgeContext {
	taskContext: TaskContext
	snapshot: KnowledgeSnapshot | null
	binding: ResolvedKnowledgeBinding | null
}

/** Deep provider-neutral seam used by Planning, solve, and candidate delivery. */
export class KnowledgeIntegration {
	constructor(
		private readonly config: HelmConfig,
		private readonly profileById: (profileId: string) => HelmProfile,
		private readonly providers: KnowledgeProviderRegistry,
		private readonly onCandidatesQueued: () => void = () => undefined,
	) {}

	bindingFor(profileId: string, projectSlug: string): ResolvedKnowledgeBinding | null {
		return resolveKnowledgeBinding(this.config, this.profileById(profileId), projectSlug)
	}

	provider(providerId: string) {
		return this.providers.get(providerId)
	}

	notifyCandidatesQueued(): void {
		this.onCandidatesQueued()
	}

	enqueueCandidates(
		store: KnowledgeStore,
		input: {
			itemId: string
			projectSlug: string
			snapshotId: string | null
			binding: ResolvedKnowledgeBinding
			candidates: AgentKnowledgeCandidate[]
		},
	): KnowledgeCandidateOutboxEntry {
		const entry = store.enqueueCandidateBatch({
			itemId: input.itemId,
			projectSlug: input.projectSlug,
			snapshotId: input.snapshotId,
			binding: frozenBinding(input.binding),
			candidates: input.candidates,
		})
		this.onCandidatesQueued()
		return entry
	}

	/**
	 * Resolve one required provider brief, verify it, persist the exact bytes,
	 * then return those persisted bytes for adapter consumption. No binding means
	 * deliberate opt-out; a configured binding never degrades to empty context.
	 */
	async prepareContext(store: KnowledgeStore, input: PrepareKnowledgeContextInput): Promise<PreparedKnowledgeContext> {
		const binding = input.binding
		if (!binding) return { taskContext: input.taskContext, snapshot: null, binding: null }
		if (binding.profileId !== input.profileId || binding.projectSlug !== input.projectSlug) {
			throw new KnowledgeProviderError('configuration', 'Knowledge binding does not match the admitted Item', false)
		}
		const query = knowledgeQuery(input.taskContext)
		const provider = this.providers.get(binding.providerId)
		const rawBrief = await provider.prepareBrief({
			providerProjectId: binding.providerProjectId,
			purpose: input.purpose,
			query,
			characterBudget: binding.characterBudget,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		})
		const parsedBrief = providerKnowledgeBriefSchema.safeParse(rawBrief)
		if (!parsedBrief.success) {
			throw new KnowledgeProviderError(
				'invalid-response',
				'Knowledge provider response violated the evidence contract',
				false,
			)
		}
		const brief = parsedBrief.data
		verifyBrief(brief, binding.characterBudget)
		const snapshot = store.createSnapshot({
			itemId: input.itemId,
			projectSlug: input.projectSlug,
			purpose: input.purpose,
			query,
			characterBudget: binding.characterBudget,
			context: brief.context,
			manifest: brief.sources,
			provider: {
				bindingId: binding.bindingId,
				providerId: provider.id,
				providerType: provider.type,
				providerProjectId: binding.providerProjectId,
				briefRef: brief.briefRef,
				revision: brief.revision,
				generatedAt: brief.generatedAt,
				contextHash: brief.contextHash,
				protocolVersion: provider.protocolVersion,
			},
		})
		return {
			taskContext: {
				...input.taskContext,
				projectContext: [input.taskContext.projectContext, snapshot.context].filter(Boolean).join('\n\n'),
			},
			snapshot,
			binding,
		}
	}
}

function knowledgeQuery(taskContext: TaskContext): string {
	const textBlocks = taskContext.descriptionBlocks
		?.filter(
			(block): block is Extract<(typeof taskContext.descriptionBlocks)[number], { type: 'text' }> =>
				block.type === 'text',
		)
		.map(block => block.text)
	const values = [
		taskContext.title,
		taskContext.description,
		...(textBlocks ?? []),
		...(taskContext.comments?.map(comment => comment.body) ?? []),
		...Object.values(taskContext.metadata ?? {}),
	].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
	return truncateCodePoints(values.join('\n'), 4_000)
}

function verifyBrief(brief: ReturnType<typeof providerKnowledgeBriefSchema.parse>, characterBudget: number): void {
	if (sha256(brief.context) !== brief.contextHash) {
		throw new KnowledgeProviderError('invalid-response', 'Knowledge provider returned an invalid context hash', false)
	}
	if (
		codePointLength(brief.context) > characterBudget ||
		codePointLength(brief.context) > MAX_KNOWLEDGE_CONTEXT_CHARACTERS
	) {
		throw new KnowledgeProviderError('invalid-response', 'Knowledge provider returned context above its budget', false)
	}
	const seen = new Set<string>()
	let previousEnd = 0
	for (const source of brief.sources) {
		if (seen.has(source.sourceRef)) {
			throw new KnowledgeProviderError(
				'invalid-response',
				'Knowledge provider returned duplicate source evidence',
				false,
			)
		}
		seen.add(source.sourceRef)
		if (source.range.start < previousEnd || source.range.end > brief.context.length) {
			throw new KnowledgeProviderError('invalid-response', 'Knowledge provider returned an invalid source range', false)
		}
		const selected = brief.context.slice(source.range.start, source.range.end)
		if (sha256(selected) !== source.contentHash || codePointLength(selected) !== source.characters) {
			throw new KnowledgeProviderError(
				'invalid-response',
				'Knowledge provider returned inconsistent source evidence',
				false,
			)
		}
		previousEnd = source.range.end
	}
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

function truncateCodePoints(value: string, maximum: number): string {
	return [...value].slice(0, maximum).join('')
}

function codePointLength(value: string): number {
	return [...value].length
}
