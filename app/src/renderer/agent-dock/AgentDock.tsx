// Agent dock body (design §3.24): the fixed 28px strip plus
// the card rail it toggles. The rail shows one card per item that owes Jakub
// something (never paged out of sight: cards compact instead) and one Agents
// button; a card opens a detail popover over the terminal that never covers the
// terminal's last rows; answering happens in that popover (slice 2) and the
// card shows the receipt. Layout, persistence, focus return and ⌘⇧J belong to
// agent-dock-layout.ts. Agent text is untrusted and always rendered as plain
// React text (never markup), bounded and control-stripped.

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
import { ActivityIndicator } from '../activity-indicator'
import { Btn } from '../button'
import { GLYPH } from '../sidebar/ui'
import { AgentsDetail, type DetailKeys, type DockDrafts, ItemDetail } from './AgentDockDetail'
import {
	type AgentDockPosition,
	type PopoverPlacement,
	type RailAgentsSlot,
	type RailDensity,
	type TerminalMetrics,
	canAnswer,
	cardGist,
	cardKindLabel,
	cardTone,
	dockSummary,
	findSession,
	formatAge,
	formatClock,
	itemAgeTone,
	itemIndicator,
	itemWaitingSince,
	nextLingerExpiry,
	orderedSessions,
	plainAgentText,
	popoverPlacement,
	railItems,
	railLayout,
	receiptView,
	sessionIndicator,
	sessionStatusText,
	sessionWhere,
	unknownAgentsText,
	unknownSessionCount,
} from './presentation'

export type AgentDockTarget = { type: 'item'; id: number } | { type: 'agents' }

export interface AgentDockProps {
	snapshot: AgentDockSnapshot | null
	now: number
	/** Rail open (user toggle only: new items never open it or resize the terminal). */
	expanded: boolean
	position: AgentDockPosition
	shortcutLabel: string
	onToggle(): void
	onTogglePosition(): void
	onAck(itemId: number): Promise<boolean>
	/** Jakub answered from a popover (main runs the Okena CAS + POST; the receipt arrives in the snapshot). */
	onAct?(itemId: number, rev: number, action: DockAction): Promise<AgentDockActResult>
	/** Viewport metrics of the active terminal; the popover keeps its last rows visible. */
	terminalMetrics?: () => TerminalMetrics | null
	/** After a popover opens or closes (the layout watches the active terminal only meanwhile). */
	onPopoverOpenChange?(open: boolean): void
	/** Review fixtures only: the popover to show on first render. */
	initialOpen?: AgentDockTarget | null
}

const targetKey = (target: AgentDockTarget | null): string | null =>
	target === null ? null : target.type === 'agents' ? 'agents' : `item:${target.id}`

/** Agent lines shown inside the rail's Agents button; the popover lists every agent. */
const AGENT_LINES = 3

