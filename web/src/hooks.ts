import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

export type DashboardSelection = { kind: 'item'; id: string } | null

/** Read selected dashboard entity from URL hash: #item/{id}. */
function getHashSelectionKey(): string {
	const hash = window.location.hash
	const match = hash.match(/^#(item)\/(.+)$/)
	return match ? `${match[1]}/${match[2]}` : ''
}

function subscribeHash(cb: () => void) {
	window.addEventListener('hashchange', cb)
	return () => window.removeEventListener('hashchange', cb)
}

export function useHashRoute() {
	const selectionKey = useSyncExternalStore(subscribeHash, getHashSelectionKey)
	const selection = parseSelection(selectionKey)

	const selectItem = useCallback((id: string | null) => {
		window.location.hash = id ? `item/${id}` : ''
	}, [])

	return { selection, selectItem }
}

function parseSelection(key: string): DashboardSelection {
	const match = key.match(/^(item)\/(.+)$/)
	if (!match) return null
	return { kind: 'item', id: match[2] }
}

export function useInterval(callback: () => void, ms: number) {
	useEffect(() => {
		callback()
		const id = setInterval(callback, ms)
		return () => clearInterval(id)
	}, [callback, ms])
}

export function useRelativeTime(date: string | null) {
	const [, setTick] = useState(0)
	useEffect(() => {
		if (!date) return
		const id = setInterval(() => setTick(t => t + 1), 1000)
		return () => clearInterval(id)
	}, [date])

	if (!date) return null
	const ms = Date.now() - new Date(date).getTime()
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ${s % 60}s`
	const h = Math.floor(m / 60)
	return `${h}h ${m % 60}m`
}
