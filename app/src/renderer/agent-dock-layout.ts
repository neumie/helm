import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { AgentDockSnapshot } from '../agent-dock/model'
import type { AgentDockApi } from '../shared'
import { AgentDock } from './agent-dock/AgentDock'
import type { AgentDockPosition, TerminalMetrics } from './agent-dock/presentation'

/** Renderer-only presentation preferences (never placement, session or process state). */
export const AGENT_DOCK_STORAGE = {
	expanded: 'helm.agentDock.expanded',
	position: 'helm.agentDock.position',
} as const

/** Re-render ages ("oldest 12m") while nothing else changes. */
const AGE_TICK_MS = 30_000
/** xterm cell height at the default 13px font (design §2.2) until a row has rendered. */
const FALLBACK_ROW_HEIGHT = 19

export interface MountedAgentDock {
	/** Open/close the rail: opening focuses the rail; closing returns dock focus to the terminal. */
	toggle(): void
	dispose(): void
}

/**
 * Agent dock presentation inside `main#right`, next to `#terms` (below by default).
 * Read-only: it renders main-pushed snapshots and can only ack. Only the user's
 * rail toggle changes the dock's height (the rail has one fixed height); the
 * terminal pane shrinks through the grid row, so the #terms ResizeObserver refits
 * xterm. The detail popover floats over the terminal without resizing anything.
 */
