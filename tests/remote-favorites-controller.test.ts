import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import controllerModule from '../app/src/renderer/remote/favorites-controller.js'
import type { FavoriteView } from '../app/src/renderer/remote/favorites-controller.js'
import fixtureModule from '../app/src/renderer/remote/remote-fixtures.js'
import transportModule from '../app/src/renderer/remote/transport.js'
import type { FavoriteRequest, FavoritesResponse } from '../src/remote/favorites-protocol.js'
const { RemoteFavoritesController } = controllerModule
const { createRemoteFixture } = fixtureModule
const { RemoteAccessError } = transportModule
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}
async function fixture(t: { after(fn: () => void): void }) {
	const { transport } = createRemoteFixture()
	const directory = await transport.directory(new AbortController().signal)
	const target = directory.sessions[0]?.target
	assert.ok(target)
	const current = { directory, available: true }
	let saved = false
	let posts = 0
	let reads = 0
	const views: FavoriteView[] = []
	const response = (): FavoritesResponse => ({
		hostEpoch: directory.hostEpoch,
		entries: [{ target, favorite: saved, canEdit: true }],
	})
	transport.favorites = async () => {
		reads++
		return response()
	}
	transport.setFavorite = async value => {
		posts++
		saved = value.favorite
		return value
	}
	const controller = new RemoteFavoritesController(
		transport,
		directory.hostEpoch,
		() => current,
		view => views.push(view),
	)
	t.after(() => controller.dispose())
	controller.start()
	await setImmediate()
	return {
		transport,
		directory,
		target,
		current,
		views,
		controller,
		response,
		posts: () => posts,
		reads: () => reads,
		save: (value: boolean) => {
			saved = value
		},
	}
}

test('favorite admission is synchronous, late pre-write reads cannot roll back the post-write read', async t => {
	const f = await fixture(t)
	const old = deferred<FavoritesResponse>()
	const write = deferred<FavoriteRequest>()
	let writes = 0
	let oldSignal: AbortSignal | undefined
	const fresh = f.transport.favorites
	assert.ok(fresh)
	f.transport.favorites = async signal => {
		oldSignal = signal
		return old.promise
	}
	f.controller.refresh()
	f.transport.setFavorite = async input => {
		writes++
		await write.promise
		f.save(input.favorite)
		return input
	}
	f.controller.setFavorite(f.target, true)
	f.controller.setFavorite(f.target, true)
	assert.equal(writes, 1)
	assert.equal(oldSignal?.aborted, true)
	f.transport.favorites = fresh
	write.resolve({ hostEpoch: f.directory.hostEpoch, target: f.target, favorite: true })
	await setImmediate()
	assert.equal(f.views.at(-1)?.entries[0]?.favorite, true)
	old.resolve({ ...f.response(), entries: [{ target: f.target, favorite: false, canEdit: true }] })
	await setImmediate()
	assert.equal(f.views.at(-1)?.entries[0]?.favorite, true)
	assert.equal(f.views.at(-1)?.pending, null)
})

test('dispose fences late write callbacks and never auto-retries a mutation', async t => {
	const f = await fixture(t)
	const late = deferred<FavoriteRequest>()
	let writes = 0
	f.transport.setFavorite = async () => {
		writes++
		return late.promise
	}
	f.controller.setFavorite(f.target, true)
	f.controller.dispose()
	const publications = f.views.length
	const reads = f.reads()
	late.resolve({ hostEpoch: f.directory.hostEpoch, target: f.target, favorite: true })
	await setImmediate()
	assert.equal(f.views.length, publications)
	assert.equal(f.reads(), reads)
	assert.equal(writes, 1)
})

test('stale target, availability loss, and read-only projection reject clicks before a mutation', async t => {
	const f = await fixture(t)
	f.current.available = false
	f.controller.setFavorite(f.target, true)
	f.current.available = true
	f.current.directory = {
		...f.directory,
		sessions: f.directory.sessions.map(session => ({
			...session,
			target: { ...session.target, incarnation: randomUUID() },
		})),
	}
	f.controller.setFavorite(f.target, true)
	assert.equal(f.posts(), 0)
	f.current.directory = f.directory
	f.transport.favorites = async () => ({
		...f.response(),
		entries: [{ target: f.target, favorite: false, canEdit: false }],
	})
	f.controller.refresh()
	await setImmediate()
	f.controller.setFavorite(f.target, true)
	assert.equal(f.posts(), 0)
})

test('failed writes retain a visible failure, refresh saved state, and do not replay; 401 clears preferences', async t => {
	const f = await fixture(t)
	let writes = 0
	f.transport.setFavorite = async () => {
		writes++
		throw new RemoteAccessError(503)
	}
	f.controller.setFavorite(f.target, true)
	await setImmediate()
	assert.equal(writes, 1)
	assert.match(f.views.at(-1)?.error ?? '', /Could not confirm/)
	assert.equal(f.views.at(-1)?.entries[0]?.favorite, false)
	assert.equal(f.views.at(-1)?.pending, null)
	f.transport.favorites = async () => {
		throw new RemoteAccessError(401)
	}
	f.controller.refresh()
	await setImmediate()
	assert.equal(f.views.at(-1)?.accessEnded, true)
	assert.deepEqual(f.views.at(-1)?.entries, [])
})
