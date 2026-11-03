// The agent dock's queue row (design §3.24): one quiet line per item that owes Jakub something
// (kind glyph, short name, wait or receipt), measured to fit one row with "+N more" past that, then
// the Agents entry. AgentDock owns which pane is open; the row only reports clicks and keys.
import { useId, useLayoutEffect, useMemo, useState } from 'react'
import type { AgentDockSnapshot, DockItem } from '../../agent-dock/model'
import { AgentsEntryLine, useAgentsEntryVariant } from './AgentsEntryLine'
import { agentsTally } from './agents-entry'
import { KindGlyph } from './pane-chrome'
import {
	type AgentWho,
	type TextWidth,
	agentWho,
	agentsEntryText,
	anySourceOk,
	emptyQueueText,
	entryGist,
	entryTone,
	formatAge,
	formatClock,
	itemAgeTone,
	itemKindLabel,
	itemWaitingSince,
	noSessionText,
	orderedSessions,
	plainAgentText,
	queueLayout,
	receiptView,
	sourceNames,
	unknownSessionCount,
} from './presentation'
import { type ArrivalKind, mostUrgent, useArrivalFlash } from './use-arrival-flash'

/** What a pane shows: one item, or the Agents list. */
export type AgentDockTarget = { type: 'item'; id: number } | { type: 'agents' }

/**
 * Real text widths in the queue's own font: `measure(text)` lays the text out in a hidden meter beside
 * the entries (same face, size, letter-spacing and tabular digits) and caches it. A sentinel's width
 * changing (UI text scale, font) starts a fresh cache. Null until both nodes are mounted.
 */
function useTextWidth(sentinel: HTMLElement | null, meter: HTMLElement | null): TextWidth | null {
	const [font, setFont] = useState(0)
	useLayoutEffect(() => {
		if (!sentinel) return
		const update = () => setFont(sentinel.getBoundingClientRect().width)
		update()
		const observer = new ResizeObserver(update)
		observer.observe(sentinel)
		return () => observer.disconnect()
	}, [sentinel])
	return useMemo(() => {
		if (!meter || font <= 0) return null
		const cache = new Map<string, number>()
		return (text: string) => {
			let width = cache.get(text)
			if (width === undefined) {
				meter.textContent = text
				width = meter.getBoundingClientRect().width
				cache.set(text, width)
			}
			return width
		}
	}, [meter, font])
}

/** What follows an entry's name on its line: the receipt once answered from the dock, else the wait. */
const entryTail = (item: DockItem, now: number): string =>
	receiptView(item)?.text ?? formatAge(now - itemWaitingSince(item))

