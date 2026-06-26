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

function formatRelative(date: string | null): string | null {
	if (!date) return null
	const ms = Date.now() - new Date(date).getTime()
	const m = Math.floor(ms / 60000)
	if (m < 1) return 'just now'
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ${m % 60}m`
	const d = Math.floor(h / 24)
	return `${d}d ${h % 24}h`
}

/**
 * Minute-granularity relative time. Re-renders only when the displayed label
 * actually changes (the updater returns the previous string otherwise, so React
 * bails) — not every second. One slow shared-cadence interval per instance.
 */
export function useRelativeTime(date: string | null) {
	const [label, setLabel] = useState(() => formatRelative(date))
	useEffect(() => {
		setLabel(formatRelative(date))
		if (!date) return
		const id = setInterval(() => {
			const next = formatRelative(date)
			setLabel(prev => (prev === next ? prev : next))
		}, 30000)
		return () => clearInterval(id)
	}, [date])
	return label
}
