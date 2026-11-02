// Agent dock body (design §3.24), drawn in the terminal's own language: the fixed
// 28px strip (a status line), the queue it toggles (one entry per item that owes
// Jakub something, never paged out of sight, plus the Agents entry) and, when an
// entry is opened, a pane split off the terminal in-flow — the terminal row
// shrinks and refits once, nothing ever floats over its text. The open entry and
// the pane are one shape: the pane's edge opens over that entry like a tab joined
// to its page. Answering happens in the pane (slice 2) and the receipt shows in
// place; entries keep their slots while the pane is open. Layout, persistence,
// focus return and ⌘⇧J belong to agent-dock-layout.ts. Agent text is untrusted and
// always rendered as plain React text (never markup), bounded and control-stripped.

import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import type { AgentDockActResult, AgentDockSnapshot, DockAction, DockItem, DockSession } from '../../agent-dock/model'
import { AgentsDetail, type DetailKeys, type DockDrafts, ItemDetail, draftKeys } from './AgentDockDetail'
import {
	type AgentDockPosition,
	QUEUE_ENTRY_MIN,
	QUEUE_FIRST_EXTRA,
	type QueueAgentsSlot,
	type QueueDensity,
	canAnswer,
	cardGist,
	cardKindLabel,
	cardTone,
	dockSummary,
	entryMetaChars,
	entryNameWidth,
	findSession,
	formatAge,
	formatClock,
	itemAgeTone,
	itemWaitingSince,
	keepOrder,
	kindGlyph,
	needsYouItems,
	nextLingerExpiry,
	orderedSessions,
	plainAgentText,
	queueLayout,
	railItems,
	receiptView,
	sessionSince,
	sessionStatusText,
	sessionWhere,
	statusGlyph,
	unknownAgentsText,
	unknownSessionCount,
} from './presentation'

export type AgentDockTarget = { type: 'item'; id: number } | { type: 'agents' }