export function Queue({
	snapshot,
	now,
	needs,
	openKey,
	paneId,
	register,
	onOpen,
}: {
	snapshot: AgentDockSnapshot | null
	now: number
	needs: DockItem[]
	openKey: string | null
	paneId: string
	register(key: string): (node: HTMLButtonElement | null) => void
	onOpen(target: AgentDockTarget, viaKeyboard: boolean): void
}) {
	// The entries' room can mount after the first render (Connecting → data): measure it via a callback ref.
	const [list, setList] = useState<HTMLUListElement | null>(null)
	const [sentinel, setSentinel] = useState<HTMLSpanElement | null>(null)
	const [meter, setMeter] = useState<HTMLSpanElement | null>(null)
	const [room, setRoom] = useState(0)
	const measure = useTextWidth(sentinel, meter)
	const arrivals = useArrivalFlash(snapshot)
	useLayoutEffect(() => {
		if (!list) return
		const update = () => {
			const style = getComputedStyle(list)
			setRoom(list.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight))
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(list)
		return () => observer.disconnect()
	}, [list])
	const meters = (
		<span className="agent-dock-measure" aria-hidden="true">
			<span ref={setSentinel}>0123456789 abcdefghijklmnopqrstuvwxyz</span>
			<span ref={setMeter} />
		</span>
	)
	const source = snapshot?.source
	// Only while no source has answered yet: one source connecting never hides another's entries.
	if (!snapshot || (source?.state === 'pending' && !anySourceOk(snapshot)))
		return (
			<div className="agent-dock-row-note">
				<span>Connecting to {sourceNames(snapshot, 'pending')}…</span>
			</div>
		)
	const unknown = unknownSessionCount(snapshot)
	const whos = needs.map(item => agentWho(snapshot, item.session))
	const openIndex = needs.findIndex(item => `item:${item.id}` === openKey)
	// Names shorten (in the middle) before anything goes behind "+N more"; the open entry is always in the row.
	const layout = queueLayout(
		needs.map((item, at) => ({ name: whos[at]?.name ?? '', tail: entryTail(item, now) })),
		measure,
		room,
		openIndex,
	)
	const hidden = layout.hidden.flatMap(at => (needs[at] ? [needs[at]] : []))
	const openHidden = hidden.find(item => `item:${item.id}` === openKey)
	const sessions = orderedSessions(snapshot)
	return (
		<>
			{meters}
			{source?.state === 'down' ? (
				// One quiet line, like the entries beside it; when data was last seen is its tooltip.
				<div
					className="agent-dock-row-note"
					data-tone="warn"
					title={[
						source.lastObservedAt !== null ? `last data ${formatClock(source.lastObservedAt)}` : 'no data yet',
						'nothing resolves until it’s back',
						source.detail ? plainAgentText(source.detail, 200) : '',
					]
						.filter(Boolean)
						.join('\n')}
				>
					<span>
						<span className="agent-dock-row-note-mark" aria-hidden="true">
							!{' '}
						</span>
						{sourceNames(snapshot, 'down')} unreachable
					</span>
				</div>
			) : null}
			<ul ref={setList} className="agent-dock-queue" aria-label={`Needs you, ${needs.length}`}>
				{needs.length === 0 ? (
					<li className="agent-dock-queue-empty">{emptyQueueText(snapshot)}</li>
				) : (
					layout.slots.map(({ index, width, name }) => {
						const item = needs[index]
						if (!item) return null
						const who = whos[index] ?? { name: '', title: '', project: '' }
						return (
							<li key={item.id} className="agent-dock-queue-slot" style={width ? { flexBasis: width } : undefined}>
								<Entry
									item={item}
									who={who}
									shownName={name}
									now={now}
									arrival={arrivals.get(item.id)}
									open={openKey === `item:${item.id}`}
									paneId={paneId}
									buttonRef={register(`item:${item.id}`)}
									onOpen={viaKeyboard => onOpen({ type: 'item', id: item.id }, viaKeyboard)}
								/>
							</li>
						)
					})
				)}
				{hidden.length > 0 ? (
					<li className="agent-dock-queue-slot" style={layout.more ? { flexBasis: layout.more } : undefined}>
						<MoreEntry
							items={hidden}
							snapshot={snapshot}
							arrival={mostUrgent(hidden.map(item => arrivals.get(item.id)))}
							open={openHidden !== undefined}
							paneId={paneId}
							buttonRef={register('more')}
							onOpen={viaKeyboard => {
								const next = openHidden ?? hidden[0]
								if (next) onOpen({ type: 'item', id: next.id }, viaKeyboard)
							}}
						/>
					</li>
				) : null}
			</ul>
			<AgentsEntry
				snapshot={snapshot}
				sessions={sessions}
				unknown={needs.length > 0 ? unknown : 0}
				now={now}
				open={openKey === 'agents'}
				paneId={paneId}
				buttonRef={register('agents')}
				onOpen={viaKeyboard => onOpen({ type: 'agents' }, viaKeyboard)}
			/>
		</>
	)
}

/**
 * One item, one quiet line: the kind glyph (its tone is the kind), the agent's short name, then the
 * wait (toned only once it is genuinely old) or, once answered from the dock, the receipt. Just after
 * it arrives it carries `data-arrival` (its kind) and flashes once in the kind's color (styles.css).
 */
