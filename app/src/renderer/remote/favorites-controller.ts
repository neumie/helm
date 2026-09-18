import type { FavoritesResponse } from '../../../../src/remote/favorites-protocol.js'
import type { RemoteDirectory, RemoteTarget } from '../../../../src/remote/protocol.js'
import { sameRemoteTarget } from '../../../../src/remote/protocol.js'
import { remoteSessionIdentity } from './remote-identity.js'
import { RemoteAccessError, type RemoteTransport } from './transport.js'

export interface FavoriteView {
	entries: FavoritesResponse['entries']
	pending: string | null
	available: boolean
	error: string | null
	accessEnded: boolean
}
export const emptyFavoriteView = (): FavoriteView => ({
	entries: [],
	pending: null,
	available: false,
	error: null,
	accessEnded: false,
})

/** Preferences have their own read/write fence, never a Pi command or an optimistic directory update. */
export class RemoteFavoritesController {
	private view = emptyFavoriteView()
	private disposed = false
	private retired = false
	private sequence = 0
	private readAbort?: AbortController
	private mutation?: AbortController
	private timer?: ReturnType<typeof setTimeout>
	constructor(
		private readonly transport: RemoteTransport,
		private readonly epoch: string,
		private readonly current: () => { directory: RemoteDirectory | null; available: boolean },
		private readonly publish: (view: FavoriteView) => void,
		private readonly visible: () => boolean = () => true,
	) {}
	start(): void {
		this.refresh()
	}
	refresh(): void {
		if (this.disposed || this.retired || this.mutation) return
		this.cancelRead()
		if (this.visible()) void this.read()
	}
	dispose(): void {
		this.disposed = true
		this.cancelRead()
		this.mutation?.abort()
	}
	setFavorite(target: RemoteTarget, favorite: boolean): void {
		const entry = this.view.entries.find(value => sameRemoteTarget(value.target, target))
		if (
			!this.live() ||
			!this.view.available ||
			this.mutation ||
			this.view.pending !== null ||
			!entry?.canEdit ||
			!this.present(target) ||
			!this.transport.setFavorite
		)
			return
		this.cancelRead()
		const abort = new AbortController()
		this.mutation = abort // synchronous admission before the first await
		const key = remoteSessionIdentity(this.epoch, target)
		this.update({ pending: key, error: null })
		void this.write(target, favorite, abort)
	}
	private async write(target: RemoteTarget, favorite: boolean, abort: AbortController): Promise<void> {
		try {
			await this.transport.setFavorite?.({ hostEpoch: this.epoch, target, favorite }, abort.signal)
		} catch (error) {
			if (this.live() && this.mutation === abort) {
				if (error instanceof RemoteAccessError && error.status === 401) this.endAccess()
				else if (this.present(target))
					this.update({ error: 'Could not confirm the favorite change. Check the saved state before trying again.' })
			}
		} finally {
			if (this.mutation === abort) {
				this.mutation = undefined
				if (this.live()) {
					// Keep controls busy until the fresh, post-write read settles. No automatic write retry.
					if (this.visible()) void this.read()
					else this.update({ pending: null, available: false })
				}
			}
		}
	}
	private async read(): Promise<void> {
		if (!this.live() || !this.transport.favorites || this.mutation || !this.visible()) return
		const sequence = ++this.sequence
		const abort = new AbortController()
		this.readAbort = abort
		const valid = () => this.live() && this.sequence === sequence && !abort.signal.aborted && this.visible()
		try {
			const response = await this.transport.favorites(abort.signal)
			if (!valid()) return
			if (response.hostEpoch !== this.epoch) throw new Error('Favorite owner changed')
			this.update({ entries: response.entries, available: true, pending: null })
		} catch (error) {
			if (!valid()) return
			if (error instanceof RemoteAccessError && error.status === 401) this.endAccess()
			else if (error instanceof RemoteAccessError && error.status === 404) {
				this.retired = true // legacy endpoint: try again only for a new host/transport
				this.update({ entries: [], available: false, pending: null })
			} else this.update({ available: false, pending: null })
		} finally {
			if (this.sequence === sequence) {
				this.readAbort = undefined
				if (this.live() && this.visible()) this.timer = setTimeout(() => void this.read(), 2000)
			}
		}
	}
	private cancelRead(): void {
		this.sequence++
		clearTimeout(this.timer)
		this.timer = undefined
		this.readAbort?.abort()
		this.readAbort = undefined
	}
	private live(): boolean {
		const current = this.current()
		return !this.disposed && !this.retired && current.available && current.directory?.hostEpoch === this.epoch
	}
	private present(target: RemoteTarget): boolean {
		return this.current().directory?.sessions.some(value => sameRemoteTarget(value.target, target)) ?? false
	}
	private update(patch: Partial<FavoriteView>): void {
		if (this.disposed) return
		const next = { ...this.view, ...patch }
		if (JSON.stringify(this.view) === JSON.stringify(next)) return
		this.view = next
		this.publish(next)
	}
	private endAccess(): void {
		this.retired = true
		this.update({ entries: [], pending: null, available: false, accessEnded: true })
	}
}
