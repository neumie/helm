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

/**
 * Where a shortcut or menu item acts: a cockpit-side BrowserWindow, or one document view (spec: Per-view access
 * keys). A document view is a WebContentsView in a BaseWindow container; the container itself is never a target.
 */
export type ShortcutTarget<W, V> = { window: W } | { review: V }

/**
 * The target of a menu item. `document` is non-null whenever one of Helm's document containers is focused; its
 * `contents` is the shown view, null while that view closes. A focused document container never falls back to
 * the cockpit, or ⌘W / File → Close would close a terminal tab and the font keys would step the terminal font.
 */
export function focusedShortcutTarget<W, V>(
	document: { contents: V | null } | null,
	focusedBrowserWindow: W | null,
	mainWindow: W | null,
): ShortcutTarget<W, V> | null {
	if (document) return document.contents ? { review: document.contents } : null
	const window = focusedBrowserWindow ?? mainWindow
	return window ? { window } : null
}

export type ShortcutEffect<W, V> =
	| { kind: 'none' }
	/** The cockpit's handler for a configurable action. */
	| { kind: 'action'; action: ShortcutAction; target: ShortcutTarget<W, V> }
	| { kind: 'zoom'; view: V; step: -1 | 0 | 1 }
	/** Close that view only, through its close guard; its window's other views stay. */
	| { kind: 'close-view'; view: V }
	| { kind: 'open-file'; view: V }

/** The effect of a route on a target. A document-only route on a cockpit target does nothing. */
export function shortcutEffect<W, V>(target: ShortcutTarget<W, V>, route: ShortcutRoute): ShortcutEffect<W, V> {
	if (route.kind === 'action') return { kind: 'action', action: route.action, target }
	if (!('review' in target)) return { kind: 'none' }
	if (route.kind === 'zoom') return { kind: 'zoom', view: target.review, step: route.step }
	if (route.kind === 'close-window') return { kind: 'close-view', view: target.review }
	if (route.kind === 'open-file') return { kind: 'open-file', view: target.review }
	return { kind: 'none' }
}
