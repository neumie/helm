// The task-sidebar column holds one of two surfaces (design §3.25): Signals (default) or the task
// sidebar. Both stay mounted in their own child hosts; the hidden one is `hidden` + `inert`.
// Presentation only: no session, placement or process authority, and switching never resizes the
// column (so no terminal refit). sidebar-layout.ts owns the column's width/visibility and what
// "the task sidebar is visible" means for the daemon watch.

import { storedPreference } from './stored-preference'

export type LeftColumnMode = 'signals' | 'tasks'

export const LEFT_COLUMN_STORAGE = 'helm.leftColumn'

/** Settings → Appearance → Left column, and the Signals header's "Show tasks". Default Signals. */
export const leftColumn = storedPreference<LeftColumnMode>(LEFT_COLUMN_STORAGE, raw =>
	raw === 'tasks' ? 'tasks' : 'signals',
)

/** What mountLeftColumn reads and writes the mode through (stories pass an in-memory one). */
export interface LeftColumnModeSource {
	get(): LeftColumnMode
	set(mode: LeftColumnMode): void
	subscribe(listener: () => void): () => void
}

/** An in-memory mode (stories): nothing persists across story loads. */
export function memoryLeftColumnMode(initial: LeftColumnMode): LeftColumnModeSource {
	let mode = initial
	const listeners = new Set<() => void>()
	return {
		get: () => mode,
		set(next) {
			if (next === mode) return
			mode = next
			for (const listener of listeners) listener()
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
}

export interface MountedLeftColumn {
	/** The effective mode: always `tasks` when this run has no Signals surface. */
	mode(): LeftColumnMode
	setMode(mode: LeftColumnMode): void
	subscribe(listener: () => void): () => void
	/** The Signals surface takes the keys (its open flow, else its list). */
	focusSignals(): void
	signalsHost: HTMLElement | null
	tasksHost: HTMLElement
	dispose(): void
}

/**
 * Splits `#left` into `#left-signals` and `#left-tasks` (each fills the column) and mounts both
 * surfaces. Without `mountSignals` (an older preload with no Signals bridge) the column is Tasks only.
 */
export function mountLeftColumn({
	left,
	mountTasks,
	mountSignals,
	mode: source = leftColumn,
}: {
	left: HTMLElement
	mountTasks(host: HTMLElement): { dispose(): void } | undefined
	mountSignals?: (host: HTMLElement) => { focus(): void; dispose(): void }
	mode?: LeftColumnModeSource
}): MountedLeftColumn {
	const ownerDocument = left.ownerDocument
	const host = (id: string): HTMLElement => {
		const node = ownerDocument.createElement('div')
		node.id = id
		node.className = 'left-column-host'
		left.append(node)
		return node
	}
	const signalsHost = mountSignals ? host('left-signals') : null
	const tasksHost = host('left-tasks')
	const tasks = mountTasks(tasksHost)
	const signals = signalsHost && mountSignals ? mountSignals(signalsHost) : null
	const effective = (): LeftColumnMode => (signals ? source.get() : 'tasks')
	let shown: LeftColumnMode | null = null
	const apply = (): void => {
		const mode = effective()
		if (mode === shown) return
		shown = mode
		const hiding = mode === 'signals' ? tasksHost : signalsHost
		const showing = mode === 'signals' ? signalsHost : tasksHost
		// Focus leaves the subtree being hidden first (Chromium accessibility safety); only then.
		const hadFocus = hiding?.contains(ownerDocument.activeElement) ?? false
		if (showing) {
			showing.hidden = false
			showing.inert = false
		}
		if (hadFocus) {
			if (mode === 'signals') signals?.focus()
			else ownerDocument.querySelector<HTMLElement>('#sidebar-toggle')?.focus()
			if (hiding?.contains(ownerDocument.activeElement)) (ownerDocument.activeElement as HTMLElement | null)?.blur()
		}
		if (hiding) {
			hiding.hidden = true
			hiding.inert = true
		}
		left.dataset.leftColumn = mode
	}
	const unsubscribe = source.subscribe(apply)
	apply()
	return {
		mode: effective,
		setMode(mode) {
			if (signals) source.set(mode)
		},
		subscribe: source.subscribe,
		focusSignals() {
			signals?.focus()
		},
		signalsHost,
		tasksHost,
		dispose() {
			unsubscribe()
			signals?.dispose()
			if (tasks) tasks.dispose()
			signalsHost?.remove()
			tasksHost.remove()
			delete left.dataset.leftColumn
		},
	}
}

/**
 * ⌘⇧I (macOS; reserved in shortcuts.ts) = "go to Signals" from anywhere, including a focused xterm
 * (window capture runs before xterm's textarea): a hidden column, or one in Tasks mode, shows in
 * Signals mode, then Signals takes the keys; pressed inside Signals it hands them back to the terminal.
 */
export function mountSignalsShortcut({
	window: ownerWindow,
	platform,
	column,
	showColumn,
	focusTerminal,
}: {
	window: Window
	platform?: string
	column: MountedLeftColumn
	/** Shows the column when it is hidden (sidebar-layout); absent in hosts without the toggle. */
	showColumn?: () => void
	focusTerminal(): void
}): () => void {
	const mac = (platform ?? (/Mac/.test(ownerWindow.navigator.platform) ? 'darwin' : 'other')) === 'darwin'
	if (!mac || !column.signalsHost) return () => undefined
	const host = column.signalsHost
	const onKeydown = (event: KeyboardEvent): void => {
		if (event.repeat || event.isComposing || event.code !== 'KeyI' || !event.shiftKey || event.altKey) return
		if (!event.metaKey || event.ctrlKey) return
		event.preventDefault()
		event.stopPropagation()
		const inside = host.contains(ownerWindow.document.activeElement)
		if (inside && column.mode() === 'signals' && !host.hidden) {
			focusTerminal()
			return
		}
		column.setMode('signals')
		showColumn?.()
		column.focusSignals()
	}
	ownerWindow.addEventListener('keydown', onKeydown, { capture: true })
	return () => ownerWindow.removeEventListener('keydown', onKeydown, { capture: true })
}

/** The active terminal's input, without scrolling its holder (see agent-dock-layout focusTerminal). */
export function focusActiveTerminal(root: Document | HTMLElement): void {
	const input = root.querySelector<HTMLElement>('#terms .term-holder.active .xterm-helper-textarea')
	if (!input) {
		const active = (root instanceof Document ? root : root.ownerDocument).activeElement
		if (active instanceof HTMLElement) active.blur()
		return
	}
	input.focus({ preventScroll: true })
	const holder = input.closest<HTMLElement>('.term-holder.active')
	if (holder && holder.scrollTop !== 0) holder.scrollTop = 0
}