export function mountAgentDock({
	root,
	fitActive,
	api,
	platform,
	focusTerminal: focusTerminalOverride,
	now = Date.now,
}: {
	root: Document | HTMLElement
	fitActive: () => void
	api: AgentDockApi
	/** `window.helm.platform`; picks ⌘⇧J (darwin) or Ctrl+Shift+J. */
	platform?: string
	/** Defaults to the active xterm's input. */
	focusTerminal?: () => void
	now?: () => number
}): MountedAgentDock {
	const ownerDocument = root instanceof Document ? root : root.ownerDocument
	const ownerWindow = ownerDocument.defaultView
	const right = root.querySelector<HTMLElement>('#right')
	const terms = root.querySelector<HTMLElement>('#terms')
	const dock = root.querySelector<HTMLElement>('#agent-dock')
	if (!ownerWindow || !right || !terms || !dock) throw new Error('Missing agent-dock layout shell')
	const read = (key: string): string | null => {
		try {
			return ownerWindow.localStorage.getItem(key)
		} catch {
			return null
		}
	}
	const save = (key: string, value: string): void => {
		try {
			ownerWindow.localStorage.setItem(key, value)
		} catch {
			// Presentation still works when storage is unavailable.
		}
	}
	const mac = (platform ?? (/Mac/.test(ownerWindow.navigator.platform) ? 'darwin' : 'other')) === 'darwin'
	const shortcutLabel = mac ? '⌘⇧J' : 'Ctrl+Shift+J'
	let expanded = read(AGENT_DOCK_STORAGE.expanded) === 'true'
	let position: AgentDockPosition = read(AGENT_DOCK_STORAGE.position) === 'top' ? 'top' : 'bottom'
	let snapshot: AgentDockSnapshot | null = null
	let published: boolean | null = null
	let disposed = false
	let restoreTerminal = false

	const view = ownerDocument.createElement('div')
	view.className = 'agent-dock-view'
	dock.replaceChildren(view)
	dock.classList.add('agent-dock')
	const reactRoot = createRoot(view)

	/** Keyboard home inside the dock: the open card, else the first card/Agents button, else the rail. */
	const focusRail = (): void => {
		const rail = dock.querySelector<HTMLElement>('.agent-dock-rail')
		const stop =
			rail?.querySelector<HTMLElement>('[data-rail-stop][data-open="true"]') ??
			rail?.querySelector<HTMLElement>('[data-rail-stop]')
		;(stop ?? rail)?.focus()
	}
	// Measured only while a popover is open (layout effect), never on the pty:data path.
	const terminalMetrics = (): TerminalMetrics | null => {
		const pane = terms.getBoundingClientRect()
		if (pane.height <= 0) return null
		const screen = terms.querySelector<HTMLElement>('.term-holder.active .xterm-screen')?.getBoundingClientRect()
		const rowsElement = terms.querySelector<HTMLElement>('.term-holder.active .xterm-rows')
		const rows = rowsElement?.childElementCount ?? 0
		const visible = screen && screen.height > 0 ? screen : null
		// The row holding xterm's drawn cursor (DOM renderer); absent while a TUI hides it.
		const cursorRow = rowsElement?.querySelector('.xterm-cursor')?.closest('.xterm-rows > div')
		return {
			top: pane.top,
			bottom: pane.bottom,
			screenTop: visible ? visible.top : pane.top,
			screenBottom: visible ? visible.bottom : pane.bottom,
			rowHeight: visible && rows > 0 ? visible.height / rows : FALLBACK_ROW_HEIGHT,
			cursorTop: visible && cursorRow ? cursorRow.getBoundingClientRect().top : null,
		}
	}
	const focusTerminal = (): void => {
		if (focusTerminalOverride) {
			focusTerminalOverride()
			return
		}
		const input = terms.querySelector<HTMLElement>('.term-holder.active .xterm-helper-textarea')
		if (input) input.focus()
		else if (dock.contains(ownerDocument.activeElement)) (ownerDocument.activeElement as HTMLElement).blur()
	}

	const render = (): void => {
		if (disposed) return
		dock.hidden = false
		dock.dataset.position = position
		dock.dataset.expanded = String(expanded)
		right.dataset.agentDockPosition = position
		const element = createElement(AgentDock, {
			snapshot,
			now: now(),
			expanded,
			position,
			shortcutLabel,
			onToggle: () => toggle(false),
			onTogglePosition,
			onAck,
			terminalMetrics,
			onPopoverOpenChange: watchActiveScreen,
		})
		// Commit synchronously so fitActive() and focus moves measure the new layout.
		flushSync(() => reactRoot.render(element))
		watchActiveScreen()
	}

	// While a popover is open, re-place it when the active terminal's grid changes without
	// #right resizing (font size, tab switch hides the old screen); idle otherwise.
	let watchedScreen: Element | null = null
	const screenObserver = new ResizeObserver(() => render())
	const watchActiveScreen = (): void => {
		const next = dock.querySelector('.agent-dock-popover')
			? terms.querySelector('.term-holder.active .xterm-screen')
			: null
		if (next === watchedScreen) return
		screenObserver.disconnect()
		watchedScreen = next
		if (next) screenObserver.observe(next)
	}

	const toggle = (focusPanel: boolean): void => {
		const focusInDock = dock.contains(ownerDocument.activeElement)
		expanded = !expanded
		// Move owned focus out before the panel turns inert/hidden (Chromium accessibility safety).
		if (!expanded && focusInDock) focusTerminal()
		save(AGENT_DOCK_STORAGE.expanded, String(expanded))
		render()
		fitActive()
		if (expanded && focusPanel) focusRail()
	}

	const onTogglePosition = (): void => {
		position = position === 'bottom' ? 'top' : 'bottom'
		save(AGENT_DOCK_STORAGE.position, position)
		render()
		fitActive()
	}

	const onAck = async (itemId: number): Promise<boolean> => {
		const focusInDock = dock.contains(ownerDocument.activeElement)
		const acked = await api.ack(itemId)
		// The acked row disappears; keep keyboard focus inside the dock instead of dropping it to <body>.
		if (!disposed && focusInDock && !dock.contains(ownerDocument.activeElement)) focusRail()
		return acked
	}

	const publishVisible = (): void => {
		const visible = !disposed && ownerDocument.visibilityState !== 'hidden'
		if (published === visible) return
		published = visible
		api.setVisible(visible)
	}

	// ⌘⇧J = "go to the dock" from anywhere, including a focused xterm (window capture runs
	// before xterm's textarea): an already-expanded dock just takes focus (no layout change,
	// so no PTY resize under a TUI being typed into); pressed again inside the dock it collapses.
	const onWindowKeydown = (event: KeyboardEvent): void => {
		if (event.repeat || event.isComposing || event.code !== 'KeyJ' || !event.shiftKey || event.altKey) return
		if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return
		event.preventDefault()
		event.stopPropagation()
		if (expanded && !dock.contains(ownerDocument.activeElement)) focusRail()
		else toggle(true)
	}
	// Esc in the dock returns to the terminal (an open popover consumes the first Esc itself).
	const onDockKeydown = (event: KeyboardEvent): void => {
		if (event.key !== 'Escape' || event.defaultPrevented) return
		event.preventDefault()
		focusTerminal()
	}
	// Pointer use never steals terminal focus: buttons act without taking focus, and any
	// other click returns focus to the terminal unless it left a text selection to copy.
	const onDockMouseDown = (event: MouseEvent): void => {
		restoreTerminal = terms.contains(ownerDocument.activeElement)
		if ((event.target as Element | null)?.closest?.('button')) event.preventDefault()
	}
	const onDockClick = (event: MouseEvent): void => {
		const restore = restoreTerminal
		restoreTerminal = false
		if (event.detail === 0 || !restore) return
		const selection = ownerWindow.getSelection()
		if (selection && !selection.isCollapsed && dock.contains(selection.anchorNode)) return
		focusTerminal()
	}
	// Re-place an open popover when the pane changes size (window resize); the dock itself never resizes #right.
	const rightObserver = new ResizeObserver(() => render())
	const ageTimer = ownerWindow.setInterval(() => {
		if (ownerDocument.visibilityState !== 'hidden') render()
	}, AGE_TICK_MS)

	ownerWindow.addEventListener('keydown', onWindowKeydown, { capture: true })
	ownerDocument.addEventListener('visibilitychange', publishVisible)
	dock.addEventListener('keydown', onDockKeydown)
	dock.addEventListener('mousedown', onDockMouseDown, true)
	dock.addEventListener('click', onDockClick)
	render()
	rightObserver.observe(right)
	const unsubscribe = api.onSnapshot(next => {
		snapshot = next
		const focusInDock = dock.contains(ownerDocument.activeElement)
		render()
		// A live update removed the focused row (resolved elsewhere): keep keyboard focus in the dock.
		if (focusInDock && !dock.contains(ownerDocument.activeElement)) focusRail()
	})
	publishVisible()
	fitActive()

	return {
		toggle: () => toggle(true),
		dispose(): void {
			if (disposed) return
			disposed = true
			unsubscribe()
			publishVisible()
			rightObserver.disconnect()
			screenObserver.disconnect()
			ownerWindow.clearInterval(ageTimer)
			ownerWindow.removeEventListener('keydown', onWindowKeydown, { capture: true })
			ownerDocument.removeEventListener('visibilitychange', publishVisible)
			dock.removeEventListener('keydown', onDockKeydown)
			dock.removeEventListener('mousedown', onDockMouseDown, true)
			dock.removeEventListener('click', onDockClick)
			if (dock.contains(ownerDocument.activeElement)) focusTerminal()
			dock.hidden = true
			dock.classList.remove('agent-dock')
			delete dock.dataset.position
			delete dock.dataset.expanded
			delete right.dataset.agentDockPosition
			// Unmount outside any React commit that may be disposing this mount (e.g. a fixture effect cleanup).
			queueMicrotask(() => {
				reactRoot.unmount()
				view.remove()
			})
		},
	}
}