export function AgentDock({
	snapshot,
	now,
	expanded,
	position,
	shortcutLabel,
	onToggle,
	onTogglePosition,
	onAck,
	onAct,
	terminalMetrics,
	onPopoverOpenChange,
	initialOpen = null,
}: AgentDockProps) {
	const railId = useId()
	const popoverId = useId()
	const hostRef = useRef<HTMLDivElement>(null)
	const popoverRef = useRef<HTMLElement>(null)
	const anchors = useRef(new Map<string, HTMLButtonElement>())
	const [target, setTarget] = useState<AgentDockTarget | null>(initialOpen)
	const targetRef = useRef(target)
	targetRef.current = target
	/** The card the popover is aligned to; stepping keeps it so ‹ › never move sideways. */
	const [anchorKey, setAnchorKey] = useState<string | null>(targetKey(initialOpen))
	const [place, setPlace] = useState<PopoverPlacement | null>(null)
	/** Tallest the popover has been since it opened: stepping never shrinks it, so ‹ › stay put. */
	const [lockedHeight, setLockedHeight] = useState(0)
	const focusOnOpen = useRef(false)
	/** Keyboard focus was inside the popover when a step or ack swapped its content. */
	const keepFocus = useRef(false)
	/** Index to advance to after a local ack removes the open item. */
	const advanceFrom = useRef<number | null>(null)
	const [pending, setPending] = useState<ReadonlySet<number>>(new Set())
	const [refused, setRefused] = useState<ReadonlySet<number>>(new Set())
	/** Acts awaiting main's answer (the button shows Sending… even before the snapshot does). */
	const [submitting, setSubmitting] = useState<ReadonlySet<number>>(new Set())
	/** Outcomes main could not record on the item (bad request, IPC failure), by item id. */
	const [actErrors, setActErrors] = useState<ReadonlyMap<number, string>>(new Map())
	/** Popover-level key handler of the shown body (digits pick, Enter submits). */
	const detailKeys = useRef<DetailKeys | null>(null)
	/** Unsent reply/deny drafts, by item: survive stepping and closing (memory only). */
	const drafts = useRef<DockDrafts>(new Map()).current
	/** Re-render clock for answered cards that linger with their receipt. */
	const [lingerNow, setLingerNow] = useState(0)
	const clock = Math.max(now, lingerNow)

	const summary = dockSummary(snapshot, clock)
	const needs = expanded ? railItems(snapshot, clock) : []
	const openKey = targetKey(target)
	const openIndex = target?.type === 'item' ? needs.findIndex(item => item.id === target.id) : -1
	const openItem = openIndex >= 0 ? needs[openIndex] : undefined
	const popoverOpen = expanded && (target?.type === 'agents' || openItem !== undefined)
	const popoverShown = popoverOpen && place !== null

	const close = useCallback((refocus: boolean) => {
		const key = targetKey(targetRef.current)
		focusOnOpen.current = false
		keepFocus.current = false
		setTarget(null)
		setPlace(null)
		setLockedHeight(0)
		if (refocus && key) queueMicrotask(() => anchors.current.get(key)?.focus())
	}, [])

	const open = (next: AgentDockTarget, viaKeyboard: boolean) => {
		const key = targetKey(next)
		if (key === openKey) {
			close(viaKeyboard)
			return
		}
		focusOnOpen.current = viaKeyboard
		keepFocus.current = false
		advanceFrom.current = null
		setTarget(next)
		setAnchorKey(key)
		setLockedHeight(0)
	}

	const focusInPopover = () => {
		const popover = popoverRef.current
		return !!popover && popover.contains(popover.ownerDocument.activeElement)
	}

	const step = (delta: number) => {
		const next = needs[openIndex + delta]
		if (openIndex < 0 || !next) return
		advanceFrom.current = null
		keepFocus.current = focusInPopover()
		setTarget({ type: 'item', id: next.id })
	}

	// A card that just got its answer lingers RECEIPT_LINGER_MS with "✓ answered"; re-render when it should go.
	useEffect(() => {
		const expiry = nextLingerExpiry(snapshot, clock)
		if (expiry === null) return
		const timer = setTimeout(() => setLingerNow(Date.now()), Math.max(50, expiry - clock + 20))
		return () => clearTimeout(timer)
	}, [snapshot, clock])

	// The open item went away: after a local ack show the next one, otherwise close.
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

	// Anchor the popover above (bottom dock) or below (top dock) the rail, clear of the terminal's last rows.
	useLayoutEffect(() => {
		if (!popoverOpen) return
		const host = hostRef.current
		const anchor =
			(anchorKey ? anchors.current.get(anchorKey) : undefined) ?? (openKey ? anchors.current.get(openKey) : undefined)
		if (!host || !anchor) return
		const box = host.getBoundingClientRect()
		const anchorBox = anchor.getBoundingClientRect()
		const next = popoverPlacement({
			position,
			dock: { top: box.top, left: box.left, width: box.width, height: box.height },
			anchor: { left: anchorBox.left, width: anchorBox.width },
			terminal: terminalMetrics?.() ?? null,
			viewportHeight: host.ownerDocument.defaultView?.innerHeight ?? 0,
		})
		setPlace(prev =>
			prev &&
			prev.left === next.left &&
			prev.width === next.width &&
			prev.top === next.top &&
			prev.bottom === next.bottom &&
			prev.maxHeight === next.maxHeight &&
			prev.rowHeight === next.rowHeight
				? prev
				: next,
		)
	})

	// Stepping never shrinks the popover: its bottom-anchored head (‹ 1 of N › ×) stays under the pointer.
	// The height rounds up to whole terminal rows, so the free edge never half-covers a row either.
	useLayoutEffect(() => {
		if (!popoverOpen || !place) return
		const natural = popoverRef.current?.offsetHeight ?? 0
		const row = place.rowHeight
		const height = row ? Math.ceil(natural / row - 0.01) * row : natural
		if (height > lockedHeight + 0.5) setLockedHeight(height)
	})

	// Keyboard-opened popovers take focus; pointer use never does (the layout keeps xterm focused).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run per opened target, not only per placement
	useEffect(() => {
		if (!place || !focusOnOpen.current) return
		focusOnOpen.current = false
		popoverRef.current?.focus()
	}, [place, openKey])

	// A step or ack swapped the content under a focused control (or disabled it at an end): keep focus in the popover.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the shown item changes
	useLayoutEffect(() => {
		if (!keepFocus.current) return
		const popover = popoverRef.current
		if (!popover) return
		keepFocus.current = false
		const active = popover.ownerDocument.activeElement
		if (!active || !popover.contains(active) || (active as HTMLButtonElement).disabled) popover.focus()
	}, [openKey, popoverOpen])

	// biome-ignore lint/correctness/useExhaustiveDependencies: report open/close edges only
	useEffect(() => {
		onPopoverOpenChange?.(popoverShown)
	}, [popoverShown])

	// A pointer press outside the popover and its anchors closes it (terminal clicks included).
	useEffect(() => {
		if (!popoverOpen) return
		const doc = hostRef.current?.ownerDocument
		if (!doc) return
		const onPointer = (event: PointerEvent) => {
			const node = event.target as Node
			if (popoverRef.current?.contains(node)) return
			for (const anchor of anchors.current.values()) if (anchor.contains(node)) return
			close(false)
		}
		doc.addEventListener('pointerdown', onPointer, true)
		return () => doc.removeEventListener('pointerdown', onPointer, true)
	}, [popoverOpen, close])

	const ack = (itemId: number) => {
		advanceFrom.current = needs.findIndex(item => item.id === itemId)
		keepFocus.current = focusInPopover()
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
		setSubmitting(prev => new Set(prev).add(item.id))
		void onAct(item.id, item.rev, action)
			.catch(
				(error: unknown): AgentDockActResult => ({
					ok: false,
					outcome: { status: 'failed', detail: error instanceof Error ? error.message : String(error) },
				}),
			)
			.then(result => {
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

	// Roving ←/→ (Home/End) across cards and the Agents button; Esc closes an open popover first.
	const onRailKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape' && popoverOpen) {
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

	// Inside the popover: ← → / ↑ ↓ step between items (from the popover itself or ‹ ›; the
	// body region keeps ↑ ↓ for scrolling, tabs and options keep their own arrows); paging
	// keys scroll the body; Esc closes back to the card.
	const onPopoverKey = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === 'Escape') {
			event.preventDefault()
			close(true)
			return
		}
		// The shown body first: 1–9 pick options, Enter submits (never while typing in a field).
		if (detailKeys.current?.(event)) {
			event.preventDefault()
			return
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return
		const popover = event.currentTarget
		const scroller = popover.querySelector<HTMLElement>('.agent-dock-pop-scroll')
		const from = event.target as Element
		const onPopover = from === popover
		if (onPopover && scroller && ['PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
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
		const delta = onPopover || onStepper ? horizontal || vertical : from === scroller ? horizontal : 0
		if (!delta) return
		event.preventDefault()
		step(delta)
	}

	const toggleLabel = `${expanded ? 'Collapse' : 'Expand'} agent dock (${shortcutLabel})`
	const strip = (
		<div className="agent-dock-strip">
			<button
				type="button"
				className="agent-dock-toggle"
				aria-expanded={expanded}
				aria-controls={railId}
				title={toggleLabel}
				onClick={onToggle}
			>
				<span className="agent-dock-chevron" aria-hidden="true">
					{GLYPH.chevronDown}
				</span>
				<span className="agent-dock-needs" data-tone={summary.needsTone}>
					{summary.indicator ? (
						<ActivityIndicator variant={summary.indicator.variant} label={summary.indicator.label} />
					) : null}
					<span className="agent-dock-needs-count">{summary.needsText}</span>
					{summary.oldestText ? (
						<span className="agent-dock-age" data-tone={summary.oldestTone}>
							{' · '}
							{summary.oldestText}
						</span>
					) : null}
				</span>
				<span className="agent-dock-head">{summary.head ?? ''}</span>
				{summary.counts ? <span className="agent-dock-counts">{summary.counts}</span> : null}
				<span className="agent-dock-health" data-tone={summary.health.tone}>
					<span className="agent-dock-dot" aria-hidden="true" />
					<span className="agent-dock-health-text">{summary.health.text}</span>
				</span>
				<kbd className="agent-dock-kbd">{shortcutLabel}</kbd>
			</button>
			{expanded ? (
				<Btn
					tone="ghost"
					sm
					className="agent-dock-position"
					ariaLabel={position === 'bottom' ? 'Move agent dock above terminals' : 'Move agent dock below terminals'}
					onClick={onTogglePosition}
				>
					{position === 'bottom' ? 'Move to top' : 'Move to bottom'}
				</Btn>
			) : null}
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
				<Rail
					snapshot={snapshot}
					now={clock}
					needs={needs}
					openKey={popoverOpen ? openKey : null}
					popoverId={popoverId}
					register={register}
					onOpen={open}
				/>
			) : null}
		</section>
	)

	return (
		<div ref={hostRef} className="agent-dock-host" data-position={position}>
			{position === 'top' ? strip : rail}
			{position === 'top' ? rail : strip}
			{popoverOpen && place ? (
				<section
					ref={popoverRef}
					id={popoverId}
					className="agent-dock-popover"
					data-position={position}
					tabIndex={-1}
					aria-label={openItem ? `#${openItem.id} ${cardKindLabel(openItem)}` : 'Agents'}
					style={{
						left: place.left,
						width: place.width,
						maxHeight: place.maxHeight,
						minHeight: Math.min(lockedHeight, place.maxHeight),
						...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
					}}
					onKeyDown={onPopoverKey}
				>
					{/* Not keyed per item: the head and ‹ › stay mounted (and focused) while stepping. */}
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
							localError={actErrors.get(openItem.id) ?? null}
							keys={detailKeys}
							drafts={drafts}
							onStep={step}
							onClose={() => close(true)}
							onAck={() => ack(openItem.id)}
							onAct={action => act(openItem, action)}
						/>
					) : (
						<AgentsDetail snapshot={snapshot} now={clock} onClose={() => close(true)} />
					)}
				</section>
			) : null}
		</div>
	)
}