export interface AgentDockProps {
	snapshot: AgentDockSnapshot | null
	now: number
	/** Queue open (user toggle only: new items never open it or resize the terminal). */
	expanded: boolean
	position: AgentDockPosition
	shortcutLabel: string
	onToggle(): void
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
/** New asks arriving within this window are announced together ("3 new requests"). */
const ANNOUNCE_COALESCE_MS = 2_000

const targetKey = (target: AgentDockTarget | null): string | null =>
	target === null ? null : target.type === 'agents' ? 'agents' : `item:${target.id}`

export function AgentDock({
	snapshot,
	now,
	expanded,
	position,
	shortcutLabel,
	onToggle,
	onAck,
	onAct,
	paneRoom,
	onPaneChange,
	initialOpen = null,
	initialSent,
}: AgentDockProps) {
	const railId = useId()
	const paneId = useId()
	const headId = useId()
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

	const summary = dockSummary(snapshot, clock)
	const announcement = useArrivalAnnouncement(snapshot)
	// While a pane is open every entry keeps its slot — even one whose receipt stopped lingering or
	// that was answered in the terminal — so the pane never closes (and the PTY never refits) by itself.
	const needs = keepOrder(
		target ? order.current : null,
		expanded ? railItems(snapshot, clock) : [],
		snapshot?.items ?? [],
	)
	order.current = target ? needs.map(item => item.id) : null
	const openKey = targetKey(target)
	const openIndex = target?.type === 'item' ? needs.findIndex(item => item.id === target.id) : -1
	const openItem = openIndex >= 0 ? needs[openIndex] : undefined
	const paneOpen = expanded && (target?.type === 'agents' || openItem !== undefined)
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
		if (refocus && key) queueMicrotask(() => anchors.current.get(key)?.focus())
	}, [])

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
		if (!expanded) {
			if (target) close(false)
			return
		}
		if (target?.type !== 'item' || openItem) return
		const from = advanceFrom.current
		advanceFrom.current = null
		const next = from === null ? undefined : (needs[Math.min(from, needs.length - 1)] ?? undefined)
		if (next) setTarget({ type: 'item', id: next.id })
		else close(false)
	}, [expanded, target, openItem, needs, close])

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
			.catch(
				(error: unknown): AgentDockActResult => ({
					ok: false,
					outcome: { status: 'failed', detail: error instanceof Error ? error.message : String(error) },
				}),
			)
			.then(result => {
				// Answered: its drafts (picks, Other text, deny message, reply) have done their job.
				if (result.ok) for (const key of draftKeys(item.id)) drafts.delete(key)
				setSubmitting(prev => {
					const next = new Set(prev)
					next.delete(item.id)
					return next
				})
				const outcome = result.outcome
				// Refusals/failures main recorded on the item show from the snapshot; keep the words for the rest.
				if (outcome.status === 'refused' || outcome.status === 'failed')
					done(next =>
						next.set(
							item.id,
							outcome.status === 'refused' && outcome.reason === 'gone'
								? 'refused: already answered elsewhere'
								: outcome.status === 'refused'
									? `refused: ${plainAgentText(outcome.detail, 200)}`
									: plainAgentText(outcome.detail, 300),
						),
					)
			})
	}

	const register = (key: string) => (node: HTMLButtonElement | null) => {
		if (node) anchors.current.set(key, node)
		else anchors.current.delete(key)
	}

	// Roving ←/→ (Home/End) across entries and the Agents entry; Esc closes an open pane first.
	const onRailKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape' && paneOpen) {
			event.preventDefault()
			close(false)
			return
		}
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
		const stops = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-rail-stop]')]
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

	const toggleLabel = `${expanded ? 'Collapse' : 'Expand'} agent dock (${shortcutLabel})`
	// The strip's name says what it is and the state in words; the newest head is its description.
	const toggleName = `Agent dock, ${summary.needsText}${summary.oldestText ? `, ${summary.oldestText}` : ''}, ${summary.health.text}`
	const keyShortcut = shortcutLabel.startsWith('⌘') ? 'Meta+Shift+J' : 'Control+Shift+J'
	// The glyph points where the queue opens: away from the terminal.
	const chevron = (position === 'bottom') === expanded ? '▾' : '▴'
	const strip = (
		<div className="agent-dock-strip">
			<button
				type="button"
				className="agent-dock-toggle"
				aria-expanded={expanded}
				aria-controls={railId}
				aria-label={toggleName}
				aria-describedby={summary.head ? headId : undefined}
				aria-keyshortcuts={keyShortcut}
				title={toggleLabel}
				onClick={onToggle}
			>
				<span className="agent-dock-chevron" aria-hidden="true">
					{chevron}
				</span>
				<span className="agent-dock-needs" data-tone={summary.needsTone}>
					<span className="agent-dock-needs-count">{summary.needsText}</span>
					{summary.oldestText ? (
						<span className="agent-dock-age" data-tone={summary.oldestTone}>
							{summary.oldestText}
						</span>
					) : null}
				</span>
				{/* The newest item in the entries' order: name bright, project dim, then the gist. */}
				<span className="agent-dock-head" id={headId}>
					{summary.head ? (
						<>
							<span className="agent-dock-head-name">{summary.head.name}</span>
							{summary.head.project ? <span className="agent-dock-head-project"> {summary.head.project}</span> : null}
							<span className="agent-dock-head-sep"> · </span>
							{summary.head.gist}
						</>
					) : null}
				</span>
				{summary.counts ? <span className="agent-dock-counts">{summary.counts}</span> : null}
				<span className="agent-dock-health" data-tone={summary.health.tone}>
					<span className="agent-dock-dot" aria-hidden="true" />
					<span className="agent-dock-health-text">{summary.health.text}</span>
				</span>
				<kbd className="agent-dock-kbd">{shortcutLabel}</kbd>
			</button>
		</div>
	)

	const rail = (
		<section
			id={railId}
			className="agent-dock-rail"
			aria-label="Agent dock"
			hidden={!expanded}
			inert={!expanded}
			tabIndex={-1}
			onKeyDown={onRailKey}
		>
			{/* Collapsed (the common case): mount no item content. */}
			{expanded ? (
				<Queue
					position={position}
					snapshot={snapshot}
					now={clock}
					needs={needs}
					openKey={paneOpen ? openKey : null}
					paneId={paneId}
					register={register}
					onOpen={open}
				/>
			) : null}
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
					now={clock}
					index={openIndex}
					total={needs.length}
					pending={pending.has(openItem.id)}
					refused={refused.has(openItem.id)}
					canAct={onAct !== undefined && canAnswer(openItem, snapshot)}
					blockedNote={
						!onAct
							? 'Answer in the terminal'
							: snapshot.source.state !== 'ok'
								? 'Okena unreachable: answer in the terminal'
								: null
					}
					submitting={submitting.has(openItem.id)}
					sent={sent.get(openItem.id) ?? null}
					localError={actErrors.get(openItem.id) ?? null}
					keys={detailKeys}
					drafts={drafts}
					mod={shortcutLabel.startsWith('⌘') ? 'cmd' : 'ctrl'}
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
		<div
			ref={hostRef}
			className="agent-dock-host"
			data-position={position}
			data-pane={String(paneOpen)}
			data-pane-tone={paneOpen ? (openItem ? cardTone(openItem, clock) : 'agents') : undefined}
		>
			<span className="sr-only" aria-live="polite">
				{announcement}
			</span>
			{position === 'top' ? (
				<>
					{strip}
					{rail}
					{pane}
				</>
			) : (
				<>
					{pane}
					{rail}
					{strip}
				</>
			)}
		</div>
	)
}

