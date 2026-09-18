import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import {
	type FavoriteIdentity,
	MAX_REMOTE_FAVORITES,
	favoriteIdentity,
	favoriteIdentitySchema,
} from './favorites-protocol.js'
import { readOwnerPrivateFile } from './private-file.js'

const DOCUMENT_BYTES = 32 * 1024
const documentSchema = z
	.object({
		version: z.literal(1),
		favorites: z.array(favoriteIdentitySchema).max(MAX_REMOTE_FAVORITES),
	})
	.strict()
	.refine(value => new Set(value.favorites.map(favoriteIdentity)).size === value.favorites.length)

export class FavoriteCapacityError extends Error {}

/** One runtime-owned, bounded shared preference set. Never a session/command authority. */
export class RemoteFavorites {
	private values = new Map<string, FavoriteIdentity>()
	constructor(
		private readonly path?: string,
		private readonly persist = (path: string, content: string) => {
			writeFileSync(path, content, { mode: 0o600, flag: 'wx' })
		},
	) {
		if (!path) return
		this.checkDirectory()
		try {
			const value = documentSchema.parse(JSON.parse(readOwnerPrivateFile(path, DOCUMENT_BYTES, 'Remote favorites')))
			this.values = new Map(value.favorites.map(entry => [favoriteIdentity(entry), entry]))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
	}
	has(value: FavoriteIdentity): boolean {
		return this.values.has(favoriteIdentity(value))
	}
	set(value: FavoriteIdentity, favorite: boolean): void {
		const entry = favoriteIdentitySchema.parse({ sessionId: value.sessionId, scopeId: value.scopeId })
		const key = favoriteIdentity(entry)
		if (this.values.has(key) === favorite) return
		const next = new Map(this.values)
		if (favorite) {
			if (next.size >= MAX_REMOTE_FAVORITES) throw new FavoriteCapacityError('Favorite limit reached')
			next.set(key, entry)
		} else next.delete(key)
		const content = `${JSON.stringify({ version: 1, favorites: [...next.values()] })}\n`
		if (Buffer.byteLength(content) > DOCUMENT_BYTES) throw new FavoriteCapacityError('Favorite limit reached')
		if (this.path) {
			this.checkDirectory()
			// Refuse substituted links/nonregular files, without adopting stale disk state.
			try {
				readOwnerPrivateFile(this.path, DOCUMENT_BYTES, 'Remote favorites')
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			}
			const temp = join(dirname(this.path), `.favorites-${randomUUID()}.tmp`)
			try {
				this.persist(temp, content)
				renameSync(temp, this.path)
			} finally {
				try {
					unlinkSync(temp)
				} catch {
					/* renamed or not created */
				}
			}
		}
		// Publish only after successful persistence. Failed writes leave the trusted set unchanged.
		this.values = next
	}
	private checkDirectory(): void {
		if (!this.path) return
		const parent = dirname(resolve(this.path))
		const stat = lstatSync(parent)
		if (
			realpathSync(parent) !== parent ||
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o700
		)
			throw new Error('Remote favorites need a private canonical directory')
	}
}
