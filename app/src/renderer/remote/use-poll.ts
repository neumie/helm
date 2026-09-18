import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RemoteAccessError } from './transport.js'

type PollEqual<T> = (previous: T, next: T) => boolean

export interface RemotePollReceipt<T> {
	accepted(value: T, startedAt: number): void
	retire(): void
}
export interface RemotePollOptions<T> {
	enabled?: boolean
	equal?: PollEqual<T>
	receipt?: RemotePollReceipt<T>
}

function defaultEqual<T>(previous: T, next: T) {
	return previous === next || JSON.stringify(previous) === JSON.stringify(next)
}

/** Settled polling is the bounded proof transport, not a claim of replay or push. */
export function useRemotePoll<T>(
	read: (signal: AbortSignal) => Promise<T>,
	interval = 2000,
	options: RemotePollOptions<T> = {},
) {
	const enabled = options.enabled ?? true
	const equal = options.equal ?? defaultEqual<T>
	const requestGeneration = useRef(0)
	const [state, setState] = useState<{
		read: typeof read
		value: T | null
		error: number | null
		pending: boolean
	}>({
		read,
		value: null,
		error: null,
		pending: false,
	})
	// biome-ignore lint/correctness/useExhaustiveDependencies: interval/equal changes restart the network admission and must invalidate prior completions before passive cleanup.
	useLayoutEffect(() => {
		requestGeneration.current += 1
		setState(previous => {
			if (!enabled) {
				if (previous.read !== read) return { read, value: null, error: null, pending: false }
				return previous.pending ? { ...previous, pending: false } : previous
			}
			if (previous.read !== read) return { read, value: null, error: null, pending: true }
			return previous.pending && previous.error === null ? previous : { ...previous, error: null, pending: true }
		})
	}, [read, interval, enabled, equal, options.receipt])
	useEffect(() => {
		if (!enabled) return
		const generation = requestGeneration.current
		const abort = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		let running = false
		let visibilityEpoch = 0
		async function poll() {
			if (running || abort.signal.aborted) return
			running = true
			const requestVisibilityEpoch = visibilityEpoch
			const allowed = () =>
				!abort.signal.aborted &&
				requestGeneration.current === generation &&
				(!options.receipt || (!document.hidden && visibilityEpoch === requestVisibilityEpoch))
			try {
				if (options.receipt && document.hidden) return
				const startedAt = performance.now()
				const value = await read(abort.signal)
				if (allowed()) options.receipt?.accepted(value, startedAt)
				if (allowed())
					setState(previous => {
						if (!allowed() || previous.read !== read) return previous
						if (previous.error === null && previous.value !== null && equal(previous.value, value))
							return previous.pending ? { ...previous, pending: false } : previous
						return { read, value, error: null, pending: false }
					})
			} catch (error) {
				if (allowed() && error instanceof RemoteAccessError && (error.status === 401 || error.status === 403))
					options.receipt?.retire()
				if (allowed())
					setState(previous => {
						if (!allowed() || previous.read !== read) return previous
						const nextError = error instanceof RemoteAccessError ? error.status : 0
						const nextValue =
							previous.read !== read || (error instanceof RemoteAccessError && error.status === 401)
								? null
								: previous.value
						if (
							previous.read === read &&
							previous.error === nextError &&
							previous.value === nextValue &&
							!previous.pending
						)
							return previous
						return { read, value: nextValue, error: nextError, pending: false }
					})
			} finally {
				running = false
				if (!abort.signal.aborted && requestGeneration.current === generation)
					timer = setTimeout(() => void poll(), interval)
			}
		}
		function wake() {
			visibilityEpoch++
			if (document.hidden) {
				options.receipt?.retire()
				return
			}
			clearTimeout(timer)
			void poll()
		}
		void poll()
		document.addEventListener('visibilitychange', wake)
		return () => {
			options.receipt?.retire()
			abort.abort()
			clearTimeout(timer)
			document.removeEventListener('visibilitychange', wake)
		}
	}, [read, interval, enabled, equal, options.receipt])
	return state.read === read ? state : { read, value: null, error: null, pending: enabled }
}