/** Width of one monospace cell in the queue's font, measured once per mount (and on font changes). */
function useCellWidth(probe: HTMLElement | null): number {
	const [ch, setCh] = useState(0)
	useLayoutEffect(() => {
		if (!probe) return
		const measure = () => setCh(probe.getBoundingClientRect().width / 10)
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(probe)
		return () => observer.disconnect()
	}, [probe])
	return ch
}

function Queue({
	position,
	snapshot,
	now,
	needs,
	openKey,
	paneId,
	register,
	onOpen,
}: {
	position: AgentDockPosition
	snapshot: AgentDockSnapshot | null
	now: number
	needs: DockItem[]
	openKey: string | null
	paneId: string
	register(key: string): (node: HTMLButtonElement | null) => void
	onOpen(target: AgentDockTarget, viaKeyboard: boolean): void
}) {
	// The queue body can mount after the first render (Connecting → data): measure it via a callback ref.
	const [main, setMain] = useState<HTMLDivElement | null>(null)
	const [probe, setProbe] = useState<HTMLSpanElement | null>(null)
	const [width, setWidth] = useState(0)
	const ch = useCellWidth(probe)
	useLayoutEffect(() => {
		if (!main) return
		setWidth(main.clientWidth)
		const observer = new ResizeObserver(() => setWidth(main.clientWidth))
		observer.observe(main)
		return () => observer.disconnect()
	}, [main])
	const source = snapshot?.source
	if (!snapshot || source?.state === 'pending')
		return (
			<div className="agent-dock-rail-note">
				<span className="agent-dock-rail-note-title">Connecting to Okena…</span>
				<span>Claude sessions appear once Okena's Claude Remote answers</span>
			</div>
		)
	const unknown = unknownSessionCount(snapshot)
	const wheres = needs.map(item => sessionWhere(findSession(snapshot, item.session), item.session))
	const nameChars = wheres.map(where => [...where.name].length)
	const metaChars = needs.map(entryMetaChars)
	const layout = queueLayout(nameChars, width, ch, metaChars)
	const sessions = orderedSessions(snapshot)
	const agents = (
		<AgentsEntry
			snapshot={snapshot}
			sessions={sessions}
			now={now}
			slot={layout.agents}
			density={layout.density}
			open={openKey === 'agents'}
			paneId={paneId}
			buttonRef={register('agents')}
			onOpen={viaKeyboard => onOpen({ type: 'agents' }, viaKeyboard)}
		/>
	)
	const grid = layout.density !== 'full'
	// Grid forms fill the row next to the pane first (the first, oldest items join it like tabs).
	const rows = Math.ceil((needs.length + 1) / Math.max(1, layout.columns))
	const openAt =
		openKey === 'agents' ? needs.length : openKey ? needs.findIndex(item => `item:${item.id}` === openKey) : -1
	/**
	 * How a cell joins the open pane. In one row only the open entry does; in a grid the open
	 * entry's column joins from the pane down to it, so a far-row entry still reads as the
	 * pane's tab (the cells between are part of the tab but stay dim).
	 */
	const link = (at: number): 'open' | 'open-far' | 'between' | undefined => {
		if (openAt < 0) return undefined
		if (at === openAt) return grid && Math.floor(at / layout.columns) > 0 ? 'open-far' : 'open'
		if (!grid || at % layout.columns !== openAt % layout.columns) return undefined
		return Math.floor(at / layout.columns) < Math.floor(openAt / layout.columns) ? 'between' : undefined
	}
	/** Cells in the first column line their text up with the strip's 16px inset and draw no left tab side. */
	const colFirst = (at: number): '' | undefined => ((grid ? at % layout.columns : at) === 0 ? '' : undefined)
	const cell = (at: number): CSSProperties | undefined =>
		grid
			? {
					gridColumn: (at % layout.columns) + 1,
					gridRow: position === 'top' ? rows - Math.floor(at / layout.columns) : Math.floor(at / layout.columns) + 1,
				}
			: undefined
	return (
		<>
			<span ref={setProbe} className="agent-dock-ch-probe" aria-hidden="true">
				0000000000
			</span>
			{source?.state === 'down' ? (
				// Terminal lines, like the entries beside it (since when is on the strip already).
				<div
					className="agent-dock-rail-note"
					data-tone="warn"
					title={source.detail ? plainAgentText(source.detail, 200) : undefined}
				>
					<span className="agent-dock-rail-note-title">
						<span aria-hidden="true">! </span>Okena unreachable
					</span>
					<span>
						{source.lastObservedAt !== null ? `last data ${formatClock(source.lastObservedAt)}` : 'no data yet'}
					</span>
					<span>nothing resolves until it’s back</span>
				</div>
			) : null}
			<div ref={setMain} className="agent-dock-rail-main">
				<ul
					className="agent-dock-queue"
					aria-label={`Needs you, ${needs.length}`}
					data-density={layout.density}
					style={grid ? ({ '--queue-columns': String(Math.max(1, layout.columns)) } as CSSProperties) : undefined}
				>
					{needs.length === 0 ? (
						<li className="agent-dock-queue-empty">
							{source?.state !== 'ok'
								? 'Okena is unreachable, so open questions cannot be seen'
								: unknown > 0
									? `${unknownAgentsText(unknown)}: Okena did not return readable detail, so their open questions cannot be seen`
									: 'Nothing needs you'}
						</li>
					) : (
						needs.map((item, at) => (
							<li
								key={item.id}
								className="agent-dock-queue-slot"
								data-open={String(openKey === `item:${item.id}`)}
								data-link={link(at)}
								data-col-first={colFirst(at)}
								style={
									grid
										? cell(at)
										: {
												minWidth:
													Math.max(
														entryNameWidth(nameChars[at] ?? 0, ch, metaChars[at] ?? 0),
														QUEUE_ENTRY_MIN[layout.agents === 'side' ? 'side' : 'narrow'],
													) + (at === 0 ? QUEUE_FIRST_EXTRA : 0),
											}
								}
							>
								<Entry
									item={item}
									where={wheres[at] ?? { project: '', name: '' }}
									now={now}
									density={layout.density}
									open={openKey === `item:${item.id}`}
									paneId={paneId}
									buttonRef={register(`item:${item.id}`)}
									onOpen={viaKeyboard => onOpen({ type: 'item', id: item.id }, viaKeyboard)}
								/>
							</li>
						))
					)}
					{grid ? (
						<li
							className="agent-dock-queue-slot agent-dock-queue-agents"
							data-open={String(openKey === 'agents')}
							data-link={link(needs.length)}
							data-col-first={colFirst(needs.length)}
							style={cell(needs.length)}
						>
							{agents}
						</li>
					) : null}
					{grid || needs.length === 0 ? null : <li className="agent-dock-queue-fill" aria-hidden="true" />}
				</ul>
				{grid ? null : agents}
			</div>
		</>
	)
}

