import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type {
	AgentDockActResult,
	AgentDockMessageResult,
	AgentDockPromptRequest,
	AgentDockSnapshot,
	DockAction,
} from '../agent-dock/model'
import type { AgentDockApi } from '../shared'
import { AgentDock, type AgentDockHandle } from './agent-dock/AgentDock'
import { isTextField } from './agent-dock/pane-keys'
import {
	type AgentDockPosition,
	type AgentsLayout,
	agentsLayout,
	failedActResult,
	paneMaxHeight,
} from './agent-dock/presentation'

/** Renderer-only presentation preferences (never placement, session or process state). */
export const AGENT_DOCK_STORAGE = {
	position: 'helm.agentDock.position',
	agentsLayout: 'helm.agentDock.agentsLayout',
} as const

/**
 * One presentation preference in renderer storage (Helm's userData, shared by its app profiles: no
 * per-profile partition). Every mounted dock subscribes and re-lays out live. A choice made while
 * storage is unavailable still applies for this session; another Helm window's change arrives as a
 * `storage` event.
 */
function storedPreference<T extends string>(key: string, read: (raw: string | null) => T) {
	let chosen: T | null = null
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
			if (chosen) return chosen
			try {
				return read(globalThis.localStorage.getItem(key))
			} catch {
				return read(null)
			}
		},
		set(value: T): void {
			chosen = value
			try {
				globalThis.localStorage.setItem(key, value)
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

/** The dock's place relative to the terminals, chosen in Settings → Appearance (never on the queue row). */
export const agentDockPosition = storedPreference<AgentDockPosition>(AGENT_DOCK_STORAGE.position, raw =>
	raw === 'top' ? 'top' : 'bottom',
)

/** How the Agents pane groups its rows, switched in its header (`G`); default `by-state`. */
export const agentDockAgentsLayout = storedPreference<AgentsLayout>(AGENT_DOCK_STORAGE.agentsLayout, agentsLayout)

/** Re-render waits/ages in the queue while nothing else changes. */
const AGE_TICK_MS = 30_000
/** xterm cell height at the default 13px font (design §2.2) until a row has rendered. */
const FALLBACK_ROW_HEIGHT = 19
/** Terminal rows an open pane always leaves above (or below) itself, plus the well's 14px top/bottom padding. */
const PANE_KEEPS_ROWS = 8
const WELL_PADDING = 28

export interface MountedAgentDock {
	/** ⌘⇧J: go to the dock (its open pane, else the open or first entry); from inside it, close the pane and return to the terminal. */
	toggle(): void
	dispose(): void
}

/**
 * Agent dock presentation inside `main#right`, next to `#terms` (below by default).
 * It renders main-pushed snapshots; Jakub acks and answers through `api` (main
 * runs every Okena effect behind a fresh CAS read). The queue row is always shown at
 * one fixed height, so arriving items never refit xterm; only opening, closing or (once,
 * never shrinking) growing a pane changes the dock's height: the terminal row shrinks
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
	const mac = (platform ?? (/Mac/.test(ownerWindow.navigator.platform) ? 'darwin' : 'other')) === 'darwin'
	let position = agentDockPosition.get()
	let snapshot: AgentDockSnapshot | null = null
	let published: boolean | null = null
	let disposed = false
	let restoreTerminal = false
	const handle: { current: AgentDockHandle | null } = { current: null }

	const view = ownerDocument.createElement('div')
	view.className = 'agent-dock-view'
	dock.replaceChildren(view)
	dock.classList.add('agent-dock')
	const reactRoot = createRoot(view)

	/**
	 * Keyboard home inside the dock: an open pane (the Agents pane: its current row, so a live reorder
	 * that re-mounted the focused row keeps Jakub on that agent), else the open or first entry/Agents
	 * entry, else the row.
	 */
	const focusDock = (): void => {
		const pane = dock.querySelector<HTMLElement>('.agent-dock-pane')
		if (pane) {
			;(pane.querySelector<HTMLElement>('.agent-dock-agent[tabindex="0"]') ?? pane).focus()
			return
		}
		const row = dock.querySelector<HTMLElement>('.agent-dock-row')
		const stop =
			row?.querySelector<HTMLElement>('[data-row-stop][data-open="true"]') ??
			row?.querySelector<HTMLElement>('[data-row-stop]')
		;(stop ?? row)?.focus()
	}
	// Room for a pane, read only while one is open (render), never on the pty:data path: #right
	// minus the queue row, minus PANE_KEEPS_ROWS terminal rows and the well padding (it clamps the pane
	// on screen); and the most a pane may open (or grow) to — a share of #right (paneMaxHeight).
	const paneRoom = (): { room: number; max: number } | null => {
		const total = right.clientHeight
		if (total <= 0) return null
		const pane = dock.querySelector<HTMLElement>('.agent-dock-pane')
		const rest = dock.offsetHeight - (pane?.offsetHeight ?? 0)
		const row =
			terms.querySelector('.term-holder.active .xterm-rows > div')?.getBoundingClientRect().height ||
			FALLBACK_ROW_HEIGHT
		const room = Math.floor(total - rest - PANE_KEEPS_ROWS * row - WELL_PADDING)
		return { room, max: paneMaxHeight(total) }
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
		right.dataset.agentDockPosition = position
		const element = createElement(AgentDock, {
			snapshot,
			now: now(),
			position,
			mod: mac ? 'cmd' : 'ctrl',
			handle,
			onAck,
			onAct,
			onPrompt,
			readMessage,
			agentsLayout: agentDockAgentsLayout.get(),
			onAgentsLayout: agentDockAgentsLayout.set,
			paneRoom,
			// The pane is in-flow: opening or closing it changes the terminal row once; refit now.
			onPaneChange: () => fitActive(),
			// After an answer, or once nothing else waits (the dock decides; see AgentDock moveOn).
			focusTerminal: () => {
				if (!disposed) focusTerminal()
			},
			initialSent,
		})
		// Commit synchronously so fitActive() and focus moves measure the new layout.
		flushSync(() => reactRoot.render(element))
	}

	// "Go to the dock", or — pressed inside it — leave: focus goes back to the terminal before an open
	// pane unmounts (Chromium accessibility safety); closing it refits xterm through onPaneChange.
	const toggle = (): void => {
		if (!dock.contains(ownerDocument.activeElement)) {
			focusDock()
			return
		}
		focusTerminal()
		flushSync(() => handle.current?.closePane())
	}

	// The Agents pane's grouping changed (here or in another window): only the list re-renders.
	const unsubscribeAgentsLayout = agentDockAgentsLayout.subscribe(render)

	// Settings → Appearance moved the dock: the terminal row changes height, so refit xterm.
	const unsubscribePosition = agentDockPosition.subscribe(() => {
		const next = agentDockPosition.get()
		if (next === position) return
		position = next
		render()
		fitActive()
	})

	/** Focus fell out of a removed element: nobody has it (it was not handed to the terminal or elsewhere). */
	const focusDropped = (): boolean => {
		const active = ownerDocument.activeElement
		return !active || active === ownerDocument.body
	}

	const onAck = async (itemId: number): Promise<boolean> => {
		const focusInDock = dock.contains(ownerDocument.activeElement)
		const acked = await api.ack(itemId)
		// The acked row disappears; keep keyboard focus inside the dock instead of dropping it to <body>.
		if (!disposed && focusInDock && focusDropped()) focusDock()
		return acked
	}

	// Where the keys go after an answer (next waiting item, or back to the terminal) is the dock's call.
	const onAct = async (itemId: number, action: DockAction): Promise<AgentDockActResult> => {
		try {
			return await api.act({ itemId, action })
		} catch (error) {
			return failedActResult(error)
		}
	}

	const onPrompt = async (request: AgentDockPromptRequest): Promise<AgentDockActResult> => {
		try {
			return await api.prompt(request)
		} catch (error) {
			return failedActResult(error)
		}
	}

	const readMessage = async (session: string): Promise<AgentDockMessageResult> => {
		try {
			return await api.lastMessage(session)
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) }
		}
	}

	const publishVisible = (): void => {
		const visible = !disposed && ownerDocument.visibilityState !== 'hidden'
		if (published === visible) return
		published = visible
		api.setVisible(visible)
	}

	// ⌘⇧J = "go to the dock" from anywhere, including a focused xterm (window capture runs
	// before xterm's textarea): the dock just takes focus (no layout change, so no PTY resize
	// under a TUI being typed into); pressed again inside the dock it closes an open pane and
	// hands the keys back to the terminal.
	const onWindowKeydown = (event: KeyboardEvent): void => {
		if (event.repeat || event.isComposing || event.code !== 'KeyJ' || !event.shiftKey || event.altKey) return
		if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return
		event.preventDefault()
		event.stopPropagation()
		toggle()
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
		// (Focus the dock handed to the terminal itself, after the last waiting item, stays there.)
		if (focusInDock && focusDropped()) focusDock()
	})
	publishVisible()
	fitActive()

	return {
		toggle,
		dispose(): void {
			if (disposed) return
			disposed = true
			unsubscribe()
			unsubscribePosition()
			unsubscribeAgentsLayout()
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
			delete right.dataset.agentDockPosition
			// Unmount outside any React commit that may be disposing this mount (e.g. a fixture effect cleanup).
			queueMicrotask(() => {
				reactRoot.unmount()
				view.remove()
			})
		},
	}
}
