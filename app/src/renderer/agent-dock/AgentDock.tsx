// Agent dock body (design §3.24): one --chrome surface below (or above) the terminal,
// like the topbar mirrored. Two bands: the 28px queue row — one quiet line per item
// that owes Jakub something (glyph, short name, wait), "+N more" when they do not fit,
// then the Agents entry and ⌘⇧J — and, when an entry is opened, a pane
// split off the terminal in-flow: the terminal row shrinks and refits once, nothing
// ever floats over its text. The row is the same with or without a pane. Answering
// happens in the pane and the receipt shows in place; entries keep their
// slots while the pane is open. Layout, focus return and ⌘⇧J belong to
// agent-dock-layout.ts. Agent text is untrusted and always rendered as plain React
// text (never markup), bounded and control-stripped.

import {
	type KeyboardEvent,
	type MutableRefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import type {
	AgentDockActResult,
	AgentDockMessageResult,
	AgentDockPromptRequest,
	AgentDockSnapshot,
	DockAction,
	DockItem,
} from '../../agent-dock/model'
import { ItemDetail } from './AgentDockDetail'
import { type AgentDockTarget, Queue } from './AgentDockQueue'
import { AgentPanel, agentDraftKey } from './AgentPanel'
import { AgentsDetail } from './AgentsDetail'
import {
	type DetailKeys,
	type DockModKey,
	bodyScrollKey,
	choiceStop,
	dockShortcut,
	isAckKey,
	keepsEditKey,
	overflows,
	scrollBody,
} from './pane-keys'
import { type DockDrafts, draftKeys } from './panel'
import {
	type AgentDockPosition,
	type AgentRow,
	type AgentsLayout,
	actErrorText,
	agentOverview,
	agentWho,
	canAck,
	canAnswer,
	dockLabel,
	failedActResult,
	findSession,
	itemKindLabel,
	keepOrder,
	nextLingerExpiry,
	nextWaiting,
	paneFitHeight,
	queueItems,
	sourceBlockedNote,
} from './presentation'
import { useArrivalAnnouncement } from './use-arrival-announcement'

export type { AgentDockTarget }

/** What the layout may ask of a mounted dock (⌘⇧J pressed inside it). */
export interface AgentDockHandle {
	/** Close an open pane (no focus move: the layout hands focus back to the terminal first). */
	closePane(): void
}

export interface AgentDockProps {
	snapshot: AgentDockSnapshot | null
	now: number
	position: AgentDockPosition
	/** The platform's modifier: `cmd` on macOS (⌘⇧J, ⌘↵), `ctrl` elsewhere. */
	mod: DockModKey
	/** Filled with the dock's handle while it is mounted. */
	handle?: MutableRefObject<AgentDockHandle | null>
	onAck(itemId: number): Promise<boolean>
	/** Jakub answered from the pane (main runs the Okena CAS + POST; the receipt arrives in the snapshot). */
	onAct?(itemId: number, action: DockAction): Promise<AgentDockActResult>
	/** Jakub replied from an agent's detail (it owed him nothing); the receipt arrives on its session. */
	onPrompt?(request: AgentDockPromptRequest): Promise<AgentDockActResult>
	/** The agent detail's full last message, read live through the agent's source. */
	readMessage?(session: string): Promise<AgentDockMessageResult>
	/** How the Agents pane groups its rows (Jakub's stored setting); default `by-state`. */
	agentsLayout?: AgentsLayout
	/** Jakub switched the grouping in the Agents pane header (or with `G`): store it. */
	onAgentsLayout?(layout: AgentsLayout): void
	/**
	 * The layout's measure of #right: `room`, the most px the pane may take on screen so the terminal keeps
	 * its rows, and `max`, the most it may open or grow to (a share of #right); null = not known.
	 */
	paneRoom?: () => PaneRoom | null
	/** After the pane opens, grows or closes: the terminal row changed height once, refit it. */
	onPaneChange?(open: boolean): void
	/** Hand the keys back to the active terminal (after an answer, or once nothing else waits). */
	focusTerminal?(): void
	/** Review fixtures only: the pane to show on first render. */
	initialOpen?: AgentDockTarget | null
	/** Review fixtures only: answers already sent from the dock (the receipt stories), by item id. */
	initialSent?: ReadonlyMap<number, DockAction>
}

export interface PaneRoom {
	room: number
	max: number
}

/** However little room is left, the pane keeps its rule, a few body rows and its footer. */
const PANE_FLOOR = 120
/**
 * After the pane opens, or moves on to another item because the shown one left, its content may still
 * grow for this long (an agent's full message read live, a late snapshot): the pane grows to it once.
 */
const PANE_SETTLE_MS = 1_500

/**
 * What the shown content would take unclipped: the pane's height plus what its scrolling parts (the
 * body, the choices block) hide. A pane not yet sized has nothing hidden: its own height.
 */
function naturalHeight(pane: HTMLElement): number {
	let hidden = 0
	for (const part of pane.querySelectorAll<HTMLElement>('.agent-dock-pane-scroll, .agent-dock-pane-fixed'))
		hidden += Math.max(0, part.scrollHeight - part.clientHeight)
	return pane.offsetHeight + hidden
}

/** An agent-detail reply's local error, while the agent's last message is still the one it answered. */
const promptError = (
	error: { text: string; uuid?: string } | undefined,
	lastUuid: string | undefined,
): string | null => (error && error.uuid === lastUuid ? error.text : null)

const targetKey = (target: AgentDockTarget | null): string | null =>
	target === null
		? null
		: target.type === 'agents'
			? 'agents'
			: target.type === 'agent'
				? `agent:${target.key}`
				: `item:${target.id}`

export function AgentDock({
	snapshot,
	now,
	position,
	mod,
	handle,
	onAck,
	onAct,
	onPrompt,
	readMessage,
	agentsLayout = 'by-state',
	onAgentsLayout,
	paneRoom,
	onPaneChange,
	focusTerminal,
	initialOpen = null,
	initialSent,
}: AgentDockProps) {
	const paneId = useId()
	const hostRef = useRef<HTMLDivElement>(null)
	const paneRef = useRef<HTMLElement>(null)
	const anchors = useRef(new Map<string, HTMLButtonElement>())
	const [target, setTarget] = useState<AgentDockTarget | null>(initialOpen)
	const targetRef = useRef(target)
	targetRef.current = target
	/** The pane's height: the opened content's natural height, within its bounds; null until measured (and while closed). */
	const [paneHeight, setPaneHeight] = useState<number | null>(null)
	const paneHeightRef = useRef(paneHeight)
	paneHeightRef.current = paneHeight
	/**
	 * The shown content may still raise the pane's height once (never lower it): from an open, or a move-on
	 * to another item because the shown one left, until it grows, Jakub types or steps, or PANE_SETTLE_MS.
	 */
	const growable = useRef(false)
	/** The most it may grow to: the layout's max when it was armed (a window resized meanwhile grows nothing). */
	const growMax = useRef<number | undefined>(undefined)
	/** Bumped when growable is re-armed, so the content watch restarts its settle time. */
	const [settle, setSettle] = useState(0)
	/** Entry order while the pane is open: answered entries keep their slot until it closes. */
	const order = useRef<number[] | null>(null)
	const focusOnOpen = useRef(false)
	/** Keyboard focus was inside the pane when a step or ack swapped its content. */
	const keepFocus = useRef(false)
	/** That step came from a choice (← →): focus goes on to the new body's choices, else the pane. */
	const keepOnChoices = useRef(false)
	/** Index to advance to after a local ack removes the open item. */
	const advanceFrom = useRef<number | null>(null)
	/** An item acked from the dock: when it leaves, the pane moves on to the next waiting item. */
	const movingOn = useRef<number | null>(null)
	const [pending, setPending] = useState<ReadonlySet<number>>(new Set())
	const [refused, setRefused] = useState<ReadonlySet<number>>(new Set())
	/** Acts awaiting main's answer (the button shows Sending… even before the snapshot does). */
	const [submitting, setSubmitting] = useState<ReadonlySet<number>>(new Set())
	/** Outcomes main could not record on the item (bad request, IPC failure), by item id. */
	const [actErrors, setActErrors] = useState<ReadonlyMap<number, string>>(new Map())
	/** Pane-level key handler of the shown body (digits pick, Enter submits). */
	const detailKeys = useRef<DetailKeys | null>(null)
	/** Unsent reply/deny drafts, by item: survive stepping and closing (memory only). */
	const drafts = useRef<DockDrafts>(new Map()).current
	/**
	 * What was last sent for an item, kept from submit until the item leaves (memory only): the pane
	 * shows the sent picks under the receipt, and a refusal or failure restores them for a retry.
	 */
	const sent = useRef(new Map<number, DockAction>(initialSent ?? [])).current
	/** The Agents pane's row that holds its tab stop: the last one focused or opened. */
	const [agentCurrent, setAgentCurrent] = useState<string | null>(
		initialOpen?.type === 'agent' ? initialOpen.key : null,
	)
	/** The Agents pane's grouping: the stored setting, switched in its header (stored through onAgentsLayout). */
	const [layout, setLayout] = useState<AgentsLayout>(agentsLayout)
	useLayoutEffect(() => setLayout(agentsLayout), [agentsLayout])
	const chooseLayout = (next: AgentsLayout) => {
		setLayout(next)
		onAgentsLayout?.(next)
	}
	/** Opened from the Agents pane (an agent's detail or its item): Esc goes back to that row. */
	const returnTo = useRef<string | null>(initialOpen?.type === 'agent' ? initialOpen.key : null)
	/** Agent-detail replies awaiting main's answer, and words main could not record, by session key. */
	const [prompting, setPrompting] = useState<ReadonlySet<string>>(new Set())
	const [promptErrors, setPromptErrors] = useState<ReadonlyMap<string, { text: string; uuid?: string }>>(new Map())
	/** Re-render clock for answered entries that linger with their receipt. */
	const [lingerNow, setLingerNow] = useState(0)
	const clock = Math.max(now, lingerNow)

	const announcement = useArrivalAnnouncement(snapshot)
	// While a pane is open every entry keeps its slot — even one whose receipt stopped lingering or
	// that was answered in the terminal — so the pane never closes (and the PTY never refits) by itself.
	const needs = keepOrder(target ? order.current : null, queueItems(snapshot, clock), snapshot?.items ?? [])
	order.current = target ? needs.map(item => item.id) : null
	/** The entries as last rendered, for an answer that comes back later. */
	const needsRef = useRef(needs)
	needsRef.current = needs
	const openKey = targetKey(target)
	const openIndex = target?.type === 'item' ? needs.findIndex(item => item.id === target.id) : -1
	const liveItem = openIndex >= 0 ? needs[openIndex] : undefined
	// An open item that just left (a local ack, or the snapshot dropped it) is still shown for the one
	// commit before the layout effect below replaces or closes it, so the pane never unmounts in
	// between: moving on is a step (same height, no terminal refit), never a close and reopen.
	const shownItem = useRef<DockItem | undefined>(undefined)
	const openItem =
		liveItem ?? (target?.type === 'item' && shownItem.current?.id === target.id ? shownItem.current : undefined)
	shownItem.current = openItem
	// The Agents pane's order (its layout's groups, flattened): ‹ › in an agent's detail follow it.
	const overview = agentOverview(snapshot, clock, layout)
	const agentOrder = overview.flatMap(group => group.rows)
	const agentIndex = target?.type === 'agent' ? agentOrder.findIndex(row => row.key === target.key) : -1
	const agentRow: AgentRow | undefined = agentOrder[agentIndex]
	const agentSession = agentRow ? findSession(snapshot, agentRow.key) : undefined
	const paneOpen =
		target?.type === 'agents' || (agentRow !== undefined && agentSession !== undefined) || openItem !== undefined
	const paneShown = paneOpen && paneHeight !== null
	const room = paneOpen ? (paneRoom?.()?.room ?? null) : null
	// A window that shrinks below the pane clamps it; grown back, the pane returns to its height.
	const height =
		paneHeight === null ? undefined : Math.max(PANE_FLOOR, Math.min(paneHeight, room ?? Number.POSITIVE_INFINITY))
	/** Lets the shown content raise the pane's height once, up to the layout's max now (see growable). */
	const armGrowth = (rearm: boolean) => {
		growable.current = true
		growMax.current = paneRoom?.()?.max
		if (rearm) setSettle(count => count + 1)
	}
	/** Grows the pane to its content once, while growable; never shrinks it. */
	const growToContent = () => {
		const pane = paneRef.current
		const current = paneHeightRef.current
		if (!growable.current || !pane || current === null) return
		// Within the max it was armed with and the max now (a shrunk window).
		const caps = [growMax.current, paneRoom?.()?.max].filter(cap => cap !== undefined)
		const next = paneFitHeight(naturalHeight(pane), caps.length > 0 ? Math.min(...caps) : undefined)
		if (next <= current + 1) return
		growable.current = false
		setPaneHeight(next)
	}

	const close = useCallback((refocus: boolean) => {
		const shown = targetRef.current
		// An agent's detail stands under the Agents entry.
		const key = shown?.type === 'agent' ? 'agents' : targetKey(shown)
		returnTo.current = null
		focusOnOpen.current = false
		keepFocus.current = false
		growable.current = false
		setTarget(null)
		setPaneHeight(null)
		// An item past the queue's "+N more" cell has no entry of its own: that cell stands in for it.
		if (refocus && key) queueMicrotask(() => (anchors.current.get(key) ?? anchors.current.get('more'))?.focus())
	}, [])

	useEffect(() => {
		if (!handle) return
		handle.current = { closePane: () => close(false) }
		return () => {
			handle.current = null
		}
	}, [handle, close])

	const focusInPane = () => {
		const pane = paneRef.current
		return !!pane && pane.contains(pane.ownerDocument.activeElement)
	}
	/** Keyboard focus is in the dock (row or pane). */
	const focusInDock = () => {
		const host = hostRef.current
		return !!host && host.contains(host.ownerDocument.activeElement)
	}
	/** Focus is still where an act left it (the dock, or dropped to <body>): Jakub has not moved on elsewhere. */
	const keysStayed = () => {
		const host = hostRef.current
		if (!host) return false
		const active = host.ownerDocument.activeElement
		return !active || active === host.ownerDocument.body || host.contains(active)
	}

	/**
	 * Shows another target in the pane (when open, at the same height unless `grow`); `focus` takes the keys
	 * like a keyboard open; `onChoices` keeps keys that were on a choice on the new body's choices.
	 * `grow`: the shown content was replaced, not stepped from (a move-on, an agent or item opened from
	 * the Agents list), so the pane may grow to the new content once (see growable).
	 */
	const show = (next: AgentDockTarget, focus: boolean, onChoices = false, grow = false) => {
		focusOnOpen.current = focus
		keepFocus.current = focusInPane()
		keepOnChoices.current = onChoices
		advanceFrom.current = null
		growable.current = false
		if (grow) armGrowth(true)
		setTarget(next)
	}

	/** Keyboard home in the pane: the Agents pane's current row, else the pane itself. */
	const focusPaneHome = () => {
		const pane = paneRef.current
		const row =
			targetRef.current?.type === 'agents' ? pane?.querySelector<HTMLElement>('.agent-dock-agent[tabindex="0"]') : null
		;(row ?? pane)?.focus()
	}

	const open = (next: AgentDockTarget, viaKeyboard: boolean) => {
		returnTo.current = null
		if (targetKey(next) === openKey) {
			// Enter/Space on the open entry goes to its pane (confirming never deselects); a click closes it.
			if (viaKeyboard) focusPaneHome()
			else close(false)
			return
		}
		// Another entry while the pane is open swaps its content at the same height (no refit).
		show(next, viaKeyboard)
	}

	const step = (delta: number, onChoices = false) => {
		const next = needs[openIndex + delta]
		if (openIndex < 0 || !next) return
		show({ type: 'item', id: next.id }, false, onChoices)
	}

	/** From the Agents pane: the agent's live item (its most urgent), else its detail. */
	const openAgent = (row: AgentRow, viaKeyboard: boolean) => {
		setAgentCurrent(row.key)
		returnTo.current = row.key
		show(
			row.itemId !== undefined ? { type: 'item', id: row.itemId } : { type: 'agent', key: row.key },
			viaKeyboard,
			false,
			true,
		)
	}

	/** ‹ › in an agent's detail: the previous / next agent in the Agents pane's order. */
	const stepAgent = (delta: number) => {
		const next = agentOrder[agentIndex + delta]
		if (agentIndex < 0 || !next) return
		setAgentCurrent(next.key)
		returnTo.current = next.key
		show({ type: 'agent', key: next.key }, false)
	}

	/** Esc from an agent's detail (or an item opened from the Agents pane): back to the list, on that agent's row. */
	const backToAgents = () => {
		const key = returnTo.current
		returnTo.current = null
		if (key) setAgentCurrent(key)
		show({ type: 'agents' }, focusInPane())
	}

	/** The pane's Esc: back to the Agents pane when it came from there, else close back to the entry. */
	const leavePane = () => {
		if (targetRef.current?.type === 'agent' || returnTo.current !== null) backToAgents()
		else close(true)
	}

	/**
	 * Jakub acked or answered `handled` from the dock: open the next item that still waits on him,
	 * keys in its pane (a step: the pane keeps its height); when nothing waits, the keys go back to
	 * the terminal first and the pane closes (one refit). `at` is where `handled` sits (or sat) in `items`.
	 */
	const moveOn = (items: readonly DockItem[], handled: number, at: number) => {
		const next = nextWaiting(items, handled, at)
		if (next) {
			show({ type: 'item', id: next.id }, true, false, true)
			return
		}
		focusTerminal?.()
		close(false)
	}

	// An entry that just got its answer lingers RECEIPT_LINGER_MS with "✓ answered"; re-render when it should go.
	useEffect(() => {
		const expiry = nextLingerExpiry(snapshot, clock)
		if (expiry === null) return
		const timer = setTimeout(() => setLingerNow(Date.now()), Math.max(50, expiry - clock + 20))
		return () => clearTimeout(timer)
	}, [snapshot, clock])

	// A sent answer is remembered until its item leaves the snapshot.
	useEffect(() => {
		if (!snapshot || sent.size === 0) return
		const ids = new Set(snapshot.items.map(item => item.id))
		for (const id of sent.keys()) if (!ids.has(id)) sent.delete(id)
	}, [snapshot, sent])

	// The open item went away (a local ack, or the snapshot no longer has it): after an ack from the dock
	// move on to the next waiting item (or close back to the terminal); after a pointer ack show the next
	// entry; otherwise close.
	// Before paint, so the left item never shows a frame.
	// biome-ignore lint/correctness/useExhaustiveDependencies: moveOn and keysStayed read refs only
	useLayoutEffect(() => {
		if (target?.type !== 'item' || liveItem) return
		const from = advanceFrom.current
		const handled = movingOn.current
		advanceFrom.current = null
		movingOn.current = null
		if (handled === target.id && from !== null && keysStayed()) {
			moveOn(needs, handled, from)
			return
		}
		const next = from === null ? undefined : (needs[Math.min(from, needs.length - 1)] ?? undefined)
		if (next) {
			// The shown item left: the next one replaces it, and the pane may grow to it.
			armGrowth(true)
			setTarget({ type: 'item', id: next.id })
		} else close(false)
	}, [target, liveItem, needs, close])

	// The pane's height is decided before the first paint: the opened content's natural height within
	// [PANE_MIN_HEIGHT, the layout's max]. Content that replaces it without a step (a move-on after an
	// ack or answer, an agent or item opened from the Agents list) may grow it once here, before paint;
	// content that arrives later (an agent's full message) once below. It never shrinks while open, and
	// ‹ › stepping keeps it (the body scrolls), so ‹ › never move and the terminal refits once on open,
	// at most once per growth, and once on close.
	useLayoutEffect(() => {
		const pane = paneRef.current
		if (!paneOpen || !pane) return
		if (paneHeight !== null) {
			growToContent()
			return
		}
		armGrowth(false)
		setPaneHeight(paneFitHeight(naturalHeight(pane), growMax.current))
	})

	// While growable, content that arrives in the pane after its commit (a body's own state, e.g. the
	// agent detail's live message) grows the pane to it; the chance ends after PANE_SETTLE_MS.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-armed per open or move-on (settle)
	useEffect(() => {
		const pane = paneRef.current
		const view = pane?.ownerDocument.defaultView
		if (!paneShown || !pane || !view || !growable.current) return
		const watch = new view.MutationObserver(growToContent)
		watch.observe(pane, { childList: true, subtree: true, characterData: true })
		const settled = () => {
			growable.current = false
		}
		const timer = view.setTimeout(settled, PANE_SETTLE_MS)
		// Jakub typing anywhere (a pointer-opened pane leaves the keys in the terminal) or scrolling the
		// body ends the chance: a growth then would resize the PTY under his keys or move what he reads.
		// Capture, so it runs before a key that moves on (⌘⌫, an answer) re-arms it.
		view.addEventListener('keydown', settled, true)
		pane.addEventListener('wheel', settled, { passive: true })
		return () => {
			watch.disconnect()
			view.clearTimeout(timer)
			view.removeEventListener('keydown', settled, true)
			pane.removeEventListener('wheel', settled)
		}
	}, [paneShown, settle])

	// Keyboard-opened panes take focus (the Agents pane: its current row); pointer use never does (the
	// layout keeps xterm focused).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run per opened target, not only per height
	useEffect(() => {
		if (!paneShown || !focusOnOpen.current) return
		focusOnOpen.current = false
		focusPaneHome()
	}, [paneShown, openKey])

	// An agent's detail whose agent left the snapshot goes back to the list.
	useLayoutEffect(() => {
		if (target?.type === 'agent' && !agentRow) setTarget({ type: 'agents' })
	}, [target, agentRow])

	// A step or ack swapped the content under a focused control (or disabled it at an end): keep focus in the
	// pane — on the new body's choices when the step came from a choice and it has live ones.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the shown item changes
	useLayoutEffect(() => {
		const onChoices = keepOnChoices.current
		keepOnChoices.current = false
		if (!keepFocus.current) return
		const pane = paneRef.current
		if (!pane) return
		keepFocus.current = false
		const stop = onChoices ? choiceStop(pane) : null
		if (stop) {
			stop.focus()
			return
		}
		const active = pane.ownerDocument.activeElement
		if (!active || !pane.contains(active) || (active as HTMLButtonElement).disabled) pane.focus()
	}, [openKey, paneOpen])

	// biome-ignore lint/correctness/useExhaustiveDependencies: report open, growth and close only
	useEffect(() => {
		onPaneChange?.(paneShown)
	}, [paneShown, paneHeight])

	// A pointer press outside the pane and the entries closes it (terminal clicks included).
	useEffect(() => {
		if (!paneOpen) return
		const doc = hostRef.current?.ownerDocument
		if (!doc) return
		const onPointer = (event: PointerEvent) => {
			const node = event.target as Node
			if (paneRef.current?.contains(node)) return
			for (const anchor of anchors.current.values()) if (anchor.contains(node)) return
			close(false)
		}
		doc.addEventListener('pointerdown', onPointer, true)
		return () => doc.removeEventListener('pointerdown', onPointer, true)
	}, [paneOpen, close])

	const ack = (itemId: number) => {
		advanceFrom.current = needs.findIndex(item => item.id === itemId)
		// Acked with the keys in the dock: once the item leaves, the pane moves on (see moveOn).
		movingOn.current = focusInDock() ? itemId : null
		keepFocus.current = focusInPane()
		setPending(prev => new Set(prev).add(itemId))
		void onAck(itemId)
			.catch(() => false)
			.then(acked => {
				if (!acked) {
					advanceFrom.current = null
					movingOn.current = null
					keepFocus.current = false
				}
				setPending(prev => {
					const next = new Set(prev)
					next.delete(itemId)
					return next
				})
				setRefused(prev => {
					const next = new Set(prev)
					if (acked) next.delete(itemId)
					else next.add(itemId)
					return next
				})
			})
	}

	const act = (item: DockItem, action: DockAction) => {
		if (!onAct || submitting.has(item.id)) return
		const done = (patch: (next: Map<number, string>) => void) =>
			setActErrors(prev => {
				const next = new Map(prev)
				patch(next)
				return next
			})
		done(next => next.delete(item.id))
		sent.set(item.id, action)
		const fromDock = focusInDock()
		// Sending disables the control that sent (choice, field, button); focus left on it would drop to
		// <body>, out of the pane's keys. The pane itself keeps Esc and a retry's ⌘Enter.
		const pane = paneRef.current
		const focused = pane?.ownerDocument.activeElement
		if (pane && focused && focused !== pane && pane.contains(focused)) pane.focus({ preventScroll: true })
		setSubmitting(prev => new Set(prev).add(item.id))
		void onAct(item.id, action)
			.catch(failedActResult)
			.then(result => {
				// Answered: its drafts (picks, Other text, deny message, reply) have done their job.
				if (result.ok) for (const key of draftKeys(item.id)) drafts.delete(key)
				setSubmitting(prev => {
					const next = new Set(prev)
					next.delete(item.id)
					return next
				})
				// Refusals/failures main recorded on the item show from the snapshot; keep the words for the rest.
				const error = actErrorText(result.outcome)
				if (error !== null) done(next => next.set(item.id, error))
				// A refusal or failure keeps the pane on the item for another try. An answer sent with the keys
				// in the dock, pane still on it, moves on to the next waiting item (or back to the terminal);
				// any other success hands the keys back to the terminal, unless Jakub already moved on elsewhere
				// (another app or terminal, or another item in the pane while this one was sending).
				if (!result.ok || !keysStayed()) return
				const shown = targetRef.current
				if (fromDock && shown?.type === 'item' && shown.id === item.id) {
					const items = needsRef.current
					moveOn(
						items,
						item.id,
						items.findIndex(entry => entry.id === item.id),
					)
				} else if (!focusInPane()) focusTerminal?.()
			})
	}

	/** A reply from an agent's detail; resolves with main's result (the field clears itself on success). */
	const prompt = (key: string, request: Omit<AgentDockPromptRequest, 'session'>): Promise<AgentDockActResult> => {
		if (!onPrompt || prompting.has(key))
			return Promise.resolve({ ok: false, outcome: { status: 'refused', reason: 'in_flight', detail: '' } })
		const edit = (patch: (next: Map<string, { text: string; uuid?: string }>) => void) =>
			setPromptErrors(prev => {
				const next = new Map(prev)
				patch(next)
				return next
			})
		edit(next => next.delete(key))
		// Sending disables the field: keep the keys in the pane, not on <body>.
		const pane = paneRef.current
		const focused = pane?.ownerDocument.activeElement
		if (pane && focused && focused !== pane && pane.contains(focused)) pane.focus({ preventScroll: true })
		setPrompting(prev => new Set(prev).add(key))
		return onPrompt({ session: key, ...request })
			.catch(failedActResult)
			.then(result => {
				if (result.ok) drafts.delete(agentDraftKey(key))
				setPrompting(prev => {
					const next = new Set(prev)
					next.delete(key)
					return next
				})
				const error = actErrorText(result.outcome)
				// Tied to the message it answered: once the agent says something new it no longer applies.
				if (error !== null)
					edit(next =>
						next.set(key, { text: error, ...(request.assistantUuid ? { uuid: request.assistantUuid } : {}) }),
					)
				return result
			})
	}

	const register = (key: string) => (node: HTMLButtonElement | null) => {
		if (node) anchors.current.set(key, node)
		else anchors.current.delete(key)
	}

	// Roving ←/→ (Home/End) across entries and the Agents entry; Esc closes an open pane first.
	const onRowKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape' && paneOpen) {
			event.preventDefault()
			close(false)
			return
		}
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
		const stops = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-row-stop]')]
		const index = stops.indexOf(event.target as HTMLButtonElement)
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? stops.length - 1
					: Math.max(0, Math.min(stops.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))
		event.preventDefault()
		stops[next]?.focus()
	}

	// Inside the pane: ← → step between items (from the pane itself, ‹ ›, the body region or a
	// choice; the question tabs keep their own); ↑ ↓ on the pane itself go to the answers — into
	// the body's live choices at their stop. Without live choices (a turn, an agent, a receipt) a body
	// that overflows takes ↑ ↓ as a line scroll from the pane, its body, ‹ ›, the footer keys and an
	// empty Reply; one that fits lets them step items (‹ › step with all four). Page keys, Space and
	// Home / End scroll the body from anywhere but a field with text (see bodyScrollKey); the choices
	// rove with ↑ ↓. Esc closes back to the entry.
	const onPaneKey = (event: KeyboardEvent<HTMLElement>) => {
		// Jakub is reading or typing: the pane keeps its height from here (a reply growing never resizes it).
		growable.current = false
		// ⌘⌫ acks where Ack is offered, from anywhere in the pane; a field with text in it keeps the key
		// for editing (delete to line start). A held key acks nothing.
		if (isAckKey(event, mod) && !keepsEditKey(event.target)) {
			if (!openItem || !canAck(openItem)) return
			event.preventDefault()
			if (!event.repeat && !pending.has(openItem.id)) ack(openItem.id)
			return
		}
		// The shown body: 1–9 pick options, ⌘Enter / Enter submit (never while typing in a field).
		if (detailKeys.current?.(event)) {
			event.preventDefault()
			return
		}
		if (event.key === 'Escape') {
			event.preventDefault()
			leavePane()
			return
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return
		const pane = event.currentTarget
		const scroller = pane.querySelector<HTMLElement>('.agent-dock-pane-scroll')
		const from = event.target as Element
		const onPane = from === pane
		const reading = target?.type === 'item' || target?.type === 'agent'
		// The Agents list roves its own rows: only the pane itself pages it.
		const how = !scroller
			? null
			: reading
				? bodyScrollKey(event, { scrolls: overflows(scroller), choices: choiceStop(pane) !== null })
				: onPane
					? bodyScrollKey(event, { scrolls: false, choices: true })
					: null
		if (scroller && how) {
			event.preventDefault()
			scrollBody(scroller, how)
			return
		}
		if (!reading) return
		const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
		const vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
		const stop = onPane && vertical ? choiceStop(pane) : null
		if (stop) {
			event.preventDefault()
			stop.focus()
			return
		}
		const onStepper = from.closest('.agent-dock-stepper') !== null
		const onChoice = from.closest('.agent-dock-choice') !== null
		const delta = onPane || onStepper ? horizontal || vertical : from === scroller || onChoice ? horizontal : 0
		if (!delta) return
		event.preventDefault()
		if (target.type === 'agent') stepAgent(delta)
		else step(delta, onChoice)
	}

	// The row's name says what it is and the state in words.
	const dockName = dockLabel(snapshot, clock)
	const shortcut = dockShortcut(mod)

	const row = (
		<section
			className="agent-dock-row"
			aria-label={dockName}
			aria-keyshortcuts={shortcut.aria}
			tabIndex={-1}
			onKeyDown={onRowKey}
		>
			<Queue
				snapshot={snapshot}
				now={clock}
				needs={needs}
				openKey={paneOpen ? (target?.type === 'agent' ? 'agents' : openKey) : null}
				paneId={paneId}
				register={register}
				onOpen={open}
			/>
			{/* The row ends in the key that goes to the dock. Each source's health is in the Agents pane
			    header; an outage stays in the row as its lead note (down, connecting) and its name. */}
			<span className="agent-dock-row-end">
				<kbd className="agent-dock-kbd" title={`Go to the agent dock (${shortcut.label})`}>
					{shortcut.label}
				</kbd>
			</span>
		</section>
	)

	const pane = paneOpen ? (
		<section
			ref={paneRef}
			id={paneId}
			className="agent-dock-pane"
			data-position={position}
			tabIndex={-1}
			aria-label={
				openItem && snapshot
					? paneLabel(openItem, snapshot)
					: agentRow
						? `Agent, ${agentRow.name}${agentRow.repo ? `, ${agentRow.repo}` : ''}`
						: 'Agents'
			}
			style={height === undefined ? undefined : { height }}
			onKeyDown={onPaneKey}
		>
			{/* Not keyed per item: the rule and ‹ › stay mounted (and focused) while stepping. */}
			{openItem && snapshot ? (
				<ItemDetail
					item={openItem}
					session={findSession(snapshot, openItem.session)}
					who={agentWho(snapshot, openItem.session)}
					now={clock}
					index={Math.max(0, openIndex)}
					total={needs.length}
					pending={pending.has(openItem.id)}
					refused={refused.has(openItem.id)}
					canAct={onAct !== undefined && canAnswer(openItem, snapshot)}
					blockedNote={!onAct ? 'Answer in the terminal' : sourceBlockedNote(openItem, snapshot)}
					submitting={submitting.has(openItem.id)}
					sent={sent.get(openItem.id) ?? null}
					localError={actErrors.get(openItem.id) ?? null}
					keys={detailKeys}
					drafts={drafts}
					mod={mod}
					onStep={step}
					onClose={leavePane}
					onAck={() => ack(openItem.id)}
					onAct={action => act(openItem, action)}
				/>
			) : agentRow && agentSession ? (
				<AgentPanel
					key={agentRow.key}
					snapshot={snapshot}
					session={agentSession}
					row={agentRow}
					now={clock}
					index={agentIndex}
					total={agentOrder.length}
					mod={mod}
					keys={detailKeys}
					drafts={drafts}
					submitting={prompting.has(agentRow.key)}
					localError={promptError(promptErrors.get(agentRow.key), agentSession.lastMessage?.uuid)}
					readMessage={readMessage}
					canPrompt={onPrompt !== undefined}
					onStep={stepAgent}
					onClose={leavePane}
					onOpenItem={itemId => show({ type: 'item', id: itemId }, focusInPane(), false, true)}
					onPrompt={request => prompt(agentRow.key, request)}
				/>
			) : (
				<AgentsDetail
					snapshot={snapshot}
					now={clock}
					layout={layout}
					onLayout={chooseLayout}
					current={agentCurrent}
					keys={detailKeys}
					onCurrent={setAgentCurrent}
					onOpen={openAgent}
					onClose={() => close(true)}
				/>
			)}
		</section>
	) : null

	return (
		<div ref={hostRef} className="agent-dock-host">
			<span className="sr-only" aria-live="polite">
				{announcement}
			</span>
			{position === 'top' ? (
				<>
					{row}
					{pane}
				</>
			) : (
				<>
					{pane}
					{row}
				</>
			)}
		</div>
	)
}

/** The pane's landmark name: what it is and whose (`Question, company-create-save-firm, crm`). */
function paneLabel(item: DockItem, snapshot: AgentDockSnapshot): string {
	const who = agentWho(snapshot, item.session)
	return `${itemKindLabel(item)}, ${who.name}${who.project ? `, ${who.project}` : ''}`
}