function Rail({
	snapshot,
	now,
	needs,
	openKey,
	popoverId,
	register,
	onOpen,
}: {
	snapshot: AgentDockSnapshot | null
	now: number
	needs: DockItem[]
	openKey: string | null
	popoverId: string
	register(key: string): (node: HTMLButtonElement | null) => void
	onOpen(target: AgentDockTarget, viaKeyboard: boolean): void
}) {
	// The rail body can mount after the first render (Connecting → data): measure it via a callback ref.
	const [main, setMain] = useState<HTMLDivElement | null>(null)
	const [width, setWidth] = useState(0)
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
				<span>Claude sessions appear once Okena's Claude Remote answers.</span>
			</div>
		)
	const unknown = unknownSessionCount(snapshot)
	const layout = railLayout(needs.length, width)
	const sessions = orderedSessions(snapshot)
	const agents = (
		<AgentsButton
			sessions={sessions}
			snapshot={snapshot}
			now={now}
			slot={layout.agents}
			density={layout.density}
			open={openKey === 'agents'}
			popoverId={popoverId}
			buttonRef={register('agents')}
			onOpen={viaKeyboard => onOpen({ type: 'agents' }, viaKeyboard)}
		/>
	)
	return (
		<>
			{source?.state === 'down' ? (
				<div className="agent-dock-rail-note" data-tone="warn">
					<span className="agent-dock-rail-note-title">Okena unreachable</span>
					<span
						className="agent-dock-rail-note-detail"
						title={source.detail ? plainAgentText(source.detail, 200) : undefined}
					>
						{`Since ${formatClock(source.since)}. `}
						{source.lastObservedAt !== null
							? `Showing the last data from ${formatClock(source.lastObservedAt)}. Nothing resolves until Okena is back.`
							: 'No data yet. Nothing resolves until Okena is back.'}
					</span>
				</div>
			) : null}
			<div ref={setMain} className="agent-dock-rail-main">
				<ul
					className="agent-dock-cards"
					aria-label={`Needs you, ${needs.length}`}
					data-density={layout.density}
					style={{ '--rail-columns': String(Math.max(1, layout.columns)) } as CSSProperties}
				>
					{needs.length === 0 ? (
						<li className="agent-dock-cards-empty">
							{source?.state !== 'ok'
								? 'Okena is unreachable, so open questions cannot be seen.'
								: unknown > 0
									? `${unknownAgentsText(unknown)}: Okena did not return readable detail, so their open questions cannot be seen.`
									: 'Nothing needs you.'}
						</li>
					) : (
						needs.map(item => (
							<li key={item.id} className="agent-dock-card-slot">
								<Card
									item={item}
									session={findSession(snapshot, item.session)}
									now={now}
									density={layout.density}
									open={openKey === `item:${item.id}`}
									popoverId={popoverId}
									buttonRef={register(`item:${item.id}`)}
									onOpen={viaKeyboard => onOpen({ type: 'item', id: item.id }, viaKeyboard)}
								/>
							</li>
						))
					)}
					{layout.agents === 'cell' ? <li className="agent-dock-card-slot">{agents}</li> : null}
				</ul>
				{layout.agents === 'cell' ? null : agents}
			</div>
		</>
	)
}

