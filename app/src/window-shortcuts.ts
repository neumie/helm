// Window-aware routing of Helm's menu shortcuts (docs/plans/helm-open/spec.md, Architecture). The cockpit keeps
// its behaviour exactly; a document window gets its own zoom, close and open, and never reloads. Pure: main.ts
// supplies the window kind and performs the effect.
import type { ShortcutAction } from './shortcuts'

export type ShortcutWindowKind = 'cockpit' | 'document'

export interface ShortcutKey {
	code: string
	metaKey: boolean
	ctrlKey: boolean
	altKey: boolean
	shiftKey: boolean
}

export type ShortcutRoute =
	/** Not Helm's: let the key reach the page (and the menu, for a cockpit key no binding owns). */
	| { kind: 'pass' }
	/** A configurable action handled as before (the cockpit's handlers). */
	| { kind: 'action'; action: ShortcutAction }
	| { kind: 'zoom'; step: -1 | 0 | 1 }
	| { kind: 'close-window' }
	| { kind: 'open-file' }
	/** Consumed with no effect: a reload would drop a document window's bound state and memory-only threads. */
	| { kind: 'swallow' }

const primary = (key: ShortcutKey, platform: NodeJS.Platform) =>
	platform === 'darwin' ? key.metaKey && !key.ctrlKey : key.ctrlKey && !key.metaKey

/**
 * `action` is the configurable binding the key matched (or null). In the cockpit only that binding counts and ⌘O
 * is never consumed (the agent dock's show-terminal key). In a document window the font keys zoom the document,
 * Close closes the window, ⌘O opens a file and ⌘R / ⌘⇧R are swallowed.
 */
export function routeShortcut(
	kind: ShortcutWindowKind,
	action: ShortcutAction | null,
	key: ShortcutKey,
	platform: NodeJS.Platform,
): ShortcutRoute {
	if (kind === 'document') {
		if (primary(key, platform) && !key.altKey) {
			if (key.code === 'KeyR') return { kind: 'swallow' }
			if (key.code === 'KeyO' && !key.shiftKey) return { kind: 'open-file' }
		}
		if (action === 'fontBigger') return { kind: 'zoom', step: 1 }
		if (action === 'fontSmaller') return { kind: 'zoom', step: -1 }
		if (action === 'fontReset') return { kind: 'zoom', step: 0 }
		if (action === 'closeFocused') return { kind: 'close-window' }
	}
	return action ? { kind: 'action', action } : { kind: 'pass' }
}
