import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type {
	AgentDockActResult,
	AgentDockMessageResult,
	AgentDockPromptRequest,
	AgentDockRevealResult,
	AgentDockSnapshot,
	DockAction,
} from '../agent-dock/model'
import type { DockRevealTarget } from '../agent-dock/reveal'
import type { AgentDockApi } from '../shared'
import { AgentDock, type AgentDockHandle } from './agent-dock/AgentDock'
import { isTextField } from './agent-dock/pane-keys'
import {
	type AgentDockPosition,
	type AgentsLayout,
	agentsLayout,
	failedActResult,
	paneMaxHeight,
	storedPaneHeight,
} from './agent-dock/presentation'
import { storedPreference } from './stored-preference'

/** Renderer-only presentation preferences (never placement, session or process state). */
export const AGENT_DOCK_STORAGE = {
	position: 'helm.agentDock.position',
	agentsLayout: 'helm.agentDock.agentsLayout',
	paneHeight: 'helm.agentDock.paneHeight',
	notify: 'helm.agentDock.notify',
} as const

/** The dock's place relative to the terminals, chosen in Settings → Appearance (never on the queue row). */
export const agentDockPosition = storedPreference<AgentDockPosition>(AGENT_DOCK_STORAGE.position, raw =>
	raw === 'top' ? 'top' : 'bottom',
)

/** How the Agents pane groups its rows, switched in its header (`G`); default `by-state`. */
export const agentDockAgentsLayout = storedPreference<AgentsLayout>(AGENT_DOCK_STORAGE.agentsLayout, agentsLayout)

/**
 * The pane height Jakub dragged its terminal-side edge to (px), or null: automatic sizing. Once set it is
 * the height of every open pane (clamped on screen to the room); a double-click on the edge clears it.
 */
export const agentDockPaneHeight = storedPreference<number | null>(
	AGENT_DOCK_STORAGE.paneHeight,
	storedPaneHeight,
	height => (height === null ? null : String(Math.round(height))),
)

/**
 * Settings → Appearance → Agent dock → "Notify when Helm is in the background" (default on). Main shows
 * the notifications (agent-dock/notifier.ts); every mounted dock reports the value to it.
 */
export const agentDockNotify = storedPreference<boolean>(
	AGENT_DOCK_STORAGE.notify,
	raw => raw !== 'off',
	on => (on ? null : 'off'),
)

/** A notification click arrived before the snapshot that has its item: wait this long for one, then open the next waiting item. */
const OPEN_ITEM_WAIT_MS = 1_500

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
 * never shrinking) growing a pane, or Jakub dragging its edge, changes the dock's height: the
 * terminal row shrinks through the grid, so xterm refits once per change (a drag: at most once
 * per frame, then once on release). Nothing floats over the terminal.
 */
