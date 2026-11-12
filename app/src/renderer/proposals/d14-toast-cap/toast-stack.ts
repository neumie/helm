// D14 · story-only stand-ins for a toast stack cap (docs/plans/design-system/proposals/D14.md). Every notice is the
// production `showToast`; a policy only decides which earlier notice to dismiss through the production handle. The
// production module exposes no "left by itself" signal, so liveness is read from the notice element (`.leaving` /
// detached) the moment a new notice arrives. Nothing here is imported by production code.
import { type ToastHandle, type ToastOptions, showToast } from '../../toast'

export type ToastPolicy =
	/** Today: every notice stacks until its TTL or ×. */
	| 'stack'
	/** At most `cap` visible; the oldest leaves early, Undo or not. */
	| 'oldest-out'
	/** At most `cap` visible; only a notice without an action leaves early, so an Undo stays its whole grace. */
	| 'undo-safe'

interface Entry {
	readonly options: ToastOptions
	readonly handle: ToastHandle
	readonly element: Element | null
}

export interface ToastStack {
	show(options: ToastOptions): ToastHandle
	/** Dismisses every notice this stack showed (story unmount / replay). */
	clear(): void
}

export function createToastStack(policy: ToastPolicy, cap = 3): ToastStack {
	let entries: Entry[] = []

	const alive = (entry: Entry) => entry.element?.isConnected === true && !entry.element.classList.contains('leaving')
	const prune = () => {
		entries = entries.filter(alive)
	}
	const drop = (entry: Entry) => {
		entry.handle.dismiss()
		entries = entries.filter(other => other !== entry)
	}

	return {
		show(options) {
			prune()
			const handle = showToast(options)
			// showToast appends synchronously, so the newest notice is the container's last child.
			const element = document.getElementById('toasts')?.lastElementChild ?? null
			const shown: Entry = { options, handle, element }
			entries.push(shown)
			if (policy === 'oldest-out') {
				while (entries.length > cap) {
					const oldest = entries[0]
					if (oldest === undefined) break
					drop(oldest)
				}
			} else if (policy === 'undo-safe') {
				while (entries.length > cap) {
					const plain = entries.find(entry => entry !== shown && entry.options.action === undefined)
					if (plain === undefined) break
					drop(plain)
				}
			}
			return handle
		},
		clear() {
			for (const entry of entries) entry.handle.dismiss()
			entries = []
		},
	}
}
