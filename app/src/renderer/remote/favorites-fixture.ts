import { favoriteIdentity } from '../../../../src/remote/favorites-protocol.js'
import { sameRemoteTarget } from '../../../../src/remote/protocol.js'
import { RemoteAccessError, type RemoteTransport } from './transport.js'

/** Opt-in display-only workbench service; wire tests use the production transport separately. */
export function enableFavoritesFixture(transport: RemoteTransport): void {
	const saved = new Set<string>()
	transport.favorites = async signal => {
		const directory = await transport.directory(signal)
		return {
			hostEpoch: directory.hostEpoch,
			entries: directory.sessions.map(session => ({
				target: session.target,
				favorite: saved.has(favoriteIdentity(session.target)),
				canEdit: session.capabilities.prompt,
			})),
		}
	}
	transport.setFavorite = async (request, signal) => {
		const directory = await transport.directory(signal)
		const session = directory.sessions.find(value => sameRemoteTarget(value.target, request.target))
		if (directory.hostEpoch !== request.hostEpoch || !session) throw new RemoteAccessError(409)
		if (!session.capabilities.prompt) throw new RemoteAccessError(403)
		const key = favoriteIdentity(request.target)
		if (request.favorite) saved.add(key)
		else saved.delete(key)
		return request
	}
}
export const FAVORITES_FIXTURE_TOKEN = 'f'.repeat(43)