function Card({
	item,
	session,
	now,
	density,
	open,
	popoverId,
	buttonRef,
	onOpen,
}: {
	item: DockItem
	session: DockSession | undefined
	now: number
	density: RailDensity
	open: boolean
	popoverId: string
	buttonRef(node: HTMLButtonElement | null): void
	onOpen(viaKeyboard: boolean): void
}) {
	const where = sessionWhere(session, item.session)
	const indicator = itemIndicator(item)
	const kind = cardKindLabel(item)
	const age = formatAge(now - itemWaitingSince(item))
	const ageNode = (
		<span className="agent-dock-card-age" data-tone={itemAgeTone(item, now)}>
			{age}
		</span>
	)
	const kindNode = <span className="agent-dock-card-kind">{kind}</span>
	// Once answered from the dock, the card says how it went instead of repeating the question.
	const receipt = receiptView(item)
	const gist = receipt ? (
		<span className="agent-dock-card-receipt" data-tone={receipt.tone}>
			{receipt.text}
		</span>
	) : (
		cardGist(item)
	)
	const nameNode = (
		<span className="agent-dock-card-where">
			<span className="agent-dock-card-name">{where.name}</span>
			{where.project ? <span className="agent-dock-card-project">{where.project}</span> : null}
		</span>
	)
	let body: ReactNode
	if (density === 'full')
		body = (
			<>
				<span className="agent-dock-card-row">
					<ActivityIndicator variant={indicator.variant} label={indicator.label} />
					{kindNode}
					{ageNode}
				</span>
				<span className="agent-dock-card-row">{nameNode}</span>
				<span className="agent-dock-card-gist">{gist}</span>
			</>
		)
	else if (density === 'compact')
		body = (
			<>
				<span className="agent-dock-card-row">
					<ActivityIndicator variant={indicator.variant} label={indicator.label} />
					{nameNode}
				</span>
				<span className="agent-dock-card-row">
					{kindNode}
					<span className="agent-dock-card-line">{gist}</span>
					{ageNode}
				</span>
			</>
		)
	else
		body = (
			<span className="agent-dock-card-row">
				<ActivityIndicator variant={indicator.variant} label={indicator.label} />
				{nameNode}
				{ageNode}
			</span>
		)
	return (
		<button
			ref={buttonRef}
			type="button"
			className="agent-dock-card"
			data-rail-stop=""
			data-density={density}
			data-tone={cardTone(item, now)}
			data-kind={item.kind}
			data-item-id={item.id}
			data-state={item.state}
			data-receipt={receipt?.tone}
			data-open={String(open)}
			aria-expanded={open}
			aria-controls={open ? popoverId : undefined}
			aria-label={`#${item.id} ${kind}, ${where.project ? `${where.project} / ` : ''}${where.name}, ${receipt ? receipt.text : `waiting ${age}`}`}
			title={`${kind} · ${where.name}${where.project ? ` (${where.project})` : ''}`}
			onClick={event => onOpen(event.detail === 0)}
		>
			{body}
		</button>
	)
}

