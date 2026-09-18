import { z } from 'zod'
import { REMOTE_MAX_OWNERS, remoteTargetSchema } from './protocol.js'

export const FAVORITES_HEADER = 'X-Helm-Favorites'
export const FAVORITES_REQUEST_BYTES = 1024
export const FAVORITES_RESPONSE_BYTES = 24 * 1024
export const MAX_REMOTE_FAVORITES = 256

/** Persistent display preference only; invocation still requires the complete current owner. */
export const favoriteIdentitySchema = remoteTargetSchema.pick({ sessionId: true, scopeId: true })
export type FavoriteIdentity = z.infer<typeof favoriteIdentitySchema>
export function favoriteIdentity(value: FavoriteIdentity): string {
	return JSON.stringify([value.scopeId, value.sessionId])
}
export const favoriteRequestSchema = z
	.object({
		hostEpoch: z.string().uuid(),
		target: remoteTargetSchema,
		favorite: z.boolean(),
	})
	.strict()
export type FavoriteRequest = z.infer<typeof favoriteRequestSchema>
export const favoriteEntrySchema = z
	.object({
		target: remoteTargetSchema,
		favorite: z.boolean(),
		canEdit: z.boolean(),
	})
	.strict()
export const favoritesResponseSchema = z
	.object({
		hostEpoch: z.string().uuid(),
		entries: z.array(favoriteEntrySchema).max(REMOTE_MAX_OWNERS),
	})
	.strict()
export type FavoritesResponse = z.infer<typeof favoritesResponseSchema>
export const favoriteResultSchema = favoriteRequestSchema
