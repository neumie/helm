import { useSyncExternalStore } from 'react'
interface InstallEvent extends Event {
	prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>
}
let promptEvent: InstallEvent | null = null
let installed = false
let initialized = false
const listeners = new Set<() => void>()
const publish = () => {
	for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}
const snapshot = () => (installed ? 'installed' : promptEvent ? 'available' : 'manual')

/** Entry-owned setup, never run by Storybook or a native renderer. No storage of private browser state. */
export function initializeRemotePwa() {
	if (initialized) return
	initialized = true
	const standalone = window.matchMedia('(display-mode: standalone)')
	installed = standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
	standalone.addEventListener('change', () => {
		installed = standalone.matches
		publish()
	})
	window.addEventListener('beforeinstallprompt', event => {
		event.preventDefault()
		promptEvent = event as InstallEvent
		publish()
	})
	window.addEventListener('appinstalled', () => {
		installed = true
		promptEvent = null
		publish()
	})
	if ('serviceWorker' in navigator)
		void navigator.serviceWorker.register('/remote-sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
			/* Browser policy may prohibit installation; the online workspace still works. */
		})
}
export function useRemoteInstall() {
	const state = useSyncExternalStore(subscribe, snapshot, () => 'manual')
	return {
		state,
		install: async () => {
			const event = promptEvent
			if (!event) return
			promptEvent = null
			publish()
			// A native prompt is requested only by a direct operator click. No automatic retry.
			try {
				await event.prompt()
			} catch {
				/* Fall back to browser installation instructions. */
			}
		},
	}
}
