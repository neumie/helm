import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { AgentDockActResult, AgentDockSnapshot, DockAction } from '../agent-dock/model'
import type { AgentDockApi } from '../shared'
import { AgentDock } from './agent-dock/AgentDock'
import { isTextField } from './agent-dock/AgentDockDetail'
import type { AgentDockPosition } from './agent-dock/presentation'

/** Renderer-only presentation preferences (never placement, session or process state). */
export const AGENT_DOCK_STORAGE = {
	expanded: 'helm.agentDock.expanded',
	position: 'helm.agentDock.position',
} as const

const readPosition = (raw: string | null): AgentDockPosition => (raw === 'top' ? 'top' : 'bottom')

/**
 * The dock's place relative to the terminals, chosen in Settings → Appearance (never on the
 * strip). Every mounted dock subscribes and re-lays out live. A choice made while storage is
 * unavailable still applies for this session; another Helm window's change arrives as a
 * `storage` event.
 */
export const agentDockPosition = (() => {
	let chosen: AgentDockPosition | null = null
	const listeners = new Set<() => void>()
	const notify = (): void => {
		for (const listener of listeners) listener()
	}
	const onStorage = (event: StorageEvent): void => {
		if (event.key !== AGENT_DOCK_STORAGE.position && event.key !== null) return
		chosen = null
		notify()
	}
	return {
		get(): AgentDockPosition {
			if (chosen) return chosen
			try {
				return readPosition(globalThis.localStorage.getItem(AGENT_DOCK_STORAGE.position))
			} catch {
				return 'bottom'
			}
		},
		set(position: AgentDockPosition): void {
			chosen = position
			try {
				globalThis.localStorage.setItem(AGENT_DOCK_STORAGE.position, position)
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
})()

/** Re-render ages ("oldest 12m") while nothing else changes. */
const AGE_TICK_MS = 30_000
/** xterm cell height at the default 13px font (design §2.2) until a row has rendered. */
const FALLBACK_ROW_HEIGHT = 19
/** Terminal rows an open pane always leaves above (or below) itself, plus the well's 14px top/bottom padding. */
const PANE_KEEPS_ROWS = 8
const WELL_PADDING = 28

export interface MountedAgentDock {
	/** Open/close the rail: opening focuses the rail; closing returns dock focus to the terminal. */
	toggle(): void
	dispose(): void
}

/**
 * Agent dock presentation inside `main#right`, next to `#terms` (below by default).
 * It renders main-pushed snapshots; Jakub acks and answers through `api` (main
 * runs every Okena effect behind a fresh CAS read). Only the user changes the
 * dock's height — the queue toggle (the queue has one fixed height) and opening or
 * closing a pane (its height is fixed while it is open); the terminal row shrinks
 * through the grid, so xterm refits once per change. Nothing floats over the terminal.
 */
export function mountAgentDock({
	root,
	fitActive,
	api,
	platform,
	focusTerminal: focusTerminalOverride,
	now = Date.now,
	initialSent,
}: {
	root: Document | HTMLElement
	fitActive: () => void
	api: AgentDockApi
	/** `window.helm.platform`; picks ⌘⇧J (darwin) or Ctrl+Shift+J. */
	platform?: string
	/** Defaults to the active xterm's input. */
	focusTerminal?: () => void
	now?: () => number
	/** Review fixtures only: answers the fixture already sent from the dock (receipt stories). */
	initialSent?: ReadonlyMap<number, DockAction>
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
	let position = agentDockPosition.get()
	let snapshot: AgentDockSnapshot | null = null
	let published: boolean | null = null
	let disposed = false
	let restoreTerminal = false

	const view = ownerDocument.createElement('div')
	view.className = 'agent-dock-view'
	dock.replaceChildren(view)
	dock.classList.add('agent-dock')
	const reactRoot = createRoot(view)

	/** Keyboard home inside the dock: an open pane, else the first entry/Agents entry, else the queue. */
	const focusRail = (): void => {
		const pane = dock.querySelector<HTMLElement>('.agent-dock-pane')
		if (pane) {
			pane.focus()
			return
		}
		const rail = dock.querySelector<HTMLElement>('.agent-dock-rail')
		const stop =
			rail?.querySelector<HTMLElement>('[data-rail-stop][data-open="true"]') ??
			rail?.querySelector<HTMLElement>('[data-rail-stop]')
		;(stop ?? rail)?.focus()
	}
	// Room for a pane, read only while one is open (render), never on the pty:data path: #right
	// minus the strip and queue, minus PANE_KEEPS_ROWS terminal rows and the well padding.
	const paneRoom = (): number | null => {
		const total = right.clientHeight
		if (total <= 0) return null
		const pane = dock.querySelector<HTMLElement>('.agent-dock-pane')
		const rest = dock.offsetHeight - (pane?.offsetHeight ?? 0)
		const row =
			terms.querySelector('.term-holder.active .xterm-rows > div')?.getBoundingClientRect().height ||
			FALLBACK_ROW_HEIGHT
		return Math.floor(total - rest - PANE_KEEPS_ROWS * row - WELL_PADDING)
	}
	const focusTerminal = (): void => {
		if (focusTerminalOverride) {
			focusTerminalOverride()
			return
		}
		const input = terms.querySelector<HTMLElement>('.term-holder.active .xterm-helper-textarea')
		if (input) {
			// xterm's helper textarea still sits where the cursor was before the dock took rows: a plain
			// focus() would scroll the overflow-hidden holder, clipping the top row over a blank band.
			input.focus({ preventScroll: true })
			const holder = input.closest<HTMLElement>('.term-holder.active')
			if (holder && holder.scrollTop !== 0) holder.scrollTop = 0
		} else if (dock.contains(ownerDocument.activeElement)) (ownerDocument.activeElement as HTMLElement).blur()
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
			onAck,
			onAct,
			paneRoom,
			// The pane is in-flow: opening or closing it changes the terminal row once; refit now.
			onPaneChange: () => fitActive(),
			initialSent,
		})
		// Commit synchronously so fitActive() and focus moves measure the new layout.
		flushSync(() => reactRoot.render(element))
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

	// Settings → Appearance moved the dock: the terminal row changes height, so refit xterm.
	const unsubscribePosition = agentDockPosition.subscribe(() => {
		const next = agentDockPosition.get()
		if (next === position) return
		position = next
		render()
		fitActive()
	})

	const onAck = async (itemId: number): Promise<boolean> => {
		const focusInDock = dock.contains(ownerDocument.activeElement)
		const acked = await api.ack(itemId)
		// The acked row disappears; keep keyboard focus inside the dock instead of dropping it to <body>.
		if (!disposed && focusInDock && !dock.contains(ownerDocument.activeElement)) focusRail()
		return acked
	}

	// A successful answer hands the keyboard back to the terminal (unless Jakub already moved on elsewhere).
	const onAct = async (itemId: number, rev: number, action: DockAction): Promise<AgentDockActResult> => {
		let result: AgentDockActResult
		try {
			result = await api.act({ itemId, rev, action })
		} catch (error) {
			result = {
				ok: false,
				outcome: { status: 'failed', detail: error instanceof Error ? error.message : String(error) },
			}
		}
		const active = ownerDocument.activeElement
		if (!disposed && result.ok && (!active || active === ownerDocument.body || dock.contains(active))) focusTerminal()
		return result
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
	// Esc in the dock returns to the terminal (an open pane consumes the first Esc itself).
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
		// Clicking into an answer field means "type here": the field keeps focus.
		if ((event.target as Element | null)?.closest?.('input, textarea, label, [contenteditable="true"]')) return
		// Picking "Other…" / "Deny" moves focus into the field it reveals; leave it there.
		if (isTextField(ownerDocument.activeElement)) return
		const selection = ownerWindow.getSelection()
		if (selection && !selection.isCollapsed && dock.contains(selection.anchorNode)) return
		focusTerminal()
	}
	// Re-clamp an open pane when the window changes size; the dock itself never resizes #right.
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
			unsubscribePosition()
			publishVisible()
			rightObserver.disconnect()
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
