// Shared full-detail resource. List rows stay cheap; this cache deduplicates the
// expensive single-item observation route across the stacked detail subpages.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardItem, HelmResult, HelmSnapshot } from '../../shared-helm'

export type DetailPhase = 'loading' | 'fresh' | 'stale-error' | 'not-found'

/** One renderer-wide LRU; pending reads and mounted consumers are never evicted. */
export function createItemDetailCache() {
	const settled = new Map<string, { key: string; promise: Promise<HelmResult<DashboardItem>> }>()
	const pending = new Map<string, Promise<HelmResult<DashboardItem>>>()
	const latest = new Map<string, object>()
	const subscribers = new Map<string, number>()
	const prune = () => {
		let inactive = [...settled.keys()].filter(id => !subscribers.has(id)).length
		for (const id of settled.keys()) {
			if (inactive <= 32) break
			if (!subscribers.has(id)) {
				settled.delete(id)
				inactive -= 1
			}
		}
	}
	return {
		subscribe(id: string) {
			subscribers.set(id, (subscribers.get(id) ?? 0) + 1)
			let released = false
			return () => {
				if (released) return
				released = true
				const count = (subscribers.get(id) ?? 1) - 1
				if (count) subscribers.set(id, count)
				else subscribers.delete(id)
				prune()
			}
		},
		fetch(id: string, key: string, read: () => Promise<HelmResult<DashboardItem>>, force = false) {
			const requestKey = JSON.stringify([id, key])
			const inflight = pending.get(requestKey)
			if (inflight) return inflight
			const cached = settled.get(id)
			if (!force && cached?.key === key) {
				settled.delete(id)
				settled.set(id, cached)
				return cached.promise
			}
			const token = {}
			latest.set(id, token)
			const promise = Promise.resolve().then(read)
			pending.set(requestKey, promise)
			const finish = (success: boolean) => {
				pending.delete(requestKey)
				if (latest.get(id) !== token) return
				latest.delete(id)
				settled.delete(id)
				if (success) settled.set(id, { key, promise })
				prune()
			}
			void promise.then(
				result => finish(result.error === undefined),
				() => finish(false),
			)
			return promise
		},
	}
}

const detailRequests = createItemDetailCache()
const transports = new WeakMap<object, number>()
let nextTransport = 0
function detailIdentity(api: object, scope: string, id: string) {
	let transport = transports.get(api)
	if (transport === undefined) {
		transport = ++nextTransport
		transports.set(api, transport)
	}
	return JSON.stringify([transport, scope, id])
}

export function fetchItemDetail(
	id: string,
	key: string,
	force = false,
	api = window.helm.daemon,
	scope = '',
): Promise<HelmResult<DashboardItem>> {
	return detailRequests.fetch(detailIdentity(api, scope, id), key, () => api.item(id), force)
}

/** Pure transition used by tests and to keep 404 distinct from transport failures. */
export function detailPhaseFor(result: HelmResult<DashboardItem>, hasItem: boolean): DetailPhase {
	if (result.error === undefined) return 'fresh'
	if (result.status === 404 && !hasItem) return 'not-found'
	return 'stale-error'
}

/** Fetch the full Item on open and after its cheap list row changes. */
export function useItemDetail(id: string, snapshot: HelmSnapshot | null) {
	const api = window.helm.daemon
	const scope = JSON.stringify([snapshot?.status?.profile?.id, snapshot?.status?.profileGeneration])
	const identity = detailIdentity(api, scope, id)
	const currentIdentity = useRef(identity)
	currentIdentity.current = identity
	const [detailOwner, setDetailOwner] = useState(identity)
	const row = useMemo(() => snapshot?.items?.find(item => item.id === id) ?? null, [snapshot?.items, id])
	const [detail, setDetail] = useState<DashboardItem | null>(null)
	const [phase, setPhase] = useState<DetailPhase>('loading')
	const [error, setError] = useState<string | null>(null)
	const generation = useRef(0)
	const hasItem = useRef(Boolean(detail || row))
	hasItem.current = Boolean((detailOwner === identity ? detail : null) || row)
	// Identical-payload guard (mirrors HelmBridge.publish): a live-tail tick that
	// returns byte-identical detail must not re-render the 20KB log well.
	const lastComparable = useRef<string | null>(null)
	const rowUpdatedAt = row?.updatedAt ?? ''

	const apply = useCallback((result: HelmResult<DashboardItem>, current: number, quiet: boolean) => {
		if (current !== generation.current) return
		if (result.error === undefined) {
			const comparable = JSON.stringify(result.data)
			if (comparable !== lastComparable.current) {
				lastComparable.current = comparable
				setDetail(result.data)
			}
			setError(null)
			setPhase('fresh')
			return
		}
		// Quiet (live-tail) failures keep the last-known detail without flapping
		// the stale-error alert; the next successful tick or a real refetch wins.
		if (quiet) return
		setError(result.error)
		setPhase(detailPhaseFor(result, hasItem.current))
	}, [])

	const request = useCallback(
		(force: boolean, quiet = false) => {
			if (currentIdentity.current !== identity || window.helm.daemon !== api) return Promise.resolve()
			const current = ++generation.current
			if (!quiet) setPhase('loading')
			const publish = (result: HelmResult<DashboardItem>) => {
				if (currentIdentity.current !== identity || window.helm.daemon !== api) return
				apply(result, current, quiet)
			}
			return fetchItemDetail(id, rowUpdatedAt, force, api, scope).then(publish, error => {
				publish({ error: error instanceof Error ? error.message : String(error) })
			})
		},
		[id, identity, api, scope, rowUpdatedAt, apply],
	)
	const requestRef = useRef(request)
	requestRef.current = request

	const refetch = useCallback(async () => {
		await request(true)
	}, [request])

	/** Background refresh (live log tail): no loading phase, no error phase — a
	 *  tick never flickers the page busy or flaps an alert. Identity is stable
	 *  (ref-backed) so the caller's interval never resets on row updates. */
	const refetchQuietly = useCallback(async () => {
		await requestRef.current(true, true)
	}, [])

	useEffect(() => {
		setDetail(null)
		setDetailOwner(identity)
		setError(null)
		lastComparable.current = null
		const unsubscribe = detailRequests.subscribe(identity)
		return () => {
			generation.current += 1
			unsubscribe()
		}
	}, [identity])

	useEffect(() => {
		void request(false)
		return () => {
			generation.current += 1
		}
	}, [request])

	const ownedDetail = detailOwner === identity ? detail : null
	const item = ownedDetail ?? row
	return { item, phase, error, refetch, refetchQuietly, fresh: phase === 'fresh', hasDetail: ownedDetail !== null }
}