function Entry({
	item,
	where,
	now,
	density,
	open,
	paneId,
	buttonRef,
	onOpen,
}: {
	item: DockItem
	where: { project: string; name: string }
	now: number
	density: QueueDensity
	open: boolean
	paneId: string
	buttonRef(node: HTMLButtonElement | null): void
	onOpen(viaKeyboard: boolean): void
}) {
	const tone = cardTone(item, now)
	const kind = cardKindLabel(item)
	const age = formatAge(now - itemWaitingSince(item))
	const gistId = useId()
	const gist = cardGist(item)
	// Once answered from the dock, the entry says how it went instead of repeating the question.
	const receipt = receiptView(item)
	const receiptNode = receipt ? (
		<span className="agent-dock-entry-receipt" data-tone={receipt.tone}>
			{receipt.text}
		</span>
	) : null
	const head = (
		<span className="agent-dock-entry-line agent-dock-entry-head">
			<span
				className="agent-dock-glyph"
				data-tone={tone}
				data-glyph={kindGlyph(item) === '↵' ? 'return' : undefined}
				aria-hidden="true"
			>
				{kindGlyph(item)}
			</span>
			<span className="agent-dock-entry-name">{where.name}</span>
			{/* The project takes what the name leaves and wraps out of sight when that is under 4 cells, never a stub. */}
			{density !== 'dense' && where.project ? (
				<span className="agent-dock-entry-where">
					<span className="agent-dock-entry-project">{where.project}</span>
				</span>
			) : null}
			{density === 'dense'
				? (receiptNode ?? (
						<span className="agent-dock-entry-age" data-tone={itemAgeTone(item, now)}>
							{age}
						</span>
					))
				: null}
		</span>
	)
	const ageNode = (
		<span className="agent-dock-entry-age" data-tone={itemAgeTone(item, now)}>
			{age}
		</span>
	)
	let body: ReactNode
	if (density === 'full')
		body = (
			<>
				{head}
				<span className="agent-dock-entry-line agent-dock-entry-meta">
					<span className="agent-dock-entry-kind" data-tone={tone}>
						{kind}
					</span>
					{ageNode}
				</span>
				<span className="agent-dock-entry-line agent-dock-entry-gist" id={receiptNode ? undefined : gistId}>
					{receiptNode ?? gist}
				</span>
			</>
		)
	else if (density === 'compact')
		body = (
			<>
				{head}
				<span className="agent-dock-entry-line agent-dock-entry-meta">
					{receiptNode ?? (
						<span className="agent-dock-entry-kind" data-tone={tone}>
							{kind}
						</span>
					)}
					{ageNode}
				</span>
			</>
		)
	else body = head
	// Compact and dense entries do not show the gist: it still describes the entry for assistive tech.
	const hiddenGist =
		density !== 'full' && !receipt ? (
			<span className="sr-only" id={gistId}>
				{gist}
			</span>
		) : null
	return (
		<button
			ref={buttonRef}
			type="button"
			className="agent-dock-entry"
			data-rail-stop=""
			data-density={density}
			data-tone={tone}
			data-kind={item.kind}
			data-item-id={item.id}
			data-state={item.state}
			data-receipt={receipt?.tone}
			data-open={String(open)}
			aria-expanded={open}
			aria-controls={open ? paneId : undefined}
			aria-label={`${kind}, ${where.name}${where.project ? ` in ${where.project}` : ''}, ${receipt ? receipt.text : `${item.kind === 'turn' ? 'idle' : 'waiting'} ${age}`}`}
			aria-describedby={receipt ? undefined : gistId}
			title={`${kind} · ${where.name}${where.project ? ` (${where.project})` : ''}`}
			onClick={event => onOpen(event.detail === 0)}
		>
			{body}
			{hiddenGist}
		</button>
	)
}

