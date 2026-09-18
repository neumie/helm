import { useEffect, useRef, useState } from 'react'
import type { UsageResponse } from '../../../../src/remote/usage-protocol.js'
import type { RemoteTransport } from './transport.js'

/** The host already caches provider reads; this only keeps an open view from going stale. */
const USAGE_REFRESH_MS = 60_000

export type RemoteUsageState = {
	supported: boolean
	loading: boolean
	response: UsageResponse | null
	error: string | null
}

/**
 * Reads host-wide provider limits while the Usage destination is open. Requests are
 * fenced by generation so a slow answer from a closed view can never repaint a newer
 * one, and nothing is fetched at all while the session list is showing.
 */
export function useRemoteUsage(transport: RemoteTransport, active: boolean): RemoteUsageState {
	const read = transport.usage
	const [state, setState] = useState<RemoteUsageState>({
		supported: !!read,
		loading: false,
		response: null,
		error: null,
	})
	const generation = useRef(0)

	useEffect(() => {
		if (!read || !active) return
		generation.current += 1
		const fence = generation.current
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		setState(current => ({ ...current, supported: true, loading: current.response === null }))

		const load = async () => {
			try {
				const response = await read(controller.signal)
				if (generation.current !== fence) return
				setState({ supported: true, loading: false, response, error: null })
			} catch {
				if (generation.current !== fence || controller.signal.aborted) return
				// A failed refresh keeps the numbers already on screen and says so.
				setState(current => ({
					supported: true,
					loading: false,
					response: current.response,
					error: 'Usage is unavailable right now.',
				}))
			}
			if (generation.current === fence && !controller.signal.aborted) timer = setTimeout(load, USAGE_REFRESH_MS)
		}
		void load()

		return () => {
			generation.current += 1
			controller.abort()
			if (timer !== undefined) clearTimeout(timer)
		}
	}, [read, active])

	return state
}

/** "in 2h 50m" / "in 6 days" — a reset point is only useful as a distance from now. */
export function formatResetDistance(resetsAt: number | null, now: number): string | null {
	if (resetsAt === null) return null
	const seconds = Math.round((resetsAt - now) / 1000)
	if (seconds <= 0) return 'now'
	if (seconds < 3600) return `in ${Math.max(1, Math.round(seconds / 60))}m`
	if (seconds < 86_400) {
		const hours = Math.floor(seconds / 3600)
		const minutes = Math.round((seconds - hours * 3600) / 60)
		return minutes ? `in ${hours}h ${minutes}m` : `in ${hours}h`
	}
	const days = Math.round(seconds / 86_400)
	return days === 1 ? 'in 1 day' : `in ${days} days`
}

/** Local snapshots can lag; say how old they are rather than implying they are live. */
export function formatObservedAge(observedAt: number | null, now: number): string | null {
	if (observedAt === null) return null
	const seconds = Math.max(0, Math.round((now - observedAt) / 1000))
	if (seconds < 120) return 'just now'
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
	const days = Math.floor(seconds / 86_400)
	return days === 1 ? '1 day ago' : `${days} days ago`
}