/**
 * One quiet button: the agent count and the first few agents; the popover lists all
 * of them. Beside the cards it is a block (`side`: name + status lines, `narrow`:
 * names only); when the rail is tight it becomes the grid's last cell in the cards'
 * density. Only what DockSession observed (status, since) — never invented activity.
 */
function AgentsButton({
	sessions,
	snapshot,
	now,
	slot,
	density,
	open,
	popoverId,
	buttonRef,
	onOpen,
}: {
	sessions: DockSession[]
	snapshot: AgentDockSnapshot
	now: number
	slot: RailAgentsSlot
	density: RailDensity
	open: boolean
	popoverId: string
	buttonRef(node: HTMLButtonElement | null): void
	onOpen(viaKeyboard: boolean): void
}) {
	if (sessions.length === 0) {
		const note = (
			<span className="agent-dock-agents-empty">No Claude session is connected to Okena's Claude Remote.</span>
		)
		return slot === 'cell' ? (
			<div className="agent-dock-agents-cell-note">{note}</div>
		) : (
			<div className="agent-dock-agents" data-slot={slot}>
				{note}
			</div>
		)
	}
	const busySessions = sessions.filter(session => session.status === 'working' || session.status === 'background')
	const busy = `${busySessions.length} busy`
	const dense = slot === 'cell' && density === 'dense'
	const title = (
		<span className="agent-dock-agents-title">
			<span>Agents</span>
			<span className="agent-dock-agents-count">{sessions.length}</span>
			{dense ? <span className="agent-dock-agents-count">· {busy}</span> : null}
			<span className="agent-dock-agents-more" aria-hidden="true">
				{GLYPH.chevronRight}
			</span>
		</span>
	)
	let body: ReactNode
	if (dense) body = title
	else if (slot === 'cell')
		body = (
			<>
				{title}
				<span className="agent-dock-agents-summary">
					{busy}
					{busySessions.length > 0
						? ` · ${busySessions.map(session => sessionWhere(session, session.key).name).join(', ')}`
						: ''}
				</span>
			</>
		)
	else {
		const lines = sessions.slice(0, sessions.length > AGENT_LINES ? AGENT_LINES - 1 : AGENT_LINES)
		body = (
			<>
				{title}
				<span className="agent-dock-agents-lines">
					{lines.map(session => {
						const indicator = sessionIndicator(session, snapshot.items)
						return (
							<span key={session.key} className="agent-dock-agent-line" data-status={session.status}>
								<span className="agent-dock-agent-slot">
									{indicator ? <ActivityIndicator variant={indicator.variant} label={indicator.label} /> : null}
								</span>
								<span className="agent-dock-agent-name">{sessionWhere(session, session.key).name}</span>
								{slot === 'side' ? (
									<span className="agent-dock-agent-status">{sessionStatusText(session, now)}</span>
								) : null}
							</span>
						)
					})}
					{sessions.length > lines.length ? (
						<span className="agent-dock-agent-line agent-dock-agent-more">+{sessions.length - lines.length} more</span>
					) : null}
				</span>
			</>
		)
	}
	const button = (
		<button
			ref={buttonRef}
			type="button"
			className="agent-dock-agents-button"
			data-rail-stop=""
			data-slot={slot}
			data-density={density}
			data-open={String(open)}
			aria-expanded={open}
			aria-controls={open ? popoverId : undefined}
			aria-label={`${sessions.length} agent${sessions.length === 1 ? '' : 's'}, ${busy}. Show agents`}
			onClick={event => onOpen(event.detail === 0)}
		>
			{body}
		</button>
	)
	return slot === 'cell' ? (
		button
	) : (
		<div className="agent-dock-agents" data-slot={slot}>
			{button}
		</div>
	)
}
