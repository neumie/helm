// Agent dock body (design §3.24): one --chrome surface below (or above) the terminal,
// like the topbar mirrored. Two bands: the 28px queue row — one quiet line per item
// that owes Jakub something (glyph, short name, wait), "+N more" when they do not fit,
// then the Agents entry, the sources' health dot and ⌘⇧J — and, when an entry is opened, a pane
// split off the terminal in-flow: the terminal row shrinks and refits once, nothing
// ever floats over its text. The row is the same with or without a pane. Answering
// happens in the pane (slice 2) and the receipt shows in place; entries keep their
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
import type { AgentDockActResult, AgentDockSnapshot, DockAction, DockItem } from '../../agent-dock/model'
import { ItemDetail } from './AgentDockDetail'
import { type AgentDockTarget, Queue } from './AgentDockQueue'
import { AgentsDetail } from './AgentsDetail'
import { type DetailKeys, type DockModKey, dockShortcut } from './pane-keys'
import { type DockDrafts, draftKeys } from './panel'
import {
	type AgentDockPosition,
	actErrorText,
	agentWho,
	canAnswer,
	dockHealth,
	dockLabel,
	failedActResult,
	findSession,
	itemKindLabel,
	keepOrder,
	nextLingerExpiry,
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
	onAct?(itemId: number, rev: number, action: DockAction): Promise<AgentDockActResult>
	/** Most px the pane may take so the terminal keeps its rows (the layout measures #right); null = no limit known. */
	paneRoom?: () => number | null
	/** After the pane opens or closes: the terminal row changed height once, refit it. */
	onPaneChange?(open: boolean): void
	/** Review fixtures only: the pane to show on first render. */
	initialOpen?: AgentDockTarget | null
	/** Review fixtures only: answers already sent from the dock (the receipt stories), by item id. */
	initialSent?: ReadonlyMap<number, DockAction>
}

/** The pane's height is set once when it opens (its first item's natural height, within these) and kept while it stays open. */
export const PANE_MIN_HEIGHT = 216
export const PANE_MAX_HEIGHT = 480
/** However little room is left, the pane keeps its rule, a few body rows and its footer. */
const PANE_FLOOR = 120

const targetKey = (target: AgentDockTarget | null): string | null =>
	target === null ? null : target.type === 'agents' ? 'agents' : `item:${target.id}`

