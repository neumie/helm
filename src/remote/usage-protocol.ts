import { z } from 'zod'

/** Negotiated like every other optional Remote capability: absent header means the route stays hidden. */
export const USAGE_HEADER = 'X-Helm-Usage'
export const USAGE_RESPONSE_BYTES = 8 * 1024
/** Provider plan limits refresh slowly; a device poll must never become an upstream poll. */
export const USAGE_CACHE_MS = 300_000
export const USAGE_RETRY_MS = 30_000
export const USAGE_REQUEST_TIMEOUT_MS = 10_000
export const MAX_USAGE_PROVIDERS = 4
export const MAX_USAGE_WINDOWS = 6

export const usageProviderIdSchema = z.enum(['claude', 'codex'])
export type UsageProviderId = z.infer<typeof usageProviderIdSchema>

export const usageWindowSchema = z
	.object({
		/** Human label for the limit window, e.g. "5-hour" or "Weekly". */
		label: z.string().min(1).max(48),
		usedPercent: z.number().min(0).max(100),
		/** Epoch milliseconds when the window resets, or null when the provider omits it. */
		resetsAt: z.number().int().nullable(),
		windowSeconds: z.number().int().positive().nullable(),
		/** How far through the window we are, so a bar can show pace rather than only spend. */
		elapsedPercent: z.number().min(0).max(100).nullable(),
	})
	.strict()
export type UsageWindow = z.infer<typeof usageWindowSchema>

export const usageProviderSchema = z
	.object({
		id: usageProviderIdSchema,
		name: z.string().min(1).max(48),
		plan: z.string().min(1).max(48).nullable(),
		windows: z.array(usageWindowSchema).max(MAX_USAGE_WINDOWS),
		/** 'live' came from the provider API; 'local' was reconstructed from on-disk session records. */
		source: z.enum(['live', 'local']).nullable(),
		/** When the underlying numbers were observed, which for 'local' can lag well behind now. */
		observedAt: z.number().int().nullable(),
		/** Present only when this provider has nothing to show; never a fabricated percentage. */
		message: z.string().min(1).max(160).nullable(),
	})
	.strict()
export type UsageProvider = z.infer<typeof usageProviderSchema>

export const usageResponseSchema = z
	.object({
		hostEpoch: z.string().uuid(),
		refreshedAt: z.number().int(),
		providers: z.array(usageProviderSchema).max(MAX_USAGE_PROVIDERS),
	})
	.strict()
export type UsageResponse = z.infer<typeof usageResponseSchema>
