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
	const rowUpdatedAt = row?.updatedAt ?? ''

	const apply = useCallback((result: HelmResult<DashboardItem>, current: number) => {
		if (current !== generation.current) return
		if (result.error === undefined) {
			setDetail(result.data)
			setError(null)
			setPhase('fresh')
			return
		}
		setError(result.error)
		setPhase(detailPhaseFor(result, hasItem.current))
	}, [])

	const request = useCallback(
		(force: boolean) => {
			const current = ++generation.current
			setPhase('loading')
			return fetchItemDetail(id, rowUpdatedAt, force).then(result => apply(result, current))
		},
		[id, rowUpdatedAt, apply],
	)

	const refetch = useCallback(async () => {
		await request(true)
	}, [request])

	useEffect(() => {
		void request(false)
		return () => {
			generation.current += 1
		}
	}, [request])

	const item = detail ?? row
	return { item, phase, error, refetch, fresh: phase === 'fresh', hasDetail: detail !== null }
}