export function mountAgentDock({
	root,
	fitActive,
	api,
	platform,
	focusTerminal: focusTerminalOverride,
	revealTerminal,
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
	/**
	 * Shows a Helm terminal from the dock ("Show terminal"): its tab, focused, frame pulsed
	 * (MountedTerminalWorkspace.revealTerminal). Absent: Helm-terminal agents offer no reveal.
	 */
	revealTerminal?: (sessionId: string) => boolean
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
	// on screen and bounds a drag of its edge); the most a pane may open (or grow) to — a share of #right
	// (paneMaxHeight); and one terminal row's height (the ⌥↑ / ⌥↓ nudge step).
	const paneRoom = (): { room: number; max: number; row: number } | null => {
		const total = right.clientHeight
		if (total <= 0) return null
		const pane = dock.querySelector<HTMLElement>('.agent-dock-pane')
		const rest = dock.offsetHeight - (pane?.offsetHeight ?? 0)
		const row =
			terms.querySelector('.term-holder.active .xterm-rows > div')?.getBoundingClientRect().height ||
			FALLBACK_ROW_HEIGHT
		const room = Math.floor(total - rest - PANE_KEEPS_ROWS * row - WELL_PADDING)
		return { room, max: paneMaxHeight(total), row }
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
			userHeight: agentDockPaneHeight.get(),
			onUserHeight: agentDockPaneHeight.set,
			// The pane is in-flow: opening, closing or resizing it changes the terminal row; refit now.
			onPaneChange: () => fitActive(),
			// After an answer, or once nothing else waits (the dock decides; see AgentDock moveOn).
			focusTerminal: () => {
				if (!disposed) focusTerminal()
			},
			initialSent,
			onReveal,
			canReveal: (target: DockRevealTarget) => target.kind === 'okena' || revealTerminal !== undefined,
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
	// Jakub dragged the pane's edge (here or in another window) or reset it: the open pane takes the
	// height; the dock refits xterm once for it (AgentDock onPaneChange).
	const unsubscribePaneHeight = agentDockPaneHeight.subscribe(render)
	// Main decides on notifications; it hears Jakub's setting now and on every change.
	const reportNotify = (): void => {
		if (!disposed) api.setNotify(agentDockNotify.get())
	}
	const unsubscribeNotify = agentDockNotify.subscribe(reportNotify)

	/**
	 * A dock notification was clicked (main brought the window forward): open the pane on its item. Main's
	 * snapshot may still be on its way (the dock was not shown meanwhile): wait for it, then fall back to
	 * the next waiting item.
	 */
	let pendingOpen: { itemId: number; timer: number } | null = null
	const settleOpen = (fallback: boolean): void => {
		if (!pendingOpen) return
		const opened = handle.current?.openItem(pendingOpen.itemId, fallback) ?? false
		if (!opened && !fallback) return
		ownerWindow.clearTimeout(pendingOpen.timer)
		pendingOpen = null
	}
	const onOpenItem = (itemId: number | null): void => {
		if (pendingOpen) ownerWindow.clearTimeout(pendingOpen.timer)
		pendingOpen = null
		// Null: nothing waits any more (main's view); the window just came forward.
		if (disposed || itemId === null) return
		pendingOpen = { itemId, timer: ownerWindow.setTimeout(() => settleOpen(true), OPEN_ITEM_WAIT_MS) }
		settleOpen(false)
	}
	const unsubscribeOpenItem = api.onOpenItem(onOpenItem)

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

	// "Show in Okena" goes through main (focus + raise the app); a Helm terminal is this window's own tab.
	const onReveal = async (target: DockRevealTarget): Promise<AgentDockRevealResult> => {
		if (target.kind === 'helm')
			return revealTerminal?.(target.terminalId)
				? { ok: true, activated: true }
				: { ok: false, detail: 'This terminal is not open in this window.' }
		try {
			return await api.reveal(target.session)
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
	// Pointer use never steals terminal focus: buttons and the pane's resize edge act without taking
	// focus (a drag leaves it where it was), and any other click returns focus to the terminal unless
	// it left a text selection to copy.
	const onDockMouseDown = (event: MouseEvent): void => {
		restoreTerminal = terms.contains(ownerDocument.activeElement)
		if ((event.target as Element | null)?.closest?.('button, .agent-dock-resize')) event.preventDefault()
	}
	const onDockClick = (event: MouseEvent): void => {
		const restore = restoreTerminal
		restoreTerminal = false
		if (event.detail === 0 || !restore) return
		if ((event.target as Element | null)?.closest?.('.agent-dock-resize')) return
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
		settleOpen(false)
	})
	publishVisible()
	reportNotify()
	fitActive()

	return {
		toggle,
		dispose(): void {
			if (disposed) return
			disposed = true
			unsubscribe()
			unsubscribePosition()
			unsubscribeAgentsLayout()
			unsubscribePaneHeight()
			unsubscribeNotify()
			unsubscribeOpenItem()
			if (pendingOpen) ownerWindow.clearTimeout(pendingOpen.timer)
			pendingOpen = null
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
