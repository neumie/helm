// Renderer presentation preferences in localStorage (agent dock, left column). Never placement,
// session or process state.

/**
 * One presentation preference in renderer storage (Helm's userData, shared by its app profiles: no
 * per-profile partition). Every mounted surface subscribes and re-lays out live. A choice made while
 * storage is unavailable still applies for this session; another Helm window's change arrives as a
 * `storage` event.
 */
export function storedPreference<T>(
	key: string,
	read: (raw: string | null) => T,
	/** What to store for a value; null removes the key (back to the default). */
	write: (value: T) => string | null = String,
) {
	let chosen: { value: T } | null = null
	const listeners = new Set<() => void>()
	const notify = (): void => {
		for (const listener of listeners) listener()
	}
	const onStorage = (event: StorageEvent): void => {
		if (event.key !== key && event.key !== null) return
		chosen = null
		notify()
	}
	return {
		get(): T {
			if (chosen) return chosen.value
			try {
				return read(globalThis.localStorage.getItem(key))
			} catch {
				return read(null)
			}
		},
		set(value: T): void {
			chosen = { value }
			const raw = write(value)
			try {
				if (raw === null) globalThis.localStorage.removeItem(key)
				else globalThis.localStorage.setItem(key, raw)
			} catch {
				// Presentation still works when storage is unavailable.
			}
			notify()
		},
		subscribe(listener: () => void): () => void {
			if (listeners.size === 0) globalThis.addEventListener?.('storage', onStorage)
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
				if (listeners.size === 0) globalThis.removeEventListener?.('storage', onStorage)
			}
		},
	}
}