/**
 * One quiet entry: the agent count and the first agents; the pane lists all of them.
 * Beside the entries it is a column (`side`: status glyph, name, age lines; `narrow`:
 * count and busy count); when the queue is tight it becomes the grid's last cell.
 * Only what DockSession observed (status, since) — never invented activity.
 */
function AgentsEntry({
	snapshot,
	sessions,
	now,
	slot,
	density,
	open,
	paneId,
	buttonRef,
	onOpen,
}: {
	snapshot: AgentDockSnapshot
	sessions: DockSession[]
	now: number
	slot: QueueAgentsSlot
	density: QueueDensity
	open: boolean
	paneId: string
	buttonRef(node: HTMLButtonElement | null): void
	onOpen(viaKeyboard: boolean): void
}) {
	if (sessions.length === 0)
		return (
			<div className="agent-dock-agents-empty" data-slot={slot}>
				No Claude session is connected to Okena's Claude Remote
			</div>
		)
	const busy = sessions.filter(session => session.status === 'working' || session.status === 'background').length
	// One line only where the entries are one line (dense); otherwise it keeps their two-line rhythm.
	const oneLine = slot === 'cell' && density === 'dense'
	const title = (
		<span className="agent-dock-entry-line">
			<span className="agent-dock-agents-title">Agents</span>
			<span className="agent-dock-agents-count">{sessions.length}</span>
			{oneLine ? <span className="agent-dock-agents-count">· {busy} busy</span> : null}
		</span>
	)
	let body: ReactNode = title
	if (slot === 'narrow' || (slot === 'cell' && !oneLine))
		body = (
			<>
				{title}
				<span className="agent-dock-entry-line agent-dock-agents-count">{busy} busy</span>
			</>
		)
	else if (slot === 'side')
		body = (
			<>
				{title}
				{sessions.slice(0, 2).map(session => (
					<span key={session.key} className="agent-dock-entry-line agent-dock-agent-line">
						<span className="agent-dock-status" data-status={session.status} aria-hidden="true">
							{statusGlyph(session.status)}
						</span>
						<span className="agent-dock-agent-name">{sessionWhere(session, session.key).name}</span>
						<span className="agent-dock-entry-age">{formatAge(now - sessionSince(snapshot, session))}</span>
					</span>
				))}
			</>
		)
	return (
		<button
			ref={buttonRef}
			type="button"
			className="agent-dock-agents-entry"
			data-rail-stop=""
			data-slot={slot}
			data-density={density}
			data-open={String(open)}
			aria-expanded={open}
			aria-controls={open ? paneId : undefined}
			aria-label={`${sessions.length} agent${sessions.length === 1 ? '' : 's'}, ${busy} busy. Show agents`}
			title={sessions
				.map(
					session =>
						`${sessionWhere(session, session.key).name}: ${sessionStatusText(session, now, sessionSince(snapshot, session))}`,
				)
				.join('\n')}
			onClick={event => onOpen(event.detail === 0)}
		>
			{body}
		</button>
	)
}

