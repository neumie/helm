import { useEffect, useState } from 'react'
import { RemoteAccessError } from './transport.js'

/** Settled polling is the bounded proof transport, not a claim of replay or push. */
export function useRemotePoll<T>(read: (signal: AbortSignal) => Promise<T>, interval = 2000) {
	const [state, setState] = useState<{ value: T | null; error: number | null }>({ value: null, error: null })
	useEffect(() => {
		const abort = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		let running = false
		async function poll() {
			if (running || abort.signal.aborted) return
			running = true
			try {
				const value = await read(abort.signal)
				if (!abort.signal.aborted)
					setState(previous =>
						previous.error === null && JSON.stringify(previous.value) === JSON.stringify(value)
							? previous
							: { value, error: null },
					)
			} catch (error) {
				if (!abort.signal.aborted)
					setState(previous => ({
						value: error instanceof RemoteAccessError && error.status === 401 ? null : previous.value,
						error: error instanceof RemoteAccessError ? error.status : 0,
					}))
			} finally {
				running = false
				if (!abort.signal.aborted) timer = setTimeout(() => void poll(), interval)
			}
		}
		function wake() {
			if (!document.hidden) {
				clearTimeout(timer)
				void poll()
			}
		}
		void poll()
		document.addEventListener('visibilitychange', wake)
		return () => {
			abort.abort()
			clearTimeout(timer)
			document.removeEventListener('visibilitychange', wake)
		}
	}, [read, interval])
	return state
}
