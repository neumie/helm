import { createHash } from 'node:crypto'
import type { HelmConfig, KnowledgeProviderConfig } from '../config.js'
import type { HelmProfile, ProfileKnowledgeBinding, ProfilesState } from '../profiles/store.js'

export interface ResolvedKnowledgeBinding extends ProfileKnowledgeBinding {
	bindingId: string
	profileId: string
	provider: KnowledgeProviderConfig
}

export function validateProfileKnowledgeConfiguration(config: HelmConfig, state: ProfilesState): void {
	const configuredProjects = new Set(config.projects.map(project => project.slug))
	const providers = new Map((config.knowledge?.providers ?? []).map(provider => [provider.id, provider]))
	for (const profile of state.profiles) {
		const enabled = new Set(profile.enabledProjects)
		for (const binding of profile.knowledgeBindings) {
			if (!configuredProjects.has(binding.projectSlug) || !enabled.has(binding.projectSlug)) {
				throw new Error(`Profile ${profile.id} has a knowledge binding for an unavailable Helm project`)
			}
			if (!providers.has(binding.providerId)) {
				throw new Error(`Profile ${profile.id} references an unknown knowledge provider`)
			}
		}
	}
}

export function resolveKnowledgeBinding(
	config: HelmConfig,
	profile: HelmProfile,
	projectSlug: string,
): ResolvedKnowledgeBinding | null {
	const binding = profile.knowledgeBindings.find(candidate => candidate.projectSlug === projectSlug)
	if (!binding) return null
	const provider = config.knowledge?.providers.find(candidate => candidate.id === binding.providerId)
	if (!provider) throw new Error('Configured knowledge binding references an unavailable provider')
	return {
		...binding,
		bindingId: bindingIdentity(profile.id, binding),
		profileId: profile.id,
		provider,
	}
}

export function bindingIdentity(profileId: string, binding: ProfileKnowledgeBinding): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				profileId,
				projectSlug: binding.projectSlug,
				providerId: binding.providerId,
				providerProjectId: binding.providerProjectId,
				characterBudget: binding.characterBudget,
			}),
		)
		.digest('hex')
}
