// The left column holds Signals (§3.25). The Signals header's Settings button swaps it to the
// Settings stack (the sidebar app rooted at Settings: profiles, scheduled runs, appearance…); Back
// from its root returns to Signals. There is no task list. Both surfaces stay mounted in their own
// child hosts; the hidden one is `hidden` + `inert`. Presentation only: no session, placement or
// process authority, and switching never resizes the column (so no terminal refit).
// sidebar-layout.ts owns the column's width/visibility.

export type LeftColumnMode = 'signals' | 'settings'

/** The retired "Left column" Appearance preference (Signals or Tasks); removed on startup. */
export const LEGACY_LEFT_COLUMN_STORAGE = 'helm.leftColumn'

/** Drops the retired preference so an old `tasks` value never lingers in storage. */
export function clearLegacyLeftColumnPreference(storage: Pick<Storage, 'removeItem'> | null | undefined): void {
	try {
		storage?.removeItem(LEGACY_LEFT_COLUMN_STORAGE)
	} catch {
		// Storage may be unavailable; nothing reads the key any more.
	}
}

/** What mountLeftColumn reads and writes the mode through. */
export interface LeftColumnModeSource {
	get(): LeftColumnMode
	set(mode: LeftColumnMode): void
	subscribe(listener: () => void): () => void
}

/**
 * An in-memory mode. Production uses one too: every launch starts in Signals, and Settings is a
 * place you visit, never a stored preference.
 */
export function memoryLeftColumnMode(initial: LeftColumnMode = 'signals'): LeftColumnModeSource {
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
	mode(): LeftColumnMode
	setMode(mode: LeftColumnMode): void
	subscribe(listener: () => void): () => void
	/** The Signals surface takes the keys (its open flow, else its list). */
	focusSignals(): void
	signalsHost: HTMLElement
	settingsHost: HTMLElement
	dispose(): void
}

/** The Settings stack's top page heading (SidebarRoot marks it `data-page-heading`). */
function focusSettings(host: HTMLElement): void {
	host.querySelector<HTMLElement>('.nav-page:not([aria-hidden="true"]) [data-page-heading]')?.focus()
}

/** Splits `#left` into `#left-signals` and `#left-settings` (each fills the column) and mounts both. */
export function mountLeftColumn({
	left,
	mountSignals,
	mountSettings,
	mode: source = memoryLeftColumnMode('signals'),
}: {
	left: HTMLElement
	mountSignals(host: HTMLElement): { focus(): void; dispose(): void }
	mountSettings(host: HTMLElement): { dispose(): void } | undefined
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
	const signalsHost = host('left-signals')
	const settingsHost = host('left-settings')
	const signals = mountSignals(signalsHost)
	const settings = mountSettings(settingsHost)
	let shown: LeftColumnMode | null = null
	const apply = (): void => {
		const mode = source.get()
		if (mode === shown) return
		shown = mode
		const hiding = mode === 'signals' ? settingsHost : signalsHost
		const showing = mode === 'signals' ? signalsHost : settingsHost
		// Focus leaves the subtree being hidden first (Chromium accessibility safety); only then.
		const hadFocus = hiding.contains(ownerDocument.activeElement)
		showing.hidden = false
		showing.inert = false
		if (hadFocus) {
			if (mode === 'signals') signals.focus()
			else focusSettings(settingsHost)
			if (hiding.contains(ownerDocument.activeElement)) (ownerDocument.activeElement as HTMLElement | null)?.blur()
		}
		hiding.hidden = true
		hiding.inert = true
		left.dataset.leftColumn = mode
	}
	const unsubscribe = source.subscribe(apply)
	apply()
	return {
		mode: source.get,
		setMode: mode => source.set(mode),
		subscribe: source.subscribe,
		focusSignals() {
			signals.focus()
		},
		signalsHost,
		settingsHost,
		dispose() {
			unsubscribe()
			signals.dispose()
			settings?.dispose()
			signalsHost.remove()
			settingsHost.remove()
			delete left.dataset.leftColumn
		},
	}
}

/**
 * ⌘⇧I (macOS; reserved in shortcuts.ts) = "go to Signals" from anywhere, including a focused xterm
 * (window capture runs before xterm's textarea): a hidden column, or one showing Settings, shows
 * Signals, then Signals takes the keys; pressed inside Signals it hands them back to the terminal.
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
	if (!mac) return () => undefined
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

/** The parts of a Document the sidebar ownership check reads (root tests pass fakes). */
export interface LeftColumnDocument {
	getElementById(id: string): { hidden: boolean; contains(node: unknown): boolean } | null
}

/**
 * Whether a sidebar navigation input (Esc = back, the nav:go back/forward channel, mouse back
 * buttons) belongs to the sidebar stack: never while Signals holds the column (`#left-settings`
 * hidden), so the hidden Settings stack never moves behind Signals. `target` is the key event's
 * target (omitted for inputs with no target: the nav:go channel, mouse buttons); with a target it
 * must sit inside `#left`, and inside `#left-settings` when the column is split. A host without
 * `#left-settings` (stories mounting the sidebar alone) keeps the old rule.
 */
export function sidebarOwnsNavigation(
	doc: LeftColumnDocument,
	target?: { closest(selector: string): unknown } | null,
): boolean {
	if (target !== undefined && (!target || !target.closest('#left'))) return false
	const host = doc.getElementById('left-settings')
	if (!host) return true
	if (host.hidden) return false
	return target === undefined || host.contains(target)
}