function Entry({
	item,
	who,
	shownName,
	now,
	arrival,
	open,
	paneId,
	buttonRef,
	onOpen,
}: {
	item: DockItem
	who: AgentWho
	/** The name as the entry has room for it (cut in the middle); its label and tooltip keep it whole. */
	shownName: string
	now: number
	/** Set for ARRIVAL_FLASH_MS after the item arrived. */
	arrival: ArrivalKind | undefined
	open: boolean
	paneId: string
	buttonRef(node: HTMLButtonElement | null): void
	onOpen(viaKeyboard: boolean): void
}) {
	const kind = itemKindLabel(item)
	const age = formatAge(now - itemWaitingSince(item))
	const gistId = useId()
	const receipt = receiptView(item)
	return (
		<button
			ref={buttonRef}
			type="button"
			className="agent-dock-entry"
			data-row-stop=""
			data-tone={entryTone(item)}
			data-kind={item.kind}
			data-item-id={item.id}
			data-state={item.state}
			data-receipt={receipt?.tone}
			data-arrival={arrival}
			data-open={String(open)}
			aria-expanded={open}
			aria-controls={open ? paneId : undefined}
			aria-label={`${kind}, ${who.name}${who.project ? ` in ${who.project}` : ''}, ${receipt ? receipt.text : `${item.kind === 'turn' ? 'idle' : 'waiting'} ${age}`}`}
			aria-describedby={receipt ? undefined : gistId}
			title={[`${kind} · ${who.name}`, who.title, who.project].filter(Boolean).join('\n')}
			onClick={event => onOpen(event.detail === 0)}
		>
			<span className="agent-dock-entry-line">
				<KindGlyph item={item} />
				<span className="agent-dock-entry-name">{shownName}</span>
				{receipt ? (
					<span className="agent-dock-entry-receipt" data-tone={receipt.tone}>
						{receipt.text}
					</span>
				) : (
					<span className="agent-dock-entry-age" data-tone={itemAgeTone(item, now)}>
						{age}
					</span>
				)}
			</span>
			{/* The queue shows no gist; it still describes the entry for assistive tech. */}
			{receipt ? null : (
				<span className="sr-only" id={gistId}>
					{entryGist(item)}
				</span>
			)}
		</button>
	)
}

/**
 * The items the row has no room for, as one quiet cell. It opens the first of them (‹ › then step
 * through the rest) and stands in for whichever of them is open, and flashes for one that arrives there.
 */
function MoreEntry({
	items,
	snapshot,
	arrival,
	open,
	paneId,
	buttonRef,
	onOpen,
}: {
	items: DockItem[]
	snapshot: AgentDockSnapshot
	/** The most urgent kind among them that just arrived. */
	arrival: ArrivalKind | undefined
	open: boolean
	paneId: string
	buttonRef(node: HTMLButtonElement | null): void
	onOpen(viaKeyboard: boolean): void
}) {
	const names = items.map(item => `${itemKindLabel(item)}, ${agentWho(snapshot, item.session).name}`)
	return (
		<button
			ref={buttonRef}
			type="button"
			className="agent-dock-more"
			data-row-stop=""
			data-arrival={arrival}
			data-open={String(open)}
			aria-expanded={open}
			aria-controls={open ? paneId : undefined}
			aria-label={`${items.length} more: ${names.join('; ')}`}
			title={names.join('\n')}
			onClick={event => onOpen(event.detail === 0)}
		>
			<span className="agent-dock-entry-line">+{items.length} more</span>
		</button>
	)
}

/**
 * The Agents entry, one quiet line after the queue (`agents 4 · 2 busy`; `agents 8` alone when none is
 * busy), and the pane lists them all. Only what DockSession observed (status, since) — never invented
 * activity. Agents whose state their source could not read while items show are named here, toned: the row
 * never reads as complete without them.
 */
function AgentsEntry({
	snapshot,
	sessions,
	unknown,
	now,
	open,
	paneId,
	buttonRef,
	onOpen,
}: {
	snapshot: AgentDockSnapshot
	sessions: ReturnType<typeof orderedSessions>
	unknown: number
	now: number
	open: boolean
	paneId: string
	buttonRef(node: HTMLButtonElement | null): void
	onOpen(viaKeyboard: boolean): void
}) {
	const words = agentsEntryText(snapshot, sessions, unknown, now)
	// Story-only candidate looks (data-agents-entry on #agent-dock); without one, the current line.
	const [wrap, setWrap] = useState<HTMLDivElement | null>(null)
	const variant = useAgentsEntryVariant(wrap)
	const tally = variant ? agentsTally(sessions, noSessionText(snapshot)) : null
	return (
		<div ref={setWrap} className="agent-dock-agents" data-variant={variant ?? undefined}>
			<button
				ref={buttonRef}
				type="button"
				className="agent-dock-agents-entry"
				data-row-stop=""
				data-open={String(open)}
				aria-expanded={open}
				aria-controls={open ? paneId : undefined}
				aria-label={tally ? tally.label : words.label}
				title={words.title}
				onClick={event => onOpen(event.detail === 0)}
			>
				{variant && tally ? (
					<span className="agent-dock-entry-line" aria-hidden="true">
						<AgentsEntryLine variant={variant} tally={tally} unknown={unknown} />
					</span>
				) : (
					<span className="agent-dock-entry-line">
						{words.text}
						{unknown > 0 ? <span className="agent-dock-agents-unknown">· {unknown} unknown</span> : null}
					</span>
				)}
			</button>
		</div>
	)
}
