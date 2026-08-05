import type { HelmConfig, KnowledgeProviderConfig } from '../config.js'
import { HoldKnowledgeProvider } from './hold-provider.js'
import { type KnowledgeProvider, KnowledgeProviderRegistry } from './provider.js'

export function createKnowledgeProviderRegistry(config: HelmConfig): KnowledgeProviderRegistry {
	return new KnowledgeProviderRegistry((config.knowledge?.providers ?? []).map(createKnowledgeProvider))
}

function createKnowledgeProvider(config: KnowledgeProviderConfig): KnowledgeProvider {
	switch (config.type) {
		case 'hold':
			return new HoldKnowledgeProvider(config)
	}
}