export function AgentDock({
	snapshot,
	now,
	position,
	mod,
	handle,
	onAck,
	onAct,
	paneRoom,
	onPaneChange,
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
	/** Natural height of the first item the pane showed; null until measured (and while closed). */
	const [paneHeight, setPaneHeight] = useState<number | null>(null)
	/** Entry order while the pane is open: answered entries keep their slot until it closes. */
	const order = useRef<number[] | null>(null)
	const focusOnOpen = useRef(false)
	/** Keyboard focus was inside the pane when a step or ack swapped its content. */
	const keepFocus = useRef(false)
	/** Index to advance to after a local ack removes the open item. */
	const advanceFrom = useRef<number | null>(null)
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
	/** Re-render clock for answered entries that linger with their receipt. */
	const [lingerNow, setLingerNow] = useState(0)
	const clock = Math.max(now, lingerNow)

	const health = dockHealth(snapshot)
	const announcement = useArrivalAnnouncement(snapshot)
	// While a pane is open every entry keeps its slot — even one whose receipt stopped lingering or
	// that was answered in the terminal — so the pane never closes (and the PTY never refits) by itself.
	const needs = keepOrder(target ? order.current : null, queueItems(snapshot, clock), snapshot?.items ?? [])
	order.current = target ? needs.map(item => item.id) : null
	const openKey = targetKey(target)
	const openIndex = target?.type === 'item' ? needs.findIndex(item => item.id === target.id) : -1
	const openItem = openIndex >= 0 ? needs[openIndex] : undefined
	const paneOpen = target?.type === 'agents' || openItem !== undefined
	const paneShown = paneOpen && paneHeight !== null
	const room = paneOpen ? (paneRoom?.() ?? null) : null
	const height =
		paneHeight === null ? undefined : Math.max(PANE_FLOOR, Math.min(paneHeight, room ?? Number.POSITIVE_INFINITY))

	const close = useCallback((refocus: boolean) => {
		const key = targetKey(targetRef.current)
		focusOnOpen.current = false
		keepFocus.current = false
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

	const open = (next: AgentDockTarget, viaKeyboard: boolean) => {
		const key = targetKey(next)
		if (key === openKey) {
			// Enter/Space on the open entry goes to its pane (confirming never deselects); a click closes it.
			if (viaKeyboard) paneRef.current?.focus()
			else close(false)
			return
		}
		focusOnOpen.current = viaKeyboard
		keepFocus.current = paneOpen && focusInPane()
		advanceFrom.current = null
		// Another entry while the pane is open swaps its content at the same height (no refit).
		setTarget(next)
	}

	const step = (delta: number) => {
		const next = needs[openIndex + delta]
		if (openIndex < 0 || !next) return
		advanceFrom.current = null
		keepFocus.current = focusInPane()
		setTarget({ type: 'item', id: next.id })
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

	// The open item went away (a local ack, or the snapshot no longer has it): after an ack show the next one, otherwise close.
	useEffect(() => {
		if (target?.type !== 'item' || openItem) return
		const from = advanceFrom.current
		advanceFrom.current = null
		const next = from === null ? undefined : (needs[Math.min(from, needs.length - 1)] ?? undefined)
		if (next) setTarget({ type: 'item', id: next.id })
		else close(false)
	}, [target, openItem, needs, close])

	// The pane's height is decided once, before the first paint: the opened item's natural
	// height within [PANE_MIN_HEIGHT, PANE_MAX_HEIGHT]. Stepping and answering keep it (the body
	// scrolls), so the terminal refits once on open and once on close and ‹ › never move.
	useLayoutEffect(() => {
		if (!paneOpen || paneHeight !== null) return
		const natural = paneRef.current?.offsetHeight ?? 0
		setPaneHeight(Math.min(PANE_MAX_HEIGHT, Math.max(PANE_MIN_HEIGHT, Math.ceil(natural))))
	})

	// Keyboard-opened panes take focus; pointer use never does (the layout keeps xterm focused).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run per opened target, not only per height
	useEffect(() => {
		if (!paneShown || !focusOnOpen.current) return
		focusOnOpen.current = false
		paneRef.current?.focus()
	}, [paneShown, openKey])

	// A step or ack swapped the content under a focused control (or disabled it at an end): keep focus in the pane.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the shown item changes
	useLayoutEffect(() => {
		if (!keepFocus.current) return
		const pane = paneRef.current
		if (!pane) return
		keepFocus.current = false
		const active = pane.ownerDocument.activeElement
		if (!active || !pane.contains(active) || (active as HTMLButtonElement).disabled) pane.focus()
	}, [openKey, paneOpen])

	// biome-ignore lint/correctness/useExhaustiveDependencies: report open/close edges only
	useEffect(() => {
		onPaneChange?.(paneShown)
	}, [paneShown])

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
		keepFocus.current = focusInPane()
		setPending(prev => new Set(prev).add(itemId))
		void onAck(itemId)
			.catch(() => false)
			.then(acked => {
				if (!acked) {
					advanceFrom.current = null
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
		// Sending disables the control that sent (choice, field, button); focus left on it would drop to
		// <body>, out of the pane's keys. The pane itself keeps Esc and a retry's ⌘Enter.
		const pane = paneRef.current
		const focused = pane?.ownerDocument.activeElement
		if (pane && focused && focused !== pane && pane.contains(focused)) pane.focus({ preventScroll: true })
		setSubmitting(prev => new Set(prev).add(item.id))
		void onAct(item.id, item.rev, action)
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

	// Inside the pane: ← → / ↑ ↓ step between items (from the pane itself or ‹ ›; the body
	// region keeps ↑ ↓ for scrolling, tabs and options keep their own arrows); paging keys
	// scroll the body; Esc closes back to the entry (after cancelling a confirmation).
	const onPaneKey = (event: KeyboardEvent<HTMLElement>) => {
		// The shown body first: 1–9 pick options, ⌘Enter / Enter submit (never while typing in a field),
		// Esc cancels a risky-word confirmation before it would close the pane.
		if (detailKeys.current?.(event)) {
			event.preventDefault()
			return
		}
		if (event.key === 'Escape') {
			event.preventDefault()
			close(true)
			return
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return
		const pane = event.currentTarget
		const scroller = pane.querySelector<HTMLElement>('.agent-dock-pane-scroll')
		const from = event.target as Element
		const onPane = from === pane
		if (onPane && scroller && ['PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
			event.preventDefault()
			const page = Math.max(16, scroller.clientHeight - 32)
			if (event.key === 'Home') scroller.scrollTop = 0
			else if (event.key === 'End') scroller.scrollTop = scroller.scrollHeight
			else scroller.scrollTop += event.key === 'PageUp' || (event.key === ' ' && event.shiftKey) ? -page : page
			return
		}
		if (target?.type !== 'item') return
		const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
		const vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
		const onStepper = from.closest('.agent-dock-stepper') !== null
		const delta = onPane || onStepper ? horizontal || vertical : from === scroller ? horizontal : 0
		if (!delta) return
		event.preventDefault()
		step(delta)
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
				openKey={paneOpen ? openKey : null}
				paneId={paneId}
				register={register}
				onOpen={open}
			/>
			{/* The row ends in the sources' health and the key that goes to the dock. Healthy is a dot (its
			    tooltip names the sources: "Okena", "Okena · Helm terminals"); connecting and down say so in words. */}
			<span className="agent-dock-row-end">
				<span className="agent-dock-health" data-tone={health.tone} title={health.text}>
					<span className="agent-dock-dot" aria-hidden="true" />
					{health.tone === 'success' ? null : <span className="agent-dock-health-text">{health.text}</span>}
				</span>
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
			aria-label={openItem && snapshot ? paneLabel(openItem, snapshot) : 'Agents'}
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
					index={openIndex}
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
					onClose={() => close(true)}
					onAck={() => ack(openItem.id)}
					onAct={action => act(openItem, action)}
				/>
			) : (
				<AgentsDetail snapshot={snapshot} now={clock} onClose={() => close(true)} />
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
