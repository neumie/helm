import { ContemberProvider, type ContemberProviderConfig } from './contember.js'
import type { TaskProvider } from './provider.js'

/**
 * Single construction site for the active {@link TaskProvider}, mirroring
 * `solver/registry.ts`. Only `contember` exists today; if a second provider is
 * added, make `config.provider` a discriminated union (`config.ts`) and branch
 * on `config.type` here.
 */
export function createProvider(config: ContemberProviderConfig): TaskProvider {
	return new ContemberProvider(config)
}