/** The pane's landmark name: what it is and whose (`Question, agent-dock, helm`). */
function paneLabel(item: DockItem, snapshot: AgentDockSnapshot): string {
	const where = sessionWhere(findSession(snapshot, item.session), item.session)
	return `${cardKindLabel(item)}, ${where.name}${where.project ? `, ${where.project}` : ''}`
}

/**
 * Polite words for items that newly need Jakub (the queue never opens by itself, so the strip
 * changing is the only other signal). Only arrivals: never ticking ages or working counts. The
 * first reachable snapshot is the baseline, and arrivals within ANNOUNCE_COALESCE_MS are one line.
 */
function useArrivalAnnouncement(snapshot: AgentDockSnapshot | null): string {
	const seen = useRef<Set<number> | null>(null)
	const queued = useRef<DockItem[]>([])
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const latest = useRef(snapshot)
	latest.current = snapshot
	const [text, setText] = useState('')
	useEffect(() => {
		if (!snapshot || snapshot.source.state !== 'ok') return
		const needs = needsYouItems(snapshot)
		if (seen.current === null) {
			seen.current = new Set(needs.map(item => item.id))
			return
		}
		const known = seen.current
		const fresh = needs.filter(item => !known.has(item.id))
		for (const item of fresh) known.add(item.id)
		if (fresh.length === 0) return
		queued.current.push(...fresh)
		if (timer.current !== null) return
		timer.current = setTimeout(() => {
			timer.current = null
			const items = queued.current
			queued.current = []
			const [first] = items
			if (!first) return
			if (items.length > 1) {
				setText(`${items.length} new requests`)
				return
			}
			const where = sessionWhere(findSession(latest.current, first.session), first.session)
			setText(`${cardKindLabel(first)} from ${where.name}${where.project ? ` in ${where.project}` : ''}`)
		}, ANNOUNCE_COALESCE_MS)
	}, [snapshot])
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current)
		},
		[],
	)
	return text
}
