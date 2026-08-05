import type {
	AgentKnowledgeCandidate,
	KnowledgeDeliveryReceipt,
	KnowledgePurpose,
	ProviderKnowledgeBrief,
} from './schema.js'

export type KnowledgeProviderErrorCode =
	| 'authorization'
	| 'cancelled'
	| 'configuration'
	| 'conflict'
	| 'invalid-request'
	| 'invalid-response'
	| 'scope'
	| 'timeout'
	| 'unavailable'
	| 'version'

/** Sanitized provider failure safe for Item diagnostics and content-minimized logs. */
export class KnowledgeProviderError extends Error {
	constructor(
		readonly code: KnowledgeProviderErrorCode,
		message: string,
		readonly retryable: boolean,
		readonly outcomeUnknown = false,
	) {
		super(message)
		this.name = 'KnowledgeProviderError'
	}
}

export interface PrepareProviderBriefInput {
	providerProjectId: string
	purpose: KnowledgePurpose
	query: string
	characterBudget: number
	signal?: AbortSignal
}

export interface SubmitProviderCandidatesInput {
	providerProjectId: string
	idempotencyKey: string
	attemptRef: string
	sourceRefs: string[]
	candidates: AgentKnowledgeCandidate[]
	signal?: AbortSignal
}

/** One configured external provider instance. No adapter may write canonical knowledge. */
export interface KnowledgeProvider {
	readonly id: string
	readonly type: string
	readonly protocolVersion: number
	prepareBrief(input: PrepareProviderBriefInput): Promise<ProviderKnowledgeBrief>
	submitCandidates(input: SubmitProviderCandidatesInput): Promise<KnowledgeDeliveryReceipt>
}

export class KnowledgeProviderRegistry {
	private readonly providers: ReadonlyMap<string, KnowledgeProvider>

	constructor(providers: readonly KnowledgeProvider[]) {
		const entries = new Map<string, KnowledgeProvider>()
		for (const provider of providers) {
			if (entries.has(provider.id)) throw new Error('Knowledge provider ids must be unique')
			entries.set(provider.id, provider)
		}
		this.providers = entries
	}

	get(id: string): KnowledgeProvider {
		const provider = this.providers.get(id)
		if (!provider) throw new KnowledgeProviderError('configuration', 'Knowledge provider is not configured', false)
		return provider
	}

	list(): KnowledgeProvider[] {
		return [...this.providers.values()]
	}
}
