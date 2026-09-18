import { USAGE_CACHE_MS, USAGE_RETRY_MS, type UsageProvider } from './usage-protocol.js'
import { defaultUsageEnvironment, readProviderUsage } from './usage-sources.js'

/**
 * Plan limits move slowly and every paired device polls the same host, so a device
 * asking for usage must never become an upstream request. One cached read is shared
 * by every viewer, and concurrent asks join the single in-flight read.
 */
export class RemoteUsage {
	private readonly read: () => Promise<UsageProvider[]>
	private readonly now: () => number
	private readonly ttlMs: number
	private readonly retryMs: number
	private cached: { providers: UsageProvider[]; refreshedAt: number } | null = null
	private inFlight: Promise<UsageProvider[]> | null = null

	constructor(
		options: {
			read?: () => Promise<UsageProvider[]>
			now?: () => number
			ttlMs?: number
			retryMs?: number
		} = {},
	) {
		const environment = defaultUsageEnvironment()
		this.now = options.now ?? Date.now
		this.read = options.read ?? (() => readProviderUsage({ ...environment, now: this.now }))
		this.ttlMs = options.ttlMs ?? USAGE_CACHE_MS
		this.retryMs = options.retryMs ?? USAGE_RETRY_MS
	}

	/** A read with nothing to show is retried sooner than a healthy one, but never per request. */
	private lifetime(providers: UsageProvider[]): number {
		return providers.some(provider => provider.windows.length) ? this.ttlMs : this.retryMs
	}

	async providers(): Promise<{ providers: UsageProvider[]; refreshedAt: number }> {
		const cached = this.cached
		if (cached && this.now() - cached.refreshedAt < this.lifetime(cached.providers)) return cached
		if (!this.inFlight)
			this.inFlight = this.read()
				.then(providers => {
					this.cached = { providers, refreshedAt: this.now() }
					return providers
				})
				.finally(() => {
					this.inFlight = null
				})
		try {
			await this.inFlight
		} catch {
			// A failed read keeps the last good answer rather than blanking the view.
		}
		return this.cached ?? { providers: [], refreshedAt: this.now() }
	}
}
