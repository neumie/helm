import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteDirectory, RemoteTarget } from '../../../../src/remote/protocol.js'
import { type FavoriteView, RemoteFavoritesController, emptyFavoriteView } from './favorites-controller.js'
import type { RemoteTransport } from './transport.js'

export function useRemoteFavorites(transport: RemoteTransport, directory: RemoteDirectory | null, available: boolean) {
	const current = useRef({ transport, directory, available })
	current.current = { transport, directory, available }
	const controller = useRef<RemoteFavoritesController | null>(null)
	const [state, setState] = useState<{ transport: RemoteTransport; epoch: string; view: FavoriteView } | null>(null)
	const epoch = directory?.hostEpoch
	useEffect(() => {
		if (!epoch || !available || !transport.favorites || !transport.setFavorite) return
		const instance = new RemoteFavoritesController(
			transport,
			epoch,
			() => ({
				directory: current.current.directory,
				available: current.current.available && current.current.transport === transport,
			}),
			view => setState({ transport, epoch, view }),
			() => !document.hidden,
		)
		controller.current = instance
		instance.start()
		const visibility = () => instance.refresh()
		document.addEventListener('visibilitychange', visibility)
		return () => {
			document.removeEventListener('visibilitychange', visibility)
			instance.dispose()
			if (controller.current === instance) controller.current = null
		}
	}, [transport, epoch, available])
	const setFavorite = useCallback(
		(target: RemoteTarget, favorite: boolean) => controller.current?.setFavorite(target, favorite),
		[],
	)
	const view = state?.transport === transport && state.epoch === epoch ? state.view : emptyFavoriteView()
	return { ...view, available: available && view.available, setFavorite }
}
export type RemoteFavoriteControls = ReturnType<typeof useRemoteFavorites>
