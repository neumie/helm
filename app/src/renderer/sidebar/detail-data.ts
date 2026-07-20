// Shared full-detail resource. List rows stay cheap; this cache deduplicates the
// expensive single-item observation route across the stacked detail subpages.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardItem, HelmResult, HelmSnapshot } from '../../shared-helm'

export type DetailPhase = 'loading' | 'fresh' | 'stale-error' | 'not-found'

const detailRequests = new Map<string, { key: string; promise: Promise<HelmResult<DashboardItem>> }>()

export function fetchItemDetail(id: string, key: string, force = false): Promise<HelmResult<DashboardItem>> {
	const cached = detailRequests.get(id)
	if (!force && cached?.key === key) return cached.promise
	const promise = window.helm.daemon.item(id)
	detailRequests.set(id, { key, promise })
	void promise.then(result => {
		if (result.error !== undefined && detailRequests.get(id)?.promise === promise) detailRequests.delete(id)
	})
	return promise
}

/** Pure transition used by tests and to keep 404 distinct from transport failures. */
export function detailPhaseFor(result: HelmResult<DashboardItem>, hasItem: boolean): DetailPhase {
	if (result.error === undefined) return 'fresh'
	if (result.status === 404 && !hasItem) return 'not-found'
	return 'stale-error'
}

/** Fetch the full Item on open and after its cheap list row changes. */
export function useItemDetail(id: string, snapshot: HelmSnapshot | null) {
	const row = useMemo(() => snapshot?.items?.find(item => item.id === id) ?? null, [snapshot?.items, id])
	const [detail, setDetail] = useState<DashboardItem | null>(null)
	const [phase, setPhase] = useState<DetailPhase>('loading')
	const [error, setError] = useState<string | null>(null)
	const generation = useRef(0)
	const hasItem = useRef(Boolean(detail || row))
	hasItem.current = Boolean(detail || row)
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
			const current = ++generation.current
			if (!quiet) setPhase('loading')
			return fetchItemDetail(id, rowUpdatedAt, force).then(result => apply(result, current, quiet))
		},
		[id, rowUpdatedAt, apply],
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
		void request(false)
		return () => {
			generation.current += 1
		}
	}, [request])

	const item = detail ?? row
	return { item, phase, error, refetch, refetchQuietly, fresh: phase === 'fresh', hasDetail: detail !== null }
}
